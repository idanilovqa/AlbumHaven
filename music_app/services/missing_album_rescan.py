"""Re-scan one missing album: restore it where it was, find it where it moved, or say why it is missing."""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from time import monotonic

from music_app.services.library_event_coordinator import TargetedMove, TargetedReconciliationRequest
from music_app.services.library_reachability import (
    MISSING_UNREACHABLE,
    folder_is_readable,
    missing_reason_for_path,
)
from music_app.services.missing_album_removal_postgres import MissingAlbumNotFound, _connect, _row_mapping
from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

RESTORED = "restored"
MOVED = "moved"
MISSING = "missing"
_DEFAULT_SEARCH_SECONDS = 15.0


class MissingAlbumRescan:
    def __init__(
        self,
        config: Mapping[str, object],
        *,
        reconcile: Callable[[TargetedReconciliationRequest], object],
        roots: list[Mapping[str, object]],
        connect: Callable[[str], object] | None = None,
        search_seconds: float = _DEFAULT_SEARCH_SECONDS,
    ) -> None:
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        self._reconcile = reconcile
        self._roots = {
            str(root.get("id") or "").strip(): Path(str(root.get("path") or ""))
            for root in roots
            if str(root.get("id") or "").strip() and str(root.get("path") or "").strip()
        }
        self._connect = connect or _connect
        self._search_seconds = search_seconds

    def rescan(self, album_key: str) -> dict[str, object]:
        files = self._album_files(album_key)
        if not files:
            raise MissingAlbumNotFound()
        root_id = str(files[0]["root_id"] or "")
        root = self._roots.get(root_id)
        paths = [Path(str(row["private_path"])) for row in files]
        album_dir = Path(os.path.commonpath([str(path.parent) for path in paths]))
        if any(path.is_file() for path in paths):
            # Present where it was: re-read the folder; files still gone stay missing as deleted.
            return self._publish(RESTORED, TargetedReconciliationRequest(
                root_id=root_id, paths=frozenset({album_dir}), deleted_subtrees=frozenset({album_dir}),
            ))
        moved = self._find_moved_folder(album_dir, {path.name.casefold() for path in paths})
        if moved is not None:
            destination_root_id, destination = moved
            # The tracks follow their files, so ratings, loops and play preferences stay with them.
            self._repoint_tracks(album_dir, destination, destination_root_id, paths)
            return self._publish(MOVED, TargetedReconciliationRequest(
                root_id=destination_root_id,
                moves=(TargetedMove(album_dir, destination, root_id, destination_root_id, is_directory=True),),
            ))
        reason = missing_reason_for_path(root, paths[0])
        self._record_reason(album_key, reason)
        return {"status": MISSING, "reason": reason}

    def _publish(self, status: str, request: TargetedReconciliationRequest) -> dict[str, object]:
        result = self._reconcile(request)
        health = str(getattr(result, "health", "healthy") or "healthy")
        if health != "healthy":
            # The watcher refused the change (an unhealthy or unreadable root).
            return {"status": MISSING, "reason": MISSING_UNREACHABLE}
        return {"status": status, "library_revision": int(getattr(result, "revision", 0) or 0)}

    def _find_moved_folder(self, album_dir: Path, file_names: set[str]) -> tuple[str, Path] | None:
        """A folder with the album's folder name holding at least half of its file names.

        The same relative path under every other root is checked first (an album moved to
        another drive); then reachable roots are walked within the search time.
        """
        wanted = album_dir.name.casefold()

        def matches(folder: Path) -> bool:
            try:
                names = {
                    entry.name.casefold()
                    for _dirpath, _dirnames, filenames in os.walk(folder)
                    for entry in map(Path, filenames)
                }
            except OSError:
                return False
            return len(names & file_names) * 2 >= len(file_names)

        readable = {root_id: path for root_id, path in self._roots.items() if folder_is_readable(path)}
        for source_root in self._roots.values():
            try:
                relative = album_dir.relative_to(source_root)
            except ValueError:
                continue
            for root_id, root_path in readable.items():
                candidate = root_path / relative
                if candidate != album_dir and candidate.is_dir() and matches(candidate):
                    return root_id, candidate
        deadline = monotonic() + self._search_seconds
        for root_id, root_path in readable.items():
            for dirpath, dirnames, _filenames in os.walk(root_path):
                if monotonic() > deadline:
                    return None
                dirnames[:] = [name for name in dirnames if not name.startswith(".")]
                for name in dirnames:
                    candidate = Path(dirpath) / name
                    if name.casefold() == wanted and candidate != album_dir and matches(candidate):
                        return root_id, candidate
        return None

    def _repoint_tracks(self, album_dir: Path, destination: Path, destination_root_id: str, paths: list[Path]) -> None:
        """Give each moved file's track and file rows its new path before the folder is re-read."""
        root = self._roots[destination_root_id]
        moves = [
            (str(path), str(target), str(target.relative_to(root)))
            for path in paths
            if (target := destination / path.relative_to(album_dir)).is_file()
        ]
        if not moves:
            return
        old, new, relative = (list(column) for column in zip(*moves))
        with self._connect(self._database_url) as connection:
            connection.execute(inventory_publication_advisory_lock_sql())
            connection.execute(_REPOINT_SQL, {
                "old": old, "new": new, "relative": relative, "root_id": destination_root_id,
            })

    def _album_files(self, album_key: str) -> list[dict[str, object]]:
        with self._connect(self._database_url) as connection:
            return [_row_mapping(row) for row in connection.execute(_ALBUM_FILES_SQL, {"album_key": album_key}).fetchall()]

    def _record_reason(self, album_key: str, reason: str) -> None:
        with self._connect(self._database_url) as connection:
            connection.execute(_RECORD_REASON_SQL, {"album_key": album_key, "reason": reason})


_ALBUM_FILES_SQL = """
    select files.private_path,
           coalesce(nullif(roots.metadata ->> 'root_id', ''), files.metadata ->> 'library_root_id') as root_id
    from library.local_albums albums
    join library.local_tracks tracks on tracks.album_id = albums.id
    join library.local_track_files files on files.track_id = tracks.id
    join library.library_roots roots on roots.id = files.library_root_id
    join app.bootstrap_owners owners on owners.owner_key = 'local-bootstrap-owner'
    join library.libraries libraries
      on libraries.id = albums.library_id and libraries.owner_account_id = owners.account_id
     and libraries.name = 'Local Library' and libraries.library_kind = 'local'
    where albums.album_key = %(album_key)s
    order by files.private_path
"""

# A destination already published as its own track (a scan found the copy first) is left alone.
_REPOINT_SQL = """
    with moved as (
      select old_path, new_path, relative_path
      from unnest(%(old)s::text[], %(new)s::text[], %(relative)s::text[]) as m(old_path, new_path, relative_path)
      where not exists (select 1 from library.local_track_files existing where existing.private_path = m.new_path)
    ),
    destination as (
      select roots.id from library.library_roots roots where roots.metadata ->> 'root_id' = %(root_id)s limit 1
    ),
    tracks as (
      update library.local_tracks
         set track_key = moved.new_path
        from moved
       where library.local_tracks.track_key = moved.old_path
         and not exists (
           select 1 from library.local_tracks existing
           where existing.library_id = library.local_tracks.library_id and existing.track_key = moved.new_path)
      returning library.local_tracks.id
    )
    update library.local_track_files
       set private_path = moved.new_path,
           relative_path = moved.relative_path,
           library_root_id = coalesce((select id from destination), library.local_track_files.library_root_id)
      from moved
     where library.local_track_files.private_path = moved.old_path
"""

# Only rows whose reason changed are rewritten.
_RECORD_REASON_SQL = """
    update library.local_track_files files
       set metadata = jsonb_set(files.metadata, '{scan_cache}',
             coalesce(files.metadata -> 'scan_cache', '{}'::jsonb)
               || jsonb_build_object('missing_reason', %(reason)s::text, 'missing_checked_at', now()::text))
    from library.local_tracks tracks
    join library.local_albums albums on albums.id = tracks.album_id
    where files.track_id = tracks.id and albums.album_key = %(album_key)s
      and files.scan_cache_stale
      and files.metadata #>> '{scan_cache,missing_reason}' is distinct from %(reason)s::text
"""
