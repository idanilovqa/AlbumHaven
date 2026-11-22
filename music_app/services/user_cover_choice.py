"""A user's click on an image file wins over an automatic write that lands while the save waits, and over nothing else.

The save reads the image before it waits for any lock. Under its folder locks and the publication lock it compares
the file again. Changed bytes are replaced by the clicked ones only when an album recorded exactly those bytes as an
automatic write committed after the read. An edit outside the app or another user's save keeps the newer bytes: the
waiting save writes nothing and fails readably.
"""
from __future__ import annotations

import hashlib
import os
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from music_app.services.album_local_membership import physical_album_folder_sql
from music_app.services.library_album_index import library_album_index

_WRITE_BACKS_STATE_KEY = "_cover_write_backs"
IMAGE_CHANGED_MESSAGE = "That image changed, choose again."


class ChosenImageChanged(RuntimeError):
    def __init__(self) -> None:
        super().__init__(IMAGE_CHANGED_MESSAGE)


@dataclass(frozen=True)
class ChosenImage:
    path: Path
    raw_bytes: bytes
    revision: str
    file_state: tuple[int, int, int]
    automatic_writes_before: frozenset[tuple[int, str]]
    width: int | None = None
    height: int | None = None


@dataclass(frozen=True)
class WriteBack:
    """An automatic write the save replaces with the clicked bytes, and the albums that recorded it."""

    chosen: ChosenImage
    replaced_bytes: bytes
    album_ids: tuple[int, ...]
    track_paths: tuple[str, ...]


def read_chosen_image(connect: Callable[[], Any], path: Path) -> ChosenImage:
    """Before any lock: the clicked bytes, then the automatic writes already recorded for that file.

    In this order a write that commits between the two reads is not new under the lock, so the save fails readably.
    """
    with path.open("rb") as image:
        file_state = _file_state(os.fstat(image.fileno()))
        raw_bytes = image.read()
    with connect() as connection:
        before = frozenset(
            (album_id, revision) for album_id, revision, _paths in _automatic_writes(connection, path)
        )
    return ChosenImage(path, raw_bytes, hashlib.sha256(raw_bytes).hexdigest(), file_state, before)


def measure_if_replaced(chosen: ChosenImage, decode_dimensions) -> ChosenImage:
    """Under the folder locks, before the publication lock, where no automatic write can land any more.

    Only a replaced image needs the clicked bytes' size, for the write-back's records.
    """
    try:
        if _file_state(chosen.path.stat()) == chosen.file_state:
            return chosen
    except OSError:
        return chosen  # settle_chosen_image refuses it
    width, height = decode_dimensions(chosen.raw_bytes)
    return replace(chosen, width=width, height=height)


def settle_chosen_image(connection: Any, chosen: ChosenImage) -> WriteBack | None:
    """Under the folder locks and the publication lock, before the save writes a row: None when nothing changed."""
    try:
        if _file_state(chosen.path.stat()) == chosen.file_state:
            return None  # the usual save: untouched since the read, so it isn't opened again
        current = chosen.path.read_bytes()  # the clicked file only; no other file is read or decoded here
    except OSError as error:
        raise ChosenImageChanged() from error
    if current == chosen.raw_bytes:
        return None
    revision = hashlib.sha256(current).hexdigest()
    writes = [write for write in _automatic_writes(connection, chosen.path) if write[1] == revision]
    if not any((album_id, revision) not in chosen.automatic_writes_before for album_id, _revision, _paths in writes):
        raise ChosenImageChanged()
    album_ids = tuple(album_id for album_id, _revision, _paths in writes)
    rows = connection.execute(_RECORD_WRITE_BACK_SQL, {
        "album_ids": list(album_ids), "revision": chosen.revision, "width": chosen.width, "height": chosen.height,
    }).fetchall()
    return WriteBack(chosen, current, album_ids, tuple(str(row["private_path"]) for row in rows))


def _file_state(stat: os.stat_result) -> tuple[int, int, int]:
    """Every write changes it: a replace gives a new file id, a write in place a new time or size."""
    return (stat.st_ino, stat.st_size, stat.st_mtime_ns)


def apply_write_back(library_state: dict[str, object], write_back: WriteBack) -> None:
    """After the commit, under the runtime cache lock: only the corrected albums change, and nothing reads a file."""
    entries = library_state.get("file_cache")
    if not isinstance(entries, dict):
        return
    previous = {path: entry for path in write_back.track_paths if isinstance(entry := entries.get(path), dict)}
    if not previous:
        return
    chosen = write_back.chosen
    # As the commit recorded it: the automatic job's own publication may not have run yet.
    fields = {
        "cover_path": str(chosen.path), "cover_revision": chosen.revision, "cover_selection_origin": "automatic",
    }
    if chosen.width and chosen.height:
        fields.update(local_cover_width=chosen.width, local_cover_height=chosen.height)
    # Only these entries change and no key is added, so the library's cache is patched in place, never copied.
    sequence, written_back = library_state.get(_WRITE_BACKS_STATE_KEY) or (0, {})
    for path, entry in previous.items():
        entries[path] = {**entry, **fields}
        written_back[path] = sequence + 1
    library_state[_WRITE_BACKS_STATE_KEY] = (sequence + 1, written_back)
    for album in library_album_index(library_state).albums_with_any_track(previous):
        tracks = [track for track in getattr(album, "tracks", None) or () if str(getattr(track, "path", "")) in previous]
        for item in (album, *tracks):
            for field, value in fields.items():
                if hasattr(item, field):
                    setattr(item, field, value)


def write_back_sequence(library_state: dict[str, object]) -> int:
    """A cover run reads this when it starts, for `written_back_since` when it publishes."""
    return (library_state.get(_WRITE_BACKS_STATE_KEY) or (0, {}))[0]


def written_back_since(library_state: dict[str, object], path: str, sequence: int) -> bool:
    return (library_state.get(_WRITE_BACKS_STATE_KEY) or (0, {}))[1].get(path, 0) > sequence


def commit_with_write_back(
    write_back: WriteBack | None,
    commit: Callable[[], object],
    *,
    replace_bytes: Callable[[Path, bytes], None],
) -> object:
    """The file write, then the commit; a failure of either puts the automatic write's bytes back."""
    if write_back is None:
        return commit()
    path = write_back.chosen.path
    try:
        if path.read_bytes() != write_back.replaced_bytes:
            raise ChosenImageChanged()
        replace_bytes(path, write_back.chosen.raw_bytes)
        return commit()
    except Exception:
        if path.is_file() and path.read_bytes() == write_back.chosen.raw_bytes:
            replace_bytes(path, write_back.replaced_bytes)
        raise


def _automatic_writes(connection: Any, path: Path) -> list[tuple[int, str, list[str]]]:
    rows = connection.execute(_AUTOMATIC_WRITES_SQL, {"cover_path": str(path)}).fetchall()
    return [(int(row["album_id"]), str(row["revision"]), list(row["track_paths"])) for row in rows]


# An automatic job only writes cover.jpg beside its own album's files, so one 0088 range per root finds its album.
_AUTOMATIC_WRITES_SQL = f"""
select albums.id as album_id, albums.metadata ->> 'cover_revision' as revision,
       array_agg(distinct folder_files.private_path) as track_paths
from library.library_roots roots
join lateral (
  select files.private_path, files.track_id
  from library.local_track_files files
  where files.library_root_id = roots.id
    and files.scan_cache_stale is false
    and {physical_album_folder_sql("files.private_path")} = {physical_album_folder_sql("%(cover_path)s::text")}
  offset 0
) folder_files on true
join library.local_tracks tracks on tracks.id = folder_files.track_id
join library.local_albums albums on albums.id = tracks.album_id
where roots.is_active
  and albums.metadata ->> 'cover_selection_origin' = 'automatic'
  and albums.metadata ->> 'cover_revision' is not null
  and library.local_path_key(albums.cover_path) = library.local_path_key(%(cover_path)s::text)
group by albums.id
"""

_RECORD_WRITE_BACK_SQL = """
with correction as (
  select jsonb_strip_nulls(jsonb_build_object(
    'cover_revision', %(revision)s::text,
    'local_cover_width', %(width)s::integer,
    'local_cover_height', %(height)s::integer
  )) as fields
),
corrected_albums as (
  update library.local_albums albums
  set metadata = coalesce(albums.metadata, '{}'::jsonb) || correction.fields
  from correction
  where albums.id = any(%(album_ids)s::bigint[])
  returning albums.id
)
update library.local_track_files files
set metadata = jsonb_set(
  files.metadata, '{scan_cache,file_entry}',
  coalesce(files.metadata #> '{scan_cache,file_entry}', '{}'::jsonb) || correction.fields
)
from correction, library.local_tracks tracks
where tracks.id = files.track_id
  and tracks.album_id in (select id from corrected_albums)
returning files.private_path
"""
