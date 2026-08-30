from __future__ import annotations

import inspect
import logging
from collections.abc import Mapping
from threading import Event
from time import perf_counter
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from config import PERSISTENCE_BACKEND_POSTGRES
from music_app.routes.api_read_asgi_routes import _build_status_payload_from_state
from music_app.routes.api_edit_helpers import (
    _apply_repairs_worker,
    _build_affected_album_dicts,
    _build_artist_alias_repairs_for_entry,
    _build_disc_marker_repairs_for_entry,
    _find_problematic_album_by_track_paths,
    _rebuild_affected_albums_in_state,
    _update_cache_entry_after_repairs,
    rebuild_relation_views,
)
from music_app.routes.api_rules_helpers import (
    albums_share_any_artist,
    resolve_manual_version_root,
)
from music_app.services.app_logging import log_app_event
from music_app.services.album_ratings_postgres import PostgresAlbumRatingsService
from music_app.services.cache import (
    persist_structural_tag_edit_for_config,
    schedule_cache_updates_save_for_config,
    validate_structural_tag_edit_for_config,
)
from music_app.services.exception_overrides import (
    set_track_exception_override,
    set_track_exception_overrides,
)
from music_app.services.ignored_repairs import load_ignored_repair_keys, save_ignored_repair_keys
from music_app.services.ignored_versions import load_ignored_version_keys, save_ignored_version_keys
from music_app.services.library import _album_key, album_to_dict
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library_roots import (
    library_root_cache_identity,
    load_library_root_settings,
)
from music_app.services.library_settings import (
    LibrarySettingsWorkflowError,
    save_library_settings_and_start_refresh,
)
from music_app.services.log_history import append_log_history
from music_app.services.manual_versions import load_manual_version_links, save_manual_version_links
from music_app.services.metadata import build_text_repairs_for_entry, normalize_exception_value
from music_app.services.move_executor import AlbumMoveError, execute_album_move
from music_app.services.problematic_albums import (
    find_problematic_album_by_track_paths as _find_problematic_album_by_track_paths_in_payload,
)
from music_app.services.problem_exclusions import (
    create_problem_exclusions,
    revert_problem_exclusion,
)
from music_app.services.save_tasks import (
    acquire_structural_tag_edit_reservation_async,
    create_save_task,
    queue_finalize_save_task,
    queue_finalize_structural_tag_edit_save_task,
    save_task_result,
    structural_tag_edit_resource_keys,
)
from music_app.services.separate_releases import load_separate_release_keys, save_separate_release_keys
from music_app.services.tag_edit_intents_postgres import (
    PostgresTagEditIntentRepository,
)
from music_app.services.repair_previews import (
    build_problematic_albums_payload as _build_problematic_albums_payload,
)
from music_app.services.state import (
    hydrate_library_state_for_config,
    run_runtime_state_mutation_for_state,
    start_background_refresh_for_state,
)
from music_app.services.persistence_selection import select_runtime_persistence_adapter
from music_app.services.utility_rule_mutations import (
    create_version_exception,
    mark_manual_version_link,
    revert_rule_key,
    unmark_manual_version_link,
    validate_manual_version_link_keys,
)
from music_app.services.utility_rules import (
    build_utility_rules_payload as build_cached_utility_rules_payload,
    invalidate_utility_rules_payload_cache,
)
from music_app.services.edit_workflows import (
    handle_edit_tags_request,
    handle_repair_album_request,
)
from music_app.services.edit_state import find_album_dicts_by_track_paths


router = APIRouter()

_EDIT_WRITE_WORKERS = 2
_STRUCTURAL_EDIT_FIELDS = {"album", "album_artist", "year", "edition", "exception_type"}
_RELATION_PROJECTION_EDIT_FIELDS = {"album_artist", "artist"}
_MEDIA_TAG_EDIT_FIELDS = {
    "artist",
    "album_artist",
    "album",
    "title",
    "genre",
    "year",
    "track_number",
    "disc_number",
    "edition",
    "album_rating",
}
_TARGETED_INVENTORY_EDIT_FIELDS = {
    "title",
    "genre",
    "track_number",
    "disc_number",
}
_SELECTED_POSTGRES_MEDIA_WRITE_REFRESH_FIELDS = _STRUCTURAL_EDIT_FIELDS | _MEDIA_TAG_EDIT_FIELDS


JsonDict = dict[str, object]
ResponseValue = JsonDict | tuple[JsonDict, int]
TrackPathSet = set[str]


def _app_config(request: Request):
    return request.app.state.config


def _library_state(request: Request) -> dict[str, object]:
    return request.app.state.library_state


def _asgi_logger(request: Request):
    logger = getattr(request.app.state, "logger", None)
    if logger is not None:
        return logger
    return logging.getLogger("music_app.asgi.wave_a")


def _start_background_refresh_for_asgi_request(request: Request):
    library_state = _library_state(request)

    def start_asgi_background_refresh(force: bool = False, *, scan_mode: str = "background") -> None:
        start_background_refresh_for_state(
            library_state,
            _app_config(request),
            _asgi_logger(request),
            force=force,
            scan_mode=scan_mode,
        )

    return start_asgi_background_refresh


async def _json_payload(request: Request) -> JsonDict | None:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return payload if isinstance(payload, dict) else None


def _invalid_payload_response(error: str = "Invalid payload", status_code: int = 400) -> tuple[JsonDict, int]:
    return {"ok": False, "error": error}, status_code


def _invalid_album_payload_response() -> tuple[JsonDict, int]:
    return _invalid_payload_response("Invalid album payload")


def _task_not_found_response(task_name: str) -> tuple[JsonDict, int]:
    return _invalid_payload_response(f"{task_name} not found", 404)


def _album_track_paths(album: Mapping[str, object] | None) -> set[str]:
    tracks = album.get("tracks", []) if isinstance(album, Mapping) else []
    return {
        str(track.get("path") or "")
        for track in tracks
        if isinstance(track, Mapping) and str(track.get("path") or "")
    }


def _require_album_payload(payload: Mapping[str, object] | None) -> tuple[JsonDict | None, tuple[JsonDict, int] | None]:
    album = payload.get("album") if isinstance(payload, Mapping) else None
    if not isinstance(album, dict):
        return None, _invalid_album_payload_response()
    return album, None


def _require_album_track_paths(
    album: Mapping[str, object] | None,
    *,
    error_message: str = "Album does not contain any tracks",
) -> tuple[set[str] | None, tuple[JsonDict, int] | None]:
    track_paths = _album_track_paths(album)
    if not track_paths:
        return None, _invalid_payload_response(error_message)
    return track_paths, None


def _json_response(value: ResponseValue) -> JSONResponse:
    if isinstance(value, tuple):
        payload, status_code = value
        return JSONResponse(payload, status_code=status_code)
    return JSONResponse(value)


def _current_rules_payload(request: Request | None = None, mutation_seam_id: str | None = None) -> JsonDict:
    if request is not None and _is_postgres_utility_rules_request(request, mutation_seam_id):
        return PostgresLibraryBrowseRepository(_app_config(request)).build_utility_rules_payload()
    explicit_dependencies = (
        {
            "library_state": _library_state(request),
            "config": _app_config(request),
            "logger": _asgi_logger(request),
        }
        if request is not None
        else {}
    )
    return build_cached_utility_rules_payload(
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
        **explicit_dependencies,
    )


def hydrate_cached_library_for_rules(
    library_state: dict[str, object] | None = None,
    config: dict[str, object] | None = None,
    logger=None,
) -> None:
    if library_state is None or config is None:
        raise ValueError("library_state and config must be provided together")
    if library_state.get("albums") or library_state.get("scan_in_progress"):
        return
    hydrate_library_state_for_config(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=False,
        logger_for_prewarm=logger,
    )


def _find_albums_by_track_paths(
    track_paths: TrackPathSet,
    *,
    library_state: dict[str, object],
) -> list[JsonDict]:
    return find_album_dicts_by_track_paths(list(library_state.get("albums", []) or []), track_paths)


def _default_albums_by_track_paths_finder(get_state_provider):
    def find_albums(track_paths: TrackPathSet) -> list[JsonDict]:
        return _find_albums_by_track_paths(track_paths, library_state=get_state_provider())

    return find_albums


def _bridge_queue_finalize_save_task(**kwargs: Any) -> None:
    find_albums_by_track_paths = kwargs.pop("find_albums_by_track_paths", None)
    find_problematic_album_by_track_paths = kwargs.pop("find_problematic_album_by_track_paths", None)
    structural_edit_fields = kwargs.pop("structural_edit_fields", set(_STRUCTURAL_EDIT_FIELDS))
    get_state_provider = kwargs.pop("get_state", None)
    if get_state_provider is None:
        raise ValueError("get_state is required")

    config = kwargs.get("config")
    logger = kwargs.get("logger")
    tag_edit_intent_id = str(kwargs.pop("tag_edit_intent_id", "") or "").strip()
    exception_updates = dict(kwargs.pop("exception_updates", {}) or {})
    intent_repository = (
        PostgresTagEditIntentRepository(config)
        if tag_edit_intent_id and isinstance(config, Mapping)
        else None
    )
    before_persistence_commit = (
        lambda connection: intent_repository.complete_in_transaction(
            connection,
            tag_edit_intent_id,
            exception_updates=exception_updates,
        )
        if intent_repository is not None
        else None
    )
    complete_scoped_persistence = (
        lambda: intent_repository.complete(
            tag_edit_intent_id,
            exception_updates=exception_updates,
        )
        if intent_repository is not None
        else None
    )
    record_scoped_persistence_failure = (
        lambda compensation_succeeded, error: (
            intent_repository.mark_terminal(
                tag_edit_intent_id,
                status="rolled_back",
                last_error=str(error),
            )
            if compensation_succeeded
            else intent_repository.mark_recovery_failed(tag_edit_intent_id, error)
        )
        if intent_repository is not None
        else None
    )
    rebuild_relation_projection = bool(
        set(kwargs.get("changed_field_names") or ())
        & _RELATION_PROJECTION_EDIT_FIELDS
    ) and not bool(kwargs.get("scoped_postgres_exception_only"))
    if find_albums_by_track_paths is None:
        find_albums_by_track_paths = _default_albums_by_track_paths_finder(get_state_provider)
    if find_problematic_album_by_track_paths is None:
        try:
            signature = inspect.signature(_find_problematic_album_by_track_paths)
        except (TypeError, ValueError):
            accepts_explicit_dependencies = True
        else:
            accepts_explicit_dependencies = "config" in signature.parameters or any(
                parameter.kind == inspect.Parameter.VAR_KEYWORD
                for parameter in signature.parameters.values()
            )
        if accepts_explicit_dependencies:
            find_problematic_album_by_track_paths = lambda track_paths: _find_problematic_album_by_track_paths(
                track_paths,
                config=config,
                library_state=get_state_provider(),
                logger=logger,
            )
        else:
            find_problematic_album_by_track_paths = lambda track_paths: _find_problematic_album_by_track_paths(track_paths)
    queue_finalize_save_task(
        get_state=get_state_provider,
        run_state_mutation=run_runtime_state_mutation_for_state,
        rebuild_affected_albums_in_state=lambda st, previous_file_cache, updated_file_cache, changed_paths, separate_release_keys: _rebuild_affected_albums_in_state(
            st,
            previous_file_cache,
            updated_file_cache,
            changed_paths,
            separate_release_keys,
        ),
        build_relation_views=lambda albums, config: rebuild_relation_views(albums, config),
        schedule_cache_updates_save=lambda cache_path, payload, baseline, **save_options: schedule_cache_updates_save_for_config(
            config,
            cache_path,
            payload,
            baseline_file_cache=baseline,
            rebuild_relation_projection=rebuild_relation_projection,
            **save_options,
        ),
        append_log_history=lambda config, entry: append_log_history(config, entry),
        log_app_event=lambda config, logger, message, **extra: log_app_event(config, logger, message, **extra),
        find_albums_by_track_paths=find_albums_by_track_paths,
        find_problematic_album_by_track_paths=find_problematic_album_by_track_paths,
        structural_edit_fields=set(structural_edit_fields),
        before_persistence_commit=before_persistence_commit,
        complete_scoped_persistence=complete_scoped_persistence,
        record_scoped_persistence_failure=record_scoped_persistence_failure,
        **kwargs,
    )


@router.get("/library-settings")
async def library_settings_read(request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "ok": True,
            "settings": load_library_root_settings(_app_config(request)),
        }
    )


@router.post("/library-settings/import-album-ratings")
async def library_settings_import_album_ratings(request: Request) -> JSONResponse:
    try:
        service = PostgresAlbumRatingsService(_app_config(request))
        result = await run_in_threadpool(service.import_missing_tag_ratings)
    except Exception:
        _asgi_logger(request).exception("Failed to import album ratings")
        return _json_response(
            ({"ok": False, "error": "Failed to import album ratings."}, 500)
        )
    return JSONResponse({"ok": True, **result})


@router.post("/library-settings")
async def library_settings_write(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())

    settings_payload = payload.get("settings", payload)
    if not isinstance(settings_payload, dict):
        return _json_response(
            ({"ok": False, "error": "Library settings payload must be an object."}, 400)
        )

    try:
        result = save_library_settings_and_start_refresh(
            _app_config(request),
            settings_payload,
            library_state=_library_state(request),
            start_background_refresh=_start_background_refresh_for_asgi_request(request),
            build_status_payload=lambda: _build_status_payload_from_state(_library_state(request)),
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except LibrarySettingsWorkflowError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, exc.status_code))

    return JSONResponse({"ok": True, **result})


@router.get("/utilities/rules")
def utility_rules(request: Request) -> JSONResponse:
    if _is_postgres_utility_rules_request(request):
        return JSONResponse(_current_rules_payload(request))
    return JSONResponse(_current_rules_payload(request))


def _is_postgres_utility_rules_request(request: Request, mutation_seam_id: str | None = None) -> bool:
    config = _app_config(request)
    browse_selection = select_runtime_persistence_adapter("library_browse", config)
    if browse_selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        return False
    if mutation_seam_id is None:
        return True
    mutation_selection = select_runtime_persistence_adapter(mutation_seam_id, config)
    return mutation_selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _is_selected_postgres_library_browse_request(request: Request) -> bool:
    config = _app_config(request)
    browse_selection = select_runtime_persistence_adapter("library_browse", config)
    return browse_selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _repair_album_rule_state_keys(payload: Mapping[str, object]) -> tuple[set[str], set[str]]:
    ignored_values = payload.get("ignored_rows")
    if not isinstance(ignored_values, list):
        ignored_values = payload.get("ignored_row_keys")
    if not isinstance(ignored_values, list):
        ignored_values = []
    separate_values = payload.get("separate_release_keys")
    if not isinstance(separate_values, list):
        separate_values = []
    return (
        {str(value).strip() for value in ignored_values if str(value).strip()},
        {str(value).strip() for value in separate_values if str(value).strip()},
    )


def _normalize_asgi_repair_album_payload(payload: JsonDict) -> JsonDict:
    if isinstance(payload.get("ignored_rows"), list):
        return payload
    if not isinstance(payload.get("ignored_row_keys"), list):
        return payload
    normalized = dict(payload)
    normalized["ignored_rows"] = list(payload["ignored_row_keys"])
    return normalized


def _is_postgres_repair_album_embedded_response_request(
    request: Request,
    payload: Mapping[str, object],
) -> bool:
    selected_rows = payload.get("selected_rows")
    if not isinstance(selected_rows, list):
        return False
    selected_row_keys = {str(value).strip() for value in selected_rows if str(value).strip()}
    if selected_row_keys:
        return False

    ignored_row_keys, separate_release_keys = _repair_album_rule_state_keys(payload)
    if not ignored_row_keys and not separate_release_keys:
        return False
    if not _is_postgres_utility_rules_request(request):
        return False

    config = _app_config(request)
    if ignored_row_keys:
        ignored_selection = select_runtime_persistence_adapter("ignored_repairs", config)
        if ignored_selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
            return False
    if separate_release_keys:
        separate_selection = select_runtime_persistence_adapter("separate_releases", config)
        if separate_selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
            return False
    return True


def _has_repair_album_media_write_rows(payload: Mapping[str, object]) -> bool:
    selected_rows = payload.get("selected_rows")
    if not isinstance(selected_rows, list):
        return False
    return any(str(value).strip() for value in selected_rows)


def _has_edit_tags_media_write_fields(payload: Mapping[str, object]) -> bool:
    updates = payload.get("updates")
    if not isinstance(updates, Mapping):
        return False
    for raw_edits in updates.values():
        if not isinstance(raw_edits, Mapping):
            continue
        if any(str(field or "") in _MEDIA_TAG_EDIT_FIELDS for field in raw_edits):
            return True
    return False


def _edit_tags_reservation_resource_keys(
    album: Mapping[str, object],
    updates: Mapping[str, object],
) -> set[str]:
    media_write_paths = {
        str(raw_path)
        for raw_path, raw_edits in updates.items()
        if str(raw_path)
        and isinstance(raw_edits, Mapping)
        and any(
            str(field or "") in _MEDIA_TAG_EDIT_FIELDS
            for field in raw_edits
        )
    }
    if not media_write_paths:
        return set()

    current_album_artist = str(album.get("album_artist") or "")
    current_album_title = str(
        album.get("name") or album.get("album") or ""
    )
    current_edition = str(album.get("edition") or "") or None
    current_year = album.get("year")
    source_album_key = str(album.get("key") or "").strip() or _album_key(
        current_album_artist,
        current_album_title,
        current_edition,
        current_year,
    )
    identity_fields = {"album", "album_artist", "year", "edition"}
    destination_album_keys: set[str] = set()
    for raw_edits in updates.values():
        if not isinstance(raw_edits, Mapping):
            continue
        if not identity_fields.intersection(
            str(field or "") for field in raw_edits
        ):
            continue
        destination_album_keys.add(
            _album_key(
                str(
                    raw_edits.get("album_artist") or ""
                    if "album_artist" in raw_edits
                    else current_album_artist
                ),
                str(
                    raw_edits.get("album") or ""
                    if "album" in raw_edits
                    else current_album_title
                ),
                (
                    str(raw_edits.get("edition") or "") or None
                    if "edition" in raw_edits
                    else current_edition
                ),
                (
                    raw_edits.get("year")
                    if "year" in raw_edits
                    else current_year
                ),
            )
        )
    return structural_tag_edit_resource_keys(
        source_album_key,
        media_write_paths,
        destination_album_keys,
    )


def _is_selected_postgres_targeted_structural_edit_request(
    request: Request,
    payload: Mapping[str, object],
) -> bool:
    if not _is_selected_postgres_library_browse_request(request):
        return False
    updates = payload.get("updates")
    if not isinstance(updates, Mapping) or not updates:
        return False
    field_sets: set[frozenset[str]] = set()
    for raw_edits in updates.values():
        if not isinstance(raw_edits, Mapping):
            return False
        field_sets.add(frozenset(str(field or "") for field in raw_edits))
    if len(field_sets) == 1 and next(iter(field_sets)) in {
        frozenset({"album"}),
        frozenset({"year"}),
    }:
        return True
    return bool(field_sets) and all(
        bool(fields) and fields <= _TARGETED_INVENTORY_EDIT_FIELDS
        for fields in field_sets
    )


def _empty_affected_album_dicts(
    _previous_file_cache,
    _updated_file_cache,
    _requested_track_paths,
    _changed_paths,
    _separate_release_keys,
) -> list[JsonDict]:
    return []


def _empty_albums_by_track_paths(_track_paths: TrackPathSet) -> list[JsonDict]:
    return []


def _empty_problematic_album_by_track_paths(_track_paths: TrackPathSet) -> JsonDict | None:
    return None


def _asgi_albums_by_track_paths_finder(request: Request):
    config = _app_config(request)
    library_state = _library_state(request)

    def find_albums(track_paths: TrackPathSet) -> list[JsonDict]:
        if not track_paths:
            return []
        matches: list[JsonDict] = []
        for album in list(library_state.get("albums", []) or []):
            album_paths = {
                str(getattr(track, "path", "") or "")
                for track in getattr(album, "tracks", []) or []
                if str(getattr(track, "path", "") or "")
            }
            if album_paths & track_paths:
                matches.append(album_to_dict(album, config=config))
        return matches

    return find_albums


def _asgi_problematic_album_by_track_paths_finder(request: Request):
    config = _app_config(request)
    library_state = _library_state(request)
    logger = _asgi_logger(request)

    def build_payload() -> JsonDict:
        return _build_problematic_albums_payload(
            config=config,
            library_state=library_state,
            logger=logger,
        )

    def find_problematic_album(track_paths: TrackPathSet) -> JsonDict | None:
        return _find_problematic_album_by_track_paths_in_payload(
            track_paths,
            build_problematic_albums_payload=build_payload,
        )

    return find_problematic_album


def _asgi_cache_entry_updater(request: Request):
    updater_signature = inspect.signature(_update_cache_entry_after_repairs)
    supports_logger = "logger" in updater_signature.parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in updater_signature.parameters.values()
    )

    def update_cache_entry(path, entry, repairs):
        if supports_logger:
            return _update_cache_entry_after_repairs(
                path,
                entry,
                repairs,
                logger=_asgi_logger(request),
            )
        return _update_cache_entry_after_repairs(path, entry, repairs)

    return update_cache_entry


def _selected_postgres_media_write_response(value: ResponseValue) -> ResponseValue:
    if isinstance(value, tuple):
        return value
    if not value.get("save_task_id"):
        return value
    response = dict(value)
    response["updated_album"] = None
    response["updated_albums"] = []
    response["updated_problematic_album"] = None
    response["requires_view_refresh"] = True
    return response


async def _run_edit_tags_handler_with_reservation(
    handler_options: Mapping[str, object],
    structural_tag_edit_reservation: object | None,
):
    handler_started = Event()
    try:
        reserved_handler_options = {
            **handler_options,
            "structural_tag_edit_reservation": (
                structural_tag_edit_reservation
            ),
        }

        def run_handler():
            handler_started.set()
            return handle_edit_tags_request(**reserved_handler_options)

        return await run_in_threadpool(run_handler)
    except BaseException:
        if not handler_started.is_set():
            release = getattr(
                structural_tag_edit_reservation,
                "release",
                None,
            )
            if callable(release):
                release()
        raise


def _selected_postgres_media_write_queue_finalize_save_task(**kwargs: Any) -> None:
    _bridge_queue_finalize_save_task(
        find_albums_by_track_paths=_empty_albums_by_track_paths,
        find_problematic_album_by_track_paths=_empty_problematic_album_by_track_paths,
        structural_edit_fields=set(_SELECTED_POSTGRES_MEDIA_WRITE_REFRESH_FIELDS),
        **kwargs,
    )


def _asgi_bridge_queue_finalize_save_task_builder(
    request: Request,
    *,
    wait_for_completion: bool = False,
):
    def queue_finalize_with_asgi_state(**kwargs: Any) -> None:
        _bridge_queue_finalize_save_task(
            get_state=lambda: _library_state(request),
            wait_for_completion=wait_for_completion,
            **kwargs,
        )

    return queue_finalize_with_asgi_state


def _asgi_selected_postgres_media_write_queue_finalize_save_task_builder(request: Request):
    def compensate_media_write(
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]] | None = None,
        changed_field_names: set[str],
    ) -> None:
        failures: list[str] = []
        exception_rollbacks: dict[str, str] = {}
        for path in sorted(changed_paths):
            previous_entry = previous_file_entries.get(path)
            if not isinstance(previous_entry, Mapping):
                failures.append(f"{path}: previous metadata is unavailable")
                continue
            updated_entry = (updated_file_entries or {}).get(path)
            path_field_names = {
                field
                for field in changed_field_names
                if not isinstance(updated_entry, Mapping)
                or previous_entry.get(field, "")
                != updated_entry.get(field, "")
            }
            if "exception_type" in path_field_names:
                exception_rollbacks[path] = normalize_exception_value(
                    previous_entry.get("exception_type")
                )
            reverse_repairs = {
                field: str(
                    (
                        previous_entry.get("release_date")
                        or previous_entry.get("year")
                    )
                    if field == "year"
                    else previous_entry.get(field)
                    or ""
                )
                for field in path_field_names
                if field in _MEDIA_TAG_EDIT_FIELDS
            }
            if not reverse_repairs:
                continue
            try:
                _apply_repairs_worker(path, reverse_repairs)
            except Exception as exc:
                failures.append(f"{path}: {exc}")
        if exception_rollbacks:
            try:
                set_track_exception_overrides(
                    _app_config(request),
                    exception_rollbacks,
                )
            except Exception as exc:
                failures.append(f"exception overrides: {exc}")
        if failures:
            raise RuntimeError(
                "Tag edit database commit failed and media compensation also "
                f"failed: {'; '.join(failures)}"
            )

    def queue_selected_postgres_media_write(**kwargs: Any) -> None:
        _selected_postgres_media_write_queue_finalize_save_task(
            get_state=lambda: _library_state(request),
            wait_for_completion=True,
            compensate_save_task=compensate_media_write,
            **kwargs,
        )

    return queue_selected_postgres_media_write


def _asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
    request: Request,
):
    def compensate_structural_tag_edit(
        *,
        changed_paths: set[str],
        previous_file_entries: dict[str, dict[str, object]],
        updated_file_entries: dict[str, dict[str, object]] | None = None,
        changed_field_names: set[str],
    ) -> None:
        failures: list[str] = []
        for path in sorted(changed_paths):
            previous_entry = previous_file_entries.get(path)
            if not isinstance(previous_entry, Mapping):
                failures.append(f"{path}: previous metadata is unavailable")
                continue
            updated_entry = (updated_file_entries or {}).get(path)
            path_field_names = {
                field
                for field in changed_field_names
                if not isinstance(updated_entry, Mapping)
                or previous_entry.get(field, "")
                != updated_entry.get(field, "")
            }
            reverse_repairs = {
                field: str(
                    (
                        previous_entry.get("release_date")
                        or previous_entry.get("year")
                    )
                    if field == "year"
                    else previous_entry.get(field)
                    or ""
                )
                for field in path_field_names
                if field in _MEDIA_TAG_EDIT_FIELDS
            }
            if not reverse_repairs:
                continue
            try:
                _apply_repairs_worker(path, reverse_repairs)
            except Exception as exc:
                failures.append(f"{path}: {exc}")
        if failures:
            raise RuntimeError(
                "Structural tag edit database commit failed and media compensation "
                f"also failed: {'; '.join(failures)}"
            )

    def queue_selected_postgres_structural_tag_edit(**kwargs: Any) -> None:
        config = kwargs["config"]
        tag_edit_intent_id = str(kwargs.pop("tag_edit_intent_id", "") or "").strip()
        exception_updates = dict(kwargs.pop("exception_updates", {}) or {})
        intent_repository = (
            PostgresTagEditIntentRepository(config)
            if tag_edit_intent_id
            else None
        )
        record_scoped_persistence_failure = (
            lambda compensation_succeeded, error: (
                intent_repository.mark_terminal(
                    tag_edit_intent_id,
                    status="rolled_back",
                    last_error=str(error),
                )
                if compensation_succeeded
                else intent_repository.mark_recovery_failed(
                    tag_edit_intent_id,
                    error,
                )
            )
            if intent_repository is not None
            else None
        )
        queue_finalize_structural_tag_edit_save_task(
            wait_for_completion=True,
            get_state=lambda: _library_state(request),
            run_state_mutation=run_runtime_state_mutation_for_state,
            rebuild_affected_albums_in_state=lambda st, previous_file_cache, updated_file_cache, changed_paths, separate_release_keys: _rebuild_affected_albums_in_state(
                st,
                previous_file_cache,
                updated_file_cache,
                changed_paths,
                separate_release_keys,
            ),
            persist_structural_tag_edit=lambda **options: persist_structural_tag_edit_for_config(
                config,
                rebuild_relation_projection=bool(
                    set(options.get("changed_field_names") or ())
                    & _RELATION_PROJECTION_EDIT_FIELDS
                ),
                **options,
            ),
            before_persistence_commit=(
                lambda connection: intent_repository.complete_in_transaction(
                    connection,
                    tag_edit_intent_id,
                    exception_updates=exception_updates,
                )
                if intent_repository is not None
                else None
            ),
            record_scoped_persistence_failure=record_scoped_persistence_failure,
            compensate_structural_tag_edit=compensate_structural_tag_edit,
            append_log_history=lambda app_config, entry: append_log_history(
                app_config,
                entry,
            ),
            log_app_event=lambda app_config, logger, message, **extra: log_app_event(
                app_config,
                logger,
                message,
                **extra,
            ),
            find_albums_by_track_paths=_postgres_album_finder_for_track_paths(request),
            find_problematic_album_by_track_paths=_empty_problematic_album_by_track_paths,
            structural_edit_fields=set(_SELECTED_POSTGRES_MEDIA_WRITE_REFRESH_FIELDS),
            relation_projection_edit_fields=set(_RELATION_PROJECTION_EDIT_FIELDS),
            **kwargs,
        )

    return queue_selected_postgres_structural_tag_edit


def _repair_album_embedded_response_matchers(request: Request, payload: Mapping[str, object]):
    if not _is_postgres_repair_album_embedded_response_request(request, payload):
        return _asgi_problematic_album_by_track_paths_finder(request), _asgi_albums_by_track_paths_finder(request)

    repository: PostgresLibraryBrowseRepository | None = None

    def repo() -> PostgresLibraryBrowseRepository:
        nonlocal repository
        if repository is None:
            repository = PostgresLibraryBrowseRepository(_app_config(request))
        return repository

    def find_problematic_album(track_paths: TrackPathSet) -> JsonDict | None:
        return repo().build_problematic_album_payload_by_track_paths(track_paths)

    def find_albums(track_paths: TrackPathSet) -> list[JsonDict]:
        return repo().build_album_payloads_by_track_paths(track_paths)

    return find_problematic_album, find_albums


def _is_postgres_edit_tags_exception_only_response_request(
    request: Request,
    payload: Mapping[str, object],
) -> bool:
    updates = payload.get("updates")
    if not isinstance(updates, Mapping) or not updates:
        return False
    for raw_edits in updates.values():
        if not isinstance(raw_edits, Mapping):
            return False
        if len(raw_edits) != 1 or next(iter(raw_edits.keys())) != "exception_type":
            return False

    config = _app_config(request)
    exception_selection = select_runtime_persistence_adapter("exception_overrides", config)
    if exception_selection.effective_backend != PERSISTENCE_BACKEND_POSTGRES:
        return False
    browse_selection = select_runtime_persistence_adapter("library_browse", config)
    return browse_selection.effective_backend == PERSISTENCE_BACKEND_POSTGRES


def _postgres_exception_only_edit_state(
    request: Request,
    payload: Mapping[str, object],
) -> dict[str, object]:
    requested_paths = {
        str(path or "").strip()
        for path in (payload.get("updates") or {})
        if str(path or "").strip()
    }
    request_state = dict(_library_state(request))
    runtime_file_cache = dict(request_state.get("file_cache", {}) or {})
    repository = PostgresLibraryBrowseRepository(_app_config(request))
    selected_file_entries = repository.build_track_file_entries_by_paths(
        requested_paths
    )
    unresolved_paths = requested_paths - set(selected_file_entries)
    if unresolved_paths:
        raise ValueError(
            "Postgres library inventory could not resolve requested track paths: "
            + ", ".join(sorted(unresolved_paths))
        )
    for path, selected_entry in selected_file_entries.items():
        runtime_file_cache[path] = dict(selected_entry)
    request_state["file_cache"] = runtime_file_cache
    return request_state


def _postgres_album_finder_for_track_paths(request: Request):
    repository: PostgresLibraryBrowseRepository | None = None

    def repo() -> PostgresLibraryBrowseRepository:
        nonlocal repository
        if repository is None:
            repository = PostgresLibraryBrowseRepository(_app_config(request))
        return repository

    def find_albums(track_paths: TrackPathSet) -> list[JsonDict]:
        return repo().build_album_payloads_by_track_paths(track_paths)

    return find_albums


def _edit_tags_affected_album_dicts_builder(
    request: Request,
    payload: Mapping[str, object],
):
    if not _is_postgres_edit_tags_exception_only_response_request(request, payload):
        return _build_affected_album_dicts

    find_albums = _postgres_album_finder_for_track_paths(request)

    def build_affected_album_dicts(
        _previous_file_cache,
        _updated_file_cache,
        requested_track_paths,
        _changed_paths,
        _separate_release_keys,
    ):
        return find_albums(set(requested_track_paths))

    return build_affected_album_dicts


def _repair_album_affected_album_dicts_builder(request: Request, payload: Mapping[str, object]):
    if (
        _is_selected_postgres_library_browse_request(request)
        and _has_repair_album_media_write_rows(payload)
    ):
        return _empty_affected_album_dicts
    return _build_affected_album_dicts


def _edit_tags_queue_finalize_save_task_builder(
    request: Request,
    payload: Mapping[str, object],
):
    if _is_selected_postgres_targeted_structural_edit_request(request, payload):
        return _asgi_selected_postgres_structural_tag_edit_queue_finalize_save_task_builder(
            request
        )
    if _is_selected_postgres_library_browse_request(request) and _has_edit_tags_media_write_fields(payload):
        return _asgi_selected_postgres_media_write_queue_finalize_save_task_builder(request)

    if not _is_postgres_edit_tags_exception_only_response_request(request, payload):
        return _asgi_bridge_queue_finalize_save_task_builder(
            request,
            wait_for_completion=True,
        )

    find_albums = _postgres_album_finder_for_track_paths(request)
    skip_problematic_album_refresh = payload.get("problematic_files_origin") is not True

    def queue_finalize_with_postgres_album_finder(**kwargs: Any) -> None:
        _bridge_queue_finalize_save_task(
            get_state=lambda: _library_state(request),
            find_albums_by_track_paths=find_albums,
            **(
                {
                    "find_problematic_album_by_track_paths": (
                        _empty_problematic_album_by_track_paths
                    )
                }
                if skip_problematic_album_refresh
                else {}
            ),
            scoped_postgres_exception_only=True,
            wait_for_completion=True,
            **kwargs,
        )

    return queue_finalize_with_postgres_album_finder


def _authoritative_edit_tags_response(
    result: ResponseValue,
    *,
    total_ms: float,
) -> ResponseValue:
    if isinstance(result, tuple) or not result.get("ok"):
        return result
    task_id = str(result.get("save_task_id") or "").strip()
    if not task_id:
        return result
    response = dict(result)
    response_timings = dict(response.get("timings") or {})
    response_timings["total_ms"] = round(total_ms, 3)
    response["timings"] = response_timings
    task = save_task_result(task_id)
    status = str(task.get("status") or "missing")
    if status != "completed":
        error = str(task.get("error") or "").strip()
        if not error:
            error = (
                "Tag edits were written but authoritative persistence did not "
                f"complete (save task status: {status})."
            )
        failure_response = {
            "ok": False,
            "error": error,
            "save_task_id": task_id,
            "save_task_status": status,
            "timings": response_timings,
        }
        task_log_entry = task.get("log_entry")
        if isinstance(task_log_entry, Mapping):
            failure_response["log_entry"] = dict(task_log_entry)
        return failure_response, 500

    for key in (
        "updated_albums",
        "updated_problematic_album",
        "requires_view_refresh",
        "warnings",
    ):
        if key in task:
            response[key] = task[key]
    if "committed_values" not in response and "committed_values" in task:
        response["committed_values"] = task["committed_values"]
    task_timings = dict(task.get("timings") or {})
    response_timings.update(task_timings)
    response_timings["total_ms"] = round(total_ms, 3)
    response["timings"] = response_timings
    response["save_task_status"] = "completed"
    return response


@router.post("/utilities/rules/version-exceptions/revert")
async def revert_version_exception(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    config = _app_config(request)
    _ignored, mutation_error = revert_rule_key(
        config,
        payload.get("album_key"),
        missing_error="Missing album key",
        load_keys=load_ignored_version_keys,
        save_keys=save_ignored_version_keys,
    )
    if mutation_error:
        return _json_response(({"ok": False, "error": mutation_error}, 400))
    invalidate_utility_rules_payload_cache(_library_state(request))
    return JSONResponse(_current_rules_payload(request, "ignored_versions"))


@router.post("/utilities/rules/problem-ignores/revert")
async def revert_problem_ignore(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    config = _app_config(request)
    try:
        row_key = revert_problem_exclusion(config, payload.get("row_key"))
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    log_app_event(
        config,
        _asgi_logger(request),
        "Problem exclusion reverted",
        level="info",
        history=True,
        row_key=row_key,
    )
    return JSONResponse({"ok": True, "reverted_row_key": row_key})


@router.post("/utilities/rules/problem-ignores")
async def create_problem_ignores(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    config = _app_config(request)
    repository = PostgresLibraryBrowseRepository(config)
    try:
        result = create_problem_exclusions(
            config,
            payload,
            resolve_items=repository.resolve_problem_exclusion_items,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    log_app_event(
        config,
        _asgi_logger(request),
        "Problem exclusion created",
        level="info",
        history=True,
        row_keys=[str(item.get("row_key") or "") for item in result.applied_items],
        migrated_legacy_row_keys=list(result.removed_legacy_row_keys),
    )
    return JSONResponse({
        "ok": True,
        "applied_items": result.applied_items,
        "removed_legacy_row_keys": result.removed_legacy_row_keys,
    })


@router.post("/versions/ignore")
async def ignore_album_version(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    config = _app_config(request)
    ignored, mutation_error = create_version_exception(
        config,
        payload.get("album_key"),
        load_keys=load_ignored_version_keys,
        save_keys=save_ignored_version_keys,
    )
    if mutation_error:
        return _json_response(({"ok": False, "error": mutation_error}, 400))
    invalidate_utility_rules_payload_cache(_library_state(request))
    album_key = str(payload.get("album_key") or "").strip()
    log_app_event(
        config,
        _asgi_logger(request),
        "Version exception created",
        level="info",
        album_key=album_key,
    )
    return JSONResponse({"ok": True, "ignored_version_keys": sorted(ignored)})


@router.post("/versions/mark")
async def mark_album_version(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())

    config = _app_config(request)
    library_state = _library_state(request)
    logger = _asgi_logger(request)
    album_key, parent_album_key, mutation_error = validate_manual_version_link_keys(
        payload.get("album_key"),
        payload.get("parent_album_key"),
    )
    if mutation_error:
        return _json_response(({"ok": False, "error": mutation_error}, 400))

    hydrate_cached_library_for_rules(library_state, config, logger)
    all_albums = {
        str(getattr(album, "key", "") or ""): album
        for album in list(library_state.get("albums", []))
        if str(getattr(album, "key", "") or "")
    }
    album = all_albums.get(album_key)
    parent_album = all_albums.get(parent_album_key)
    if album is None or parent_album is None:
        return _json_response(({"ok": False, "error": "Album could not be found"}, 404))

    relation_views = library_state.get("relation_views", {})
    alias_to_canonical = relation_views.get("alias_to_canonical", {}) if isinstance(relation_views, dict) else {}
    if not albums_share_any_artist(album, parent_album, alias_to_canonical):
        return _json_response(({"ok": False, "error": "Versions must share at least one artist"}, 400))

    existing_manual_version_links = load_manual_version_links(config)
    candidate_root = resolve_manual_version_root(parent_album_key, existing_manual_version_links)
    if candidate_root == album_key:
        return _json_response(({"ok": False, "error": "That version link would create a cycle"}, 400))

    manual_version_links, mutation_error = mark_manual_version_link(
        config,
        album_key,
        parent_album_key,
        load_links=load_manual_version_links,
        save_links=save_manual_version_links,
    )
    if mutation_error:
        return _json_response(({"ok": False, "error": mutation_error}, 400))
    log_app_event(
        config,
        logger,
        "Manual version link created",
        level="info",
        album_key=album_key,
        parent_album_key=parent_album_key,
    )
    return JSONResponse({"ok": True, "manual_version_links": manual_version_links})


@router.post("/versions/unmark")
async def unmark_album_version(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    config = _app_config(request)
    logger = _asgi_logger(request)
    album_key = str(payload.get("album_key") or "").strip()
    manual_version_links, mutation_error = unmark_manual_version_link(
        config,
        payload.get("album_key"),
        load_links=load_manual_version_links,
        save_links=save_manual_version_links,
    )
    if mutation_error:
        status_code = 400 if mutation_error == "Missing album key" else 404
        return _json_response(({"ok": False, "error": mutation_error}, status_code))
    log_app_event(
        config,
        logger,
        "Manual version link removed",
        level="info",
        album_key=album_key,
    )
    return JSONResponse({"ok": True, "manual_version_links": manual_version_links})


@router.post("/utilities/move-album")
async def utilities_move_album(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    if not payload.get("confirmed"):
        return _json_response(_invalid_payload_response("Move was not confirmed"))

    action = str(payload.get("action") or "").strip()
    if not action:
        return _json_response(_invalid_payload_response("No move action was provided"))

    album_key = str(payload.get("album_key") or "").strip()
    requested_track_paths = None
    if not album_key:
        album, album_error = _require_album_payload(payload)
        if album_error is not None:
            return _json_response(album_error)
        requested_track_paths, track_error = _require_album_track_paths(album)
        if track_error is not None:
            return _json_response(track_error)

    try:
        return _json_response(
            execute_album_move(
                action=action,
                album_key=album_key or None,
                requested_track_paths=requested_track_paths,
                config=_app_config(request),
                logger=_asgi_logger(request),
                get_state=lambda: _library_state(request),
                rebuild_affected_albums_in_state=_rebuild_affected_albums_in_state,
                find_albums_by_track_paths=_asgi_albums_by_track_paths_finder(request),
                find_problematic_album_by_track_paths=_asgi_problematic_album_by_track_paths_finder(request),
            )
        )
    except AlbumMoveError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, exc.status_code))


@router.get("/utilities/save-task/{task_id}")
async def utilities_save_task(task_id: str) -> JSONResponse:
    payload = save_task_result(str(task_id or "").strip())
    if not payload:
        return _json_response(_task_not_found_response("Save task"))
    return JSONResponse({"ok": True, **payload})


@router.post("/utilities/repair-album")
async def utilities_repair_album(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None or not payload.get("confirmed"):
        return _json_response(({"ok": False, "error": "Repair was not confirmed"}, 400))
    payload = _normalize_asgi_repair_album_payload(payload)

    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    requested_track_paths, track_error = _require_album_track_paths(album)
    if track_error is not None:
        return _json_response(track_error)
    find_problematic_album, find_albums = _repair_album_embedded_response_matchers(request, payload)
    queue_finalize_save_task = _asgi_bridge_queue_finalize_save_task_builder(request)
    if _is_selected_postgres_library_browse_request(request) and _has_repair_album_media_write_rows(payload):
        queue_finalize_save_task = _asgi_selected_postgres_media_write_queue_finalize_save_task_builder(request)
    result = handle_repair_album_request(
        payload=payload,
        album=album,
        requested_track_paths=requested_track_paths,
        config=_app_config(request),
        logger=_asgi_logger(request),
        get_state=lambda: _library_state(request),
        create_save_task=create_save_task,
        queue_finalize_save_task=queue_finalize_save_task,
        build_text_repairs_for_entry=build_text_repairs_for_entry,
        build_artist_alias_repairs_for_entry=_build_artist_alias_repairs_for_entry,
        build_disc_marker_repairs_for_entry=_build_disc_marker_repairs_for_entry,
        apply_repairs_worker=_apply_repairs_worker,
        update_cache_entry_after_repairs=_asgi_cache_entry_updater(request),
        build_affected_album_dicts=_repair_album_affected_album_dicts_builder(request, payload),
        find_problematic_album_by_track_paths=find_problematic_album,
        find_albums_by_track_paths=find_albums,
        rebuild_affected_albums_in_state=_rebuild_affected_albums_in_state,
        load_ignored_repair_keys=load_ignored_repair_keys,
        save_ignored_repair_keys=save_ignored_repair_keys,
        load_separate_release_keys=load_separate_release_keys,
        save_separate_release_keys=save_separate_release_keys,
        append_log_history=append_log_history,
        log_app_event=log_app_event,
        structural_edit_fields=set(_STRUCTURAL_EDIT_FIELDS),
        edit_write_workers=_EDIT_WRITE_WORKERS,
    )
    if _is_selected_postgres_library_browse_request(request) and _has_repair_album_media_write_rows(payload):
        result = _selected_postgres_media_write_response(result)
    return _json_response(result)


@router.post("/utilities/edit-tags")
async def utilities_edit_tags(request: Request) -> JSONResponse:
    request_started = perf_counter()
    payload = await _json_payload(request)
    if payload is None or not payload.get("confirmed"):
        return _json_response(({"ok": False, "error": "Tag edit was not confirmed"}, 400))

    album, album_error = _require_album_payload(payload)
    updates = payload.get("updates")
    if album_error is not None:
        return _json_response(album_error)
    if not isinstance(updates, dict) or not updates:
        return _json_response(({"ok": False, "error": "No tag edits were provided"}, 400))

    album_track_path_set, _track_error = _require_album_track_paths(album)
    requested_track_paths = (album_track_path_set or set()) | {str(path) for path in updates.keys() if str(path)}
    postgres_targeted_structural_edit = (
        _is_selected_postgres_targeted_structural_edit_request(
            request,
            payload,
        )
    )
    reservation_resource_keys = _edit_tags_reservation_resource_keys(
        album,
        updates,
    )
    config = _app_config(request)
    logger = _asgi_logger(request)
    library_state = _library_state(request)
    get_state = lambda: library_state
    postgres_exception_only = _is_postgres_edit_tags_exception_only_response_request(
        request,
        payload,
    )
    if postgres_exception_only:
        try:
            postgres_edit_state = _postgres_exception_only_edit_state(request, payload)
        except ValueError as exc:
            return _json_response(({"ok": False, "error": str(exc)}, 400))
        get_state = lambda: postgres_edit_state
    build_affected_album_dicts = _edit_tags_affected_album_dicts_builder(request, payload)
    if _is_selected_postgres_library_browse_request(request) and _has_edit_tags_media_write_fields(payload):
        build_affected_album_dicts = _empty_affected_album_dicts
    handler_options = {
        "album": album,
        "updates": updates,
        "requested_track_paths": requested_track_paths,
        "config": config,
        "logger": logger,
        "get_state": get_state,
        "create_save_task": create_save_task,
        "queue_finalize_save_task": _edit_tags_queue_finalize_save_task_builder(
            request,
            payload,
        ),
        "apply_repairs_worker": _apply_repairs_worker,
        "update_cache_entry_after_repairs": _asgi_cache_entry_updater(request),
        "build_affected_album_dicts": build_affected_album_dicts,
        "load_separate_release_keys": load_separate_release_keys,
        "normalize_exception_value": normalize_exception_value,
        "append_log_history": append_log_history,
        "log_app_event": log_app_event,
        "structural_edit_fields": set(_STRUCTURAL_EDIT_FIELDS),
        "edit_write_workers": _EDIT_WRITE_WORKERS,
        "save_track_exception_override": set_track_exception_override,
        "save_track_exception_overrides": (
            set_track_exception_overrides
            if postgres_exception_only
            else None
        ),
        "prevalidate_structural_tag_edit": (
            lambda **options: validate_structural_tag_edit_for_config(
                config,
                **options,
            )
        )
        if postgres_targeted_structural_edit
        else None,
        "prepare_tag_edit_intent": (
            lambda *, changes: PostgresTagEditIntentRepository(config).prepare_intent(
                library_root_identity=library_root_cache_identity(config),
                changes=changes,
            )
        ),
        "mark_tag_edit_files_verified": (
            lambda intent_id: PostgresTagEditIntentRepository(config).mark_files_verified(
                intent_id
            )
        ),
    }
    structural_tag_edit_reservation = (
        await acquire_structural_tag_edit_reservation_async(
            reservation_resource_keys
        )
        if reservation_resource_keys
        else None
    )
    result = await _run_edit_tags_handler_with_reservation(
        handler_options,
        structural_tag_edit_reservation,
    )
    result = _authoritative_edit_tags_response(
        result,
        total_ms=(perf_counter() - request_started) * 1000.0,
    )
    if _is_selected_postgres_library_browse_request(request) and _has_edit_tags_media_write_fields(payload):
        result = _selected_postgres_media_write_response(result)
    return _json_response(result)
