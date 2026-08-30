from __future__ import annotations

from pathlib import Path
from typing import Callable

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.services.cache import (
    save_cache_to_disk_for_config,
    schedule_cache_updates_save_for_config,
)
from music_app.services.covers import find_cover_image, image_dimensions
from music_app.services.exception_overrides import apply_exception_override
from music_app.services.library import build_albums_from_file_cache
from music_app.services.metadata import file_metadata_schema_is_current
from music_app.services.library_roots import (
    get_library_roots,
    library_category_slug,
    library_root_cache_identity,
    root_definition_for_path,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.relation_state import empty_relation_views
from music_app.services.scan_cache_persistence import select_scan_cache_adapter
from music_app.services.separate_releases import load_separate_release_keys


_DISC_FOLDER_NAMES = {"cd1", "cd 1", "cd2", "cd 2", "disc1", "disc 1", "disc2", "disc 2"}
_HYDRATION_FILE_ERROR_PATH_LIMIT = 1024
_HYDRATION_FILE_ERROR_MESSAGE_LIMIT = 1000


def _record_hydration_file_error(
    record_file_error: Callable[..., None] | None,
    action: str,
    *,
    path: object,
    error: BaseException,
) -> None:
    if record_file_error is None:
        return
    try:
        record_file_error(
            action,
            path=str(path or "")[:_HYDRATION_FILE_ERROR_PATH_LIMIT],
            error=str(error)[:_HYDRATION_FILE_ERROR_MESSAGE_LIMIT],
            error_type=type(error).__name__,
        )
    except Exception:
        # Diagnostics must never interrupt cache hydration.
        return


def _cached_cover_for_folder(
    folder: Path,
    image_extensions: set[str],
    folder_cover_cache: dict[str, Path | None] | None = None,
) -> Path | None:
    cache_key = str(folder).casefold()
    if folder_cover_cache is not None and cache_key in folder_cover_cache:
        return folder_cover_cache[cache_key]
    cover = find_cover_for_track_folder(folder, image_extensions)
    if folder_cover_cache is not None:
        folder_cover_cache[cache_key] = cover
    return cover


def _apply_local_cover_dimensions(
    entry: dict[str, object],
    *,
    cover_dimensions_cache: dict[str, tuple[int | None, int | None]] | None = None,
    directory_file_cache: dict[str, set[str] | None] | None = None,
    record_file_error: Callable[..., None] | None = None,
) -> bool:
    cover_value = str(entry.get("cover_path") or "").strip()
    cover_path = Path(cover_value) if cover_value else None
    if cover_path is None or not _path_exists_in_cached_directory(
        cover_path,
        directory_file_cache,
        record_file_error,
    ):
        changed = entry.get("local_cover_width") is not None or entry.get("local_cover_height") is not None
        entry["local_cover_width"] = None
        entry["local_cover_height"] = None
        return changed
    cache_key = str(cover_path).casefold()
    cached_dimensions = cover_dimensions_cache.get(cache_key) if cover_dimensions_cache is not None else None
    if cached_dimensions is None:
        try:
            width, height = image_dimensions(cover_path, raise_errors=True)
            cached_dimensions = (int(width or 0) or None, int(height or 0) or None)
        except Exception as error:
            _record_hydration_file_error(
                record_file_error,
                "Library hydration cover image decode failed",
                path=cover_path,
                error=error,
            )
            cached_dimensions = (None, None)
        if cover_dimensions_cache is not None:
            cover_dimensions_cache[cache_key] = cached_dimensions
    next_width, next_height = cached_dimensions
    changed = entry.get("local_cover_width") != next_width or entry.get("local_cover_height") != next_height
    entry["local_cover_width"] = next_width
    entry["local_cover_height"] = next_height
    return changed


def _cached_root_definition_for_track_folder(
    root_definitions: list[dict[str, object]],
    track_folder: Path,
    root_match_cache: dict[str, dict[str, object] | None] | None = None,
) -> dict[str, object] | None:
    cache_key = str(track_folder).casefold()
    if root_match_cache is not None and cache_key in root_match_cache:
        return root_match_cache[cache_key]
    matched_root = root_definition_for_path(root_definitions, track_folder)
    if root_match_cache is not None:
        root_match_cache[cache_key] = matched_root
    return matched_root


def _cached_directory_file_names(
    folder: Path,
    directory_file_cache: dict[str, set[str] | None] | None = None,
    record_file_error: Callable[..., None] | None = None,
) -> set[str] | None:
    cache_key = str(folder).casefold()
    if directory_file_cache is not None and cache_key in directory_file_cache:
        return directory_file_cache[cache_key]

    file_names: set[str] = set()
    try:
        for child in folder.iterdir():
            try:
                child_is_file = child.is_file()
            except OSError as error:
                _record_hydration_file_error(
                    record_file_error,
                    "Library hydration directory entry inspection failed",
                    path=folder / child.name,
                    error=error,
                )
                continue
            if child_is_file:
                file_names.add(child.name.casefold())
    except OSError as error:
        _record_hydration_file_error(
            record_file_error,
            "Library hydration directory read failed",
            path=folder,
            error=error,
        )
        failed_file_names = None
        if directory_file_cache is not None:
            directory_file_cache[cache_key] = failed_file_names
        return failed_file_names

    if directory_file_cache is not None:
        directory_file_cache[cache_key] = file_names
    return file_names


def _path_exists_in_cached_directory(
    path: Path,
    directory_file_cache: dict[str, set[str] | None] | None = None,
    record_file_error: Callable[..., None] | None = None,
) -> bool:
    file_name = path.name.casefold()
    if not file_name:
        return False
    file_names = _cached_directory_file_names(
        path.parent,
        directory_file_cache,
        record_file_error,
    )
    return file_names is not None and file_name in file_names


def find_cover_for_track_folder(folder: Path, image_extensions: set[str]) -> Path | None:
    if folder is None or not folder.exists() or not folder.is_dir():
        return None
    cover = find_cover_image(folder, image_extensions)
    if cover:
        return cover
    folder_name = folder.name.strip().casefold()
    if folder_name in _DISC_FOLDER_NAMES:
        return find_cover_image(folder.parent, image_extensions)
    return None


def repair_cover_paths_in_cache(
    file_cache: dict[str, dict[str, object]],
    image_extensions: set[str],
    *,
    missing_only: bool = True,
    record_file_error: Callable[..., None] | None = None,
) -> dict[str, dict[str, object]]:
    changed_entries: dict[str, dict[str, object]] = {}
    folder_cover_cache: dict[str, Path | None] = {}
    cover_dimensions_cache: dict[str, tuple[int | None, int | None]] = {}
    directory_file_cache: dict[str, set[str] | None] = {}
    for path_str, entry in file_cache.items():
        if not isinstance(entry, dict):
            continue
        track_path = Path(path_str)
        if not _path_exists_in_cached_directory(
            track_path,
            directory_file_cache,
            record_file_error,
        ):
            continue
        cover_value = str(entry.get("cover_path") or "").strip()
        cover_path = Path(cover_value) if cover_value else None
        if missing_only and cover_path is not None and _path_exists_in_cached_directory(
            cover_path,
            directory_file_cache,
            record_file_error,
        ):
            continue
        cover = _cached_cover_for_folder(track_path.parent, image_extensions, folder_cover_cache)
        repaired_cover = str(cover) if cover else None
        if entry.get("cover_path") != repaired_cover:
            entry["cover_path"] = repaired_cover
            changed_entries[path_str] = dict(entry)
        if _apply_local_cover_dimensions(
            entry,
            cover_dimensions_cache=cover_dimensions_cache,
            directory_file_cache=directory_file_cache,
            record_file_error=record_file_error,
        ):
            changed_entries[path_str] = dict(entry)
    return changed_entries


def sanitize_hydrated_file_cache(
    file_cache: dict[str, dict[str, object]],
    exception_overrides: dict[str, object],
    image_extensions: set[str],
    *,
    root_definitions: list[dict[str, object]] | None = None,
    record_file_error: Callable[..., None] | None = None,
) -> tuple[dict[str, dict[str, object]], dict[str, dict[str, object]]]:
    sanitized_file_cache: dict[str, dict[str, object]] = {}
    changed_entries: dict[str, dict[str, object]] = {}
    configured_root_definitions = list(root_definitions or [])
    folder_cover_cache: dict[str, Path | None] = {}
    cover_dimensions_cache: dict[str, tuple[int | None, int | None]] = {}
    root_match_cache: dict[str, dict[str, object] | None] = {}
    directory_file_cache: dict[str, set[str] | None] = {}

    for path_str, entry in file_cache.items():
        if not isinstance(entry, dict):
            continue
        track_path = Path(path_str)
        if not _path_exists_in_cached_directory(
            track_path,
            directory_file_cache,
            record_file_error,
        ):
            continue
        matched_root = _cached_root_definition_for_track_folder(
            configured_root_definitions,
            track_path.parent,
            root_match_cache,
        )
        if isinstance(matched_root, dict):
            next_root_id = str(matched_root.get("id") or "").strip() or None
            next_root_category = library_category_slug(matched_root.get("category"))
            if entry.get("library_root_id") != next_root_id or entry.get("library_root_category") != next_root_category:
                entry["library_root_id"] = next_root_id
                entry["library_root_category"] = next_root_category
                changed_entries[path_str] = dict(entry)
        apply_exception_override(entry, exception_overrides)
        sanitized_file_cache[path_str] = entry
        cover_value = str(entry.get("cover_path") or "").strip()
        cover_path = Path(cover_value) if cover_value else None
        if cover_path is None or not _path_exists_in_cached_directory(
            cover_path,
            directory_file_cache,
            record_file_error,
        ):
            cover = _cached_cover_for_folder(track_path.parent, image_extensions, folder_cover_cache)
            repaired_cover = str(cover) if cover else None
            if entry.get("cover_path") != repaired_cover:
                entry["cover_path"] = repaired_cover
                changed_entries[path_str] = dict(entry)
        if _apply_local_cover_dimensions(
            entry,
            cover_dimensions_cache=cover_dimensions_cache,
            directory_file_cache=directory_file_cache,
            record_file_error=record_file_error,
        ):
            changed_entries[path_str] = dict(entry)

    return sanitized_file_cache, changed_entries


def refresh_cached_cover_paths_in_library_state(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    min_interval_seconds: float = 5.0,
    now: float,
    record_file_error: Callable[..., None] | None = None,
) -> bool:
    if library_state.get("scan_in_progress") or library_state.get("covers_in_progress"):
        return False
    file_cache = library_state.get("file_cache")
    if not isinstance(file_cache, dict) or not file_cache:
        return False
    last_refresh = float(library_state.get("cover_path_refresh_at") or 0.0)
    if now - last_refresh < max(0.5, float(min_interval_seconds or 5.0)):
        return False
    library_state["cover_path_refresh_at"] = now
    changed_entries = repair_cover_paths_in_cache(
        file_cache,
        config["IMAGE_EXTENSIONS"],
        missing_only=True,
        record_file_error=record_file_error,
    )
    if not changed_entries:
        return False
    library_state["albums"] = build_albums_from_file_cache(
        file_cache,
        set(library_state.get("separate_release_keys") or set()),
    )
    schedule_cache_updates_save_for_config(config, config["CACHE_PATH"], changed_entries)
    return True


def hydrate_library_state_from_disk(
    library_state: dict[str, object],
    config: dict[str, object],
    *,
    ensure_relations: bool = True,
    validate_cache: bool = True,
    ensure_relation_views: Callable[[dict[str, object], dict[str, object]], None] | None = None,
    load_exception_overrides: Callable[[dict[str, object]], dict[str, object]] | None = None,
    queue_problematic_albums_prewarm: Callable[[], None] | None = None,
    queue_utility_rules_prewarm: Callable[[], None] | None = None,
    scan_cache_adapter=None,
    strict_scan_cache_load: bool = False,
    record_file_error: Callable[..., None] | None = None,
) -> bool:
    def _relations_missing(state: dict[str, object]) -> bool:
        relation_views = state.get("relation_views", {}) or {}
        return not relation_views.get("artists")

    if library_state.get("albums"):
        if ensure_relations and ensure_relation_views is not None and _relations_missing(library_state):
            ensure_relation_views(library_state, config)
        return True

    root_identity = library_root_cache_identity(config)
    adapter_was_selected = scan_cache_adapter is None
    scan_cache_adapter = scan_cache_adapter or select_scan_cache_adapter(config)
    load_snapshot = (
        scan_cache_adapter.load_snapshot_strict
        if adapter_was_selected or strict_scan_cache_load
        else scan_cache_adapter.load_snapshot
    )
    file_cache, disk_last_scan, relation_views, relations_last_built, disk_error = load_snapshot(
        config["CACHE_PATH"],
        root_identity,
    )
    exception_overrides_loader = load_exception_overrides
    exception_overrides = exception_overrides_loader(config) if exception_overrides_loader is not None else {}
    if disk_error:
        library_state["last_error"] = disk_error
        _record_hydration_file_error(
            record_file_error,
            "Library scan cache load failed",
            path=config["CACHE_PATH"],
            error=RuntimeError(disk_error),
        )
    library_state["last_scan"] = disk_last_scan
    if not file_cache:
        if disk_last_scan <= 0 or disk_error:
            return False
        library_state["file_cache"] = {}
        library_state["albums"] = []
        library_state["relation_views"] = empty_relation_views()
        library_state["relations_last_built"] = 0.0
        library_state["separate_release_keys"] = set()
        return True

    if validate_cache:
        sanitized_file_cache, changed_entries = sanitize_hydrated_file_cache(
            file_cache,
            exception_overrides,
            config["IMAGE_EXTENSIONS"],
            root_definitions=get_library_roots(config),
            record_file_error=record_file_error,
        )
    else:
        sanitized_file_cache = file_cache
        changed_entries = {}
        for entry in sanitized_file_cache.values():
            if isinstance(entry, dict):
                apply_exception_override(entry, exception_overrides)

    saved_sanitized_snapshot = False
    if validate_cache and len(sanitized_file_cache) != len(file_cache):
        if scan_cache_adapter.backend == PERSISTENCE_BACKEND_POSTGRES:
            scan_cache_adapter.save_snapshot(
                config["CACHE_PATH"],
                sanitized_file_cache,
                root_identity,
                disk_last_scan,
                relation_views=relation_views,
                relations_last_built=relations_last_built,
            )
            saved_sanitized_snapshot = True
        else:
            save_cache_to_disk_for_config(
                config,
                config["CACHE_PATH"],
                sanitized_file_cache,
                root_identity,
                disk_last_scan,
                relation_views=relation_views,
                relations_last_built=relations_last_built,
            )

    library_state["file_cache"] = sanitized_file_cache
    library_state["scan_metadata_repair_required"] = any(
        not file_metadata_schema_is_current(entry)
        for entry in sanitized_file_cache.values()
    )
    if relation_views:
        library_state["relation_views"] = relation_views
    if relations_last_built:
        library_state["relations_last_built"] = relations_last_built
    library_state["separate_release_keys"] = load_separate_release_keys(config)
    library_state["albums"] = build_albums_from_file_cache(
        sanitized_file_cache,
        set(library_state.get("separate_release_keys") or set()),
    )
    if (
        changed_entries
        and scan_cache_adapter.backend == PERSISTENCE_BACKEND_POSTGRES
        and not saved_sanitized_snapshot
    ):
        scan_cache_adapter.save_snapshot(
            config["CACHE_PATH"],
            sanitized_file_cache,
            root_identity,
            disk_last_scan,
            relation_views=relation_views,
            relations_last_built=relations_last_built,
        )
    elif changed_entries:
        schedule_cache_updates_save_for_config(config, config["CACHE_PATH"], changed_entries)
    if ensure_relations and ensure_relation_views is not None and _relations_missing(library_state):
        ensure_relation_views(library_state, config)
    library_browse_selection = select_runtime_persistence_adapter("library_browse", config)
    should_queue_file_prewarm = library_browse_selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES
    if (
        should_queue_file_prewarm
        and queue_problematic_albums_prewarm is not None
        and library_state.get("albums")
        and library_state.get("file_cache")
    ):
        queue_problematic_albums_prewarm()
    if (
        should_queue_file_prewarm
        and queue_utility_rules_prewarm is not None
        and library_state.get("albums")
        and library_state.get("file_cache")
    ):
        queue_utility_rules_prewarm()
    return bool(library_state["albums"])
