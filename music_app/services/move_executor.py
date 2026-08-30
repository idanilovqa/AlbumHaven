from __future__ import annotations

from collections.abc import Callable
import logging
from pathlib import Path
import shutil

from music_app.services.app_logging import log_app_event
from music_app.services.cache import save_cache_to_disk_for_config
from music_app.services.covers import image_dimensions
from music_app.services.exception_overrides import apply_exception_override, load_exception_overrides
from music_app.services.library_hydration import find_cover_for_track_folder
from music_app.services.library_roots import (
    get_library_roots,
    library_category_slug,
    library_root_cache_identity,
    root_definition_for_path,
)
from music_app.services.metadata import read_metadata_for_file
from music_app.services.move_planner import build_move_availability_payload
from music_app.services.move_tasks import build_move_follow_up, build_move_response
from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
from music_app.services.separate_releases import load_separate_release_keys
from music_app.services.utility_rules import invalidate_utility_rules_payload_cache


JsonDict = dict[str, object]
StateDict = dict[str, object]
StateProvider = Callable[[], StateDict]
ProblematicAlbumMatcher = Callable[[set[str]], JsonDict | None]
AlbumFinder = Callable[[set[str]], list[JsonDict]]
AlbumStateRebuilder = Callable[[StateDict, dict[str, JsonDict], dict[str, JsonDict], set[str], set[str]], None]
MoveFollowUpBuilder = Callable[..., JsonDict]

_REMOTE_COVER_KEYS = (
    "remote_cover_url",
    "remote_cover_thumbnail_url",
    "remote_cover_source",
    "remote_cover_source_label",
    "remote_cover_album_url",
    "remote_cover_width",
    "remote_cover_height",
)


class AlbumMoveError(RuntimeError):
    def __init__(self, message: str, *, status_code: int = 400):
        super().__init__(message)
        self.status_code = int(status_code)


def execute_album_move(
    *,
    action: str,
    album_key: str | None = None,
    requested_track_paths: set[str] | None = None,
    config: dict[str, object],
    logger: logging.Logger,
    get_state: StateProvider,
    rebuild_affected_albums_in_state: AlbumStateRebuilder,
    find_albums_by_track_paths: AlbumFinder,
    find_problematic_album_by_track_paths: ProblematicAlbumMatcher,
    build_follow_up: MoveFollowUpBuilder = build_move_follow_up,
) -> JsonDict:
    st = get_state()
    live_album = _find_state_album(st, album_key=album_key, requested_track_paths=requested_track_paths)
    if live_album is None:
        raise AlbumMoveError("Album is no longer available for moving", status_code=404)

    availability = build_move_availability_payload(live_album, config)
    action_payload = availability.get("actions", {}).get(action)
    if not isinstance(action_payload, dict):
        raise AlbumMoveError(f"Unsupported move action: {action}")
    if not bool(action_payload.get("available")):
        blocked_reasons = [
            str(reason or "").strip()
            for reason in list(action_payload.get("blocked_reasons") or availability.get("blocked_reasons") or [])
            if str(reason or "").strip()
        ]
        raise AlbumMoveError(blocked_reasons[0] if blocked_reasons else "Move is not currently available", status_code=409)

    source_folder_value = str(availability.get("source_folder") or "").strip()
    destination_folder_value = str(action_payload.get("destination_path") or "").strip()
    if not source_folder_value or not destination_folder_value:
        raise AlbumMoveError("Move planning did not produce one concrete source and destination", status_code=409)

    source_folder = Path(source_folder_value).resolve(strict=False)
    destination_folder = Path(destination_folder_value).resolve(strict=False)
    old_track_paths = _album_track_paths(live_album)
    track_path_map = _build_track_path_map(old_track_paths, source_folder, destination_folder)

    _validate_move_request(
        config=config,
        source_folder=source_folder,
        destination_folder=destination_folder,
        destination_category=str(action_payload.get("target_category") or "").strip(),
    )

    previous_file_cache = dict(st.get("file_cache", {}) or {})
    previous_album_keys = {
        str(getattr(album, "key", "") or "")
        for album in list(st.get("albums", []) or [])
        if str(getattr(album, "key", "") or "")
    }

    try:
        destination_folder.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source_folder), str(destination_folder))
    except Exception as exc:
        raise AlbumMoveError(f"Failed to move album folder: {exc}", status_code=500) from exc

    try:
        updated_file_cache, new_track_paths = _refresh_cache_after_move(
            config=config,
            previous_file_cache=previous_file_cache,
            track_path_map=track_path_map,
        )
    except Exception as exc:
        raise AlbumMoveError(
            f"Album folder moved but cache refresh failed: {exc}",
            status_code=500,
        ) from exc

    st["file_cache"] = updated_file_cache
    separate_release_keys = set(st.get("separate_release_keys") or load_separate_release_keys(config))
    st["separate_release_keys"] = separate_release_keys
    changed_paths = set(track_path_map.keys()) | set(new_track_paths)
    rebuild_affected_albums_in_state(
        st,
        previous_file_cache,
        updated_file_cache,
        changed_paths,
        separate_release_keys,
    )
    invalidate_problematic_albums_payload_cache(st)
    invalidate_utility_rules_payload_cache(st)
    committed_relation_state = save_cache_to_disk_for_config(
        config,
        config["CACHE_PATH"],
        updated_file_cache,
        library_root_cache_identity(config),
        float(st.get("last_scan") or 0.0),
        rebuild_relation_projection=True,
    )
    if not isinstance(committed_relation_state, dict) or not isinstance(
        committed_relation_state.get("relation_views"),
        dict,
    ):
        raise AlbumMoveError(
            "Album move persistence returned no canonical relation projection state.",
            status_code=500,
        )
    st["relation_views"] = dict(committed_relation_state["relation_views"])
    st["relations_last_built"] = float(
        committed_relation_state.get("relations_last_built") or 0.0
    )

    follow_up = build_follow_up(
        new_track_paths,
        find_albums_by_track_paths=find_albums_by_track_paths,
        find_problematic_album_by_track_paths=find_problematic_album_by_track_paths,
    )
    log_app_event(
        config,
        logger,
        "Album moved",
        level="info",
        move_action=action,
        source_folder=str(source_folder),
        destination_folder=str(destination_folder),
        moved_track_count=len(new_track_paths),
        previous_album_count=len(previous_album_keys),
        updated_album_count=len(list(follow_up.get("updated_albums") or [])),
    )
    return build_move_response(
        action=action,
        source_folder=str(source_folder),
        destination_folder=str(destination_folder),
        moved_track_paths=new_track_paths,
        follow_up=follow_up,
    )


def _validate_move_request(
    *,
    config: dict[str, object],
    source_folder: Path,
    destination_folder: Path,
    destination_category: str,
) -> None:
    if not source_folder.exists() or not source_folder.is_dir():
        raise AlbumMoveError("Album source folder is no longer available", status_code=409)
    matched_source_root = root_definition_for_path(get_library_roots(config), source_folder)
    if not isinstance(matched_source_root, dict) or library_category_slug(matched_source_root.get("category")) != "new_arrivals":
        raise AlbumMoveError("Album source folder is outside the configured New Arrivals roots", status_code=409)
    if source_folder == destination_folder:
        raise AlbumMoveError("Album is already in that destination", status_code=409)
    if destination_folder.exists():
        raise AlbumMoveError("Destination folder already exists", status_code=409)

    matched_root = root_definition_for_path(get_library_roots(config), destination_folder)
    if not isinstance(matched_root, dict):
        raise AlbumMoveError("Destination folder is outside the configured library roots", status_code=409)
    matched_category = library_category_slug(matched_root.get("category"))
    if matched_category != destination_category:
        raise AlbumMoveError("Move planner destination no longer matches the configured library roots", status_code=409)


def _find_state_album(
    st: StateDict,
    *,
    album_key: str | None,
    requested_track_paths: set[str] | None,
):
    normalized_key = str(album_key or "").strip()
    if normalized_key:
        matching_albums = [
            album
            for album in list(st.get("albums", []) or [])
            if str(getattr(album, "key", "") or "") == normalized_key
        ]
        if len(matching_albums) == 1:
            return matching_albums[0]
        if len(matching_albums) > 1:
            raise AlbumMoveError(
                "Album no longer resolves to one concrete source folder",
                status_code=409,
            )
        return None
    return _find_state_album_for_track_paths(st, requested_track_paths or set())


def _find_state_album_for_track_paths(st: StateDict, requested_track_paths: set[str]):
    exact_match = None
    partial_match = None
    for album in list(st.get("albums", []) or []):
        album_track_paths = _album_track_paths(album)
        if not album_track_paths:
            continue
        if album_track_paths == requested_track_paths:
            exact_match = album
            break
        if requested_track_paths and requested_track_paths <= album_track_paths:
            partial_match = album
    return exact_match or partial_match


def _album_track_paths(album) -> set[str]:
    return {
        str(getattr(track, "path", "") or "")
        for track in getattr(album, "tracks", []) or []
        if str(getattr(track, "path", "") or "")
    }


def _build_track_path_map(
    old_track_paths: set[str],
    source_folder: Path,
    destination_folder: Path,
) -> dict[str, str]:
    path_map: dict[str, str] = {}
    for raw_path in old_track_paths:
        old_path = Path(raw_path).resolve(strict=False)
        try:
            relative_path = old_path.relative_to(source_folder)
        except Exception as exc:
            raise AlbumMoveError(
                f"Track path no longer matches the planned source folder: {raw_path}",
                status_code=409,
            ) from exc
        path_map[str(old_path)] = str((destination_folder / relative_path).resolve(strict=False))
    return path_map


def _refresh_cache_after_move(
    *,
    config: dict[str, object],
    previous_file_cache: dict[str, JsonDict],
    track_path_map: dict[str, str],
) -> tuple[dict[str, JsonDict], set[str]]:
    updated_file_cache = dict(previous_file_cache)
    roots = get_library_roots(config)
    exception_overrides = load_exception_overrides(config)
    image_extensions = set(config["IMAGE_EXTENSIONS"])
    new_track_paths: set[str] = set()

    for old_path, new_path in track_path_map.items():
        previous_entry = previous_file_cache.get(old_path)
        updated_file_cache.pop(old_path, None)

        new_track = Path(new_path)
        if not new_track.exists():
            raise AlbumMoveError(f"Moved track is missing from the destination: {new_path}", status_code=500)

        refreshed_entry = read_metadata_for_file(new_track)
        if isinstance(previous_entry, dict):
            for key in _REMOTE_COVER_KEYS:
                if refreshed_entry.get(key) in (None, ""):
                    refreshed_entry[key] = previous_entry.get(key)

        matched_root = root_definition_for_path(roots, new_track)
        if isinstance(matched_root, dict):
            refreshed_entry["library_root_id"] = str(matched_root.get("id") or "").strip() or None
            refreshed_entry["library_root_category"] = library_category_slug(matched_root.get("category"))

        apply_exception_override(refreshed_entry, exception_overrides)
        cover_path = find_cover_for_track_folder(new_track.parent, image_extensions)
        refreshed_entry["cover_path"] = str(cover_path) if cover_path else None
        if cover_path is not None and cover_path.exists():
            width, height = image_dimensions(cover_path)
            refreshed_entry["local_cover_width"] = int(width or 0) or None
            refreshed_entry["local_cover_height"] = int(height or 0) or None
        else:
            refreshed_entry["local_cover_width"] = None
            refreshed_entry["local_cover_height"] = None

        updated_file_cache[str(new_track)] = refreshed_entry
        new_track_paths.add(str(new_track))

    return updated_file_cache, new_track_paths
