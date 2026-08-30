from __future__ import annotations

"""Phase 3 owner for shared edit-state mutation helpers.

Route and workflow seams can call into this module for cache-entry repair,
affected-album rebuilds, and related edit-side state refreshes.
"""

import logging
from pathlib import Path

from music_app.services.cache import schedule_cache_updates_save_for_config
from music_app.services.exception_overrides import apply_exception_override, load_exception_overrides
from music_app.services.library import album_separate_release_key, album_to_dict, build_albums_from_file_cache
from music_app.services.metadata import apply_text_repairs_to_file, normalize_exception_value, read_metadata_for_file
from music_app.services.non_album_view_payloads import is_loose_track_album_value
from music_app.services.relations import build_relation_views
from music_app.services.separate_releases import load_separate_release_keys
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


def _merge_rebuilt_albums(existing_albums: list, rebuilt_albums: list, affected_album_keys: set[str]) -> list:
    merged = [
        album
        for album in existing_albums
        if str(getattr(album, "key", "") or "") not in affected_album_keys
    ]
    merged.extend(rebuilt_albums)
    merged.sort(
        key=lambda album: (
            str(getattr(album, "album_artist", "") or "").lower(),
            int(getattr(album, "year", None) or 9999),
            str(getattr(album, "name", "") or "").lower(),
        )
    )
    return merged


def rebuild_affected_albums_in_state(
    st: dict[str, object],
    previous_file_cache: dict[str, dict[str, object]],
    updated_file_cache: dict[str, dict[str, object]],
    changed_paths: set[str],
    separate_release_keys: set[str],
) -> None:
    affected_album_keys: set[str] = set()
    for raw_path in changed_paths:
        previous_entry = previous_file_cache.get(raw_path)
        if isinstance(previous_entry, dict):
            affected_album_keys.update(_cache_entry_album_keys(previous_entry, separate_release_keys))
        updated_entry = updated_file_cache.get(raw_path)
        if isinstance(updated_entry, dict):
            affected_album_keys.update(_cache_entry_album_keys(updated_entry, separate_release_keys))

    if not affected_album_keys:
        st["albums"] = _merge_rebuilt_albums(list(st.get("albums", []) or []), [], set())
        return

    affected_entries = {
        path_str: entry
        for path_str, entry in updated_file_cache.items()
        if _cache_entry_album_key(entry, separate_release_keys) in affected_album_keys
    }
    rebuilt_albums = build_albums_from_file_cache(affected_entries, separate_release_keys)
    st["albums"] = _merge_rebuilt_albums(list(st.get("albums", []) or []), rebuilt_albums, affected_album_keys)


def build_affected_album_dicts(
    previous_file_cache: dict[str, dict[str, object]],
    updated_file_cache: dict[str, dict[str, object]],
    track_paths: set[str],
    changed_paths: set[str],
    separate_release_keys: set[str],
) -> list[dict[str, object]]:
    affected_album_keys: set[str] = set()
    for raw_path in changed_paths or track_paths:
        previous_entry = previous_file_cache.get(raw_path)
        if isinstance(previous_entry, dict):
            affected_album_keys.update(_cache_entry_album_keys(previous_entry, separate_release_keys))
        updated_entry = updated_file_cache.get(raw_path)
        if isinstance(updated_entry, dict):
            affected_album_keys.update(_cache_entry_album_keys(updated_entry, separate_release_keys))
    affected_entries = {
        path_str: entry
        for path_str, entry in updated_file_cache.items()
        if _cache_entry_album_key(entry, separate_release_keys) in affected_album_keys
    }
    rebuilt_albums = build_albums_from_file_cache(affected_entries, separate_release_keys)
    return find_album_dicts_by_track_paths(rebuilt_albums, track_paths)


def apply_repairs_worker(raw_path: str, repairs: dict[str, str]) -> tuple[str, bool, list[str]]:
    changed, changed_fields = apply_text_repairs_to_file(Path(raw_path), repairs)
    return raw_path, changed, changed_fields


def refresh_changed_files_in_cache(
    st: dict[str, object],
    file_cache: dict[str, dict[str, object]],
    changed_paths: set[str],
    *,
    config: dict[str, object],
    logger: object | None = None,
) -> bool:
    if not changed_paths:
        return False

    log_target = logger if logger is not None else globals()["logger"]
    updated_file_cache = dict(file_cache)
    exception_overrides = load_exception_overrides(config)
    cache_changed = False
    for raw_path in changed_paths:
        previous_entry = file_cache.get(raw_path) if isinstance(file_cache.get(raw_path), dict) else {}
        try:
            refreshed_entry = read_metadata_for_file(Path(raw_path))
            previous_cover_value = str(previous_entry.get("cover_path") or "").strip() if isinstance(previous_entry, dict) else ""
            previous_cover_path = Path(previous_cover_value) if previous_cover_value else None
            if (
                isinstance(previous_entry, dict)
                and previous_cover_path is not None
                and previous_cover_path.exists()
                and not refreshed_entry.get("cover_path")
            ):
                refreshed_entry["cover_path"] = previous_cover_value
            apply_exception_override(refreshed_entry, exception_overrides)
            updated_file_cache[raw_path] = refreshed_entry
            cache_changed = True
        except Exception as exc:
            log_target.warning("Could not refresh metadata cache entry for %s: %s", raw_path, exc)

    if not cache_changed:
        return False

    st["file_cache"] = updated_file_cache
    separate_release_keys = set(st.get("separate_release_keys") or load_separate_release_keys(config))
    rebuild_affected_albums_in_state(st, file_cache, updated_file_cache, changed_paths, separate_release_keys)
    try:
        schedule_cache_updates_save_for_config(
            config,
            config["CACHE_PATH"],
            {
                path_str: updated_file_cache[path_str]
                for path_str in changed_paths
                if isinstance(updated_file_cache.get(path_str), dict)
            },
        )
    except Exception as exc:
        log_target.warning("Could not schedule repaired metadata cache update: %s", exc)
    return True


def rebuild_relation_views(albums: list[object], config: dict[str, object]) -> dict[str, object]:
    return build_relation_views(albums, config)
