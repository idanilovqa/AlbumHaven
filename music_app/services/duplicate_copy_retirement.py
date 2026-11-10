"""Retire inventory evidence for an explicitly confirmed, completed copy deletion.

This is an internal publication boundary, not a deletion executor or API. Its
caller must authenticate/authorize and confirm an exact physical-file manifest,
complete filesystem deletion, and hold shared media reservations until commit.
It never deletes media, chooses a copy, or establishes audio equivalence.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import json
import stat

from music_app.services.library_watch_health import guard_destructive_library_publication


class DuplicateCopyRetirementConflict(ValueError):
    """The confirmed physical inventory no longer matches the current scope."""


@dataclass(frozen=True)
class PhysicalFileGeneration:
    file_id: int
    track_id: int
    root_id: int
    modified_at: datetime
    file_size_bytes: int
    last_seen_at: datetime


@dataclass(frozen=True)
class ConfirmedDuplicateCopyRemoval:
    library_id: int
    selected_files: tuple[PhysicalFileGeneration, ...]
    survivor_files: tuple[PhysicalFileGeneration, ...]
    physical_deletion_confirmed: bool


@dataclass(frozen=True)
class PreparedDuplicateCopyRetirement:
    selected_rows: tuple[dict, ...]
    survivor_rows: tuple[dict, ...]

    @property
    def paths(self):
        return tuple(row['private_path'] for row in self.selected_rows)

    def revalidate_files(self):
        """Reject changed physical outcomes before retirement or publication."""
        _check_physical_rows(self.selected_rows, self.survivor_rows)


def _conflict():
    # Private paths and physical IDs must not escape through a future API error.
    raise DuplicateCopyRetirementConflict('The confirmed copy inventory changed. Refresh the copies before continuing.')


def _validate_confirmation(confirmation):
    if (not isinstance(confirmation, ConfirmedDuplicateCopyRemoval)
            or confirmation.physical_deletion_confirmed is not True
            or type(confirmation.library_id) is not int or confirmation.library_id <= 0):
        _conflict()
    all_ids = []
    for group in (confirmation.selected_files, confirmation.survivor_files):
        if not isinstance(group, tuple) or not group:
            _conflict()
        for generation in group:
            if not isinstance(generation, PhysicalFileGeneration):
                _conflict()
            if any(type(value) is not int or value <= 0 for value in (
                    generation.file_id, generation.track_id, generation.root_id)):
                _conflict()
            if type(generation.file_size_bytes) is not int or generation.file_size_bytes < 0:
                _conflict()
            if any(not isinstance(value, datetime) or value.utcoffset() is None
                   for value in (generation.modified_at, generation.last_seen_at)):
                _conflict()
            all_ids.append(generation.file_id)
    if len(all_ids) != len(set(all_ids)):
        _conflict()


def _generation(row):
    return PhysicalFileGeneration(row['id'], row['track_id'], row['library_root_id'],
                                  row['modified_at'], row['file_size_bytes'], row['last_seen_at'])


def _unredirected_stat(path):
    try:
        result = path.lstat()
    except FileNotFoundError:
        return None
    if (stat.S_ISLNK(result.st_mode)
            or getattr(result, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        _conflict()
    return result


def _check_physical_rows(selected_rows, survivor_rows):
    for row, removed in [*((row, True) for row in selected_rows),
                         *((row, False) for row in survivor_rows)]:
        try:
            root = Path(row['root_path'])
            path = Path(row['private_path'])
            # lstat distinguishes a missing component from a dangling junction.
            # Absence beneath an unavailable mount is not removal evidence.
            root_stat = _unredirected_stat(root)
            if (not root.is_absolute() or root_stat is None
                    or not stat.S_ISDIR(root_stat.st_mode) or root.resolve(strict=True) != root):
                _conflict()
            relative = path.relative_to(root)
            if not relative.parts or '..' in relative.parts:
                _conflict()
            current = root
            for part in relative.parts[:-1]:
                current = current / part
                component_stat = _unredirected_stat(current)
                if component_stat is not None and (
                        not stat.S_ISDIR(component_stat.st_mode) or current.resolve(strict=True) != current):
                    _conflict()
            actual = _unredirected_stat(path)
            if actual is None:
                if removed:
                    continue
                _conflict()
            if (removed or path.resolve(strict=True) != path
                    or not stat.S_ISREG(actual.st_mode)
                    or actual.st_size != row['file_size_bytes']
                    or datetime.fromtimestamp(actual.st_mtime, timezone.utc) != row['modified_at']):
                _conflict()
        except (OSError, ValueError, RuntimeError):
            _conflict()


def prepare_confirmed_duplicate_retirement(connection, confirmation, root_id):
    """Validate and lock exact generations inside the inventory transaction."""
    _validate_confirmation(confirmation)
    library = connection.execute("""
        select library.libraries.id from library.libraries
        join app.bootstrap_owners on app.bootstrap_owners.account_id = library.libraries.owner_account_id
        where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          and library.libraries.name = 'Local Library' and library.libraries.library_kind = 'local'
          and library.libraries.id = %(library_id)s
    """, {'library_id': confirmation.library_id}).fetchone()
    if library is None:
        _conflict()
    generations = (*confirmation.selected_files, *confirmation.survivor_files)
    rows = [dict(row) for row in connection.execute("""
        select files.id, files.track_id, files.library_root_id, files.private_path,
               files.file_size_bytes, files.modified_at, files.last_seen_at,
               files.scan_cache_stale, files.metadata #>> '{scan_cache,source}' as source,
               tracks.library_id, albums.album_key, albums.title as album_title,
               coalesce(nullif(albums.metadata ->> 'album_artist', ''), artists.name) as album_artist,
               roots.library_id as root_library_id, roots.root_path, roots.is_active,
               roots.metadata ->> 'root_id' as configured_root_id
        from library.local_track_files files
        join library.local_tracks tracks on tracks.id = files.track_id
        join library.local_albums albums on albums.id = tracks.album_id and albums.library_id = tracks.library_id
        join library.library_roots roots on roots.id = files.library_root_id
        left join library.local_artists artists on artists.id = albums.artist_id and artists.library_id = albums.library_id
        where files.id = any(%(file_ids)s::bigint[])
        order by files.id for update of files, tracks, albums, roots
    """, {'file_ids': [item.file_id for item in generations]}).fetchall()]
    by_id = {row['id']: row for row in rows}
    for row in rows:
        if (row['library_id'] != confirmation.library_id
                or row['root_library_id'] != confirmation.library_id):
            _conflict()
    selected = tuple(by_id[item.file_id] for item in confirmation.selected_files if item.file_id in by_id)
    if not selected:
        # An exact-ID replay has no effect, including after a path is recreated
        # with a new row. This does not assert what removed the original rows.
        return PreparedDuplicateCopyRetirement((), ())
    if len(selected) != len(confirmation.selected_files) or len(rows) != len(generations):
        _conflict()
    for expected in generations:
        row = by_id[expected.file_id]
        if (_generation(row) != expected or row['scan_cache_stale'] is not False
                or row['source'] != 'runtime_scan_cache' or row['is_active'] is not True
                or not row['configured_root_id']):
            _conflict()
    if any(row['configured_root_id'] != root_id for row in selected):
        _conflict()
    survivors = tuple(by_id[item.file_id] for item in confirmation.survivor_files)
    identities = {tuple(' '.join(str(row[field] or '').casefold().split())
                        for field in ('album_artist', 'album_title')) for row in rows}
    if len(identities) != 1 or not all(next(iter(identities))):
        _conflict()
    with guard_destructive_library_publication(connection, sorted({row['configured_root_id'] for row in rows})):
        _check_physical_rows(selected, survivors)
    return PreparedDuplicateCopyRetirement(selected, survivors)


def retire_confirmed_duplicate_rows(connection, prepared):
    """Retire only validated physical rows; the caller owns commit/publication."""
    if not prepared.selected_rows:
        return 0
    prepared.revalidate_files()
    def generations(rows):
        return json.dumps([
            {field: row[field].isoformat() if isinstance(row[field], datetime) else row[field]
             for field in ('id', 'track_id', 'library_root_id', 'file_size_bytes', 'modified_at', 'last_seen_at')}
            for row in rows
        ])

    rows = connection.execute("""
        select library.retire_confirmed_duplicate_copy_files(
          %(library_id)s, %(selected)s::jsonb, %(survivors)s::jsonb) as id
    """, {'library_id': prepared.selected_rows[0]['library_id'],
           'selected': generations(prepared.selected_rows),
           'survivors': generations(prepared.survivor_rows)}).fetchall()
    if len(rows) != len(prepared.selected_rows):
        _conflict()
    return len(rows)
