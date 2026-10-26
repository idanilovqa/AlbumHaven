from __future__ import annotations

from music_app.services.log_history import history_scope_for_request

from collections.abc import Mapping
from datetime import datetime, timezone
import logging
from threading import Event
from time import perf_counter
from uuid import UUID

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_cover_helpers import (
    apply_cover_path_for_tracks,
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_task_summaries,
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
    count_local_cover_images,
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
    count_cover_lookup_task_notifications,
    cover_lookup_result,
    create_cover_lookup_task,
    is_terminal_cover_lookup_task,
    load_cover_lookup_task_summary_page,
    serialize_cover_lookup_task_payload,
    update_cover_lookup_task,
)
from music_app.services.cover_lookup_notifications import load_cover_lookup_notification
from music_app.services.cover_manual_links import add_manual_cover_candidates_from_urls
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.cover_provider_candidates import (
    DISPLAY_ONLY_REMOTE_SOURCES,
    is_provider_lookup_match,
    is_remote_cover_candidate_selectable,
)
from music_app.services.cover_refresh_runtime import (
    cancel_cover_refresh_status,
    start_manual_cover_refresh_request,
)
from music_app.services.cover_workflow import (
    CoverAlbumContext,
    begin_local_image_promotion,
    complete_local_image_promotion,
    cover_revision_for_path,
    delete_local_cover_and_choose_next,
    resolve_album_context,
    resolve_album_write_root_from_track_paths,
    rollback_local_image_promotion,
    save_pasted_image_as_authoritative_cover,
    validate_local_cover_source,
)
from music_app.services.covers import image_dimensions, score_image
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.repair_previews import build_problematic_album_detail_payload
from music_app.services.save_tasks import (
    acquire_structural_tag_edit_reservation,
    latest_structural_tag_edit_destination,
    structural_tag_edit_resource_keys,
)


router = APIRouter()
LOGGER = logging.getLogger(__name__)
_STRUCTURAL_RECONCILIATION_LOOKBACK_SECONDS = 30.0

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
    authoritative_album["cover_selection_origin"] = "user"
    authoritative_album["cover_selection_provenance"] = "explicit"
    width, height = image_dimensions(cover_path)
    authoritative_album["local_cover_width"] = width or None
    authoritative_album["local_cover_height"] = height or None
    for field in remote_fields:
        authoritative_album[field] = None
    authoritative_tracks: list[JsonDict] = []
    for track in list(album.get("tracks") or []):
        if not isinstance(track, Mapping):
            continue
        authoritative_track = dict(track)
        authoritative_track["cover_path"] = str(cover_path)
        authoritative_track["cover_revision"] = cover_revision
        authoritative_track["local_cover_width"] = width or None
        authoritative_track["local_cover_height"] = height or None
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


def _album_with_context_tracks(album: Mapping[str, object]) -> JsonDict:
    normalized_album = dict(album)
    if _album_track_paths(normalized_album):
        return normalized_album
    gallery_list_block = normalized_album.get("gallery_list_block")
    if not isinstance(gallery_list_block, Mapping):
        return normalized_album
    track_rows = gallery_list_block.get("track_rows")
    if isinstance(track_rows, list):
        normalized_album["tracks"] = track_rows
    return normalized_album


def _resolve_distributed_album_context(
    config: Mapping[str, object],
    album: Mapping[str, object],
) -> CoverAlbumContext | None:
    track_paths = _album_track_paths(album)
    if len(track_paths) < 2:
        return None
    album_root = resolve_album_write_root_from_track_paths(config, track_paths)
    if album_root is None:
        return None
    # One validated physical source owns file writes; the logical album keeps all tracks.
    return CoverAlbumContext(
        album_root=album_root,
        track_paths=track_paths,
    )


async def _resolve_album_payload_context(
    config: Mapping[str, object],
    album: Mapping[str, object],
    *,
    fallback_track_paths: set[str] | None = None,
):
    normalized_album = _album_with_context_tracks(album)
    repository = AlbumCoverCandidateSnapshotRepository(config)
    fallback_paths = {
        str(path or "").strip()
        for path in (fallback_track_paths or set())
        if str(path or "").strip()
    }
    resolved_context = resolve_album_context(config, normalized_album)
    if resolved_context is not None:
        return normalized_album, resolved_context
    if fallback_paths and not _album_track_paths(normalized_album):
        album_id = await run_in_threadpool(
            repository.resolve_album_id_for_track_paths,
            track_paths=fallback_paths,
        )
        if album_id is not None:
            track_context = await run_in_threadpool(
                repository.resolve_album_track_context,
                album_id=album_id,
                album_key=None,
            )
            if isinstance(track_context, Mapping):
                context_paths = {
                    str(path or "").strip()
                    for path in list(track_context.get("track_paths") or [])
                    if str(path or "").strip()
                }
                if (
                    str(track_context.get("album_key") or "").strip().casefold()
                    == "unknown artist::"
                    and fallback_paths < context_paths
                ):
                    normalized_album.pop("id", None)
                    normalized_album.pop("album_id", None)
                    normalized_album["tracks"] = [
                        {"path": path} for path in sorted(fallback_paths)
                    ]
                    normalized_album["_cover_lookup_task_scoped_context"] = True
                    resolved_context = (
                        resolve_album_context(config, normalized_album)
                        or _resolve_distributed_album_context(config, normalized_album)
                    )
                    if resolved_context is not None:
                        return normalized_album, resolved_context
                normalized_album["id"] = track_context.get("album_id")
                normalized_album["album_id"] = track_context.get("album_id")
                normalized_album["key"] = track_context.get("album_key")
                normalized_album["tracks"] = [
                    {"path": path}
                    for path in list(track_context.get("track_paths") or [])
                    if str(path or "").strip()
                ]
                resolved_context = (
                    resolve_album_context(config, normalized_album)
                    or _resolve_distributed_album_context(config, normalized_album)
                )
                if resolved_context is not None:
                    return normalized_album, resolved_context
    album_id = _album_id(normalized_album)
    album_key = str(
        normalized_album.get("_persisted_album_key")
        or normalized_album.get("key")
        or normalized_album.get("album_ref")
        or ""
    ).strip() or None
    if album_id is not None or album_key is not None:
        track_context = await run_in_threadpool(
            repository.resolve_album_track_context,
            album_id=album_id,
            album_key=album_key,
        )
        if isinstance(track_context, Mapping):
            normalized_album["id"] = track_context.get("album_id")
            normalized_album["album_id"] = track_context.get("album_id")
            normalized_album["key"] = track_context.get("album_key")
            normalized_album["tracks"] = [
                {"path": path}
                for path in list(track_context.get("track_paths") or [])
                if str(path or "").strip()
            ]
    return normalized_album, (
        resolve_album_context(config, normalized_album)
        or _resolve_distributed_album_context(config, normalized_album)
    )


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


async def _serialize_cover_gallery_from_asgi(
    request: Request,
    album_root,
    track_paths: set[str],
    task_id: str = "",
    candidate_snapshot: Mapping[str, object] | None = None,
    task_payload: Mapping[str, object] | None = None,
    *,
    refresh_persisted_cover_state: bool = False,
) -> dict[str, object]:
    config = _app_config(request)
    file_cache = _library_state(request).get("file_cache", {}) or {}
    paths_to_load = track_paths if refresh_persisted_cover_state else track_paths - set(file_cache)
    if paths_to_load and str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip():
        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

        selected_entries = await run_in_threadpool(
            PostgresLibraryBrowseRepository(config).build_cover_state_entries_by_paths,
            paths_to_load,
        )
        file_cache = {**file_cache, **selected_entries}
    serialized_task_payload = serialize_cover_lookup_task_payload(
        dict(task_payload) if isinstance(task_payload, Mapping)
        else cover_lookup_result(task_id) if task_id
        else {}
    )
    return await run_in_threadpool(
        serialize_cover_gallery_payload,
        album_root=album_root,
        track_paths=track_paths,
        file_cache=file_cache,
        image_extensions=set(config["IMAGE_EXTENSIONS"]),
        image_dimensions=image_dimensions,
        is_squareish_cover=_is_squareish_cover,
        task_payload=serialized_task_payload,
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
    track_paths: set[str],
    album_id: int | None = None,
) -> bool:
    task_track_paths = _cover_lookup_task_track_paths(task_payload)
    task_album = task_payload.get("album_payload")
    if (
        album_id is not None
        and isinstance(task_album, Mapping)
        and _album_id(task_album) == album_id
    ):
        return True
    if task_track_paths and task_track_paths <= track_paths:
        return True
    if task_track_paths & track_paths:
        return False
    return False


def _cover_lookup_task_track_paths(
    task_payload: Mapping[str, object],
) -> set[str]:
    task_track_paths = {
        str(path or "").strip()
        for path in list(task_payload.get("track_paths") or [])
        if str(path or "").strip()
    }
    task_album = task_payload.get("album_payload")
    if not task_track_paths and isinstance(task_album, Mapping):
        task_track_paths = _album_track_paths(task_album)
    return task_track_paths


async def _cover_lookup_album_split_response(
    config: Mapping[str, object],
    task_track_paths: set[str],
) -> tuple[JsonDict, int] | None:
    if len(task_track_paths) < 2:
        return None
    try:
        albums = await run_in_threadpool(
            PostgresLibraryBrowseRepository(config).build_album_payloads_by_track_paths,
            task_track_paths,
        )
    except Exception:
        return None
    current_releases: list[dict[str, object]] = []
    covered_paths: set[str] = set()
    seen_album_ids: set[int] = set()
    identity_repository = AlbumCoverCandidateSnapshotRepository(config)
    for album in albums:
        if not isinstance(album, Mapping):
            continue
        album_id = _album_id(album)
        album_paths = _album_track_paths(album)
        matching_paths = album_paths & task_track_paths
        if album_id is None and matching_paths:
            try:
                album_id = await run_in_threadpool(
                    identity_repository.resolve_album_id_for_track_paths,
                    track_paths=matching_paths,
                )
            except Exception:
                album_id = None
        album_name = str(album.get("name") or album.get("album") or "").strip()
        if (
            album_id is None
            or not matching_paths
            or not album_name
        ):
            continue
        covered_paths.update(matching_paths)
        if album_id in seen_album_ids:
            continue
        seen_album_ids.add(album_id)
        current_releases.append(
            {
                "album_id": album_id,
                "identity_resolution": "album_split_choice",
                "key": str(album.get("key") or album.get("album_ref") or "").strip(),
                "album_artist": str(album.get("album_artist") or album.get("artist") or "").strip(),
                "name": album_name,
                "year": album.get("year") or "",
                "edition": str(album.get("edition") or album.get("edition_name") or "").strip(),
                "track_count": len(album_paths),
            }
        )
    if len(current_releases) < 2 or covered_paths != task_track_paths:
        return None
    return (
        {
            "ok": False,
            "error": "This album was split—choose the current release",
            "resolution_kind": "album_split",
            "current_releases": current_releases,
        },
        409,
    )


def _is_valid_split_choice(
    album: Mapping[str, object],
    split_response: tuple[JsonDict, int] | None,
    album_id: int | None,
) -> bool:
    if (
        split_response is None
        or album_id is None
        or album.get("identity_resolution") != "album_split_choice"
    ):
        return False
    payload, _status = split_response
    return any(
        isinstance(release, Mapping) and _album_id(release) == album_id
        for release in list(payload.get("current_releases") or [])
    )


def _same_cover_lookup_generation(left: object, right: object) -> bool:
    left_text = str(left or "").strip()
    right_text = str(right or "").strip()
    if left_text == right_text:
        return bool(left_text)
    try:
        return UUID(left_text) == UUID(right_text)
    except ValueError:
        return False


@router.get("/utilities/cover-lookup/tasks/counts")
async def utilities_cover_lookup_task_counts(request: Request) -> JSONResponse:
    counts = await run_in_threadpool(
        count_cover_lookup_task_notifications,
        config=_app_config(request),
    )
    return JSONResponse({"ok": True, **counts})


@router.get("/utilities/cover-lookup/tasks")
async def utilities_cover_lookup_tasks(
    request: Request,
    limit: int | None = None,
    cursor: str | None = None,
    active_only: bool | None = None,
) -> JSONResponse:
    config = _app_config(request)
    if limit is None and cursor is None and active_only is None:
        tasks = await run_in_threadpool(list_cover_lookup_task_summaries, config=config)
        return JSONResponse({"ok": True, "tasks": tasks})
    try:
        page = await run_in_threadpool(
            load_cover_lookup_task_summary_page,
            config=config,
            limit=max(1, min(limit or 50, 50)),
            cursor=cursor,
            active_only=active_only is True,
        )
    except ValueError:
        return JSONResponse(
            {"ok": False, "error": "Invalid cover lookup notification cursor"},
            status_code=400,
        )
    counts = page["counts"]
    return JSONResponse(
        {
            "ok": True,
            "tasks": page["items"],
            "next_cursor": page["next_cursor"],
            "total_count": counts["total_count"],
            "active_count": counts["active_count"],
            "finished_count": counts["finished_count"],
        }
    )


@router.post("/utilities/cover-lookup/tasks/clear-completed")
async def utilities_cover_lookup_tasks_clear_completed(request: Request) -> JSONResponse:
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    raw_task_ids = payload.get("task_ids") if isinstance(payload, dict) else None
    task_ids = _clean_string_list(raw_task_ids) if isinstance(raw_task_ids, list) else None
    config = _app_config(request)
    removed_count = clear_completed_cover_lookup_tasks(
        task_ids,
        config=config,
        actioned_only=True,
    )
    return JSONResponse(
        {
            "ok": True,
            "removed_count": removed_count,
            "tasks": list_cover_lookup_task_summaries(config=config),
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
            "tasks": list_cover_lookup_task_summaries(config=config),
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
    return JSONResponse({"ok": True, "task": task, "tasks": list_cover_lookup_task_summaries(config=config)})


@router.post("/utilities/cover-lookup/gallery")
async def utilities_cover_lookup_gallery(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    task_id = str(payload.get("task_id") or "").strip()
    task_payload = cover_lookup_result(task_id) if task_id else {}
    if task_id and not task_payload:
        task_payload = await run_in_threadpool(
            load_cover_lookup_notification,
            dict(config),
            task_id,
        ) or {}
    task_track_paths = _cover_lookup_task_track_paths(task_payload)
    album, album_context = await _resolve_album_payload_context(
        config,
        album,
        fallback_track_paths=task_track_paths,
    )
    if album_context is None:
        split_response = await _cover_lookup_album_split_response(config, task_track_paths)
        if split_response is not None:
            return _json_response(split_response)
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    repository, album_id, identity_error = _resolved_snapshot_album_context(
        config,
        album,
        album_context.track_paths,
    )
    if identity_error is not None:
        split_response = await _cover_lookup_album_split_response(config, task_track_paths)
        if split_response is not None:
            return _json_response(split_response)
        return _json_response(identity_error)
    task_matches = bool(task_payload) and _task_matches_album_context(
        task_payload,
        track_paths=album_context.track_paths,
        album_id=album_id,
    )
    split_response = None
    if task_payload and task_track_paths and not task_track_paths <= album_context.track_paths:
        split_response = await _cover_lookup_album_split_response(config, task_track_paths)
    valid_split_choice = _is_valid_split_choice(album, split_response, album_id)
    if split_response is not None and not valid_split_choice:
        return _json_response(split_response)
    if task_payload and not valid_split_choice and not task_matches:
        return _json_response(
            ({"ok": False, "error": "Lookup task does not belong to this album"}, 409)
        )
    if payload.get("inventory_only") is True:
        return JSONResponse(
            {
                "ok": True,
                "local_image_count": await run_in_threadpool(
                    count_local_cover_images,
                    album_context.album_root,
                    image_extensions=set(config["IMAGE_EXTENSIONS"]),
                ),
            }
        )
    candidate_snapshot = None
    if not album.get("_cover_lookup_task_scoped_context"):
        try:
            candidate_snapshot = repository.get_for_album_context(album_id=int(album_id))
        except Exception:
            candidate_snapshot = _candidate_snapshot_read_failure(
                "candidate_snapshot_read_failed"
            )
    return JSONResponse(
        await _serialize_cover_gallery_from_asgi(
            request,
            album_context.album_root,
            album_context.track_paths,
            task_id,
            candidate_snapshot,
            task_payload,
            refresh_persisted_cover_state=True,
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
    album, album_context = await _resolve_album_payload_context(config, album or {})
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
    history_scope = await history_scope_for_request(request, required=False)
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    album, album_error = _require_album_payload(payload)
    if album_error is not None:
        return _json_response(album_error)
    manual_urls = _clean_string_list(payload.get("manual_urls"))
    if manual_urls and client_surface_from_request(request) == "tv":
        return _json_response(({"ok": False, "error": "Manual cover links are unavailable on TV."}, 403))
    task_id = str(payload.get("task_id") or "").strip()
    task_payload = cover_lookup_result(task_id) if task_id else {}
    if task_id and not task_payload:
        task_payload = await run_in_threadpool(
            load_cover_lookup_notification,
            dict(config),
            task_id,
        ) or {}
    queued_album = album or {}
    requested_track_paths = (
        _album_track_paths(album)
        or _cover_lookup_task_track_paths(task_payload)
    )
    album_context = resolve_album_context(config, queued_album)
    if task_payload:
        queued_album, album_context = await _resolve_album_payload_context(
            config,
            queued_album,
            fallback_track_paths=requested_track_paths,
        )
        if album_context is None:
            split_response = await _cover_lookup_album_split_response(
                config,
                _cover_lookup_task_track_paths(task_payload),
            )
            if split_response is not None:
                return _json_response(split_response)
            return _json_response(
                ({"ok": False, "error": "Album does not contain any tracks"}, 400)
            )
        if not _task_matches_album_context(
            task_payload,
            track_paths=album_context.track_paths,
            album_id=_album_id(queued_album),
        ):
            split_response = await _cover_lookup_album_split_response(
                config,
                _cover_lookup_task_track_paths(task_payload),
            )
            if not _is_valid_split_choice(
                queued_album,
                split_response,
                _album_id(queued_album),
            ):
                return _json_response(
                    ({"ok": False, "error": "Lookup task does not belong to this album"}, 409)
                )
        requested_track_paths = album_context.track_paths
    elif album_context is None and _album_id(queued_album) is None:
        return _json_response(
            ({"ok": False, "error": "Album does not contain any tracks"}, 400)
        )
    reservation_resource_keys = structural_tag_edit_resource_keys(
        str((album or {}).get("key") or (album or {}).get("album_ref") or ""),
        requested_track_paths,
    )
    reconciliation_started_at = (
        perf_counter() - _STRUCTURAL_RECONCILIATION_LOOKBACK_SECONDS
    )
    def prepare_cover_lookup(
        current_album: dict[str, object],
        current_track_paths: set[str],
        cancel_event: Event,
    ) -> tuple[dict[str, object], set[str]]:
        reservation = acquire_structural_tag_edit_reservation(
            reservation_resource_keys,
            cancel_event=cancel_event,
        )
        if reservation is None:
            return current_album, current_track_paths
        prepared_album = current_album
        try:
            album_context = resolve_album_context(config, prepared_album)
            album_id = _album_id(prepared_album)
            repository = PostgresLibraryBrowseRepository(config)
            if album_id is not None:
                reconciliation = latest_structural_tag_edit_destination(
                    reservation_resource_keys,
                    completed_after_monotonic=reconciliation_started_at,
                )
                destination_album_id = int(
                    (reconciliation or {}).get("destination_album_id") or 0
                )
                refreshed_album = repository.build_album_detail_payload_by_id(
                    destination_album_id or album_id
                )
                if refreshed_album is not None:
                    prepared_album = _album_with_context_tracks(refreshed_album)
                    album_context = resolve_album_context(config, prepared_album)
                elif destination_album_id > 0:
                    album_context = None
            if album_context is None and current_track_paths:
                current_albums = repository.build_album_payloads_by_track_paths(
                    current_track_paths
                )
                for refreshed_album in current_albums:
                    candidate = _album_with_context_tracks(refreshed_album)
                    candidate_context = resolve_album_context(config, candidate)
                    if (
                        candidate_context is not None
                        and current_track_paths <= candidate_context.track_paths
                    ):
                        prepared_album = candidate
                        album_context = candidate_context
                        break
        finally:
            reservation.release()
        if album_context is None:
            raise ValueError("Album does not contain any tracks")
        return prepared_album, album_context.track_paths

    task_id = queue_cover_lookup_task(
        queued_album,
        requested_track_paths,
        manual_urls,
        config=config,
        logger=logger,
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
        preferred_task_id=task_id,
        allow_preferred_path_rebind=bool(task_payload),
        prepare=prepare_cover_lookup,
    )
    log_app_event(
        config,
        logger,
        "Cover lookup task queued",
        level="info",
        task_id=task_id,
        artist=str(queued_album.get("album_artist") or ""),
        album=str(queued_album.get("name") or queued_album.get("album") or ""),
        year=queued_album.get("year"),
        edition=str(queued_album.get("edition") or ""),
     history_scope=history_scope)
    return JSONResponse(
        {
            "ok": True,
            "task": serialize_cover_lookup_task_payload(cover_lookup_result(task_id)),
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
    if client_surface_from_request(request) == "tv":
        return _json_response(({"ok": False, "error": "Local cover selection is unavailable on TV."}, 403))
    history_scope = await history_scope_for_request(request, required=False)
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
    album, album_context = await _resolve_album_payload_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    selected_inventory_state = library_state
    if (
        str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        and not album_context.track_paths <= set(library_state.get("file_cache") or {})
    ):
        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
        from music_app.services.library import build_albums_from_file_cache

        def load_selected_inventory():
            repository = PostgresLibraryBrowseRepository(config)
            albums = repository.build_album_payloads_by_track_paths(album_context.track_paths)
            paths = {
                str(track.get("path") or "").strip()
                for selected_album in albums
                for track in selected_album.get("tracks", [])
                if str(track.get("path") or "").strip()
            }
            entries = repository.build_track_file_entries_by_paths(paths)
            return {**library_state, "file_cache": entries,
                    "albums": build_albums_from_file_cache(entries)}

        selected_inventory_state = await run_in_threadpool(load_selected_inventory)
    try:
        authoritative_track_paths = resolve_authoritative_album_track_paths(
            selected_inventory_state,
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
            explicit_selection=True,
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
             history_scope=history_scope)
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
             history_scope=history_scope)
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
         history_scope=history_scope)
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
    if selected_inventory_state is not library_state and runtime_refresh_error is None:
        updated_albums = [
            _authoritative_local_cover_album_payload(selected_album, authoritative_cover, cover_revision)
            for selected_album in find_albums_by_track_paths_in_state(
                selected_inventory_state.get("albums", []), authoritative_track_paths
            )
        ]
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
         history_scope=history_scope)
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
         history_scope=history_scope)
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
     history_scope=history_scope)
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(authoritative_cover),
            "cover_revision": cover_revision,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "gallery": await _serialize_cover_gallery_from_asgi(
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
    album, album_context = await _resolve_album_payload_context(config, album or {})
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
            explicit_selection=next_cover is not None,
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
            "gallery": await _serialize_cover_gallery_from_asgi(
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
    album, album_context = await _resolve_album_payload_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    if (
        str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
        and not album_context.track_paths <= set(library_state.get("file_cache") or {})
    ):
        from music_app.services.library import build_albums_from_file_cache
        from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

        def load_selected_inventory():
            repository = PostgresLibraryBrowseRepository(config)
            albums = repository.build_album_payloads_by_track_paths(album_context.track_paths)
            paths = {
                str(track.get("path") or "").strip()
                for selected_album in albums
                for track in selected_album.get("tracks", [])
                if str(track.get("path") or "").strip()
            }
            entries = repository.build_track_file_entries_by_paths(paths)
            file_cache = {**(library_state.get("file_cache") or {}), **entries}
            return file_cache, build_albums_from_file_cache(file_cache)

        file_cache, albums = await run_in_threadpool(load_selected_inventory)
        library_state["file_cache"] = file_cache
        library_state["albums"] = albums
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
    cover_revision = cover_revision_for_path(saved_cover_path)
    try:
        persist_cover_selection_for_tracks(
            album_context.track_paths,
            saved_cover_path,
            config=config,
            logger=logger,
            cover_revision=cover_revision,
            cover_selection_origin="user",
            explicit_selection=True,
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
        cover_revision=cover_revision,
    )
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(saved_cover_path),
            "cover_revision": cover_revision,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "gallery": await _serialize_cover_gallery_from_asgi(
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
    if not task_id and snapshot_generation:
        try:
            task_id = UUID(snapshot_generation).hex
        except ValueError:
            pass
    album, album_context = await _resolve_album_payload_context(config, album or {})
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    task_payload = cover_lookup_result(task_id)
    if not task_payload and task_id:
        try:
            normalized_task_id = UUID(task_id).hex
        except ValueError:
            normalized_task_id = ""
        if normalized_task_id:
            task_payload = cover_lookup_result(normalized_task_id)
            if task_payload:
                task_id = normalized_task_id
    selected_match = None
    notification_action_taken = is_terminal_cover_lookup_task(task_payload)
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
            track_paths=album_context.track_paths,
            album_id=album_id,
        ):
            split_response = await _cover_lookup_album_split_response(
                config,
                _cover_lookup_task_track_paths(task_payload),
            )
            if not _is_valid_split_choice(album or {}, split_response, album_id):
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
            or not _same_cover_lookup_generation(
                candidate_snapshot.get("search_generation"),
                snapshot_generation,
            )
        ):
            return _json_response(
                ({"ok": False, "error": "Saved cover candidate generation was not found"}, 404)
            )
        snapshot_candidates = candidate_snapshot.get("candidates")
        notification_action_taken = is_terminal_cover_lookup_task(candidate_snapshot)
        selected_match = next(
            (
                dict(item)
                for item in snapshot_candidates
                if isinstance(item, Mapping)
                and str(item.get("id") or "") == candidate_id
            ),
            None,
        ) if isinstance(snapshot_candidates, list) else None
    if (selected_match and client_surface_from_request(request) == "tv"
            and not is_provider_lookup_match(selected_match)):
        return _json_response(({"ok": False, "error": "Only provider cover candidates can be selected on TV."}, 403))
    if selected_match and not task_payload:
        task_id, _cancel_event = create_cover_lookup_task(
            dict(album or {}),
            album_context.track_paths,
            internal=True,
            config=config,
            preferred_task_id=task_id,
        )
        task_payload = cover_lookup_result(task_id)
    if not task_payload:
        return _json_response(_task_not_found_response("Lookup task"))
    if not selected_match:
        return _json_response(({"ok": False, "error": "Selected remote candidate was not found"}, 404))
    if not is_remote_cover_candidate_selectable(
        art_kind=selected_match.get("art_kind"),
    ):
        return _json_response(
            (
                {
                    "ok": False,
                    "error": "This remote image is preview-only and cannot be selected as the album cover",
                },
                400,
            )
        )
    if str(selected_match.get("art_kind") or "cover") != "cover":
        selected_match = {
            **selected_match,
            "display_only": str(selected_match.get("source") or "").strip().casefold()
            in DISPLAY_ONLY_REMOTE_SOURCES,
        }
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
    def persist_authoritative_cover_selection(track_paths, cover_path, **changes):
        def commit_cover_selection(commit_action):
            return state_service.run_authoritative_cover_commit_for_state(
                library_state,
                commit_action,
            )

        return persist_cover_selection_for_tracks(
            track_paths,
            cover_path,
            **changes,
            commit_guard=commit_cover_selection,
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
        notification_action_taken=notification_action_taken,
        apply_cover_selection_for_tracks=apply_cover_path_for_tracks,
        persist_cover_selection_for_tracks=persist_authoritative_cover_selection,
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
        }
    )


@router.post("/utilities/cover-lookup/add-remote")
async def utilities_cover_lookup_add_remote(request: Request) -> JSONResponse:
    history_scope = await history_scope_for_request(request, required=False)
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
     history_scope=history_scope)
    album, album_context = await _resolve_album_payload_context(config, album or {})
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
     history_scope=history_scope)
    if not matches:
        return _json_response(({"ok": False, "error": "No usable cover art could be extracted from those links"}, 400))
    if not task_id:
        task_id, _cancel_event = create_cover_lookup_task(
            album or {},
            album_context.track_paths,
            config=config,
        )
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
            "gallery": await _serialize_cover_gallery_from_asgi(
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
    history_scope = await history_scope_for_request(request, required=False)
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
         history_scope=history_scope)
        return _json_response(({"ok": False, "error": str(exc)}, 500))
    updated_albums = find_albums_by_track_paths_in_state(
        library_state.get("albums", []) if isinstance(library_state, dict) else [],
        requested_track_paths or set(),
    )
    album_key = str(updated_albums[0].get("key") or "") if updated_albums else ""
    updated_problematic_album = (
        build_problematic_album_detail_payload(
            album_key,
            config=config,
            library_state=library_state,
            logger=logger,
        )
        if album_key
        else None
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
    history_scope = await history_scope_for_request(request, required=False)
    config = _app_config(request)
    logger = _app_logger(request)
    library_state = _library_state(request)
    payload = await _json_payload(request)
    force_search = bool(payload.get("force_search")) if isinstance(payload, dict) else False
    try:
        start_result = await run_in_threadpool(
            start_manual_cover_refresh_request,
            cache_lock=state_service._CACHE_LOCK,
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
            get_file_cache_snapshot=lambda: state_service.cover_file_cache_snapshot_for_state(
                library_state,
                config,
            ),
            submit_cover_job=state_service._COVER_EXECUTOR.submit,
            refresh_unsuccessful_cover_artwork=(
                lambda force_search=False, prepared=None: state_service.refresh_unsuccessful_cover_artwork_for_state(
                    library_state,
                    config,
                    logger,
                    force_search=force_search,
                    prepared=prepared,
                )
            ),
            force_search=force_search,
            defer_preparation=True,
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
         history_scope=history_scope)
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
    return JSONResponse({"ok": True, **cancel_cover_refresh_status(get_state=lambda: _library_state(request), cache_lock=state_service._CACHE_LOCK)})
