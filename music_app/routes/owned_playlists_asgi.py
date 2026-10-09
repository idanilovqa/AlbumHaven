"""Existing-grant transport for authenticated same-server Playlist persistence."""
from __future__ import annotations

import hmac

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import read_bounded_json_object, JSONBodyTooLarge
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.owned_playlists import (
    BROWSE, CREATE, MANAGE, ITEMS, ACCESS, SETTINGS, MAX_PLAYLIST_COMMAND_BYTES,
    PlaylistError, normalize_playlist_command,
)
from music_app.services.owned_playlists_postgres import PostgresOwnedPlaylistsService
from music_app.services.playlist_preferences_postgres import (
    PREFERENCE_READ, PREFERENCE_WRITE, PostgresPlaylistPreferencesService, normalize_preference_command,
)
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.playlist_read_seams import build_view_surface_payload
from music_app.services.shell_layout_seams import build_shell_layout_payload

router = APIRouter()
_NO_STORE = {"Cache-Control": "private, no-store"}


def _context(request, action):
    actor = getattr(request.state, "current_actor", None)
    if actor is None:
        raise PlaylistError("forbidden", 403)
    context = PolicyContext.build(actor=actor, action=action, library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request), request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver = getattr(request.app.state, "policy_constraint_resolver", None)
    constraints = resolver if callable(resolver) else PolicyEvaluationConstraints()
    return context, constraints


def _context_ref(request):
    try:
        reference = private_ui_context_ref(request)
    except PrivateUIContextError as error:
        raise PlaylistError(error.code, error.status_code) from None
    if reference is None:
        raise PlaylistError("forbidden", 403)
    return reference


def _require_context_header(request):
    current = _context_ref(request)
    supplied = request.headers.get("x-albumhaven-context", "")
    if len(supplied) != 64 or not supplied.isascii() or not hmac.compare_digest(supplied, current):
        raise PlaylistError("stale_context", 409)


def _response(request, payload):
    # One shared shell/session freshness anchor, outside any nested data envelope.
    return JSONResponse({**payload, "context_ref": _context_ref(request)}, headers=_NO_STORE)


def _service(request):
    service = getattr(request.app.state, "owned_playlists_service", None)
    if service is not None:
        return service
    return PostgresOwnedPlaylistsService(request.app.state.config)


def _error(error):
    return JSONResponse({"ok": False, "error": error.code}, status_code=error.status_code, headers=_NO_STORE)


def playlist_view_response(request):
    """Early synchronous /view-data branch; no global Playlist state fallback."""
    try:
        context, constraints = _context(request, BROWSE)
        payload = _service(request).read(context, playlist_ref=request.query_params.get("playlist_id") or None,
            query=request.query_params.get("q", ""), constraints=constraints)
        config = request.app.state.config
        payload.update(surface=build_view_surface_payload("playlists"),
            shell_layout=build_shell_layout_payload(active_surface="playlists", has_playlist_detail="playlist_detail" in payload),
            album_count=0, artist_count=0, query=request.query_params.get("q", ""),
            search_filters={}, non_album_tracks=[], ignored_version_keys=[], manual_version_links={},
            app_name=config.get("APP_NAME", "Album Haven"), app_version=config.get("APP_VERSION", ""))
        return _response(request, payload)
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/destinations")
def playlist_destinations(request: Request):
    try:
        context, constraints = _context(request, BROWSE)
        payload = _service(request).read(context, constraints=constraints)
        rows = payload["playlist_index"]["playlists"]
        return _response(request, {"status": "ready" if rows else "empty", "data": {
            "actor_scope": payload["actor_scope"], "destinations": rows,
            "allowed_actions": payload["playlist_actions"],
            "playlist_creation_protocol": payload["playlist_creation_protocol"]}})
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/creation-source/current")
def begin_playlist_source(request: Request):
    try:
        if request.query_params:
            raise PlaylistError("invalid_source_query")
        context, constraints = _context(request, CREATE)
        _require_context_header(request)
        return _response(request, _service(request).begin_source(context, constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/creation-source/entries")
def playlist_source_entries(request: Request):
    try:
        params = request.query_params
        if set(params) - {"source_ref", "source_revision", "q", "cursor", "limit"}:
            raise PlaylistError("invalid_source_query")
        value = params.get("limit", "100")
        if len(value) > 3 or not value.isascii() or not value.isdecimal():
            raise PlaylistError("invalid_source_query")
        context, constraints = _context(request, CREATE)
        return _response(request, _service(request).read_source_page(context,
            source_ref=params.get("source_ref"), source_revision=params.get("source_revision"),
            query=params.get("q", ""), cursor=params.get("cursor"), limit=int(value),
            constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/operations/{request_key}")
def playlist_operation(request: Request, request_key: str):
    try:
        context, constraints = _context(request, BROWSE)
        return _response(request, _service(request).read_operation(context, request_key, constraints=constraints))
    except PlaylistError as error:
        return _error(error)


async def _write(request, action, playlist_ref=None, item_ref=None, grant_ref=None, request_ref=None):
    try:
        coarse = (BROWSE if action == "request_edit" else CREATE if action in {"create", "copy"}
                  else ACCESS if action in {"visibility", "grant_editor", "revoke_editor", "decide_edit_request"}
                  else SETTINGS if action == "default_sort" else MANAGE if action in {"save", "delete"} else ITEMS)
        context, constraints = _context(request, coarse)
        _require_context_header(request)
        if action == "create" and request.headers.get("content-type", "").split(";", 1)[0] in {
            "multipart/form-data", "application/x-www-form-urlencoded",
        }:
            # Keep the dedicated local-playlist import guidance; uploads do not
            # become metadata-only Playlist creation or bypass source receipts.
            from music_app.routes.api_wave_b_asgi_routes import _reserved_playlist_response
            return await _reserved_playlist_response(request, create_route=True)
        payload = await read_bounded_json_object(request, max_bytes=MAX_PLAYLIST_COMMAND_BYTES)
        if item_ref is not None:
            if not isinstance(payload, dict) or set(payload) != {"revision", "request_key"}:
                raise PlaylistError("invalid_command")
            payload = {**payload, "item_refs": [item_ref]}
        if grant_ref is not None:
            if not isinstance(payload, dict) or set(payload) != {"revision", "request_key"}:
                raise PlaylistError("invalid_command")
            payload = {**payload, "grant_ref": grant_ref}
        if request_ref is not None:
            if not isinstance(payload,dict) or set(payload)!={"revision","request_key","decision"}:
                raise PlaylistError("invalid_command")
            payload={**payload,"request_ref":request_ref}
        command = normalize_playlist_command(action, payload, playlist_ref=playlist_ref)
        result = await run_in_threadpool(_service(request).execute, context, command, constraints=constraints)
        return _response(request, {"status": "ready", "data": result} if action == "create" else result)
    except JSONBodyTooLarge:
        return _error(PlaylistError("command_too_large", 413))
    except PlaylistError as error:
        return _error(error)


@router.post("/playlists")
async def create_playlist(request: Request):
    return await _write(request, "create")


@router.patch("/playlists/{playlist_ref}")
async def save_playlist(request: Request, playlist_ref: str):
    return await _write(request, "save", playlist_ref)


@router.post("/playlists/{playlist_ref}/items")
async def add_playlist_items(request: Request, playlist_ref: str):
    return await _write(request, "add", playlist_ref)


@router.post("/playlists/{playlist_ref}/items/reorder")
async def reorder_playlist_items(request: Request, playlist_ref: str):
    return await _write(request, "reorder", playlist_ref)


@router.post("/playlists/{playlist_ref}/items/remove")
async def remove_playlist_items(request: Request, playlist_ref: str):
    return await _write(request, "remove", playlist_ref)


@router.delete("/playlists/{playlist_ref}/items/{playlist_item_ref}")
async def remove_playlist_item(request: Request, playlist_ref: str, playlist_item_ref: str):
    return await _write(request, "remove", playlist_ref, playlist_item_ref)


@router.get("/playlists/{playlist_ref}/access-grants")
def playlist_access(request: Request, playlist_ref: str):
    try:
        context, constraints = _context(request, ACCESS)
        return _response(request, _service(request).read_access(context, playlist_ref, constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/{playlist_ref}/access-candidates")
def playlist_access_candidates(request: Request, playlist_ref: str):
    try:
        params = request.query_params
        if set(params) - {"q", "cursor", "limit"} or len(params.multi_items()) != len(params):
            raise PlaylistError("invalid_access_query")
        value = params.get("limit", "50")
        if len(value)>3 or not value.isascii() or not value.isdecimal():
            raise PlaylistError("invalid_access_query")
        context, constraints = _context(request, ACCESS)
        # Validate the shared signing configuration before using it for cursors.
        _context_ref(request)
        return _response(request, _service(request).read_access_candidates(context, playlist_ref,
            query=params.get("q", ""),cursor=params.get("cursor"),limit=int(value),
            cursor_secret=request.app.state.auth_policy_config["hmac"]["secret"],constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.patch("/playlists/{playlist_ref}/visibility")
async def playlist_visibility(request: Request, playlist_ref: str):
    return await _write(request, "visibility", playlist_ref)


@router.post("/playlists/{playlist_ref}/access-grants")
async def grant_playlist_editor(request: Request, playlist_ref: str):
    return await _write(request, "grant_editor", playlist_ref)


@router.delete("/playlists/{playlist_ref}/access-grants/{grant_ref}")
async def revoke_playlist_editor(request: Request, playlist_ref: str, grant_ref: str):
    return await _write(request, "revoke_editor", playlist_ref, grant_ref=grant_ref)


@router.delete("/playlists/{playlist_ref}")
async def delete_playlist(request: Request, playlist_ref: str):
    return await _write(request, "delete", playlist_ref)


@router.get("/account/playlist-preferences")
def playlist_preferences(request: Request):
    try:
        context, constraints = _context(request, PREFERENCE_READ)
        service = PostgresPlaylistPreferencesService(request.app.state.config)
        return _response(request, service.read(context, constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.put("/account/playlist-preferences")
async def update_playlist_preferences(request: Request):
    try:
        context, constraints = _context(request, PREFERENCE_WRITE)
        _require_context_header(request)
        payload = await read_bounded_json_object(request, max_bytes=4096)
        command = normalize_preference_command(payload)
        service = PostgresPlaylistPreferencesService(request.app.state.config)
        result = await run_in_threadpool(service.execute, context, command, constraints=constraints)
        return _response(request, result)
    except JSONBodyTooLarge:
        return _error(PlaylistError("command_too_large", 413))
    except PlaylistError as error:
        return _error(error)


@router.get("/account/playlist-preferences/operations/{request_key}")
def playlist_preference_operation(request: Request, request_key: str):
    try:
        context, constraints = _context(request, PREFERENCE_READ)
        service = PostgresPlaylistPreferencesService(request.app.state.config)
        return _response(request, service.read_operation(context, request_key, constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.post("/playlists/{playlist_ref}/default-sort")
async def playlist_default_sort(request: Request, playlist_ref: str):
    return await _write(request, "default_sort", playlist_ref)


@router.get("/playlists/{playlist_ref}/sharing")
def playlist_sharing(request: Request, playlist_ref: str):
    try:
        if set(request.query_params)-{"cursor"} or len(request.query_params.multi_items())!=len(request.query_params):
            raise PlaylistError("invalid_access_query")
        context,constraints=_context(request,BROWSE)
        _context_ref(request)
        return _response(request,_service(request).read_sharing(context,playlist_ref,
            cursor_secret=request.app.state.auth_policy_config["hmac"]["secret"],
            cursor=request.query_params.get("cursor"),constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/edit-requests")
def playlist_edit_requests(request: Request):
    try:
        params=request.query_params
        if set(params)-{"cursor","limit"} or len(params.multi_items())!=len(params):
            raise PlaylistError("invalid_access_query")
        limit=params.get("limit","50")
        if len(limit)>3 or not limit.isascii() or not limit.isdecimal():
            raise PlaylistError("invalid_access_query")
        context,constraints=_context(request,BROWSE)
        _context_ref(request)
        return _response(request,_service(request).read_edit_requests(context,
            cursor_secret=request.app.state.auth_policy_config["hmac"]["secret"],
            cursor=params.get("cursor"),limit=int(limit),constraints=constraints))
    except PlaylistError as error:
        return _error(error)


@router.post("/playlists/{playlist_ref}/edit-requests")
async def request_playlist_edit(request: Request, playlist_ref: str):
    return await _write(request,"request_edit",playlist_ref)


@router.post("/playlists/{playlist_ref}/edit-requests/{request_ref}/decision")
async def decide_playlist_edit_request(request: Request, playlist_ref: str, request_ref: str):
    return await _write(request,"decide_edit_request",playlist_ref,request_ref=request_ref)


@router.post("/playlists/{playlist_ref}/copy")
async def copy_playlist(request: Request, playlist_ref: str):
    return await _write(request,"copy",playlist_ref)
