from __future__ import annotations

from music_app.services.log_history import history_scope_for_request

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
import logging
from pathlib import Path
from threading import Event
from time import perf_counter
from uuid import UUID
from urllib.parse import urlencode

import asyncio
from concurrent.futures import TimeoutError as FutureTimeoutError
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_cover_helpers import (
    apply_cover_path_for_tracks,
    publish_ordered_cover_selection_for_tracks,
    serialize_ordered_cover_selection_for_read,
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_task_summaries,
    mark_cover_lookup_notifications_action_taken_for_track_paths,
    mark_cover_lookup_task_notification_action_taken,
)
from music_app.services import state as state_service
from music_app.services.cache import (
    run_cover_mutation_for_config, persist_ordered_cover_selection_for_config,
    load_cover_selections_for_config,
)
from music_app.services.cover_mutation import CoverMutationFinalizationError, CoverMutationCommitUncertainError
from music_app.services.app_logging import log_app_event
from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)
from music_app.services.album_identity_lineage_postgres import (
    AlbumIdentityLineageRepository,
)
from music_app.services.cover_state import (
    find_albums_by_track_paths as find_albums_by_track_paths_in_state,
    serialize_cover_candidate_snapshot,
    serialize_cover_gallery_payload,
)
from music_app.services.cover_lookup_runtime import (
    fetch_remote_cover_bytes,
    merge_lookup_matches,
    queue_cover_lookup_task,
)
from music_app.services.cover_lookup_tasks import (
    cancel_cover_lookup_task_payload,
    count_cover_lookup_task_notifications,
    cover_lookup_result,
    create_cover_lookup_task,
    load_cover_lookup_task_summary_page,
    serialize_cover_lookup_task_payload,
    update_cover_lookup_task,
)
from music_app.services.cover_lookup_notifications import load_cover_lookup_notification
from music_app.services.local_cover_provenance import record_local_cover_provenance
from music_app.services.cover_manual_links import add_manual_cover_candidates_from_urls
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.cover_refresh_runtime import (
    cancel_cover_refresh_status,
    start_manual_cover_refresh_request,
)
from music_app.services.cover_workflow import (
    CoverAlbumContext,
    begin_prepared_remote_cover_promotion,
    cover_promotion_effect,
    prepare_pasted_cover_bytes,
    prepare_remote_cover_bytes_for_authoritative_write,
    prepare_local_cover_image,
    decode_image_bytes,
    delete_local_cover_effect,
    complete_local_image_promotion,
    ranked_local_cover_candidates,
    resolve_album_context,
    resolve_album_write_root_from_track_paths,
    rollback_local_image_promotion,
    validate_local_cover_source,
    write_new_cover_file,
)
from music_app.services.album_cover_candidate_publisher import sanitize_persisted_candidate_snapshot
from music_app.services.cover_provider_candidates import DISPLAY_ONLY_REMOTE_SOURCES
from music_app.services.custom_collection_artwork_postgres import (
    CustomCollectionArtworkRepository,
)
from music_app.services.covers import image_dimensions, score_image
from music_app.services.ordered_cover_references import OrderedCoverSelectionConflict
from music_app.services.ordered_cover_selection import InvalidOrderedCoverSelection, current_cover_token, validate_save_request
from music_app.services.policy import ResourceScope
from music_app.services.policy_asgi import require_action
from music_app.services.scan_cache_persistence import select_scan_cache_adapter
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


def _custom_collection_artwork_payload(row: Mapping[str, object] | None) -> JsonDict | None:
    if not row:
        return None
    name = str(row.get("collection_name") or "").strip()
    revision = int(row.get("revision") or 0)
    return {
        "collection_name": name,
        "revision": revision,
        "content_sha256": str(row.get("content_sha256") or ""),
        "width": int(row.get("width") or 0),
        "height": int(row.get("height") or 0),
        "filename": str(row.get("filename") or "collection-cover.jpg"),
        "updated_at": str(row.get("updated_at") or ""),
        "image_url": "/api/custom-collections/artwork/image?" + urlencode({
            "collection_name": name,
            "revision": revision,
        }),
    }


def _custom_collection_scope(request: Request) -> tuple[int, int]:
    actor = request.state.current_actor
    library_id = int(actor.current_library_id or 0)
    account_id = int(actor.account_id or 0)
    if library_id <= 0 or account_id <= 0:
        raise HTTPException(status_code=403, detail="Current library access is required.")
    return library_id, account_id


@router.get("/api/custom-collections/artwork")
async def custom_collection_artwork_read(request: Request) -> JSONResponse:
    library_id, _account_id = _custom_collection_scope(request)
    collection_name = str(request.query_params.get("collection_name") or "").strip()
    try:
        artwork = await run_in_threadpool(
            CustomCollectionArtworkRepository(_app_config(request)).load,
            library_id=library_id,
            collection_name=collection_name,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    return JSONResponse({"ok": True, "artwork": _custom_collection_artwork_payload(artwork)})


@router.get("/api/custom-collections/artwork/image")
async def custom_collection_artwork_image(request: Request) -> Response:
    library_id, _account_id = _custom_collection_scope(request)
    collection_name = str(request.query_params.get("collection_name") or "").strip()
    requested_revision = str(request.query_params.get("revision") or "").strip()
    try:
        artwork = await run_in_threadpool(
            CustomCollectionArtworkRepository(_app_config(request)).load_image,
            library_id=library_id,
            collection_name=collection_name,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    if not artwork or (requested_revision and requested_revision != str(artwork.get("revision") or "")):
        return _json_response(({"ok": False, "error": "Collection artwork was not found."}, 404))
    return Response(
        content=bytes(artwork["image_bytes"]),
        media_type="image/jpeg",
        headers={
            "Cache-Control": "private, max-age=31536000, immutable",
            "ETag": f'"{str(artwork.get("content_sha256") or "")}"',
        },
    )


@router.post("/api/custom-collections/artwork")
async def custom_collection_artwork_save(request: Request) -> JSONResponse:
    library_id, account_id = _custom_collection_scope(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    collection_name = str(payload.get("collection_name") or "").strip()
    try:
        image_bytes = prepare_pasted_cover_bytes(str(payload.get("data_url") or ""))
        decoded = decode_image_bytes(image_bytes)
        if decoded is None:
            raise ValueError("Collection artwork could not be decoded.")
        image, width, height = decoded
        image.close()
        artwork = await run_in_threadpool(
            CustomCollectionArtworkRepository(_app_config(request)).save,
            library_id=library_id,
            collection_name=collection_name,
            account_id=account_id,
            image_bytes=image_bytes,
            content_sha256=sha256(image_bytes).hexdigest(),
            width=width,
            height=height,
            filename=Path(str(payload.get("filename") or "collection-cover.jpg")).name,
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    return JSONResponse({"ok": True, "artwork": _custom_collection_artwork_payload(artwork)})


@router.delete("/api/custom-collections/artwork")
async def custom_collection_artwork_delete(request: Request) -> JSONResponse:
    library_id, _account_id = _custom_collection_scope(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    try:
        deleted = await run_in_threadpool(
            CustomCollectionArtworkRepository(_app_config(request)).delete,
            library_id=library_id,
            collection_name=str(payload.get("collection_name") or "").strip(),
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    return JSONResponse({"ok": True, "deleted": deleted})


@router.post("/api/custom-collections/artwork/extract")
async def custom_collection_artwork_extract(request: Request) -> JSONResponse:
    _library_id, _account_id = _custom_collection_scope(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    collection_name = str(payload.get("collection_name") or "").strip()
    urls = [str(url).strip() for url in list(payload.get("urls") or [])[:8] if str(url).strip()]
    if not collection_name or not urls:
        return _json_response(({"ok": False, "error": "Collection name and link are required."}, 400))
    config = _app_config(request)
    try:
        matches = await run_in_threadpool(
            add_manual_cover_candidates_from_urls,
            urls,
            target_artist="",
            target_album=collection_name,
            target_edition=None,
            target_year=None,
            user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    allowed = ("id", "url", "thumbnail_url", "source", "source_label", "width", "height")
    candidates = [
        {key: match[key] for key in allowed if key in match}
        for match in list(matches or [])[:8]
        if isinstance(match, Mapping) and str(match.get("url") or "").strip()
    ]
    return JSONResponse({"ok": True, "candidates": candidates})


@router.post("/api/custom-collections/artwork/remote")
async def custom_collection_artwork_remote_save(request: Request) -> JSONResponse:
    library_id, account_id = _custom_collection_scope(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    collection_name = str(payload.get("collection_name") or "").strip()
    remote_url = str(payload.get("url") or "").strip()
    if not collection_name or not remote_url:
        return _json_response(({"ok": False, "error": "Collection name and image link are required."}, 400))
    config = _app_config(request)
    try:
        raw_bytes, _mime_type = await run_in_threadpool(
            fetch_remote_cover_bytes,
            remote_url,
            config=config,
            user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
        )
        image_bytes = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes or b"")
        decoded = decode_image_bytes(image_bytes or b"")
        if not image_bytes or decoded is None:
            raise ValueError("Remote collection artwork could not be decoded.")
        image, width, height = decoded
        image.close()
        artwork = await run_in_threadpool(
            CustomCollectionArtworkRepository(config).save,
            library_id=library_id,
            collection_name=collection_name,
            account_id=account_id,
            image_bytes=image_bytes,
            content_sha256=sha256(image_bytes).hexdigest(),
            width=width,
            height=height,
            filename="collection-cover.jpg",
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    return JSONResponse({"ok": True, "artwork": _custom_collection_artwork_payload(artwork)})


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
    resolved_context = resolve_album_context(config, normalized_album)
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
                        resolve_album_context(config, normalized_album)
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
    resolved_context = (
        resolve_album_context(config, normalized_album)
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
    task_ids: str | None = None,
) -> JSONResponse:
    config = _app_config(request)
    if limit is None and cursor is None and active_only is None and task_ids is None:
        tasks = await run_in_threadpool(list_cover_lookup_task_summaries, config=config)
        return JSONResponse({"ok": True, "tasks": tasks})
    tracked_task_ids = tuple(dict.fromkeys(
        item.strip() for item in str(task_ids or "").split(",") if item.strip()
    ))
    if len(tracked_task_ids) > 60 or any(len(task_id) > 200 for task_id in tracked_task_ids):
        return JSONResponse(
            {"ok": False, "error": "Invalid cover lookup notification task IDs"},
            status_code=400,
        )
    try:
        page_kwargs = {
            "config": config,
            "limit": max(1, min(limit or 50, 50)),
            "cursor": cursor,
            "active_only": active_only is True,
        }
        if tracked_task_ids:
            page_kwargs["task_ids"] = tracked_task_ids
        page = await run_in_threadpool(
            load_cover_lookup_task_summary_page,
            **page_kwargs,
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
    repository, album_id, identity_error = _resolved_snapshot_album_context(
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
    task_matches = bool(task_payload) and _task_matches_album_context(
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
            candidate_snapshot = repository.get_for_album_context(album_id=int(album_id))
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


async def _legacy_cover_mutation_preflight(config, track_paths, *, deleting_source_path=None):
    try:
        await run_in_threadpool(
            select_scan_cache_adapter(config).assert_legacy_cover_mutation_allowed,
            track_paths=track_paths,
            deleting_source_path=deleting_source_path,
        )
    except OrderedCoverSelectionConflict:
        return _json_response(({
            "ok": False,
            "code": "ordered_cover_selection_conflict",
            "error": "Reload this album and use the full cover selection to change its artwork.",
        }, 409))
    except ValueError:
        return _json_response(({"ok": False, "error": "Album cover selection could not be resolved."}, 409))
    except Exception:
        return _json_response(({"ok": False, "error": "Album cover selection is unavailable. Try again."}, 503))
    return None


@router.get("/albums/{album_ref}/selected-covers")
async def albums_selected_covers_read(request: Request, album_ref: str) -> JSONResponse:
    """Read current saved references under the existing editor-gallery policy."""
    await require_action("library.covers.lookup", refresh_actor=True)(request)
    if (len(album_ref) > 19 or not album_ref.isascii() or not album_ref.isdecimal()
            or not 0 < int(album_ref) < 2**63):
        return JSONResponse({"ok": False, "error": "Album was not found."}, status_code=404)
    album_id = int(album_ref)
    config = _app_config(request)
    resource = ResourceScope("album", str(album_id))
    try:
        context = await run_in_threadpool(
            AlbumCoverCandidateSnapshotRepository(config).resolve_album_track_context,
            album_id=album_id, album_key=None,
        )
        if (not context or context.get("album_id") != album_id
                or type(context.get("library_id")) is not int
                or context["library_id"] != request.state.current_actor.current_library_id):
            return JSONResponse({"ok": False, "error": "Album was not found."}, status_code=404)
        library_id = context["library_id"]
        await require_action("library.covers.lookup", library_id=library_id, resource=resource)(request)
        selections = await run_in_threadpool(load_cover_selections_for_config, config, {album_id})
        if album_id not in selections:
            return JSONResponse({"ok": False, "error": "Album was not found."}, status_code=404)
        await require_action("library.covers.lookup", library_id=library_id,
                             resource=resource, refresh_actor=True)(request)
        if request.state.current_actor.current_library_id != library_id:
            raise HTTPException(status_code=403, detail="Action not permitted.")
        remote_read = True
        try:
            await require_action("library.covers.remote.read", library_id=library_id, resource=resource)(request)
        except HTTPException as exc:
            if exc.status_code != 403:
                raise
            remote_read = False
        selection = selections[album_id]
        references = await run_in_threadpool(
            serialize_ordered_cover_selection_for_read, config, set(context["track_paths"]),
            selection, remote_read=remote_read,
        )
        primary_token = current_cover_token(
            album_id=album_id, library_id=library_id,
            cover_path=selection.get("selected_cover_path"), metadata=selection,
        )
    except HTTPException:
        raise
    except Exception:
        return JSONResponse({"ok": False, "error": "Cover selection is temporarily unavailable."}, status_code=503)
    # A local source leaves as `candidate_cover_path`, which the cover reference boundary
    # publishes as `candidate_cover_ref`; the client never receives the path itself.
    references = [
        {**{key: value for key, value in item.items() if key != "path"}, "candidate_cover_path": item["path"]}
        if item.get("kind") == "local" and item.get("path") else item
        for item in references
    ]
    return JSONResponse({
        "ok": True, "album_ref": str(album_id), "selected_covers": references,
        "selected_covers_revision": selection.get("selected_covers_revision", 0),
        **({"current_cover_token": primary_token} if primary_token is not None else {}),
    }, headers={"Cache-Control": "private, no-store"})


@router.put("/albums/{album_ref}/selected-covers")
async def albums_selected_covers_save(request: Request, album_ref: str) -> JSONResponse:
    """Remember existing source references without copying or fetching artwork."""
    await require_action("library.covers.write", refresh_actor=True)(request)
    if client_surface_from_request(request) == "tv":
        return JSONResponse({"ok": False, "error": "Ordered cover selection is unavailable on TV."}, status_code=403)
    if (len(album_ref) > 19 or not album_ref.isascii() or not album_ref.isdecimal()
            or not 0 < int(album_ref) < 2**63):
        return JSONResponse({"ok": False, "error": "Album was not found."}, status_code=404)
    album_id = int(album_ref)
    payload = await _json_payload(request)
    if (not isinstance(payload, dict)
            or not {"expected_revision", "mutation_id", "references"} <= set(payload)
            or not set(payload) <= {"expected_revision", "mutation_id", "references", "lookup_task_id"}):
        return JSONResponse({"ok": False, "error": "A revision, mutation ID and ordered references are required."}, status_code=422)
    # The Cover Look Up notification this choice answers, when it was opened from one.
    lookup_task_id = payload.pop("lookup_task_id", "")
    if not isinstance(lookup_task_id, str):
        return JSONResponse({"ok": False, "error": "A revision, mutation ID and ordered references are required."}, status_code=422)
    lookup_task_id = lookup_task_id.strip()
    # A local source arrives as the `candidate_cover_ref` the lookup published; the cover reference
    # boundary has already resolved it to `candidate_cover_path` (null when it names no visible file).
    if isinstance(payload["references"], list):
        payload["references"] = [
            {"kind": "local", "path": item["candidate_cover_path"]}
            if isinstance(item, dict) and item.get("kind") == "local" and set(item) == {"kind", "candidate_cover_path"}
            else item
            for item in payload["references"]
        ]
    try:
        validate_save_request(expected_album_id=album_id, **payload)
    except ValueError:
        return JSONResponse({"ok": False, "error": "Select up to three valid cover references (or none) with a revision and mutation UUID."}, status_code=422)

    config = _app_config(request)
    library_state = _library_state(request)
    resource = ResourceScope("album", str(album_id))
    remote_read = any(item.get("kind") == "remote" for item in payload["references"])
    try:
        context = await run_in_threadpool(
            AlbumCoverCandidateSnapshotRepository(config).resolve_album_track_context,
            album_id=album_id, album_key=None,
        )
        if (not context or context.get("album_id") != album_id
                or type(context.get("library_id")) is not int
                or context["library_id"] != request.state.current_actor.current_library_id):
            return JSONResponse({"ok": False, "error": "Album was not found."}, status_code=404)
        library_id = context["library_id"]

        async def authorize_current_selection():
            # Refresh again after waiting for source/database locks. A cached
            # actor from the start of a long request is not commit authority.
            await require_action("library.covers.write", library_id=library_id,
                                 resource=resource, refresh_actor=True)(request)
            if request.state.current_actor.current_library_id != library_id:
                raise HTTPException(status_code=403, detail="Action not permitted.")
            if remote_read:
                await require_action("library.covers.remote.read", library_id=library_id,
                                     resource=resource)(request)

        await authorize_current_selection()
        loop = asyncio.get_running_loop()
        track_paths = set(context["track_paths"])
        album_root = await run_in_threadpool(resolve_album_write_root_from_track_paths, config, track_paths)

        def commit_and_publish(commit):
            # This thread holds the album's database and folder locks: every wait from here is bounded.
            _run_on_loop_within(loop, authorize_current_selection, _COVER_SAVE_AUTHORIZATION_WAIT_SECONDS)

            def publish():
                committed = commit()
                if committed["changed"] or (
                    committed["replayed"] and committed["replay_publication_required"]
                ):
                    publish_ordered_cover_selection_for_tracks(
                        library_state, track_paths, committed["selected_covers"],
                    )
                return committed

            # The shared owner holds the runtime lock through commit and
            # publication. A replay may repair a lost publication without
            # cancelling a scan started after the original mutation.
            committed = state_service.run_authoritative_cover_commit_for_state(
                library_state, publish,
                should_supersede_scan=lambda value: value["changed"],
            )
            # A previous response may have failed after primary publication
            # but before all projections were invalidated. Replays repeat this
            # idempotent refresh even when the primary cache already matches.
            if committed["changed"] or committed["replayed"]:
                state_service.invalidate_targeted_library_projections(
                    library_state, config, revision=committed["inventory_mutation_revision"],
                    affected_album_keys=(context["album_key"],),
                    lock_timeout_seconds=state_service.COVER_COMMIT_RUNTIME_LOCK_WAIT_SECONDS,
                )

        downloads = await run_in_threadpool(
            _download_online_cover_choices, config, album_id=album_id, album_root=album_root, payload=payload,
        )
        try:
            result = await run_in_threadpool(
                persist_ordered_cover_selection_for_config, config,
                track_paths=track_paths, album_root=album_root, expected_album_id=album_id,
                **payload, commit_guard=commit_and_publish, downloads=downloads.paths,
            )
        except (CoverMutationCommitUncertainError, CoverMutationFinalizationError):
            raise  # The selection may name these downloads: keep them.
        except Exception:
            # Definitely not saved: the album folder returns to how it was, so a cover that
            # never committed cannot stand in for the saved one.
            await run_in_threadpool(downloads.undo)
            raise
        # A replay saved nothing new, so this request's downloads are not referenced.
        await run_in_threadpool(downloads.undo if result["replayed"] else downloads.finish)
    except OnlineCoverDownloadFailed:
        return JSONResponse({"ok": False, "error": "This online cover could not be downloaded. Your current cover is unchanged."}, status_code=502)
    except HTTPException:
        raise
    except OrderedCoverSelectionConflict:
        return JSONResponse({"ok": False, "error": "The album or cover selection changed. Reload before saving again."}, status_code=409)
    except InvalidOrderedCoverSelection:
        return JSONResponse({"ok": False, "error": "Select up to three distinct cover references."}, status_code=422)
    except (ValueError, FileNotFoundError):
        return JSONResponse({"ok": False, "error": "An album or cover source is unavailable."}, status_code=404)
    except CoverMutationCommitUncertainError:
        return JSONResponse({"ok": False, "persisted": None, "error": "Save confirmation was interrupted. Retry the same request to check its outcome."}, status_code=503)
    except CoverMutationFinalizationError:
        return JSONResponse({"ok": False, "persisted": True, "error": "The selection was saved, but its display could not refresh. Retry the same request."}, status_code=503)
    except Exception:
        return JSONResponse({"ok": False, "error": "Cover selection is temporarily unavailable. Retry the same request."}, status_code=503)
    if downloads.provenance and not result["replayed"]:
        # Album Details shows a downloaded cover's provider badge (album page setting, owner 2026-11-17).
        # The cover is saved either way; a failure here only loses the badge.
        try:
            await run_in_threadpool(
                record_local_cover_provenance, config,
                library_id=request.state.current_actor.current_library_id, provenance=downloads.provenance,
            )
        except Exception:
            logging.getLogger(__name__).exception("Could not record the provider of a downloaded cover.")
    # Which lookup and provider each saved cover came from, including downloaded online covers.
    provenance = {
        item["selection_id"]: (
            _ordered_remote_cover_provenance(item) if item["kind"] == "remote"
            else downloads.provenance.get(str(item.get("path") or ""))
        )
        for item in result["selected_covers"]
    }
    lookup_task = await _answer_cover_lookup_with_ordered_save(
        config, lookup_task_id, track_paths=track_paths, album_id=album_id,
        album_key=str(context.get("album_key") or ""), provenance=list(provenance.values()),
    )
    # Source URLs remain private. An editor with remote-read authority also sees which lookup and
    # provider each online cover came from; retaining an opaque saved ID discloses neither.
    from music_app.services.policy_asgi import allowed_actions_for_request

    remote_details = allowed_actions_for_request(
        request, ("library.covers.remote.read",),
    ).as_payload().get("library.covers.remote.read") is True
    return JSONResponse({
        "ok": True, "album_ref": str(album_id),
        "selected_covers": [
            {"selection_id": item["selection_id"], "kind": item["kind"],
             **((provenance[item["selection_id"]] or {}) if remote_details else {})}
            for item in result["selected_covers"]
        ],
        "selected_covers_revision": result["selected_covers_revision"],
        "changed": result["changed"], "replayed": result["replayed"],
        "lookup_task": lookup_task,
    })


def _ordered_remote_cover_provenance(item: Mapping[str, object]) -> dict[str, str]:
    """The lookup and provider an online cover was chosen from; never its URL."""
    return {
        "candidate_id": str(item.get("candidate_id") or ""),
        "lookup_task_id": _uuid_hex(str(item.get("candidate_generation") or "")),
        "source": str(item.get("source") or ""),
        "source_label": str(item.get("source_label") or ""),
    }


async def _answer_cover_lookup_with_ordered_save(
    config, lookup_task_id: str, *, track_paths: set[str], album_id: int, album_key: str,
    provenance: list[Mapping[str, str] | None],
) -> dict[str, object] | None:
    """Mark the lookup notification a saved choice answers, naming the candidate taken from it."""
    if not lookup_task_id:
        return None
    task = cover_lookup_result(lookup_task_id) or await run_in_threadpool(
        load_cover_lookup_notification, dict(config), lookup_task_id,
    ) or {}
    if not task or not _task_matches_album_context(
        task, track_paths=track_paths, album_id=album_id, album_key=album_key,
    ):
        return None
    chosen = next((
        item["candidate_id"] for item in provenance
        if item and item["lookup_task_id"] == _uuid_hex(lookup_task_id)
    ), "")
    return await run_in_threadpool(
        lambda: mark_cover_lookup_task_notification_action_taken(
            lookup_task_id, config=config, selected_candidate_id=chosen,
        ),
    )


_COVER_SAVE_AUTHORIZATION_WAIT_SECONDS = 10.0


def _run_on_loop_within(loop, coroutine_function, timeout_seconds: float):
    """Run a coroutine on the request's loop from a worker thread, waiting at most `timeout_seconds`."""
    future = asyncio.run_coroutine_threadsafe(coroutine_function(), loop)
    try:
        return future.result(timeout=timeout_seconds)
    except FutureTimeoutError:
        future.cancel()
        raise TimeoutError("The cover save could not be confirmed in time.") from None


class OnlineCoverDownloadFailed(RuntimeError):
    """An online cover chosen for download could not be fetched or written."""


@dataclass
class _OnlineCoverDownloads:
    """Album files written for online choices before their Save commits, and how to undo them."""

    paths: dict[tuple[str, str], str] = field(default_factory=dict)
    provenance: dict[str, dict[str, str]] = field(default_factory=dict)
    promotions: list = field(default_factory=list)
    files: list[Path] = field(default_factory=list)

    def undo(self) -> None:
        for promotion in self.promotions:
            rollback_local_image_promotion(promotion)
        for path in self.files:
            path.unlink(missing_ok=True)
        self.promotions, self.files = [], []

    def finish(self) -> None:
        for promotion in self.promotions:
            complete_local_image_promotion(promotion)
        self.promotions, self.files = [], []


def _download_online_cover_choices(config, *, album_id: int, album_root: Path | None,
                                   payload: Mapping[str, object]) -> _OnlineCoverDownloads:
    """Download every chosen online cover except linked ones (Spotify) into the album folder.

    The first cover becomes cover.jpg (the previous one is kept as a cover-existing copy) unless
    the same Save also selects the current cover.jpg; others become cover-2.jpg, cover-3.jpg,
    never overwriting a file. Local files are only selected, never copied or renamed.
    """
    downloads = _OnlineCoverDownloads()
    references = list(payload["references"])
    if not any(item.get("kind") == "remote" for item in references):
        return downloads
    prior = load_cover_selections_for_config(config, {album_id}).get(album_id) or {}
    if (prior.get("selected_covers_last_request") or {}).get("mutation_id") == str(UUID(payload["mutation_id"])):
        return downloads  # A retry of a saved request replays it without downloading again.
    snapshot = AlbumCoverCandidateSnapshotRepository(config).get_for_album_context(album_id=album_id) or {}
    try:
        generation = str(UUID(str(snapshot.get("search_generation"))))
    except ValueError:
        return downloads  # The Save itself reports the changed candidates.
    candidates, invalid = sanitize_persisted_candidate_snapshot(snapshot.get("candidates"))
    by_id = {candidate.get("id"): candidate for candidate in ([] if invalid else candidates)}
    prior_paths = {item["selection_id"]: item.get("path") for item in prior.get("selected_covers", [])}
    named = [item.get("path") for item in references if item.get("kind") == "local"]
    named += [prior_paths.get(item["selection_id"]) for item in references if "selection_id" in item]
    if any(item.get("retain_current") is True for item in references):
        named.append(prior.get("selected_cover_path"))
    cover_jpg = str(album_root / "cover.jpg").casefold() if album_root is not None else ""
    keep_cover_jpg = any(path and str(path).casefold() == cover_jpg for path in named)
    try:
        for index, reference in enumerate(references):
            if reference.get("kind") != "remote" or str(UUID(reference["candidate_generation"])) != generation:
                continue
            candidate = by_id.get(reference["candidate_id"])
            if candidate is None or candidate.get("source") in DISPLAY_ONLY_REMOTE_SOURCES:
                continue
            if album_root is None:
                raise OnlineCoverDownloadFailed("The album folder is unavailable.")
            raw_bytes, _mime_type = fetch_remote_cover_bytes(str(candidate.get("url") or ""), config=config)
            prepared = prepare_remote_cover_bytes_for_authoritative_write(raw_bytes or b"")
            if not prepared:
                raise OnlineCoverDownloadFailed("The online cover is not a readable image.")
            if index == 0 and not keep_cover_jpg:
                promotion = begin_prepared_remote_cover_promotion(album_root, prepared)
                if promotion is None:
                    raise OnlineCoverDownloadFailed("The online cover is not a readable image.")
                downloads.promotions.append(promotion)
                path = promotion.cover_path
            else:
                path = write_new_cover_file(album_root, prepared, f"cover-{index + 1}.jpg")
                downloads.files.append(path)
            downloads.paths[(candidate["id"], generation)] = str(path)
            downloads.provenance[str(path)] = {
                "candidate_id": str(candidate["id"]), "lookup_task_id": UUID(generation).hex,
                "source": str(candidate.get("source") or ""),
                "source_label": str(candidate.get("source_label") or ""),
            }
    except Exception as exc:
        downloads.undo()
        if isinstance(exc, OnlineCoverDownloadFailed):
            raise
        raise OnlineCoverDownloadFailed("The online cover could not be downloaded.") from exc
    return downloads


def _uuid_hex(value: str) -> str:
    # Lookup task IDs are the hex form of the candidate search generation.
    try:
        return UUID(value).hex
    except ValueError:
        return value


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
    preflight_error = await _legacy_cover_mutation_preflight(
        config, album_context.track_paths, deleting_source_path=resolved,
    )
    if preflight_error is not None:
        return preflight_error
    candidate_dimensions = {}
    candidate_revisions = {}

    def prepare_candidate(path):
        dimensions, revision = prepare_local_cover_image(path, image_dimensions)
        candidate_dimensions[path] = dimensions
        candidate_revisions[path] = revision
        return dimensions

    try:
        candidates = ranked_local_cover_candidates(
            album_context.album_root, image_extensions=set(config["IMAGE_EXTENSIONS"]),
            image_dimensions=prepare_candidate, is_squareish_cover=_is_squareish_cover,
            score_image=score_image,
        )
    except OrderedCoverSelectionConflict as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 409))
    updated_albums: list[dict[str, object]] = []
    updated_problematic_album = None

    def delete(scope):
        fresh_source = validate_local_cover_source(
            config, album_context.album_root, source_path,
            track_paths=album_context.track_paths,
        )
        if fresh_source != resolved:
            raise OrderedCoverSelectionConflict("The image source moved while deletion was prepared. Retry the deletion.")
        active = Path(scope["cover_path"]) if scope.get("cover_path") else None
        return delete_local_cover_effect(
            source_path=fresh_source, active_cover_path=active,
            prepared_candidates=candidates, prepared_dimensions=candidate_dimensions,
            prepared_revisions=candidate_revisions,
        )

    def commit_deleted(commit, effect):
        def publish():
            nonlocal updated_albums, updated_problematic_album
            commit()
            if effect.selection is not None:
                updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
                    album_context.track_paths, effect.value, config=config, logger=logger,
                    library_state=library_state,
                    cover_revision=effect.selection.get("cover_revision"),
                    local_cover_dimensions=candidate_dimensions.get(effect.value, (None, None)),
                    schedule_cache_update=False, include_problematic_album=False,
                )
        return state_service.run_authoritative_cover_commit_for_state(library_state, publish)

    try:
        run_cover_mutation_for_config(
            config, track_paths=album_context.track_paths, album_root=album_context.album_root,
            source_paths=(Path(source_path), resolved, *candidates), affected_paths=(resolved,),
            expected_album_id=_album_id(album), allow_ordered_selection=True,
            mutate=delete, commit_guard=commit_deleted,
        )
    except OrderedCoverSelectionConflict as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 409))
    except ValueError:
        return _json_response(({"ok": False, "error": "Album cover selection could not be resolved."}, 409))
    except OSError:
        return _json_response(({"ok": False, "error": "Album cover selection is unavailable. Try again."}, 503))
    except CoverMutationCommitUncertainError as exc:
        return _json_response(({"ok": False, "persisted": None, "error": str(exc)}, 503))
    except CoverMutationFinalizationError as exc:
        return _json_response(({"ok": False, "persisted": True, "error": str(exc)}, 500))
    if updated_albums:
        try:
            updated_problematic_album = build_problematic_album_detail_payload(
                str(updated_albums[0].get("key") or ""),
                config=config, library_state=library_state, logger=logger,
            )
        except Exception:
            return _json_response(({"ok": False, "persisted": True,
                                    "error": "Cover selection was saved, but its details could not be refreshed. Reload the app."}, 500))
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
    preflight_error = await _legacy_cover_mutation_preflight(config, album_context.track_paths)
    if preflight_error is not None:
        return preflight_error
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
    try:
        prepared_bytes = prepare_pasted_cover_bytes(data_url)
        decoded = decode_image_bytes(prepared_bytes)
        width, height = decoded[1:] if decoded is not None else (None, None)
        if decoded is not None:
            decoded[0].close()
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    saved_cover_path = authoritative_cover_path
    cover_revision = None
    updated_albums = []
    updated_problematic_album = None

    def paste(scope):
        promotion = begin_prepared_remote_cover_promotion(
            album_context.album_root, prepared_bytes,
            reserved_cover_variant_path=scope["reserved_cover_variant_path"],
        )
        if promotion is None:
            raise ValueError("Clipboard image could not be processed.")
        dimensions = {"local_cover_width": width, "local_cover_height": height} if width and height else {}
        return cover_promotion_effect(promotion, **dimensions)

    def commit_pasted(commit, effect):
        def publish():
            nonlocal cover_revision, saved_cover_path, updated_albums, updated_problematic_album
            commit()
            saved_cover_path = effect.value
            cover_revision = effect.selection["cover_revision"]
            updated_albums, updated_problematic_album = apply_cover_path_for_tracks(
                album_context.track_paths, saved_cover_path, config=config, logger=logger,
                library_state=library_state, cover_revision=cover_revision,
                local_cover_dimensions=(width, height),
                schedule_cache_update=False, include_problematic_album=False,
            )
        return state_service.run_authoritative_cover_commit_for_state(library_state, publish)

    try:
        run_cover_mutation_for_config(
            config, track_paths=album_context.track_paths, album_root=album_context.album_root,
            source_paths=(authoritative_cover_path,), affected_paths=(authoritative_cover_path,),
            expected_album_id=_album_id(album), mutate=paste,
            reserve_variant_bytes=prepared_bytes,
            selection_options={"cover_selection_origin": "user", "explicit_selection": True},
            commit_guard=commit_pasted,
        )
    except OrderedCoverSelectionConflict as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 409))
    except CoverMutationCommitUncertainError as exc:
        return _json_response(({"ok": False, "persisted": None, "error": str(exc)}, 503))
    except CoverMutationFinalizationError as exc:
        return _json_response(({"ok": False, "persisted": True, "error": str(exc)}, 500))
    except Exception:
        return _json_response(({"ok": False, "error": "Pasted cover art could not be saved. Try again."}, 500))
    if updated_albums:
        try:
            updated_problematic_album = build_problematic_album_detail_payload(
                str(updated_albums[0].get("key") or ""),
                config=config, library_state=library_state, logger=logger,
            )
        except Exception:
            return _json_response(({"ok": False, "persisted": True,
                                    "error": "Cover selection was saved, but its details could not be refreshed. Reload the app."}, 500))
    task_id = str(payload.get("task_id") or "").strip()
    try:
        if task_id:
            task_payload = cover_lookup_result(task_id) or await run_in_threadpool(
                load_cover_lookup_notification,
                dict(config),
                task_id,
            )
            actioned_task = (
                await run_in_threadpool(
                    mark_cover_lookup_task_notification_action_taken,
                    task_id,
                    config=config,
                )
                if _cover_lookup_task_track_paths(task_payload or {})
                == album_context.track_paths
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
