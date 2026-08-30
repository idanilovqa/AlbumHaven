from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_cover_helpers import (
    apply_cover_path_for_tracks,
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_tasks,
    mark_cover_lookup_task_notification_action_taken,
    persist_cover_selection_for_tracks,
)
from music_app.services import state as state_service
from music_app.services.app_logging import log_app_event
from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)
from music_app.services.cover_state import (
    active_cover_path_for_track_paths as active_cover_path_for_track_paths_in_state,
    apply_authoritative_local_cover_fallback,
    find_albums_by_track_paths as find_albums_by_track_paths_in_state,
    resolve_authoritative_album_track_paths,
    serialize_cover_candidate_snapshot,
    serialize_cover_gallery_payload,
)
from music_app.services.cover_lookup_jobs import build_cover_lookup_job_contract
from music_app.services.cover_lookup_runtime import (
    fetch_remote_cover_bytes,
    merge_lookup_matches,
    queue_cover_lookup_save_remote_task,
    queue_cover_lookup_task,
)
from music_app.services.cover_lookup_tasks import (
    cancel_cover_lookup_task_payload,
    cover_lookup_result,
    create_cover_lookup_task,
    serialize_cover_lookup_task_payload,
    update_cover_lookup_task,
)
from music_app.services.cover_manual_links import add_manual_cover_candidates_from_urls
from music_app.services.cover_refresh_runtime import (
    cancel_cover_refresh_status,
    start_manual_cover_refresh_request,
)
from music_app.services.cover_workflow import (
    begin_local_image_promotion,
    complete_local_image_promotion,
    cover_revision_for_path,
    delete_local_cover_and_choose_next,
    resolve_album_context,
    rollback_local_image_promotion,
    save_pasted_image_as_authoritative_cover,
    validate_local_cover_source,
)
from music_app.services.covers import image_dimensions, score_image
from music_app.services.repair_previews import (
    find_problematic_album_by_track_paths as find_problematic_album_by_track_paths_in_state,
)


router = APIRouter()
LOGGER = logging.getLogger(__name__)

JsonDict = dict[str, object]
ResponseValue = JsonDict | tuple[JsonDict, int]


def _app_config(request: Request):
    return request.app.state.config


def _app_logger(request: Request):
    return getattr(request.app.state, "logger", None) or LOGGER


def _log_local_cover_persistence_event(config, logger, message: str, **fields) -> None:
    try:
        log_app_event(
            config,
            logger,
            message,
            history=True,
            **fields,
        )
    except Exception:
        # Operational history is evidence, not part of the cover persistence transaction.
        return


def _authoritative_local_cover_album_payload(
    album: Mapping[str, object],
    cover_path,
    cover_revision: str,
) -> JsonDict:
    remote_fields = (
        "remote_cover_url",
        "remote_cover_thumbnail_url",
        "remote_cover_source",
        "remote_cover_source_label",
        "remote_cover_album_url",
        "remote_cover_width",
        "remote_cover_height",
    )
    authoritative_album = dict(album)
    authoritative_album["cover_path"] = str(cover_path)
    authoritative_album["cover_revision"] = cover_revision
    for field in remote_fields:
        authoritative_album[field] = None
    authoritative_tracks: list[JsonDict] = []
    for track in list(album.get("tracks") or []):
        if not isinstance(track, Mapping):
            continue
        authoritative_track = dict(track)
        authoritative_track["cover_path"] = str(cover_path)
        authoritative_track["cover_revision"] = cover_revision
        for field in remote_fields:
            authoritative_track[field] = None
        authoritative_tracks.append(authoritative_track)
    authoritative_album["tracks"] = authoritative_tracks
    return authoritative_album


def _library_state(request: Request) -> dict[str, object]:
    return getattr(request.app.state, "library_state", {}) or {}


async def _json_payload(request: Request) -> JsonDict | None:
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    return payload if isinstance(payload, dict) else None


def _json_response(value: ResponseValue) -> JSONResponse:
    if isinstance(value, tuple):
        payload, status_code = value
        return JSONResponse(payload, status_code=status_code)
    return JSONResponse(value)


def _invalid_payload_response(error: str = "Invalid payload", status_code: int = 400) -> tuple[JsonDict, int]:
    return {"ok": False, "error": error}, status_code


def _task_not_found_response(task_name: str) -> tuple[JsonDict, int]:
    return _invalid_payload_response(f"{task_name} not found", 404)


def _require_album_payload(payload: Mapping[str, object] | None) -> tuple[JsonDict | None, tuple[JsonDict, int] | None]:
    album = payload.get("album") if isinstance(payload, Mapping) else None
    if not isinstance(album, dict):
        return None, _invalid_payload_response("Invalid album payload")
    return album, None


def _album_track_paths(album: Mapping[str, object] | None) -> set[str]:
    tracks = album.get("tracks", []) if isinstance(album, Mapping) else []
    return {
        str(track.get("path") or "")
        for track in tracks
        if isinstance(track, Mapping) and str(track.get("path") or "")
    }


def _require_album_track_paths(
    album: Mapping[str, object] | None,
    *,
    error_message: str = "Album does not contain any tracks",
) -> tuple[set[str] | None, tuple[JsonDict, int] | None]:
    track_paths = _album_track_paths(album)
    if not track_paths:
        return None, _invalid_payload_response(error_message)
    return track_paths, None


def _clean_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item or "").strip() for item in value if str(item or "").strip()]


def _is_squareish_cover(width: int, height: int) -> bool:
    if width <= 0 or height <= 0:
        return False
    return abs(width - height) / max(width, height) <= 0.18


def _serialize_cover_gallery_from_asgi(
    request: Request,
    album_root,
    track_paths: set[str],
    task_id: str = "",
    candidate_snapshot: Mapping[str, object] | None = None,
) -> dict[str, object]:
    config = _app_config(request)
    task_payload = serialize_cover_lookup_task_payload(cover_lookup_result(task_id) if task_id else {})
    return serialize_cover_gallery_payload(
        album_root=album_root,
        track_paths=track_paths,
        file_cache=_library_state(request).get("file_cache", {}) or {},
        image_extensions=set(config["IMAGE_EXTENSIONS"]),
        image_dimensions=image_dimensions,
        is_squareish_cover=_is_squareish_cover,
        task_payload=task_payload,
        candidate_snapshot=candidate_snapshot,
    )


def _album_id(album: Mapping[str, object]) -> int | None:
    raw_album_id = album.get("album_id", album.get("id"))
    try:
        album_id = int(raw_album_id)
    except (TypeError, ValueError):
        return None
    return album_id if album_id > 0 else None


def _candidate_snapshot_read_failure(diagnostic: str) -> dict[str, object]:
    return {
        "candidates": [],
        "search_kind": None,
        "status": None,
        "revision": 0,
        "best_candidate_id": None,
        "automatic_improvement_revision": 0,
        "seen_automatic_improvement_revision": 0,
        "diagnostic": diagnostic,
    }


def _resolved_snapshot_album_context(
    config: Mapping[str, object],
    album: Mapping[str, object],
    track_paths: set[str],
) -> tuple[
    AlbumCoverCandidateSnapshotRepository | None,
    int | None,
    tuple[JsonDict, int] | None,
]:
    repository = AlbumCoverCandidateSnapshotRepository(config)
    try:
        resolved_album_id = repository.resolve_album_id_for_track_paths(
            track_paths=track_paths
        )
    except Exception:
        return None, None, (
            {"ok": False, "error": "Album identity could not be resolved"},
            503,
        )
    supplied_album_id = _album_id(album)
    if resolved_album_id is None or (
        supplied_album_id is not None and supplied_album_id != resolved_album_id
    ):
        return None, None, (
            {
                "ok": False,
                "error": "Album identity does not match the resolved track inventory",
            },
            409,
        )
    return repository, resolved_album_id, None


def _task_matches_album_context(
    task_payload: Mapping[str, object],
    *,
    repository: AlbumCoverCandidateSnapshotRepository,
    album_id: int,
    track_paths: set[str],
) -> bool:
    task_track_paths = {
        str(path or "").strip()
        for path in list(task_payload.get("track_paths") or [])
        if str(path or "").strip()
    }
    if task_track_paths != track_paths:
        return False
    try:
        return repository.resolve_album_id_for_track_paths(
            track_paths=task_track_paths
        ) == album_id
    except Exception:
        return False


@router.get("/utilities/cover-lookup/tasks")
async def utilities_cover_lookup_tasks(request: Request) -> JSONResponse:
    config = _app_config(request)
    return JSONResponse({"ok": True, "tasks": list_cover_lookup_tasks(config=config)})


@router.post("/utilities/cover-lookup/tasks/clear-completed")
async def utilities_cover_lookup_tasks_clear_completed(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    raw_task_ids = payload.get("task_ids") if isinstance(payload, dict) else None
    task_ids = _clean_string_list(raw_task_ids) if isinstance(raw_task_ids, list) else None
    config = _app_config(request)
    removed_count = clear_completed_cover_lookup_tasks(task_ids, config=config)
    return JSONResponse(
        {
            "ok": True,
            "removed_count": removed_count,
            "tasks": list_cover_lookup_tasks(config=config),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/clear")
async def utilities_cover_lookup_task_clear(request: Request, task_id: str) -> JSONResponse:
    normalized_id = str(task_id or "").strip()
    if not normalized_id:
        return _json_response(_task_not_found_response("Lookup task"))
    config = _app_config(request)
    removed_count = clear_completed_cover_lookup_tasks([normalized_id], config=config)
    if removed_count <= 0:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse(
        {
            "ok": True,
            "removed_count": removed_count,
            "tasks": list_cover_lookup_tasks(config=config),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/mark-action-taken")
async def utilities_cover_lookup_task_mark_action_taken(request: Request, task_id: str) -> JSONResponse:
    normalized_id = str(task_id or "").strip()
    if not normalized_id:
        return _json_response(_task_not_found_response("Lookup task"))
    config = _app_config(request)
    task = mark_cover_lookup_task_notification_action_taken(normalized_id, config=config)
    if task is None:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse({"ok": True, "task": task, "tasks": list_cover_lookup_tasks(config=config)})


@router.post("/utilities/cover-lookup/gallery")
async def utilities_cover_lookup_gallery(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    task_id = str(payload.get("task_id") or "").strip()
    repository, album_id, identity_error = _resolved_snapshot_album_context(
        config,
        album or {},
        album_context.track_paths,
    )
    if identity_error is not None:
        return _json_response(identity_error)
    task_payload = cover_lookup_result(task_id) if task_id else {}
    if task_payload and not _task_matches_album_context(
        task_payload,
        repository=repository,
        album_id=int(album_id),
        track_paths=album_context.track_paths,
    ):
        return _json_response(
            ({"ok": False, "error": "Lookup task does not belong to this album"}, 409)
        )
    try:
        candidate_snapshot = repository.get_for_album_context(album_id=int(album_id))
    except Exception:
        candidate_snapshot = _candidate_snapshot_read_failure(
            "candidate_snapshot_read_failed"
        )
    return JSONResponse(
        _serialize_cover_gallery_from_asgi(
            request,
            album_context.album_root,
            album_context.track_paths,
            task_id,
            candidate_snapshot,
        )
    )


@router.post("/utilities/cover-lookup/gallery/mark-seen")
async def utilities_cover_lookup_gallery_mark_seen(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(
            ({"ok": False, "error": "Album root could not be resolved"}, 400)
        )
    album_id = _album_id(album or {})
    repository, album_id, identity_error = _resolved_snapshot_album_context(
        config,
        album or {},
        album_context.track_paths,
    )
    if identity_error is not None:
        return _json_response(identity_error)
    try:
        candidate_snapshot = repository.mark_seen(album_id=album_id)
    except Exception:
        try:
            candidate_snapshot = repository.get_for_album_context(album_id=album_id)
        except Exception:
            candidate_snapshot = None
        failed_snapshot = dict(
            candidate_snapshot
            or _candidate_snapshot_read_failure("mark_seen_failed")
        )
        failed_snapshot["diagnostic"] = "mark_seen_failed"
        gallery_snapshot = serialize_cover_candidate_snapshot(failed_snapshot)
        return JSONResponse(
            {"ok": False, "candidate_snapshot": gallery_snapshot},
            status_code=503,
        )

    gallery_snapshot = serialize_cover_candidate_snapshot(candidate_snapshot)
    return JSONResponse({"ok": True, "candidate_snapshot": gallery_snapshot})


@router.post("/utilities/cover-lookup/start")
async def utilities_cover_lookup_start(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    manual_urls = _clean_string_list(payload.get("manual_urls"))
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album does not contain any tracks"}, 400))
    task_id = queue_cover_lookup_task(
        album or {},
        album_context.track_paths,
        manual_urls,
        config=config,
        logger=logger,
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
    )
    log_app_event(
        config,
        logger,
        "Cover lookup task queued",
        level="info",
        task_id=task_id,
        artist=str((album or {}).get("album_artist") or ""),
        album=str((album or {}).get("name") or (album or {}).get("album") or ""),
        year=(album or {}).get("year"),
        edition=str((album or {}).get("edition") or ""),
    )
    return JSONResponse(
        {
            "ok": True,
            "task": serialize_cover_lookup_task_payload(cover_lookup_result(task_id)),
            "gallery": _serialize_cover_gallery_from_asgi(
                request,
                album_context.album_root,
                album_context.track_paths,
                task_id,
            ),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/cancel")
async def utilities_cover_lookup_cancel(request: Request, task_id: str) -> JSONResponse:
    task_payload = cancel_cover_lookup_task_payload(task_id, config=_app_config(request))
    if task_payload is None:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse({"ok": True, "task": task_payload})


@router.post("/utilities/cover-lookup/local-select")
async def utilities_cover_lookup_local_select(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    source_path = str(payload.get("source_path") or "").strip()
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    try:
        authoritative_track_paths = resolve_authoritative_album_track_paths(
            library_state,
            album_context.track_paths,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 409))
    try:
        resolved = validate_local_cover_source(config, album_context.album_root, source_path)
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except FileNotFoundError:
        return _json_response(({"ok": False, "error": "Selected image was not found"}, 404))
    promotion = begin_local_image_promotion(
        resolved,
        album_context.album_root,
        serialize_selection=True,
    )
    authoritative_cover = promotion.cover_path
    updated_albums: list[dict[str, object]] = []
    updated_problematic_album = None
    runtime_refresh_error: Exception | None = None
    runtime_fallback_error: Exception | None = None
    commit_guard_called = False
    database_commit_completed = False

    def refresh_runtime_state() -> None:
        nonlocal updated_albums, updated_problematic_album
        nonlocal runtime_refresh_error, runtime_fallback_error
        try:
            updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
                authoritative_track_paths,
                authoritative_cover,
                config=config,
                logger=logger,
                library_state=library_state,
                cover_revision=cover_revision,
                schedule_cache_update=False,
            )
        except Exception as exc:
            runtime_refresh_error = exc
            try:
                apply_authoritative_local_cover_fallback(
                    library_state=library_state,
                    track_paths=authoritative_track_paths,
                    cover_path=authoritative_cover,
                    cover_revision=cover_revision,
                )
            except Exception as fallback_exc:
                runtime_fallback_error = fallback_exc

    def commit_cover_selection(commit_action) -> object:
        nonlocal commit_guard_called
        commit_guard_called = True

        def commit_and_refresh_runtime_state() -> object:
            nonlocal database_commit_completed
            commit_result = commit_action()
            database_commit_completed = True
            refresh_runtime_state()
            return commit_result

        return state_service.run_authoritative_cover_commit_for_state(
            library_state,
            commit_and_refresh_runtime_state,
        )

    try:
        cover_revision = cover_revision_for_path(authoritative_cover)
        persistence_result = persist_cover_selection_for_tracks(
            authoritative_track_paths,
            authoritative_cover,
            config=config,
            logger=logger,
            cover_revision=cover_revision,
            cover_selection_origin="user",
            commit_guard=commit_cover_selection,
        )
    except Exception as exc:
        if database_commit_completed:
            complete_local_image_promotion(promotion)
            _log_local_cover_persistence_event(
                config,
                logger,
                "Local cover post-commit finalization failed",
                level="error",
                artist=str((album or {}).get("album_artist") or "").strip(),
                album=str((album or {}).get("name") or "").strip(),
                year=(album or {}).get("year"),
                target_filename=authoritative_cover.name,
                error_kind=type(exc).__name__,
            )
            return _json_response(
                (
                    {
                        "ok": False,
                        "persisted": True,
                        "selected_cover_path": str(authoritative_cover),
                        "cover_revision": cover_revision,
                        "error": "Selected cover art was persisted, but runtime state could not be finalized. Reload the app.",
                    },
                    500,
                )
            )
        try:
            rollback_local_image_promotion(promotion)
        except Exception as rollback_exc:
            _log_local_cover_persistence_event(
                config,
                logger,
                "Local cover promotion rollback failed",
                level="error",
                artist=str((album or {}).get("album_artist") or "").strip(),
                album=str((album or {}).get("name") or "").strip(),
                year=(album or {}).get("year"),
                target_filename=authoritative_cover.name,
                error_kind=type(rollback_exc).__name__,
            )
        _log_local_cover_persistence_event(
            config,
            logger,
            "Local cover selection persistence failed",
            level="error",
            artist=str((album or {}).get("album_artist") or "").strip(),
            album=str((album or {}).get("name") or "").strip(),
            year=(album or {}).get("year"),
            target_filename=authoritative_cover.name,
            error_kind=type(exc).__name__,
        )
        return _json_response(
            ({"ok": False, "error": "Selected cover art could not be persisted."}, 500)
        )
    try:
        if not commit_guard_called:
            state_service.run_authoritative_cover_commit_for_state(
                library_state,
                refresh_runtime_state,
            )
    finally:
        # The per-album promotion lock covers filesystem promotion through the
        # committed runtime-state patch, but not logging or response shaping.
        complete_local_image_promotion(promotion)
    if runtime_refresh_error is not None:
        updated_albums = [
            _authoritative_local_cover_album_payload(
                album or {},
                authoritative_cover,
                cover_revision,
            )
        ]
        updated_problematic_album = None
        _log_local_cover_persistence_event(
            config,
            logger,
            "Local cover runtime refresh failed",
            level="error",
            artist=str((album or {}).get("album_artist") or "").strip(),
            album=str((album or {}).get("name") or "").strip(),
            year=(album or {}).get("year"),
            target_filename=authoritative_cover.name,
            error_kind=type(runtime_refresh_error).__name__,
        )
    interrupted_scan_mode = (
        state_service.take_cover_selection_interrupted_scan_mode_for_state(
            library_state
        )
    )
    if interrupted_scan_mode is not None:
        state_service.start_background_refresh_for_state(
            library_state,
            config,
            logger,
            force=True,
            scan_mode=interrupted_scan_mode,
        )
    if runtime_fallback_error is not None:
        _log_local_cover_persistence_event(
            config,
            logger,
            "Local cover authoritative runtime fallback failed",
            level="error",
            artist=str((album or {}).get("album_artist") or "").strip(),
            album=str((album or {}).get("name") or "").strip(),
            year=(album or {}).get("year"),
            target_filename=authoritative_cover.name,
            error_kind=type(runtime_fallback_error).__name__,
        )
        return _json_response(
            (
                {
                    "ok": False,
                    "persisted": True,
                    "selected_cover_path": str(authoritative_cover),
                    "cover_revision": cover_revision,
                    "error": "Selected cover art was persisted, but runtime state could not be refreshed. Reload the app.",
                },
                500,
            )
        )
    _log_local_cover_persistence_event(
        config,
        logger,
        "Local cover selection persisted",
        level="info",
        artist=str((album or {}).get("album_artist") or "").strip(),
        album=str((album or {}).get("name") or "").strip(),
        year=(album or {}).get("year"),
        target_filename=authoritative_cover.name,
        album_rows_updated=int(persistence_result.get("album_rows_updated") or 0),
        track_file_rows_updated=int(persistence_result.get("track_file_rows_updated") or 0),
    )
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(authoritative_cover),
            "cover_revision": cover_revision,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "gallery": _serialize_cover_gallery_from_asgi(
                request,
                album_context.album_root,
                authoritative_track_paths,
            ),
        }
    )


@router.post("/utilities/cover-lookup/local-delete")
async def utilities_cover_lookup_local_delete(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    source_path = str(payload.get("source_path") or "").strip()
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    try:
        resolved = validate_local_cover_source(config, album_context.album_root, source_path)
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except FileNotFoundError:
        return _json_response(({"ok": False, "error": "Selected image was not found"}, 404))
    deleted_cover_bytes = resolved.read_bytes()
    next_cover = delete_local_cover_and_choose_next(
        album_root=album_context.album_root,
        source_path=resolved,
        active_cover_path=active_cover_path_for_track_paths_in_state(
            library_state.get("file_cache", {}) or {},
            album_context.track_paths,
        ),
        image_extensions=set(config["IMAGE_EXTENSIONS"]),
        image_dimensions=image_dimensions,
        is_squareish_cover=_is_squareish_cover,
        score_image=score_image,
    )
    try:
        persist_cover_selection_for_tracks(
            album_context.track_paths,
            next_cover,
            config=config,
            logger=logger,
            cover_selection_origin="user" if next_cover is not None else None,
            clear_selection=next_cover is None,
        )
    except Exception:
        resolved.write_bytes(deleted_cover_bytes)
        raise
    updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
        album_context.track_paths,
        next_cover,
        config=config,
        logger=logger,
        library_state=library_state,
    )
    return JSONResponse(
        {
            "ok": True,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "gallery": _serialize_cover_gallery_from_asgi(
                request,
                album_context.album_root,
                album_context.track_paths,
            ),
        }
    )


@router.post("/utilities/cover-lookup/pasted-image-save")
async def utilities_cover_lookup_pasted_image_save(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    data_url = str(payload.get("data_url") or "").strip()
    if not data_url:
        return _json_response(({"ok": False, "error": "Clipboard image payload is missing"}, 400))
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    authoritative_cover_path = album_context.album_root / "cover.jpg"
    prior_cover_bytes = (
        authoritative_cover_path.read_bytes()
        if authoritative_cover_path.is_file()
        else None
    )
    try:
        saved_cover_path = save_pasted_image_as_authoritative_cover(data_url, album_context.album_root)
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except Exception as exc:
        return _json_response(({"ok": False, "error": str(exc or "Failed to save pasted image.")}, 500))
    try:
        persist_cover_selection_for_tracks(
            album_context.track_paths,
            saved_cover_path,
            config=config,
            logger=logger,
            cover_selection_origin="user",
        )
    except Exception:
        if prior_cover_bytes is None:
            saved_cover_path.unlink(missing_ok=True)
        else:
            saved_cover_path.write_bytes(prior_cover_bytes)
        raise
    updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
        album_context.track_paths,
        saved_cover_path,
        config=config,
        logger=logger,
        library_state=library_state,
    )
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(saved_cover_path),
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "gallery": _serialize_cover_gallery_from_asgi(
                request,
                album_context.album_root,
                album_context.track_paths,
            ),
        }
    )


@router.post("/utilities/cover-lookup/save-remote")
async def utilities_cover_lookup_save_remote(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    task_id = str(payload.get("task_id") or "").strip()
    candidate_id = str(payload.get("candidate_id") or "").strip()
    snapshot_generation = str(payload.get("snapshot_generation") or "").strip()
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    task_payload = cover_lookup_result(task_id)
    selected_match = None
    if task_payload:
        repository, album_id, identity_error = _resolved_snapshot_album_context(
            config,
            album or {},
            album_context.track_paths,
        )
        if identity_error is not None:
            return _json_response(identity_error)
        if not _task_matches_album_context(
            task_payload,
            repository=repository,
            album_id=int(album_id),
            track_paths=album_context.track_paths,
        ):
            return _json_response(
                ({"ok": False, "error": "Lookup task does not belong to this album"}, 409)
            )
        matches = (
            task_payload.get("possible_matches")
            if isinstance(task_payload.get("possible_matches"), list)
            else []
        )
        selected_match = next(
            (
                item
                for item in matches
                if isinstance(item, dict) and str(item.get("id") or "") == candidate_id
            ),
            None,
        )
    if selected_match is None and snapshot_generation:
        repository, album_id, identity_error = _resolved_snapshot_album_context(
            config,
            album or {},
            album_context.track_paths,
        )
        if identity_error is not None:
            return _json_response(identity_error)
        try:
            candidate_snapshot = repository.get_for_album_context(album_id=int(album_id))
        except Exception:
            return _json_response(
                ({"ok": False, "error": "Saved cover candidates are unavailable"}, 503)
            )
        if (
            not isinstance(candidate_snapshot, Mapping)
            or str(candidate_snapshot.get("search_generation") or "").strip()
            != snapshot_generation
        ):
            return _json_response(
                ({"ok": False, "error": "Saved cover candidate generation was not found"}, 404)
            )
        snapshot_candidates = candidate_snapshot.get("candidates")
        selected_match = next(
            (
                dict(item)
                for item in snapshot_candidates
                if isinstance(item, Mapping)
                and str(item.get("id") or "") == candidate_id
            ),
            None,
        ) if isinstance(snapshot_candidates, list) else None
        if selected_match:
            if not task_payload:
                task_id, _cancel_event = create_cover_lookup_task(
                    dict(album or {}),
                    album_context.track_paths,
                    internal=True,
                )
                task_payload = cover_lookup_result(task_id)
    if not task_payload:
        return _json_response(_task_not_found_response("Lookup task"))
    if not selected_match:
        return _json_response(({"ok": False, "error": "Selected remote candidate was not found"}, 404))
    if str(selected_match.get("art_kind") or "cover") != "cover":
        return _json_response(
            (
                {
                    "ok": False,
                    "error": "This remote image is preview-only and cannot be selected as the album cover",
                },
                400,
            )
        )
    update_cover_lookup_task(
        task_id,
        config=config,
        status="running",
        progress=92,
        progress_label="Saving selected cover art...",
        selected_candidate_id=candidate_id,
        notification_completed_at=str(
            task_payload.get("notification_completed_at") or task_payload.get("finished_at") or ""
        ).strip(),
        message="Saving selected cover art...",
        job_contract=build_cover_lookup_job_contract("save_remote_selection"),
    )
    response_task_payload = serialize_cover_lookup_task_payload(
        cover_lookup_result(task_id)
    )
    response_gallery_payload = _serialize_cover_gallery_from_asgi(
        request,
        album_context.album_root,
        album_context.track_paths,
        task_id,
    )
    queue_cover_lookup_save_remote_task(
        task_id,
        album_context.album_root,
        album_context.track_paths,
        candidate_id,
        selected_match,
        config=config,
        logger=logger,
        library_state=library_state,
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
        cover_selection_origin="user",
        apply_cover_selection_for_tracks=apply_cover_path_for_tracks,
        persist_cover_selection_for_tracks=persist_cover_selection_for_tracks,
    )
    return JSONResponse(
        {
            "ok": True,
            "queued": True,
            "optimistic_cover_path": ""
            if bool(selected_match.get("display_only"))
            else str(album_context.album_root / "cover.jpg"),
            "optimistic_remote_url": str(selected_match.get("url") or ""),
            "optimistic_remote_thumbnail_url": str(
                selected_match.get("thumbnail_url") or selected_match.get("url") or ""
            ),
            "optimistic_remote_source": str(selected_match.get("source") or ""),
            "optimistic_remote_source_label": str(selected_match.get("source_label") or ""),
            "optimistic_remote_album_url": str(selected_match.get("album_url") or ""),
            "optimistic_remote_width": int(selected_match.get("width") or 0),
            "optimistic_remote_height": int(selected_match.get("height") or 0),
            "task": response_task_payload,
            "gallery": response_gallery_payload,
        }
    )


@router.post("/utilities/cover-lookup/add-remote")
async def utilities_cover_lookup_add_remote(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    task_id = str(payload.get("task_id") or "").strip()
    raw_urls = payload.get("urls")
    if not isinstance(raw_urls, list):
        return _json_response(({"ok": False, "error": "Invalid URL payload"}, 400))
    cleaned_urls = _clean_string_list(raw_urls)
    if not cleaned_urls:
        return _json_response(({"ok": False, "error": "Paste at least one URL"}, 400))
    log_app_event(
        config,
        logger,
        "Manual cover link extraction requested",
        level="info",
        artist=str((album or {}).get("album_artist") or ""),
        album=str((album or {}).get("name") or (album or {}).get("album") or ""),
        task_id=task_id,
        url_count=len(cleaned_urls),
        urls=cleaned_urls,
    )
    album_context = resolve_album_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    matches = add_manual_cover_candidates_from_urls(
        cleaned_urls,
        target_artist=str((album or {}).get("album_artist") or ""),
        target_album=str((album or {}).get("name") or (album or {}).get("album") or ""),
        target_edition=str((album or {}).get("edition") or "").strip() or None,
        target_year=int((album or {}).get("year")) if isinstance((album or {}).get("year"), int) else None,
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
    )
    log_app_event(
        config,
        logger,
        "Manual cover link extraction completed",
        level="info",
        artist=str((album or {}).get("album_artist") or ""),
        album=str((album or {}).get("name") or (album or {}).get("album") or ""),
        task_id=task_id,
        url_count=len(cleaned_urls),
        match_count=len(matches),
    )
    if not matches:
        return _json_response(({"ok": False, "error": "No usable cover art could be extracted from those links"}, 400))
    if not task_id:
        task_id, _cancel_event = create_cover_lookup_task(album or {}, album_context.track_paths)
    task_payload = cover_lookup_result(task_id)
    merged_matches = merge_lookup_matches(
        task_payload.get("possible_matches") if isinstance(task_payload.get("possible_matches"), list) else [],
        matches,
    )
    update_cover_lookup_task(
        task_id,
        config=config,
        possible_matches=merged_matches,
        status="completed",
        progress=100,
        progress_label="Completed",
        message="Remote matches updated from pasted links.",
        result_kind="possible-matches",
        finished_at=datetime.now(timezone.utc).isoformat(),
    )
    return JSONResponse(
        {
            "ok": True,
            "task": serialize_cover_lookup_task_payload(cover_lookup_result(task_id)),
            "gallery": _serialize_cover_gallery_from_asgi(
                request,
                album_context.album_root,
                album_context.track_paths,
                task_id,
            ),
        }
    )


@router.get("/utilities/cover-lookup/remote-image")
async def utilities_cover_lookup_remote_image(request: Request) -> Response:
    image_url = str(request.query_params.get("url") or "").strip()
    if not image_url:
        return _json_response(({"ok": False, "error": "Missing remote image URL"}, 400))
    config = _app_config(request)
    payload, mime_type = await run_in_threadpool(
        fetch_remote_cover_bytes,
        image_url,
        config=config,
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
    )
    if payload is None:
        return _json_response(({"ok": False, "error": "Failed to load remote image"}, 502))
    return Response(payload, media_type=mime_type, headers={"Cache-Control": "public, max-age=3600"})


@router.post("/utilities/fetch-cover")
async def utilities_fetch_cover(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    requested_track_paths, track_error = _require_album_track_paths(album)
    if track_error is not None:
        return _json_response(track_error)
    try:
        result = state_service.refresh_cover_artwork_for_track_paths_for_state(
            library_state,
            config,
            logger,
            requested_track_paths or set(),
            force_search=True,
        )
    except Exception as exc:
        log_app_event(
            config,
            logger,
            "Cover art update failed",
            level="error",
            history=True,
            artist=str((album or {}).get("album_artist") or ""),
            album=str((album or {}).get("name") or (album or {}).get("album") or ""),
            error=str(exc),
            mode="manual",
        )
        return _json_response(({"ok": False, "error": str(exc)}, 500))
    updated_albums = find_albums_by_track_paths_in_state(
        library_state.get("albums", []) if isinstance(library_state, dict) else [],
        requested_track_paths or set(),
    )
    updated_problematic_album = find_problematic_album_by_track_paths_in_state(
        requested_track_paths or set(),
        config=config,
        library_state=library_state,
        logger=logger,
    )
    job_results = result.get("job_results") if isinstance(result, dict) else []
    return JSONResponse(
        {
            "ok": True,
            "mode": "manual-single",
            "force_search_used": True,
            "processed_count": int(result.get("processed") or 0),
            "downloaded_count": int(result.get("downloaded") or 0),
            "skipped_count": int(result.get("skipped") or 0),
            "failed_count": int(result.get("failed") or 0),
            "job_result": job_results[0] if isinstance(job_results, list) and job_results else None,
            "job_results": job_results if isinstance(job_results, list) else [],
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_albums": updated_albums,
            "updated_problematic_album": updated_problematic_album,
        }
    )


@router.post("/utilities/fetch-covers-unsuccessful")
async def utilities_fetch_covers_unsuccessful(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    force_search = bool(payload.get("force_search")) if isinstance(payload, dict) else False
    try:
        start_result = start_manual_cover_refresh_request(
            config=config,
            logger=logger,
            get_state=lambda: library_state,
            start_background_refresh=(
                lambda force=False, scan_mode="background": state_service.start_background_refresh_for_state(
                    library_state,
                    config,
                    logger,
                    force=force,
                    scan_mode=scan_mode,
                )
            ),
            get_file_cache_snapshot=lambda: state_service.cover_file_cache_snapshot_for_state(library_state),
            submit_cover_job=state_service._COVER_EXECUTOR.submit,
            refresh_unsuccessful_cover_artwork=(
                lambda force_search=False: state_service.refresh_unsuccessful_cover_artwork_for_state(
                    library_state,
                    config,
                    logger,
                    force_search=force_search,
                )
            ),
            force_search=force_search,
        )
    except Exception as exc:
        log_app_event(
            config,
            logger,
            "Cover art bulk update failed",
            level="error",
            history=True,
            error=str(exc),
            mode="manual-bulk",
        )
        return _json_response(({"ok": False, "error": str(exc)}, 500))
    return JSONResponse(
        {
            "ok": True,
            "mode": "manual-bulk",
            "started": bool(start_result.get("started")),
            "already_running": bool(start_result.get("already_running")),
            "queued_after_indexing": bool(start_result.get("queued_after_indexing")),
            "queued_count": int(start_result.get("queued_count") or 0),
            "current_folder": str(start_result.get("current_folder") or ""),
            "force_search_used": force_search,
            "processed_count": 0,
            "downloaded_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
            "job_results": [],
            "job_result_summary": [],
        }
    )


@router.post("/utilities/cancel-cover-scan")
async def utilities_cancel_cover_scan(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, **cancel_cover_refresh_status(get_state=lambda: _library_state(request))})
