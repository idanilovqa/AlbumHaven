from __future__ import annotations

import mimetypes
import logging
import uuid
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.api_loop_helpers import (
    parse_pitch_semitones,
    parse_required_loop_id,
    resolve_loop_creation_source,
    validate_loop_create_payload,
)
from music_app.routes.api_integration_helpers import (
    MAX_LOCAL_PLAYLIST_ANALYZE_BYTES,
    build_foobar_asset_url,
    resolve_foobar_asset,
)
from music_app.routes.web_asgi import _etag_matches, _not_modified_response, _not_modified_since_matches
from music_app.services.app_logging import log_app_event
from music_app.services.client_surfaces import resolve_client_surface_class
from music_app.services.foobar_integrations import build_foobar_help_payload, build_foobar_integration_payload
from music_app.services.lastfm import (
    LastfmError,
    authenticate_lastfm,
    build_lastfm_status,
    clear_lastfm_settings,
    get_lastfm_user_timezone,
    lastfm_api_enabled,
    save_lastfm_user_timezone,
    scrobble_track,
    update_now_playing,
)
from music_app.services.lastfm_retry import pending_scrobble_count, retry_pending_lastfm_scrobbles
from music_app.services.lastfm_sync_bridge import (
    build_lastfm_integration_status,
    record_playback_session_complete,
)
from music_app.services.library_roots import resolve_configured_media_path
from music_app.services.listen_history import (
    append_listen_history_entry,
    build_listen_history_status_counts,
    count_scrobbled_listen_history_entries,
    is_meaningful_listen_session,
    update_listen_history_entry,
)
from music_app.services.local_playlist_imports import (
    LOCAL_PLAYLIST_IMPORT_ANALYZE_ROUTE,
    LOCAL_PLAYLIST_IMPORT_EXECUTE_ROUTE,
    analyze_local_playlist_upload,
    build_local_playlist_import_integration_payload,
    is_supported_local_playlist_filename,
    supported_local_playlist_extensions,
)
from music_app.services.loops import (
    add_loop,
    build_loop_item,
    create_loop_file,
    create_pitch_preview_file,
    delete_loop,
    get_loop,
    load_loops,
    reorder_loops,
    resolve_loop_media_path,
)
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from music_app.services.track_preferences import save_track_preference


router = APIRouter()

JsonDict = dict[str, object]
ResponseValue = JsonDict | tuple[JsonDict, int]

_PLAYLIST_MUTATION_ERROR = "Playlist mutations land on the dedicated /playlists route family in later phases."


def _app_config(request: Request):
    return request.app.state.config


def _app_logger(request: Request):
    return getattr(request.app.state, "logger", logging.getLogger("music_app.asgi.wave_b"))


def _library_state(request: Request) -> dict[str, object]:
    return request.app.state.library_state


def _first_query_value(request: Request, key: str) -> str | None:
    values = request.query_params.getlist(key)
    if not values:
        return None
    return values[0]


def _client_surface_class_from_asgi(request: Request) -> str:
    requested_value = (
        _first_query_value(request, "client_surface")
        or _first_query_value(request, "client_surface_class")
        or request.headers.get("X-Album-Haven-Client-Surface")
        or request.headers.get("X-Album-Haven-Client-Surface-Class")
    )
    return resolve_client_surface_class(requested_value)


async def _json_payload(request: Request) -> JsonDict | None:
    try:
        payload = await request.json()
    except Exception:
        if _is_json_media_type(request.headers.get("content-type", "")):
            return None
        payload = {}
    return payload if isinstance(payload, dict) else None


def _is_json_media_type(content_type: str) -> bool:
    media_type = content_type.partition(";")[0].strip().lower()
    if media_type == "application/json":
        return True
    type_name, separator, subtype = media_type.partition("/")
    return type_name == "application" and bool(separator) and subtype.endswith("+json")


def _json_response(value: ResponseValue) -> JSONResponse:
    if isinstance(value, tuple):
        payload, status_code = value
        return JSONResponse(payload, status_code=status_code)
    return JSONResponse(value)


def _invalid_payload_response(error: str = "Invalid payload", status_code: int = 400) -> tuple[JsonDict, int]:
    return {"ok": False, "error": error}, status_code


def _enrich_lastfm_status(config: dict[str, Any], status: JsonDict) -> JsonDict:
    return build_lastfm_integration_status(
        config,
        base_status=status,
        listen_history_count=count_scrobbled_listen_history_entries(config),
        pending_scrobble_count=pending_scrobble_count(config),
    )


def _build_integrations_payload(config: dict[str, Any]) -> JsonDict:
    history_counts = build_listen_history_status_counts(config)
    lastfm = build_lastfm_integration_status(
        config,
        base_status=build_lastfm_status(config),
        listen_history_count=history_counts["listen_history_count"],
        pending_scrobble_count=history_counts["pending_scrobble_count"],
    )
    return {
        "ok": True,
        "integrations": [
            lastfm,
            build_foobar_integration_payload(
                build_help_url=lambda: "/utilities/integrations/foobar/help",
                build_asset_url=build_foobar_asset_url,
            ),
            _build_local_playlist_import_integration(),
        ],
    }


def _build_local_playlist_import_integration() -> JsonDict:
    return build_local_playlist_import_integration_payload(
        build_analyze_url=lambda: LOCAL_PLAYLIST_IMPORT_ANALYZE_ROUTE,
        build_import_url=lambda: LOCAL_PLAYLIST_IMPORT_EXECUTE_ROUTE,
    )


def _log_lastfm_scrobble_event(
    config: dict[str, Any],
    logger: Any,
    action: str,
    *,
    level: str,
    payload: JsonDict,
    error: str = "",
    retry_count: int = 0,
) -> None:
    log_app_event(
        config,
        logger,
        action,
        level=level,
        history=True,
        artist=str(payload.get("artist") or "").strip(),
        album=str(payload.get("album") or "").strip(),
        title=str(payload.get("title") or payload.get("track") or "").strip(),
        track_number=str(payload.get("track_number") or payload.get("trackNumber") or "").strip(),
        timestamp=str(payload.get("started_at") or payload.get("timestamp") or ""),
        error=error,
        retry_count=retry_count,
    )


def _safe_lastfm_connection_error(error: LastfmError) -> str:
    if error.error_kind == "invalid_credentials":
        return "Invalid username or password."
    if error.error_kind == "network_error":
        return "Album Haven could not reach Last.fm."
    if error.error_kind == "malformed_response":
        return "Last.fm returned an invalid response."
    return "Last.fm rejected the connection."


def _lastfm_submission_response(result: object, *, success_key: str) -> dict[str, object]:
    if result is None:
        return {"ok": True}
    sent = bool(getattr(result, "sent", False))
    succeeded = bool(getattr(result, "succeeded", False))
    return {
        "ok": succeeded,
        "sent": sent,
        success_key: succeeded,
        "outcome": str(getattr(result, "outcome", "not_sent") or "not_sent"),
        "accepted": int(getattr(result, "accepted", 0) or 0),
        "ignored": int(getattr(result, "ignored", 0) or 0),
        "ignored_code": getattr(result, "ignored_code", None),
        "message": str(getattr(result, "message", "") or ""),
    }


def _file_response(
    request: Request,
    path: Path,
    *,
    media_type: str,
    filename: str,
    as_attachment: bool,
) -> Response:
    stat_result = path.stat()
    disposition = "attachment" if as_attachment else "inline"
    response = FileResponse(
        path,
        stat_result=stat_result,
        media_type=media_type,
        filename=filename,
        content_disposition_type=disposition,
    )
    response.headers["Cache-Control"] = "public, max-age=300"

    if_none_match = request.headers.get("if-none-match")
    etag = response.headers.get("etag")
    if if_none_match and etag:
        if _etag_matches(if_none_match, etag):
            return _not_modified_response(response)
        return response

    if_modified_since = request.headers.get("if-modified-since")
    if if_modified_since and _not_modified_since_matches(if_modified_since, stat_result.st_mtime):
        return _not_modified_response(response)
    return response


def _parse_multipart_file(
    body: bytes,
    content_type: str,
    field_name: str,
) -> tuple[str, bytes] | None:
    if not body or "multipart/form-data" not in content_type.lower():
        return None
    message = BytesParser(policy=policy.default).parsebytes(
        f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8") + body
    )
    if not message.is_multipart():
        return None
    for part in message.iter_parts():
        if part.get_param("name", header="content-disposition") != field_name:
            continue
        filename = str(part.get_filename() or "").strip()
        payload = part.get_payload(decode=True) or b""
        if not filename:
            return None
        return filename, payload
    return None


async def _read_limited_body(request: Request, *, max_bytes: int) -> tuple[bytes, bool]:
    content_length = str(request.headers.get("content-length") or "").strip()
    if content_length:
        try:
            if int(content_length) > max_bytes:
                return b"", True
        except ValueError:
            pass

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            return b"", True
        chunks.append(chunk)
    return b"".join(chunks), False


def _playlist_upload_redirect_payload() -> JsonDict:
    return {
        "ok": False,
        "error": (
            "Supported local playlist files must use the separate local-playlist import flow "
            "instead of the ordinary /playlists create route."
        ),
        "import_route": LOCAL_PLAYLIST_IMPORT_EXECUTE_ROUTE,
        "analyze_route": LOCAL_PLAYLIST_IMPORT_ANALYZE_ROUTE,
        "supported_extensions": supported_local_playlist_extensions(),
    }


@router.get("/utilities/integrations")
async def utilities_integrations(request: Request) -> JSONResponse:
    config = _app_config(request)
    return JSONResponse(await run_in_threadpool(_build_integrations_payload, config))


@router.get("/utilities/integrations/foobar/help")
async def utilities_foobar_help() -> JSONResponse:
    return JSONResponse(build_foobar_help_payload(build_asset_url=build_foobar_asset_url))


@router.get("/utilities/integrations/foobar/assets/{asset_key}")
async def utilities_foobar_asset(request: Request, asset_key: str) -> Response:
    try:
        asset_definition, asset_path = resolve_foobar_asset(asset_key)
    except KeyError:
        return JSONResponse({"ok": False, "error": "Unknown Foobar reference asset."}, status_code=404)
    media_type = str(asset_definition.get("mime_type") or "")
    if not media_type:
        media_type, _encoding = mimetypes.guess_type(asset_path.name)
    asset_download = str(request.query_params.get("download") or "").strip().lower() in {"1", "true", "yes"}
    return _file_response(
        request,
        asset_path,
        media_type=media_type or "text/plain",
        filename=str(asset_definition.get("filename") or asset_path.name),
        as_attachment=asset_download,
    )


@router.post(LOCAL_PLAYLIST_IMPORT_ANALYZE_ROUTE)
async def utilities_local_playlist_import_analyze(request: Request) -> JSONResponse:
    body, too_large = await _read_limited_body(
        request,
        max_bytes=MAX_LOCAL_PLAYLIST_ANALYZE_BYTES,
    )
    if too_large:
        return _json_response(
            (
                {
                    "ok": False,
                    "error": "Selected playlist file is too large for Phase 3 analysis. Limit: 2 MiB.",
                },
                413,
            )
        )
    parsed_file = _parse_multipart_file(
        body,
        str(request.headers.get("content-type") or ""),
        "playlist_file",
    )
    if parsed_file is None:
        return _json_response(({"ok": False, "error": "Select a local playlist file before running analysis."}, 400))

    filename, payload = parsed_file
    if len(payload) > MAX_LOCAL_PLAYLIST_ANALYZE_BYTES:
        return _json_response(
            (
                {
                    "ok": False,
                    "error": "Selected playlist file is too large for Phase 3 analysis. Limit: 2 MiB.",
                },
                413,
            )
        )
    try:
        return JSONResponse(analyze_local_playlist_upload(filename=filename, size_bytes=len(payload)))
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))


@router.post(LOCAL_PLAYLIST_IMPORT_EXECUTE_ROUTE)
async def utilities_local_playlist_import_execute() -> JSONResponse:
    return _json_response(
        (
            {
                "ok": False,
                "error": "Local playlist import execution lands in later phases after parser and persistence work.",
            },
            409,
        )
    )


@router.post("/utilities/integrations/lastfm")
async def utilities_lastfm_settings(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())

    if payload.get("disconnect"):
        clear_lastfm_settings(config)
        return JSONResponse(
            {"ok": True, "integration": _enrich_lastfm_status(config, build_lastfm_status(config))}
        )

    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    timezone_name = str(payload.get("timezone") or "").strip()
    if payload.get("save_timezone_only"):
        try:
            integration = save_lastfm_user_timezone(config, timezone_name)
        except LastfmError as exc:
            return _json_response(({"ok": False, "error": str(exc)}, 400))
        return JSONResponse({"ok": True, "integration": _enrich_lastfm_status(config, integration)})

    if not lastfm_api_enabled(config):
        return _json_response(
            ({"ok": False, "error": "Last.fm API credentials are not configured on the server."}, 503)
        )

    if not username or not password:
        return _json_response(({"ok": False, "error": "Last.fm username and password are required."}, 400))

    try:
        integration = authenticate_lastfm(
            config,
            username,
            password,
            connected_at=datetime.now(timezone.utc).isoformat(),
            user_timezone=timezone_name,
        )
    except LastfmError as exc:
        try:
            log_app_event(
                config,
                logger,
                "Last.fm connection failed",
                level="warning",
                history=True,
                integration="Last.fm",
                status="failed",
                failure_stage="provider_authentication",
                error=_safe_lastfm_connection_error(exc),
                error_kind=exc.error_kind,
                error_code=exc.code,
                retryable=exc.retryable,
            )
        except Exception:
            try:
                logger.exception(
                    "Failed to record the credential-safe Last.fm connection failure in log history.",
                )
            except Exception:
                pass
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    except Exception as exc:
        try:
            log_app_event(
                config,
                logger,
                "Last.fm connection failed",
                level="warning",
                history=True,
                integration="Last.fm",
                status="failed",
                failure_stage="provider_or_session_persistence",
                error="Album Haven could not complete the Last.fm connection.",
                error_kind=type(exc).__name__,
            )
        except Exception:
            try:
                logger.exception(
                    "Failed to record the credential-safe Last.fm connection failure in log history.",
                )
            except Exception:
                pass
        raise

    retry_pending_lastfm_scrobbles(config, reauthenticated=True)
    return JSONResponse({"ok": True, "integration": _enrich_lastfm_status(config, integration)})


@router.post("/playback/session/now-playing")
async def playback_session_now_playing(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    try:
        result = update_now_playing(config, normalize_playback_track_payload(payload))
    except LastfmError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    return JSONResponse(_lastfm_submission_response(result, success_key="now_playing"))


@router.post("/playback/session/scrobble")
async def playback_session_scrobble(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    try:
        result = scrobble_track(config, normalize_playback_track_payload(payload))
    except LastfmError as exc:
        _log_lastfm_scrobble_event(
            config,
            logger,
            "Last.fm scrobble failed",
            level="warning",
            payload=payload,
            error=str(exc),
        )
        return _json_response(({"ok": False, "error": str(exc)}, 400))
    response_payload = _lastfm_submission_response(result, success_key="scrobbled")
    _log_lastfm_scrobble_event(
        config,
        logger,
        "Last.fm scrobble succeeded" if response_payload.get("scrobbled", True) else "Last.fm scrobble not submitted",
        level="info" if response_payload.get("scrobbled", True) else "warning",
        payload=payload,
        error="" if response_payload.get("scrobbled", True) else str(response_payload.get("message", "")),
    )
    return JSONResponse(response_payload)


@router.post("/playback/session/complete")
async def playback_session_complete(request: Request) -> JSONResponse:
    config = _app_config(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    response_payload, status_code = record_playback_session_complete(
        config,
        payload,
        user_timezone=get_lastfm_user_timezone(config),
        normalize_playback_track_payload=normalize_playback_track_payload,
        is_meaningful_listen_session=is_meaningful_listen_session,
        append_listen_history_entry=append_listen_history_entry,
        update_listen_history_entry=update_listen_history_entry,
        scrobble_track=scrobble_track,
        log_lastfm_scrobble_event=lambda action, **kwargs: _log_lastfm_scrobble_event(
            config,
            logger,
            action,
            **kwargs,
        ),
    )
    return JSONResponse(response_payload, status_code=status_code)


@router.post("/loops/create")
async def create_saved_loop(request: Request) -> JSONResponse:
    config = _app_config(request)
    library_state = _library_state(request)
    logger = _app_logger(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())

    validated, error_response = validate_loop_create_payload(payload)
    if error_response is not None:
        return _json_response(error_response)

    source_details, source_error = resolve_loop_creation_source(
        payload,
        config=config,
        get_loop=get_loop,
        resolve_loop_media_path=resolve_loop_media_path,
        normalize_music_file_path=lambda raw_path: resolve_configured_media_path(config, raw_path),
        file_cache=library_state.get("file_cache", {}) or {},
    )
    if source_error is not None:
        return _json_response(source_error)

    source_path = source_details["source_path"]
    if not source_path.exists() or not source_path.is_file():
        return _json_response(({"ok": False, "error": "Source file does not exist"}, 400))

    loop_id = uuid.uuid4().hex
    try:
        output_path = create_loop_file(
            config,
            source_path,
            float(validated["start_seconds"]),
            float(validated["end_seconds"]),
            loop_id,
        )
    except Exception as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 500))

    item = build_loop_item(
        loop_id=loop_id,
        name=str(validated["name"]),
        path=output_path,
        source_path=source_path,
        start_seconds=float(validated["start_seconds"]),
        end_seconds=float(validated["end_seconds"]),
        artist=str(source_details["artist"]),
        title=str(source_details["title"]),
        album=str(source_details["album"]),
        cover_path=str(source_details["cover_path"]),
        parent_loop_id=str(source_details["parent_loop_id"]),
    )
    add_loop(config, item)
    log_app_event(
        config,
        logger,
        "Loop created",
        level="info",
        history=True,
        loop_id=loop_id,
        name=str(validated["name"]),
        artist=str(source_details["artist"]),
        album=str(source_details["album"]),
        source_path=str(source_path),
    )
    return JSONResponse({"ok": True, "loop": item, "loops": load_loops(config)})


@router.post("/loops/pitch-preview")
async def create_loop_pitch_preview(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    loop_id, loop_error = parse_required_loop_id(payload)
    if loop_error is not None:
        return _json_response(loop_error)
    semitones, pitch_error = parse_pitch_semitones(payload)
    if pitch_error is not None:
        return _json_response(pitch_error)
    source_path = resolve_loop_media_path(config, loop_id)
    if source_path is None:
        return _json_response(({"ok": False, "error": "Saved loop source file was not found"}, 404))
    if semitones == 0:
        return JSONResponse({"ok": True, "preview_id": "", "media_url": f"/loops/media/{loop_id}", "semitones": 0})
    try:
        preview_id, _path = create_pitch_preview_file(config, loop_id, source_path, semitones)
    except Exception as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 500))
    return JSONResponse(
        {
            "ok": True,
            "preview_id": preview_id,
            "media_url": f"/loops/pitch-preview/{preview_id}",
            "semitones": semitones,
        }
    )


@router.post("/loops/delete")
async def delete_saved_loop(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    loop_id, error_response = parse_required_loop_id(payload)
    if error_response is not None:
        return _json_response(error_response)
    deleted, loops = delete_loop(config, loop_id)
    if not deleted:
        return _json_response(({"ok": False, "error": "Loop was not found"}, 404))
    return JSONResponse({"ok": True, "loops": loops})


@router.post("/loops/reorder")
async def reorder_saved_loops(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())
    ordered_ids = payload.get("ordered_ids")
    if not isinstance(ordered_ids, list):
        return _json_response(({"ok": False, "error": "ordered_ids must be a list"}, 400))
    return JSONResponse({"ok": True, "loops": reorder_loops(config, ordered_ids)})


async def _reserved_playlist_response(request: Request, *, create_route: bool = False) -> JSONResponse:
    if create_route:
        body, too_large = await _read_limited_body(
            request,
            max_bytes=MAX_LOCAL_PLAYLIST_ANALYZE_BYTES,
        )
        if too_large:
            return _json_response(({"ok": False, "error": _PLAYLIST_MUTATION_ERROR}, 409))
        parsed_file = _parse_multipart_file(
            body,
            str(request.headers.get("content-type") or ""),
            "playlist_file",
        )
        if parsed_file is not None and is_supported_local_playlist_filename(parsed_file[0]):
            return _json_response((_playlist_upload_redirect_payload(), 409))
    return _json_response(({"ok": False, "error": _PLAYLIST_MUTATION_ERROR}, 409))


@router.post("/playlists")
async def playlists_create_reserved(request: Request) -> JSONResponse:
    return await _reserved_playlist_response(request, create_route=True)


@router.post("/playlists/derived-popular-tracks")
async def playlist_derived_create_reserved(request: Request) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.patch("/playlists/{playlist_ref}")
@router.delete("/playlists/{playlist_ref}")
async def playlists_mutate_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/items")
async def playlist_items_create_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.patch("/playlists/{playlist_ref}/items/{playlist_item_ref}")
@router.delete("/playlists/{playlist_ref}/items/{playlist_item_ref}")
async def playlist_items_mutate_reserved(request: Request, playlist_ref: str, playlist_item_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/items/reorder")
async def playlist_items_reorder_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.put("/playlists/{playlist_ref}/cover")
@router.delete("/playlists/{playlist_ref}/cover")
async def playlist_cover_mutate_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/access-grants")
async def playlist_access_grants_create_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.patch("/playlists/{playlist_ref}/access-grants/{grant_ref}")
@router.delete("/playlists/{playlist_ref}/access-grants/{grant_ref}")
async def playlist_access_grants_mutate_reserved(request: Request, playlist_ref: str, grant_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/regenerate-derived-items")
async def playlist_derived_regenerate_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/default-sort")
async def playlist_default_sort_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/playlists/{playlist_ref}/playback-settings")
async def playlist_playback_settings_reserved(request: Request, playlist_ref: str) -> JSONResponse:
    return await _reserved_playlist_response(request)


@router.post("/track-preferences")
async def track_preferences_write(request: Request) -> JSONResponse:
    config = _app_config(request)
    payload = await _json_payload(request)
    if payload is None:
        return _json_response(_invalid_payload_response())

    track_ref = str(payload.get("track_ref") or "").strip()
    if not track_ref:
        return _json_response(({"ok": False, "error": "Track preference payload must include a track_ref."}, 400))

    track_preference_payload = payload.get("track_preference")
    if not isinstance(track_preference_payload, dict):
        return _json_response(
            ({"ok": False, "error": "Track preference payload must include a track_preference object."}, 400)
        )

    try:
        result = save_track_preference(
            config,
            track_ref,
            track_preference_payload,
            client_surface_class=_client_surface_class_from_asgi(request),
        )
    except ValueError as exc:
        return _json_response(({"ok": False, "error": str(exc)}, 400))

    return JSONResponse({"ok": True, **result})
