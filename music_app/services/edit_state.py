from __future__ import annotations

"""Phase 3 owner for shared edit-state mutation helpers.

Route and workflow seams can call into this module for cache-entry repair,
affected-album rebuilds, and related edit-side state refreshes.
"""

from collections.abc import Mapping
import logging
from pathlib import Path

from music_app.services.library import (
    album_separate_release_key,
    album_sort_key,
    album_to_dict,
    build_albums_from_file_cache,
)
from music_app.services.library_album_index import LibraryAlbumIndex, library_album_index, replace_library_albums
from music_app.services.metadata import apply_text_repairs_to_file, normalize_exception_value
from music_app.services.non_album_view_payloads import is_loose_track_album_value
from music_app.services.relations import build_relation_views
from music_app.services.utils import repair_display_text

logger = logging.getLogger(__name__)


def find_album_dicts_by_track_paths(albums: list, track_paths: set[str]) -> list[dict[str, object]]:
    if not track_paths:
        return []
    matches: list[dict[str, object]] = []
    for album in albums:
        album_paths = {
            str(getattr(track, "path", "") or "")
            for track in getattr(album, "tracks", [])
            if str(getattr(track, "path", "") or "")
        }
        if album_paths & track_paths:
            matches.append(album_to_dict(album))
    return matches


def update_cache_entry_after_repairs(
    path: Path,
    entry: dict[str, object],
    repairs: dict[str, str],
    *,
    logger: object | None = None,
) -> dict[str, object]:
    updated_entry = dict(entry)
    for field, value in repairs.items():
        updated_entry[field] = normalize_exception_value(value) if field == "exception_type" else value
        if field == "year":
            updated_entry["release_date"] = value
    try:
        stat = path.stat()
        updated_entry["mtime"] = stat.st_mtime
        updated_entry["size"] = stat.st_size
    except Exception as exc:
        log_target = logger if logger is not None else globals()["logger"]
        log_target.warning("Could not stat repaired file %s: %s", path, exc)
    return updated_entry


def _cache_entry_album_key(entry: dict[str, object], separate_release_keys: set[str]) -> str | None:
    if not isinstance(entry, dict):
        return None
    exception_type = normalize_exception_value(entry.get("exception_type"))
    album_name = repair_display_text(str(entry.get("album") or "")) or str(entry.get("album") or "")
    if exception_type or is_loose_track_album_value(album_name):
        return None
    album_artist = repair_display_text(str(entry.get("album_artist") or "")) or str(entry.get("album_artist") or "")
    raw_edition = str(entry.get("edition") or "").strip()
    edition = (repair_display_text(raw_edition) or raw_edition) if raw_edition else None
    base_key = album_separate_release_key(album_artist, album_name, edition)
    if base_key not in separate_release_keys:
        return base_key
    key_parts = [album_artist.strip().lower(), album_name.strip().lower()]
    if edition:
        key_parts.append(edition.strip().lower())
    year_value = str(entry.get("year") or "").strip().lower()
    if year_value:
        key_parts.extend(["year", year_value])
    return "::".join(key_parts)


def _cache_entry_album_keys(entry: dict[str, object], separate_release_keys: set[str]) -> set[str]:
    if not isinstance(entry, dict):
        return set()
    exception_type = normalize_exception_value(entry.get("exception_type"))
    album_name = repair_display_text(str(entry.get("album") or "")) or str(entry.get("album") or "")
    if exception_type or is_loose_track_album_value(album_name):
        return set()
    album_artist = repair_display_text(str(entry.get("album_artist") or "")) or str(entry.get("album_artist") or "")
    raw_edition = str(entry.get("edition") or "").strip()
    edition = (repair_display_text(raw_edition) or raw_edition) if raw_edition else None
    base_key = album_separate_release_key(album_artist, album_name, edition)
    keys = {base_key} if base_key else set()
    resolved_key = _cache_entry_album_key(entry, separate_release_keys)
    if resolved_key:
        keys.add(resolved_key)
    return keys


def _affected_album_keys(
    previous_file_cache: Mapping[str, dict[str, object]],
    updated_file_cache: Mapping[str, dict[str, object]],
    paths: set[str],
    separate_release_keys: set[str],
) -> set[str]:
    affected_album_keys: set[str] = set()
    for raw_path in paths:
        for file_cache in (previous_file_cache, updated_file_cache):
            entry = file_cache.get(raw_path)
            if isinstance(entry, dict):
                affected_album_keys.update(_cache_entry_album_keys(entry, separate_release_keys))
    return affected_album_keys


def _album_track_paths(albums: list[object]) -> set[str]:
    return {
        path
        for album in albums
        for track in getattr(album, "tracks", ()) or ()
        if (path := str(getattr(track, "path", "") or ""))
    }


def affected_album_track_paths(
    library_state: Mapping[str, object],
    previous_file_cache: Mapping[str, dict[str, object]],
    updated_file_cache: Mapping[str, dict[str, object]],
    changed_paths: set[str],
    separate_release_keys: set[str],
) -> set[str]:
    """The changed paths and every track of the published albums they left or
    joined, read by track path and release key, never by scanning."""
    index = library_album_index(library_state)
    affected_album_keys = _affected_album_keys(previous_file_cache, updated_file_cache, changed_paths, separate_release_keys)
    return set(changed_paths) | _album_track_paths([
        *index.albums_with_any_track(changed_paths), *index.albums_of_releases(affected_album_keys),
    ])


def _affected_album_entries(
    index: LibraryAlbumIndex,
    updated_file_cache: Mapping[str, dict[str, object]],
    paths: set[str],
    affected_album_keys: set[str],
    separate_release_keys: set[str],
) -> dict[str, dict[str, object]]:
    """The entries of every affected album: the given paths plus the tracks the
    published albums of those releases hold, read by key, never by scanning."""
    candidate_paths = set(paths) | _album_track_paths(index.albums_of_releases(affected_album_keys))
    return {
        path: entry
        for path in sorted(candidate_paths)
        if isinstance(entry := updated_file_cache.get(path), dict)
        and _cache_entry_album_keys(entry, separate_release_keys) & affected_album_keys
    }


def rebuild_affected_albums_in_state(
    st: dict[str, object],
    previous_file_cache: Mapping[str, dict[str, object]],
    updated_file_cache: Mapping[str, dict[str, object]],
    changed_paths: set[str],
    separate_release_keys: set[str],
) -> None:
    """Rebuild the albums the changed paths belonged to or now belong to and
    republish them in place of their previous versions."""
    affected_album_keys = _affected_album_keys(previous_file_cache, updated_file_cache, changed_paths, separate_release_keys)
    if not affected_album_keys:
        return
    index = library_album_index(st)
    rebuilt_albums = build_albums_from_file_cache(
        _affected_album_entries(index, updated_file_cache, changed_paths, affected_album_keys, separate_release_keys),
        separate_release_keys,
    )
    replace_library_albums(
        st, index.albums_of_releases(affected_album_keys), rebuilt_albums, sort_key=album_sort_key,
    )


def build_affected_album_dicts(
    previous_file_cache: Mapping[str, dict[str, object]],
    updated_file_cache: Mapping[str, dict[str, object]],
    track_paths: set[str],
    changed_paths: set[str],
    separate_release_keys: set[str],
    *,
    library_state: Mapping[str, object],
) -> list[dict[str, object]]:
    paths = changed_paths or track_paths
    affected_album_keys = _affected_album_keys(previous_file_cache, updated_file_cache, paths, separate_release_keys)
    rebuilt_albums = build_albums_from_file_cache(
        _affected_album_entries(
            library_album_index(library_state), updated_file_cache, paths, affected_album_keys, separate_release_keys,
        ),
        separate_release_keys,
    )
    return find_album_dicts_by_track_paths(rebuilt_albums, track_paths)


def apply_repairs_worker(raw_path: str, repairs: dict[str, str]) -> tuple[str, bool, list[str]]:
    changed, changed_fields = apply_text_repairs_to_file(Path(raw_path), repairs)
    return raw_path, changed, changed_fields


def rebuild_relation_views(albums: list[object], config: dict[str, object]) -> dict[str, object]:
    return build_relation_views(albums, config)
