from __future__ import annotations

from music_app.services.log_history import history_scope_for_request

from collections.abc import Mapping
from datetime import datetime, timezone
import logging
from pathlib import Path
import uuid
from threading import Event
from time import perf_counter
from uuid import UUID, uuid4

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_cover_helpers import (
    apply_cover_path_for_tracks,
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_task_summaries,
    mark_cover_lookup_notifications_action_taken_for_track_paths,
    mark_cover_lookup_task_notification_action_taken,
    persist_cover_selection_for_tracks,
)
from music_app.services.cache import execute_cover_mutation_for_config
from music_app.services import state as state_service
from music_app.services.app_logging import log_app_event
from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)
from music_app.services.album_identity_lineage_postgres import (
    AlbumIdentityLineageRepository,
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
from music_app.services.policy_asgi import request_origin_ref_for_request
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
    list_cover_lookup_tasks,
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
    begin_prepared_pasted_cover_promotion,
    complete_local_image_promotion,
    cover_revision_for_path,
    choose_best_remaining_local_cover,
    decode_image_bytes,
    prepare_pasted_image_for_authoritative_write,
    resolve_album_context,
    resolve_album_write_root_from_track_paths,
    rollback_local_image_promotion,
    validate_local_cover_source,
)
from music_app.services.cover_mutation_coordinator import (
    CoverArtifactIdentity,
    CoverMutationRetryRequired,
    CoverMutationStatus,
)
from music_app.services.cover_mutations_postgres import PostgresCoverMutationRepository
from music_app.services.covers import image_dimensions, score_image
from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository
from music_app.services.library_watch_suppression import suppress_library_watch_events
from music_app.services.repair_previews import (
    find_problematic_album_by_track_paths as find_problematic_album_by_track_paths_in_state,
)
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


def _durable_cover_request_context(request: Request):
    repository = getattr(request.app.state, "cover_job_repository", None)
    evaluation = getattr(request.state, "policy_evaluation", None)
    audit = getattr(evaluation, "audit", None)
    if (
        repository is None
        or getattr(audit, "action", None)
        not in {
            "library.covers.lookup",
            "library.covers.lookup.cancel",
            "library.covers.tasks.read",
            "library.covers.tasks.manage",
            "library.covers.write",
            "library.covers.fetch",
            "library.covers.fetch.cancel",
        }
        or not isinstance(getattr(audit, "account_id", None), int)
        or not isinstance(getattr(audit, "library_id", None), int)
    ):
        return None
    return repository, audit


def _cover_lookup_task_sort_key(task: Mapping[str, object]) -> tuple[str, str]:
    timestamp = (
        str(task.get("notification_completed_at") or "").strip()
        or str(task.get("finished_at") or "").strip()
        or str(task.get("updated_at") or "").strip()
        or str(task.get("created_at") or "").strip()
    )
    return timestamp, str(task.get("id") or "")


def _list_cover_lookup_tasks_for_request(
    request: Request, config: Mapping[str, object]
) -> list[dict[str, object]]:
    durable = _durable_cover_request_context(request)
    tasks_by_id = {
        str(task.get("id") or "").strip(): task
        for task in (list_cover_lookup_tasks(config=config) if durable is None else [])
        if str(task.get("id") or "").strip()
    }
    if durable is not None:
        repository, audit = durable
        durable_tasks = repository.list_candidate_lookup_tasks(
            actor_account_id=audit.account_id,
            library_id=audit.library_id,
        )
        for task in durable_tasks:
            serialized = serialize_cover_lookup_task_payload(task)
            task_id = str((serialized or {}).get("id") or "").strip()
            if task_id:
                tasks_by_id[task_id] = serialized
    tasks = list(tasks_by_id.values())
    tasks.sort(key=_cover_lookup_task_sort_key, reverse=True)
    return tasks


def _clear_cover_lookup_tasks_for_request(
    request: Request,
    config: Mapping[str, object],
    task_ids: list[str] | None,
    *,
    actioned_only: bool = False,
) -> int:
    durable = _durable_cover_request_context(request)
    if durable is None:
        return clear_completed_cover_lookup_tasks(
            task_ids, config=config, actioned_only=actioned_only
        )
    repository, audit = durable
    return len(
        repository.clear_completed_candidate_lookup_tasks(
            actor_account_id=audit.account_id,
            library_id=audit.library_id,
            task_keys=task_ids,
            actioned_only=actioned_only,
        )
    )


def _mark_cover_lookup_task_action_for_request(
    request: Request,
    config: Mapping[str, object],
    task_id: str,
) -> dict[str, object] | None:
    durable = _durable_cover_request_context(request)
    if durable is not None:
        repository, audit = durable
        task = repository.mark_candidate_lookup_notification_action_taken(
            actor_account_id=audit.account_id,
            library_id=audit.library_id,
            task_key=task_id,
        )
        return serialize_cover_lookup_task_payload(task) if task is not None else None
    return mark_cover_lookup_task_notification_action_taken(task_id, config=config)


def _lookup_task_payload_for_request(
    request: Request, task_id: str
) -> dict[str, object]:
    durable = _durable_cover_request_context(request)
    if durable is not None and task_id:
        repository, audit = durable
        try:
            row = repository.get_task(task_key=task_id, library_id=audit.library_id)
        except Exception:
            row = None
        payload = row.get("provider_payload") if isinstance(row, Mapping) else None
        if isinstance(payload, Mapping):
            return {
                **dict(payload),
                "id": task_id,
                "status": str(row.get("status") or payload.get("status") or ""),
                "album_id": row.get("local_album_id"),
            }
        return {}
    if not task_id:
        return {}
    return cover_lookup_result(task_id) or load_cover_lookup_notification(
        dict(_app_config(request)), task_id
    ) or {}


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


def _cover_mutation_retry_response() -> JSONResponse:
    return _json_response(
        (
            {
                "ok": False,
                "error": "Cover selection changed. Reload and try again.",
            },
            409,
        )
    )


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
    task_scoped: bool = False,
):
    normalized_album = _album_with_context_tracks(album)
    normalized_album.pop("_cover_lookup_task_scoped_context", None)
    repository = AlbumCoverCandidateSnapshotRepository(config)
    fallback_paths = {
        str(path or "").strip()
        for path in (fallback_track_paths or set())
        if str(path or "").strip()
    }
    album_key = str(
        normalized_album.get("_persisted_album_key")
        or normalized_album.get("key")
        or normalized_album.get("album_ref")
        or ""
    ).strip().casefold()
    if (
        (album_key == "unknown artist::" or task_scoped)
        and fallback_paths
        and fallback_paths < _album_track_paths(normalized_album)
    ):
        normalized_album.pop("id", None)
        normalized_album.pop("album_id", None)
        normalized_album["tracks"] = [
            {"path": path} for path in sorted(fallback_paths)
        ]
        normalized_album["_cover_lookup_task_scoped_context"] = True
    resolved_context = await run_in_threadpool(
        resolve_album_context, config, normalized_album
    )
    if resolved_context is not None:
        if task_scoped and fallback_paths:
            album_id = _album_id(normalized_album)
            lineage_album_key = str(
                normalized_album.get("_persisted_album_key")
                or normalized_album.get("key")
                or normalized_album.get("album_ref")
                or ""
            ).strip() or None
            if album_id is not None or lineage_album_key is not None:
                try:
                    lineage = await run_in_threadpool(
                        AlbumIdentityLineageRepository(config).resolve,
                        album_id=album_id,
                        album_key=lineage_album_key,
                        track_paths=fallback_paths,
                    )
                except (RuntimeError, OSError):
                    return normalized_album, None
                if lineage["status"] == "split":
                    normalized_album["_identity_split_choices"] = lineage["choices"]
                    return normalized_album, None
                current_album = lineage.get("album")
                if lineage["status"] == "resolved" and isinstance(
                    current_album, Mapping
                ):
                    normalized_album.update(current_album)
                    normalized_album["id"] = current_album.get("album_id")
                    normalized_album["key"] = current_album.get("album_key")
                    normalized_album["tracks"] = []
                    try:
                        track_context = await run_in_threadpool(
                            repository.resolve_album_track_context,
                            album_id=current_album.get("album_id"),
                            album_key=current_album.get("album_key"),
                        )
                    except Exception:
                        return normalized_album, None
                    if not isinstance(track_context, Mapping):
                        return normalized_album, None
                    normalized_album["id"] = track_context.get("album_id")
                    normalized_album["album_id"] = track_context.get("album_id")
                    normalized_album["key"] = track_context.get("album_key")
                    normalized_album["tracks"] = [
                        {"path": path}
                        for path in list(track_context.get("track_paths") or [])
                        if str(path or "").strip()
                    ]
                    return normalized_album, (
                        await run_in_threadpool(resolve_album_context, config, normalized_album)
                        or _resolve_distributed_album_context(config, normalized_album)
                    )
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
                    (
                        str(track_context.get("album_key") or "").strip().casefold()
                        == "unknown artist::"
                        or task_scoped
                    )
                    and fallback_paths < context_paths
                ):
                    normalized_album.pop("id", None)
                    normalized_album.pop("album_id", None)
                    normalized_album["tracks"] = [
                        {"path": path} for path in sorted(fallback_paths)
                    ]
                    normalized_album["_cover_lookup_task_scoped_context"] = True
                    resolved_context = (
                        await run_in_threadpool(resolve_album_context, config, normalized_album)
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
                    await run_in_threadpool(resolve_album_context, config, normalized_album)
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
    resolved_context = (
        await run_in_threadpool(resolve_album_context, config, normalized_album)
        or _resolve_distributed_album_context(config, normalized_album)
    )
    if resolved_context is not None:
        return normalized_album, resolved_context

    album_id = _album_id(normalized_album)
    if album_id is None and album_key is None:
        return normalized_album, None
    try:
        lineage = await run_in_threadpool(
            AlbumIdentityLineageRepository(config).resolve,
            album_id=album_id,
            album_key=album_key,
            track_paths=fallback_paths,
        )
    except (RuntimeError, OSError):
        return normalized_album, None
    if lineage["status"] == "split":
        normalized_album["_identity_split_choices"] = lineage["choices"]
        return normalized_album, None
    current_album = lineage.get("album")
    if not isinstance(current_album, Mapping):
        return normalized_album, None
    track_context = await run_in_threadpool(
        repository.resolve_album_track_context,
        album_id=current_album.get("album_id"),
        album_key=current_album.get("album_key"),
    )
    if not isinstance(track_context, Mapping):
        return normalized_album, None
    normalized_album["id"] = track_context.get("album_id")
    normalized_album["album_id"] = track_context.get("album_id")
    normalized_album["key"] = track_context.get("album_key")
    normalized_album["tracks"] = [
        {"path": path}
        for path in list(track_context.get("track_paths") or [])
        if str(path or "").strip()
    ]
    return normalized_album, (
        await run_in_threadpool(resolve_album_context, config, normalized_album)
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
        else await run_in_threadpool(_lookup_task_payload_for_request, request, task_id) if task_id
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
    album_key: str | None = None,
) -> bool:
    task_track_paths = _cover_lookup_task_track_paths(task_payload)
    task_album = task_payload.get("album_payload")
    if (
        album_id is not None
        and isinstance(task_album, Mapping)
        and _album_id(task_album) == album_id
    ):
        return True
    task_album_key = (
        str(
            task_album.get("_persisted_album_key")
            or task_album.get("key")
            or task_album.get("album_ref")
            or ""
        ).strip().casefold()
        if isinstance(task_album, Mapping)
        else ""
    )
    if (
        task_album_key
        and task_album_key == str(album_key or "").strip().casefold()
        and track_paths
        and track_paths <= task_track_paths
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
    lineage_choices: object = None,
) -> tuple[JsonDict, int] | None:
    if isinstance(lineage_choices, list) and len(lineage_choices) > 1:
        current_releases = [
            {
                **dict(choice),
                "identity_resolution": "album_split_choice",
                "key": str(choice.get("album_key") or choice.get("key") or "").strip(),
            }
            for choice in lineage_choices
            if isinstance(choice, Mapping)
        ]
        if len(current_releases) > 1:
            return (
                {
                    "ok": False,
                    "error": "This album was split—choose the current release",
                    "resolution_kind": "album_split",
                    "current_releases": current_releases,
                },
                409,
            )
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
        if album_paths - task_track_paths:
            continue
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
    durable = _durable_cover_request_context(request)
    if durable is None:
        counts = await run_in_threadpool(
            count_cover_lookup_task_notifications, config=_app_config(request)
        )
    else:
        repository, audit = durable
        counts = await run_in_threadpool(
            repository.count_candidate_lookup_task_notifications,
            actor_account_id=audit.account_id,
            library_id=audit.library_id,
        )
    return JSONResponse({"ok": True, **counts})


@router.get("/utilities/cover-lookup/tasks")
async def utilities_cover_lookup_tasks(
    request: Request,
    limit: int | None = None,
    cursor: str | None = None,
    active_only: bool | None = None,
    task_ids: str | None = None,
) -> JSONResponse:
    config = _app_config(request)
    tracked_task_ids = tuple(dict.fromkeys(
        item.strip() for item in str(task_ids or "").split(",") if item.strip()
    ))
    if len(tracked_task_ids) > 60 or any(len(task_id) > 200 for task_id in tracked_task_ids):
        return JSONResponse(
            {"ok": False, "error": "Invalid cover lookup notification task IDs"},
            status_code=400,
        )
    if limit is None and cursor is None and active_only is None and task_ids is None:
        return JSONResponse({"ok": True, "tasks": await run_in_threadpool(
            _list_cover_lookup_tasks_for_request, request, config
        )})
    durable = _durable_cover_request_context(request)
    try:
        if durable is None:
            page = await run_in_threadpool(
                load_cover_lookup_task_summary_page,
                config=config,
                task_ids=tracked_task_ids or None,
                limit=max(1, min(limit or 50, 50)),
                cursor=cursor,
                active_only=active_only is True,
            )
        else:
            repository, audit = durable
            page = await run_in_threadpool(
                repository.load_candidate_lookup_task_summary_page,
                actor_account_id=audit.account_id,
                library_id=audit.library_id,
                task_keys=tracked_task_ids or None,
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
            "membership_revision": counts["membership_revision"],
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
    removed_count = await run_in_threadpool(
        _clear_cover_lookup_tasks_for_request, request, config, task_ids, actioned_only=True
    )
    return JSONResponse(
        {
            "ok": True,
            "removed_count": removed_count,
            "tasks": await run_in_threadpool(
                _list_cover_lookup_tasks_for_request, request, config
            ),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/clear")
async def utilities_cover_lookup_task_clear(request: Request, task_id: str) -> JSONResponse:
    normalized_id = str(task_id or "").strip()
    if not normalized_id:
        return _json_response(_task_not_found_response("Lookup task"))
    config = _app_config(request)
    removed_count = await run_in_threadpool(
        _clear_cover_lookup_tasks_for_request, request, config, [normalized_id]
    )
    if removed_count <= 0:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse(
        {
            "ok": True,
            "removed_count": removed_count,
            "tasks": await run_in_threadpool(
                _list_cover_lookup_tasks_for_request, request, config
            ),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/mark-action-taken")
async def utilities_cover_lookup_task_mark_action_taken(request: Request, task_id: str) -> JSONResponse:
    normalized_id = str(task_id or "").strip()
    if not normalized_id:
        return _json_response(_task_not_found_response("Lookup task"))
    config = _app_config(request)
    task = await run_in_threadpool(
        _mark_cover_lookup_task_action_for_request, request, config, normalized_id
    )
    if task is None:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse(
        {
            "ok": True,
            "task": task,
            "tasks": await run_in_threadpool(
                _list_cover_lookup_tasks_for_request, request, config
            ),
        }
    )


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
    task_payload = await run_in_threadpool(
        _lookup_task_payload_for_request, request, task_id
    )
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
        task_scoped=bool(task_track_paths)
        and album.get("identity_resolution") != "album_split_choice",
    )
    if album_context is None:
        split_response = await _cover_lookup_album_split_response(
            config,
            task_track_paths,
            album.get("_identity_split_choices"),
        )
        if split_response is not None:
            return _json_response(split_response)
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    repository, album_id, identity_error = await run_in_threadpool(
        _resolved_snapshot_album_context,
        config,
        album,
        album_context.track_paths,
    )
    if identity_error is not None:
        split_response = await _cover_lookup_album_split_response(
            config,
            task_track_paths,
            album.get("_identity_split_choices"),
        )
        if split_response is not None:
            return _json_response(split_response)
        return _json_response(identity_error)
    task_matches = bool(task_payload) and await run_in_threadpool(
        _task_matches_album_context,
        task_payload,
        track_paths=album_context.track_paths,
        album_id=album_id,
        album_key=str(album.get("key") or album.get("album_ref") or ""),
    )
    split_response = None
    if task_payload and task_track_paths and not task_track_paths <= album_context.track_paths:
        split_response = await _cover_lookup_album_split_response(
            config,
            task_track_paths,
            album.get("_identity_split_choices"),
        )
    valid_split_choice = _is_valid_split_choice(album, split_response, album_id)
    if split_response is not None and not valid_split_choice:
        return _json_response(split_response)
    if task_payload and not valid_split_choice and not task_matches:
        return _json_response(
            ({"ok": False, "error": "Lookup task does not belong to this album"}, 409)
        )
    candidate_snapshot = None
    if not album.get("_cover_lookup_task_scoped_context"):
        try:
            candidate_snapshot = await run_in_threadpool(
                repository.get_for_album_context, album_id=int(album_id)
            )
        except Exception:
            candidate_snapshot = _candidate_snapshot_read_failure(
                "candidate_snapshot_read_failed"
            )
        if (
            task_id
            and isinstance(candidate_snapshot, Mapping)
            and not _same_cover_lookup_generation(
                candidate_snapshot.get("search_generation"),
                task_id,
            )
        ):
            candidate_snapshot = None
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
    repository, album_id, identity_error = await run_in_threadpool(
        _resolved_snapshot_album_context,
        config,
        album or {},
        album_context.track_paths,
    )
    if identity_error is not None:
        return _json_response(identity_error)
    try:
        candidate_snapshot = await run_in_threadpool(
            repository.mark_seen, album_id=album_id
        )
    except Exception:
        try:
            candidate_snapshot = await run_in_threadpool(
                repository.get_for_album_context, album_id=album_id
            )
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
    task_payload = await run_in_threadpool(
        _lookup_task_payload_for_request, request, task_id
    )
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
    album_context = await run_in_threadpool(
        resolve_album_context, config, queued_album
    )
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
                (album or {}).get("_identity_split_choices"),
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
            album_key=str(
                queued_album.get("key") or queued_album.get("album_ref") or ""
            ),
        ):
            split_response = await _cover_lookup_album_split_response(
                config,
                _cover_lookup_task_track_paths(task_payload),
                (album or {}).get("_identity_split_choices"),
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
    durable = _durable_cover_request_context(request)
    task_payload = task_payload or None
    if durable is not None:
        repository, audit = durable
        album, album_context = await _resolve_album_payload_context(config, queued_album)
        queued_album = album
        if album_context is None:
            return _json_response(({"ok": False, "error": "Album does not contain any tracks"}, 400))
        album_key = str(
            (album or {}).get("key") or (album or {}).get("album_key") or ""
        ).strip()
        if not album_key:
            return _json_response(
                ({"ok": False, "error": "Album identity could not be resolved"}, 409)
            )
        generation = uuid.uuid4()
        task_id = generation.hex
        task_payload = {
            "id": task_id,
            "status": "pending",
            "type": "cover-art-lookup",
            "internal": False,
            "artist": str((album or {}).get("album_artist") or ""),
            "album": str((album or {}).get("name") or (album or {}).get("album") or ""),
            "year": (album or {}).get("year"),
            "progress": 0,
            "progress_label": "Queued",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": "",
            "message": "",
            "manual_urls": manual_urls,
            "job_contract": build_cover_lookup_job_contract("candidate_lookup"),
            "possible_matches": [],
            "selected_candidate_id": "",
            "caa_empty_notice": False,
            "cancel_requested": False,
            "album_id": _album_id(album or {}),
        }
        try:
            def accept_candidate_lookup():
                return repository.accept_candidate_lookup(
                    task_key=task_id,
                    library_id=audit.library_id,
                    album_key=album_key,
                    account_id=audit.account_id,
                    request_origin_ref=request_origin_ref_for_request(request),
                    deployment_mode=audit.deployment_mode,
                    client_surface=audit.client_surface_class,
                    candidate_generation=generation,
                    resource_revision=repository.current_inventory_revision(
                        library_id=audit.library_id
                    ),
                    scheduled_at=datetime.now(timezone.utc),
                    task_payload=task_payload,
                )

            await run_in_threadpool(accept_candidate_lookup)
        except ValueError as exc:
            return _json_response(({"ok": False, "error": str(exc)}, 409))
        except Exception:
            return _json_response(
                ({"ok": False, "error": "Cover lookup could not be queued"}, 503)
            )
    else:
        requested_track_paths = (
            album_context.track_paths if album_context is not None else _album_track_paths(queued_album)
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
                if album_id is not None:
                    repository = PostgresLibraryBrowseRepository(config)
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
        task_payload = cover_lookup_result(task_id)
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
            "task": serialize_cover_lookup_task_payload(task_payload),
        }
    )


@router.post("/utilities/cover-lookup/task/{task_id}/cancel")
async def utilities_cover_lookup_cancel(request: Request, task_id: str) -> JSONResponse:
    durable = _durable_cover_request_context(request)
    if durable is not None:
        repository, audit = durable
        try:
            task_payload = await run_in_threadpool(
                repository.request_candidate_lookup_cancellation,
                task_key=str(task_id or "").strip(),
                library_id=audit.library_id,
                actor_account_id=audit.account_id,
                now=datetime.now(timezone.utc),
            )
        except Exception:
            task_payload = None
    else:
        task_payload = cancel_cover_lookup_task_payload(
            task_id, config=_app_config(request)
        )
    if task_payload is None:
        return _json_response(_task_not_found_response("Lookup task"))
    return JSONResponse(
        {"ok": True, "task": serialize_cover_lookup_task_payload(task_payload)}
    )


@router.post("/utilities/cover-lookup/local-select")
async def utilities_cover_lookup_local_select(request: Request) -> JSONResponse:
    request_started_at = perf_counter()
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
            album_key=str(
                album.get("_persisted_album_key")
                or album.get("key")
                or album.get("album_ref")
                or ""
            ),
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 409))
    try:
        resolved = validate_local_cover_source(
            config,
            album_context.album_root,
            source_path,
            track_paths=album_context.track_paths,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except FileNotFoundError:
        return _json_response(({"ok": False, "error": "Selected image was not found"}, 404))
    resolution_finished_at = perf_counter()
    promotion_finished_at = resolution_finished_at
    hash_ms = 0.0
    persistence_ms = 0.0
    authoritative_cover = None
    cover_revision = None
    persistence_result: dict[str, object] = {}
    updated_albums: list[dict[str, object]] = []
    updated_problematic_album = None
    runtime_refresh_error: Exception | None = None
    runtime_fallback_error: Exception | None = None
    database_commit_completed = False
    lock_wait_ms = 0.0
    database_ms = 0.0
    runtime_refresh_ms = 0.0

    def refresh_runtime_state() -> None:
        nonlocal updated_albums, updated_problematic_album
        nonlocal runtime_refresh_error, runtime_fallback_error
        nonlocal runtime_refresh_ms
        runtime_started_at = perf_counter()
        try:
            updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
                authoritative_track_paths,
                authoritative_cover,
                config=config,
                logger=logger,
                library_state=library_state,
                cover_revision=cover_revision,
                schedule_cache_update=False,
                include_problematic_album=False,
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
        finally:
            runtime_refresh_ms += (perf_counter() - runtime_started_at) * 1000

    def promote_persist_and_refresh() -> tuple[Exception | None, Exception | None]:
        nonlocal authoritative_cover, cover_revision, persistence_result
        nonlocal database_commit_completed
        promotion_holder = {}

        def prepare(_request, _baseline):
            revision = cover_revision_for_path(resolved)
            return resolved, revision, image_dimensions(resolved, raise_errors=True)

        def write_artifact(prepared, _baseline):
            prepared_source, source_revision, (width, height) = prepared
            if cover_revision_for_path(prepared_source) != source_revision:
                raise RuntimeError("Selected cover changed before promotion.")
            promotion = begin_local_image_promotion(
                prepared_source,
                album_context.album_root,
                serialize_selection=False,
            )
            promotion_holder["promotion"] = promotion
            return CoverArtifactIdentity(
                private_path=promotion.cover_path,
                sha256=promotion.promoted_cover_revision,
                post_write_exists=True,
                selected_cover_path=str(promotion.cover_path),
                promoted_cover_revision=promotion.promoted_cover_revision,
                prior_cover_existed=promotion.prior_cover_existed,
                prior_cover_bytes=promotion.prior_cover_bytes,
                local_cover_width=width,
                local_cover_height=height,
            )

        def publish_committed(_outcome, artifact) -> None:
            nonlocal authoritative_cover, cover_revision, database_commit_completed
            nonlocal persistence_result
            authoritative_cover = artifact.private_path
            cover_revision = artifact.promoted_cover_revision
            database_commit_completed = True
            persistence_result = {
                "album_rows_updated": 1,
                "track_file_rows_updated": len(authoritative_track_paths),
            }
            promotion = promotion_holder.get("promotion")
            if promotion is not None:
                complete_local_image_promotion(promotion)
            state_service.run_authoritative_cover_commit_for_state(
                library_state,
                refresh_runtime_state,
            )

        try:
            outcome = execute_cover_mutation_for_config(
                config,
                track_paths=authoritative_track_paths,
                album_root=album_context.album_root,
                selected_origin="user",
                explicit_selection=True,
                clear_selection=False,
                remote_cover=None,
                prepare=prepare,
                cleanup_prepared=lambda _prepared: None,
                write_artifact=write_artifact,
                compensate_artifact=lambda _artifact: rollback_local_image_promotion(
                    promotion_holder["promotion"]
                ),
                publish_committed=publish_committed,
            )
            if outcome.status is not CoverMutationStatus.COMMITTED:
                raise RuntimeError("Local cover selection was not committed.")
        except Exception as exc:
            return exc, None
        return None, None

    selection_error, rollback_error = await run_in_threadpool(
        promote_persist_and_refresh
    )
    if selection_error is not None:
        if isinstance(selection_error, CoverMutationRetryRequired):
            return _cover_mutation_retry_response()
        failed_target_filename = (
            authoritative_cover.name
            if authoritative_cover is not None
            else "cover.jpg"
        )
        if database_commit_completed:
            assert authoritative_cover is not None
            assert cover_revision is not None
            _log_local_cover_persistence_event(
                config,
                logger,
                "Local cover post-commit finalization failed",
                level="error",
                artist=str((album or {}).get("album_artist") or "").strip(),
                album=str((album or {}).get("name") or "").strip(),
                year=(album or {}).get("year"),
                target_filename=failed_target_filename,
                error_kind=type(selection_error).__name__,
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
        if rollback_error is not None:
            _log_local_cover_persistence_event(
                config,
                logger,
                "Local cover promotion rollback failed",
                level="error",
                artist=str((album or {}).get("album_artist") or "").strip(),
                album=str((album or {}).get("name") or "").strip(),
                year=(album or {}).get("year"),
                target_filename=failed_target_filename,
                error_kind=type(rollback_error).__name__,
             history_scope=history_scope)
        _log_local_cover_persistence_event(
            config,
            logger,
            "Local cover selection persistence failed",
            level="error",
            artist=str((album or {}).get("album_artist") or "").strip(),
            album=str((album or {}).get("name") or "").strip(),
            year=(album or {}).get("year"),
            target_filename=failed_target_filename,
            error_kind=type(selection_error).__name__,
         history_scope=history_scope)
        return _json_response(
            ({"ok": False, "error": "Selected cover art could not be persisted."}, 500)
        )

    assert authoritative_cover is not None
    assert cover_revision is not None
    assert persistence_result is not None
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
        timings_ms={
            "resolve_and_validate": round((resolution_finished_at - request_started_at) * 1000, 2),
            "promotion": round((promotion_finished_at - resolution_finished_at) * 1000, 2),
            "hash": round(hash_ms, 2),
            "persistence": round(persistence_ms, 2),
            "lock_wait": round(lock_wait_ms, 2),
            "database": round(database_ms, 2),
            "runtime_refresh": round(runtime_refresh_ms, 2),
            "total": round((perf_counter() - request_started_at) * 1000, 2),
        },
     history_scope=history_scope)
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(authoritative_cover),
            "cover_revision": cover_revision,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
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
        resolved = validate_local_cover_source(
            config,
            album_context.album_root,
            source_path,
            track_paths=album_context.track_paths,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except FileNotFoundError:
        return _json_response(({"ok": False, "error": "Selected image was not found"}, 404))
    mutation_result: dict[str, object] = {}

    def delete_and_persist_local_cover():
        def prepare(_request, baseline):
            prior_stat = resolved.stat()
            selected_cover = (
                Path(baseline.selected_cover_path)
                if baseline.selected_cover_path is not None
                else None
            )
            preserve_authority = selected_cover != resolved
            if preserve_authority:
                next_cover = selected_cover
                next_revision = baseline.selected_cover_revision
            else:
                next_cover = choose_best_remaining_local_cover(
                    album_context.album_root,
                    image_extensions=set(config["IMAGE_EXTENSIONS"]),
                    image_dimensions=image_dimensions,
                    is_squareish_cover=_is_squareish_cover,
                    score_image=score_image,
                    excluded_path=resolved,
                )
                next_revision = cover_revision_for_path(next_cover) if next_cover else None
            dimensions = image_dimensions(next_cover, raise_errors=True) if next_cover else (None, None)
            deleted_cover_bytes = resolved.read_bytes()
            return (
                deleted_cover_bytes,
                prior_stat,
                next_cover,
                next_revision,
                dimensions,
                preserve_authority,
            )

        def write_artifact(prepared, _baseline):
            (
                deleted_cover_bytes,
                prior_stat,
                next_cover,
                next_revision,
                dimensions,
                preserve_authority,
            ) = prepared
            if resolved.read_bytes() != deleted_cover_bytes:
                raise RuntimeError("Selected cover changed before deletion.")
            if next_cover is not None and cover_revision_for_path(next_cover) != next_revision:
                raise RuntimeError("Fallback cover changed before deletion.")
            artifact = CoverArtifactIdentity(
                private_path=resolved,
                sha256=None,
                post_write_exists=False,
                selected_cover_path=str(next_cover) if next_cover is not None else None,
                promoted_cover_revision=next_revision,
                prior_cover_existed=True,
                prior_cover_bytes=deleted_cover_bytes,
                prior_cover_atime_ns=prior_stat.st_atime_ns,
                prior_cover_mtime_ns=prior_stat.st_mtime_ns,
                local_cover_width=dimensions[0],
                local_cover_height=dimensions[1],
            )
            with suppress_library_watch_events((resolved,)):
                resolved.unlink()
            mutation_result["next_cover"] = next_cover
            mutation_result["next_revision"] = next_revision
            mutation_result["preserve_authority"] = preserve_authority
            return artifact

        def commit_selection(commit_request):
            repository = PostgresCoverMutationRepository(
                database_url=str(
                    config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
                ).strip()
            )
            if mutation_result.get("preserve_authority"):
                return repository.assert_baseline(request=commit_request)
            return repository.commit_selection(request=commit_request)

        def publish_committed(_outcome, _artifact) -> None:
            next_cover = mutation_result.get("next_cover")
            next_revision = mutation_result.get("next_revision")
            preserve_authority = bool(mutation_result.get("preserve_authority"))
            cover_state: Mapping[str, object] = {}
            if preserve_authority and str(
                config.get("ALBUM_HAVEN_APP_DATABASE_URL") or ""
            ).strip():
                try:
                    persisted_entries = PostgresLibraryBrowseRepository(
                        config
                    ).build_cover_state_entries_by_paths(album_context.track_paths)
                    cover_state = next(iter(persisted_entries.values()), {})
                except Exception as exc:
                    _log_local_cover_persistence_event(
                        config,
                        logger,
                        "Deleted local cover, but authoritative runtime refresh failed",
                        level="error",
                        artist=str((album or {}).get("album_artist") or "").strip(),
                        album=str((album or {}).get("name") or "").strip(),
                        year=(album or {}).get("year"),
                        error_kind=type(exc).__name__,
                    )

            if preserve_authority and not cover_state:
                mutation_result["updated"] = ([], None)
                return

            def refresh_runtime_state():
                return apply_cover_path_for_tracks(
                    album_context.track_paths,
                    next_cover,
                    config=config,
                    logger=logger,
                    library_state=library_state,
                    schedule_cache_update=False,
                    cover_revision=(
                        str(next_revision) if next_revision is not None else None
                    ),
                    remote_cover_url=cover_state.get("remote_cover_url"),
                    remote_cover_thumbnail_url=cover_state.get(
                        "remote_cover_thumbnail_url"
                    ),
                    remote_cover_source=cover_state.get("remote_cover_source"),
                    remote_cover_source_label=cover_state.get(
                        "remote_cover_source_label"
                    ),
                    remote_cover_album_url=cover_state.get(
                        "remote_cover_album_url"
                    ),
                    remote_cover_width=cover_state.get("remote_cover_width"),
                    remote_cover_height=cover_state.get("remote_cover_height"),
                    selection_authority=(
                        {
                            field: cover_state.get(field)
                            for field in (
                                "cover_selection_origin",
                                "cover_selection_provenance",
                                "local_cover_width",
                                "local_cover_height",
                            )
                        }
                        if preserve_authority
                        else None
                    ),
                )

            updated = state_service.run_authoritative_cover_commit_for_state(
                library_state,
                refresh_runtime_state,
            )
            mutation_result["updated"] = updated

        outcome = execute_cover_mutation_for_config(
            config,
            track_paths=album_context.track_paths,
            album_root=album_context.album_root,
            selected_origin="user",
            explicit_selection=True,
            clear_selection=False,
            remote_cover=None,
            prepare=prepare,
            cleanup_prepared=lambda _prepared: None,
            write_artifact=write_artifact,
            commit_selection=commit_selection,
            publish_committed=publish_committed,
        )
        if outcome.status is not CoverMutationStatus.COMMITTED:
            raise RuntimeError("Local cover deletion was not committed.")

    try:
        await run_in_threadpool(delete_and_persist_local_cover)
    except CoverMutationRetryRequired:
        return _cover_mutation_retry_response()
    updated_albums, updated_problematic_album = mutation_result["updated"]
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
    mutation_result: dict[str, object] = {}

    def save_and_persist_pasted_cover():
        def prepare(_request, _baseline):
            prepared_bytes = prepare_pasted_image_for_authoritative_write(data_url)
            decoded = decode_image_bytes(prepared_bytes)
            if decoded is None:
                raise ValueError("Clipboard image could not be processed.")
            image, width, height = decoded
            image.close()
            return prepared_bytes, width, height

        def write_artifact(prepared, _baseline):
            prepared_bytes, width, height = prepared
            promotion = begin_prepared_pasted_cover_promotion(
                album_context.album_root,
                prepared_bytes,
            )
            mutation_result["promotion"] = promotion
            mutation_result["saved_cover_path"] = promotion.cover_path
            return CoverArtifactIdentity(
                private_path=promotion.cover_path,
                sha256=promotion.promoted_cover_revision,
                post_write_exists=True,
                selected_cover_path=str(promotion.cover_path),
                promoted_cover_revision=promotion.promoted_cover_revision,
                prior_cover_existed=promotion.prior_cover_existed,
                prior_cover_bytes=promotion.prior_cover_bytes,
                local_cover_width=width,
                local_cover_height=height,
            )

        def publish_committed(_outcome, artifact) -> None:
            mutation_result["cover_revision"] = artifact.promoted_cover_revision
            promotion = mutation_result.get("promotion")
            if promotion is not None:
                complete_local_image_promotion(promotion)

            def refresh_runtime_state():
                return apply_cover_path_for_tracks(
                    album_context.track_paths,
                    artifact.private_path,
                    config=config,
                    logger=logger,
                    library_state=library_state,
                    schedule_cache_update=False,
                    cover_revision=artifact.promoted_cover_revision,
                )

            updated = state_service.run_authoritative_cover_commit_for_state(
                library_state,
                refresh_runtime_state,
            )
            mutation_result["updated"] = updated

        try:
            outcome = execute_cover_mutation_for_config(
                config,
                track_paths=album_context.track_paths,
                album_root=album_context.album_root,
                selected_origin="user",
                explicit_selection=True,
                clear_selection=False,
                remote_cover=None,
                prepare=prepare,
                cleanup_prepared=lambda _prepared: None,
                write_artifact=write_artifact,
                compensate_artifact=lambda _artifact: rollback_local_image_promotion(
                    mutation_result["promotion"]
                ),
                publish_committed=publish_committed,
            )
            if outcome.status is not CoverMutationStatus.COMMITTED:
                raise RuntimeError("Pasted cover selection was not committed.")
        except CoverMutationRetryRequired as exc:
            return None, exc, 409
        except ValueError as exc:
            return None, exc, 400
        except Exception as exc:
            return None, exc, 500
        return mutation_result.get("saved_cover_path"), None, 200

    saved_cover_path, save_error, save_status = await run_in_threadpool(
        save_and_persist_pasted_cover
    )
    if save_error is not None:
        if isinstance(save_error, CoverMutationRetryRequired):
            return _cover_mutation_retry_response()
        return _json_response(
            (
                {
                    "ok": False,
                    "error": str(save_error or "Failed to save pasted image."),
                },
                save_status,
            )
        )
    updated_albums, updated_problematic_album = mutation_result["updated"]
    cover_revision = mutation_result["cover_revision"]
    task_id = str(payload.get("task_id") or "").strip()
    try:
        if task_id:
            task_payload = await run_in_threadpool(
                _lookup_task_payload_for_request, request, task_id
            )
            actioned_task = (
                await run_in_threadpool(
                    _mark_cover_lookup_task_action_for_request,
                    request,
                    config,
                    task_id,
                )
                if _cover_lookup_task_track_paths(task_payload or {}) == album_context.track_paths
                else None
            )
            actioned_tasks = [actioned_task] if actioned_task is not None else []
        else:
            actioned_tasks = await run_in_threadpool(
                mark_cover_lookup_notifications_action_taken_for_track_paths,
                album_context.track_paths,
                config=config,
            )
    except Exception:
        logger.exception("Failed to reconcile pasted cover with lookup notifications")
        actioned_tasks = []
    return JSONResponse(
        {
            "ok": True,
            "selected_cover_path": str(saved_cover_path),
            "cover_revision": cover_revision,
            "updated_albums": updated_albums,
            "updated_album": updated_albums[0] if updated_albums else None,
            "updated_problematic_album": updated_problematic_album,
            "notification_action_taken_task_ids": [
                str(task.get("id") or "") for task in actioned_tasks
            ],
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
    durable = _durable_cover_request_context(request)
    client_surface = client_surface_from_request(request)
    if not task_id and snapshot_generation:
        try:
            task_id = UUID(snapshot_generation).hex
        except ValueError:
            pass
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
        if not task_payload and not (client_surface == "tv" and snapshot_generation):
            task_payload = await run_in_threadpool(
                load_cover_lookup_notification,
                dict(config),
                task_id,
            ) or {}
    task_payload = task_payload or {}
    task_track_paths = _cover_lookup_task_track_paths(task_payload)
    album, album_context = await _resolve_album_payload_context(
        config,
        album or {},
        fallback_track_paths=task_track_paths,
    )
    if album_context is None:
        return _json_response(({"ok": False, "error": "Album root could not be resolved"}, 400))
    task_payload = await run_in_threadpool(
        _lookup_task_payload_for_request, request, task_id
    )
    selected_match = None
    notification_action_taken = is_terminal_cover_lookup_task(task_payload)
    if task_payload:
        repository, album_id, identity_error = await run_in_threadpool(
            _resolved_snapshot_album_context,
            config,
            album or {},
            album_context.track_paths,
        )
        if identity_error is not None:
            return _json_response(identity_error)
        if not await run_in_threadpool(
            _task_matches_album_context,
            task_payload,
            track_paths=album_context.track_paths,
            album_id=album_id,
            album_key=str(
                (album or {}).get("key") or (album or {}).get("album_ref") or ""
            ),
        ):
            split_response = await _cover_lookup_album_split_response(
                config,
                _cover_lookup_task_track_paths(task_payload),
                (album or {}).get("_identity_split_choices"),
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
        repository, album_id, identity_error = await run_in_threadpool(
            _resolved_snapshot_album_context,
            config,
            album or {},
            album_context.track_paths,
        )
        if identity_error is not None:
            return _json_response(identity_error)
        try:
            candidate_snapshot = await run_in_threadpool(
                repository.get_for_album_context, album_id=int(album_id)
            )
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
        if selected_match:
            if not task_payload:
                if durable is not None:
                    durable_repository, audit = durable
                    try:
                        generation = uuid.UUID(snapshot_generation)
                        task_id = generation.hex
                        task_payload = {
                            "id": task_id,
                            "status": "completed",
                            "type": "cover-art-lookup",
                            "internal": True,
                            "artist": str((album or {}).get("album_artist") or ""),
                            "album": str((album or {}).get("name") or (album or {}).get("album") or ""),
                            "year": (album or {}).get("year"),
                            "progress": 100,
                            "progress_label": "Completed",
                            "message": "Saved cover candidates restored.",
                            "possible_matches": [
                                dict(item)
                                for item in snapshot_candidates
                                if isinstance(item, Mapping)
                            ],
                            "selected_candidate_id": "",
                            "result_kind": "possible-matches",
                        }
                        def persist_candidate_authority():
                            return durable_repository.persist_candidate_authority(
                                task_key=task_id,
                                library_id=audit.library_id,
                                album_key=str((album or {}).get("key") or (album or {}).get("album_key") or ""),
                                account_id=audit.account_id,
                                request_origin_ref=request_origin_ref_for_request(request),
                                deployment_mode=audit.deployment_mode,
                                client_surface=audit.client_surface_class,
                                candidate_generation=generation,
                                resource_revision=durable_repository.current_inventory_revision(
                                    library_id=audit.library_id
                                ),
                                recorded_at=datetime.now(timezone.utc),
                                task_payload=task_payload,
                                candidates=task_payload["possible_matches"],
                                best_candidate_id=str(candidate_snapshot.get("best_candidate_id") or "") or None,
                            )

                        await run_in_threadpool(persist_candidate_authority)
                    except (TypeError, ValueError):
                        return _json_response(
                            ({"ok": False, "error": "Saved cover candidate generation was not found"}, 404)
                        )
                    except Exception:
                        return _json_response(
                            ({"ok": False, "error": "Saved cover candidates could not be restored"}, 503)
                        )
                else:
                    task_id, _cancel_event = create_cover_lookup_task(
                        dict(album or {}),
                        album_context.track_paths,
                        internal=True,
                        config=config,
                        preferred_task_id=task_id,
                    )
                    task_payload = cover_lookup_result(task_id)
    if (selected_match and client_surface_from_request(request) == "tv"
            and not is_provider_lookup_match(selected_match)):
        return _json_response(({"ok": False, "error": "Only provider cover candidates can be selected on TV."}, 403))
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
    save_generation = uuid4().hex
    accepted_durably = False
    if durable is not None:
        repository, audit = durable
        try:
            def accept_remote_save():
                durable_task = repository.get_task(
                    task_key=task_id, library_id=audit.library_id
                )
                generation = uuid.UUID(str(durable_task["candidate_generation"]))
                return repository.accept_remote_save(
                    task_key=task_id,
                    library_id=audit.library_id,
                    account_id=audit.account_id,
                    request_origin_ref=request_origin_ref_for_request(request),
                    deployment_mode=audit.deployment_mode,
                    client_surface=audit.client_surface_class,
                    candidate_generation=generation,
                    candidate_id=candidate_id,
                    resource_revision=int(durable_task.get("resource_revision") or 0),
                    scheduled_at=datetime.now(timezone.utc),
                )

            await run_in_threadpool(accept_remote_save)
            accepted_durably = True
        except (KeyError, TypeError, ValueError):
            return _json_response(
                ({"ok": False, "error": "Selected remote candidate is stale"}, 409)
            )
        except Exception:
            return _json_response(
                ({"ok": False, "error": "Selected remote cover could not be queued"}, 503)
            )
    else:
        update_cover_lookup_task(
            task_id,
            config=config,
            **{
                **dict(task_payload),
                "status": "running",
                "progress": 92,
                "progress_label": "Saving selected cover art...",
                "selected_candidate_id": candidate_id,
                "save_generation": save_generation,
                "result_kind": "",
                "finished_at": None,
                "updated_albums": [],
                "updated_problematic_album": None,
                "notification_completed_at": str(
                    task_payload.get("notification_completed_at")
                    or task_payload.get("finished_at")
                    or ""
                ).strip(),
                "message": "Saving selected cover art...",
                "job_contract": build_cover_lookup_job_contract("save_remote_selection"),
            },
        )
    response_task_payload = serialize_cover_lookup_task_payload(
        await run_in_threadpool(_lookup_task_payload_for_request, request, task_id)
    )
    if not accepted_durably:
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
            save_generation=save_generation,
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
    durable = _durable_cover_request_context(request)
    task_payload = await run_in_threadpool(
        _lookup_task_payload_for_request, request, task_id
    )
    if durable is None and not task_id:
        task_id, _cancel_event = create_cover_lookup_task(album or {}, album_context.track_paths)
        task_payload = cover_lookup_result(task_id)
    merged_matches = merge_lookup_matches(
        task_payload.get("possible_matches") if isinstance(task_payload.get("possible_matches"), list) else [],
        matches,
    )
    if durable is not None:
        repository, audit = durable
        generation = uuid.uuid4()
        task_id = task_id or generation.hex
        task_payload = {
            **dict(task_payload or {}),
            "id": task_id,
            "status": "completed",
            "type": "cover-art-lookup",
            "internal": False,
            "artist": str((album or {}).get("album_artist") or ""),
            "album": str((album or {}).get("name") or (album or {}).get("album") or ""),
            "year": (album or {}).get("year"),
            "progress": 100,
            "progress_label": "Completed",
            "message": "Remote matches updated from pasted links.",
            "possible_matches": merged_matches,
            "selected_candidate_id": "",
            "result_kind": "possible-matches",
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            def persist_candidate_authority():
                return repository.persist_candidate_authority(
                    task_key=task_id,
                    library_id=audit.library_id,
                    album_key=str((album or {}).get("key") or (album or {}).get("album_key") or ""),
                    account_id=audit.account_id,
                    request_origin_ref=request_origin_ref_for_request(request),
                    deployment_mode=audit.deployment_mode,
                    client_surface=audit.client_surface_class,
                    candidate_generation=generation,
                    resource_revision=repository.current_inventory_revision(
                        library_id=audit.library_id
                    ),
                    recorded_at=datetime.now(timezone.utc),
                    task_payload=task_payload,
                    candidates=merged_matches,
                    best_candidate_id=str(merged_matches[0].get("id") or "") or None,
                )

            await run_in_threadpool(persist_candidate_authority)
        except ValueError as exc:
            return _json_response(({"ok": False, "error": str(exc)}, 409))
        except Exception:
            return _json_response(
                ({"ok": False, "error": "Manual cover candidates could not be saved"}, 503)
            )
    else:
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
        task_payload = cover_lookup_result(task_id)
    return JSONResponse(
        {
            "ok": True,
            "task": serialize_cover_lookup_task_payload(task_payload),
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
    durable = _durable_cover_request_context(request)
    try:
        if durable is not None:
            repository, audit = durable
            def accept_bulk_refresh():
                return repository.accept_bulk_refresh(
                    task_key=uuid.uuid4().hex,
                    library_id=audit.library_id,
                    account_id=audit.account_id,
                    request_origin_ref=request_origin_ref_for_request(request),
                    deployment_mode=audit.deployment_mode,
                    client_surface=audit.client_surface_class,
                    mode="manual",
                    force_search=force_search,
                    resource_revision=repository.current_inventory_revision(
                        library_id=audit.library_id
                    ),
                    scheduled_at=datetime.now(timezone.utc),
                )

            accepted = await run_in_threadpool(accept_bulk_refresh)
            start_result = {
                "started": not accepted.already_running,
                "already_running": accepted.already_running,
                "queued_after_indexing": False,
                "queued_count": 0,
                "current_folder": "",
            }
        else:

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
    durable = _durable_cover_request_context(request)
    if durable is not None:
        repository, audit = durable
        try:
            result = await run_in_threadpool(
                repository.request_bulk_refresh_cancellation,
                library_id=audit.library_id,
                account_id=audit.account_id,
                now=datetime.now(timezone.utc),
            )
        except Exception:
            result = {"cancelled": False, "covers_in_progress": False}
    else:
        result = cancel_cover_refresh_status(
            get_state=lambda: _library_state(request),
            cache_lock=state_service._CACHE_LOCK,
        )
    return JSONResponse({"ok": True, **result})
