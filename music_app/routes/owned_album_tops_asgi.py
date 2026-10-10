"""Authenticated Album Top transport; playback authority stays independent."""
import hmac

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, CREATE, ACCESS, MAX_TOP_COMMAND_BYTES, normalize_top_command,
    require_top_authority, top_uuid,
)
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.playlist_read_seams import build_view_surface_payload
from music_app.services.shell_layout_seams import build_shell_layout_payload

router = APIRouter()
_NO_STORE = {"Cache-Control": "private, no-store"}


def _context(request, action):
    actor = getattr(request.state, "current_actor", None)
    if actor is None:
        raise AlbumTopError("forbidden", 403)
    try:
        context = PolicyContext.build(actor=actor, action=action, library_id=actor.current_library_id,
            deployment_mode=_deployment_mode(request), request_origin=_request_origin(request),
            client_surface_class=client_surface_from_request(request))
    except ValueError:
        raise AlbumTopError("forbidden", 403) from None
    resolver = getattr(request.app.state, "policy_constraint_resolver", None)
    return context, resolver if callable(resolver) else PolicyEvaluationConstraints()


def _context_ref(request):
    try:
        ref = private_ui_context_ref(request)
    except PrivateUIContextError as error:
        raise AlbumTopError(error.code, error.status_code) from None
    if ref is None:
        raise AlbumTopError("forbidden", 403)
    return ref


def _require_context(request):
    supplied = request.headers.get("x-albumhaven-context", "")
    current = _context_ref(request)
    if len(supplied) != 64 or not supplied.isascii() or not hmac.compare_digest(supplied, current):
        raise AlbumTopError("stale_context", 409)


def _service(request):
    service = getattr(request.app.state, "owned_album_tops_service", None)
    return service if service is not None else PostgresOwnedAlbumTopsService(request.app.state.config)


def _response(request, value):
    return JSONResponse({"status": "ready", "data": value, "context_ref": _context_ref(request)}, headers=_NO_STORE)


def _error(error):
    return JSONResponse({"ok": False, "error": error.code}, status_code=error.status_code, headers=_NO_STORE)


def album_top_view_response(request):
    """Native navigation descriptor only; private Top data has its own API."""
    try:
        params = request.query_params
        if set(params) - {"surface", "top_ref", "omit_sidebar"} or len(params.multi_items()) != len(params):
            raise AlbumTopError("invalid_query")
        context, constraints = _context(request, BROWSE)
        require_top_authority(context, required_actions=(BROWSE,), owner_account_id=None,
                              constraints=constraints)
        ref = top_uuid(params["top_ref"]) if params.get("top_ref") else None
        return JSONResponse({"surface": build_view_surface_payload("album_tops"),
            "shell_layout": build_shell_layout_payload(active_surface="album_tops"),
            "top_ref": ref, "context_ref": _context_ref(request), "payload_tier": "full",
            "query": "", "artist_groups": [], "artists_sidebar": [],
            "album_count": 0, "artist_count": 0, "search_filters": {},
            "non_album_tracks": [], "ignored_version_keys": [], "manual_version_links": {},
            "initial_view_partial": False}, headers=_NO_STORE)
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops")
def list_album_tops(request: Request):
    try:
        params = request.query_params
        if set(params) - {"cursor", "limit"} or len(params.multi_items()) != len(params):
            raise AlbumTopError("invalid_query")
        limit = params.get("limit", "50")
        if not limit.isascii() or not limit.isdecimal() or len(limit) > 3:
            raise AlbumTopError("invalid_query")
        context, constraints = _context(request, BROWSE)
        _context_ref(request)
        value = _service(request).list(context, cursor=params.get("cursor"), limit=int(limit),
            cursor_secret=request.app.state.auth_policy_config["hmac"]["secret"], constraints=constraints)
        return _response(request, value)
    except AlbumTopError as error:
        return _error(error)


def _page_query(request, *, query=False, limit=True):
    params = request.query_params
    allowed = {"cursor"} | ({"limit"} if limit else set()) | ({"q"} if query else set())
    if set(params) - allowed or len(params.multi_items()) != len(params):
        raise AlbumTopError("invalid_query")
    options = {"cursor": params.get("cursor"),
               "cursor_secret": request.app.state.auth_policy_config["hmac"]["secret"]}
    if limit:
        size = params.get("limit", "50")
        if not size.isascii() or not size.isdecimal() or len(size) > 3 or not 1 <= int(size) <= 100:
            raise AlbumTopError("invalid_query")
        options["limit"] = int(size)
    if query:
        value = params.get("q", "")
        if len(value) > 100 or "\0" in value or any("\ud800" <= char <= "\udfff" for char in value):
            raise AlbumTopError("invalid_query")
        options["query"] = value
    return options


@router.get("/album-tops/edit-requests")
def read_album_top_edit_requests(request: Request):
    try:
        options = _page_query(request)
        context, constraints = _context(request, BROWSE)
        _context_ref(request)
        return _response(request, _service(request).read_edit_requests(context, constraints=constraints, **options))
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops/{top_ref}/sharing")
def read_album_top_sharing(request: Request, top_ref: str):
    try:
        ref = top_uuid(top_ref)
        options = _page_query(request, limit=False)
        context, constraints = _context(request, BROWSE)
        _context_ref(request)
        return _response(request, _service(request).read_sharing(context, ref, constraints=constraints, **options))
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops/{top_ref}/access-grants")
def read_album_top_access(request: Request, top_ref: str):
    try:
        ref = top_uuid(top_ref)
        options = _page_query(request)
        context, constraints = _context(request, ACCESS)
        _context_ref(request)
        return _response(request, _service(request).read_access(context, ref, constraints=constraints, **options))
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops/{top_ref}/access-candidates")
def read_album_top_access_candidates(request: Request, top_ref: str):
    try:
        ref = top_uuid(top_ref)
        options = _page_query(request, query=True)
        context, constraints = _context(request, ACCESS)
        _context_ref(request)
        return _response(request, _service(request).read_access_candidates(context, ref, constraints=constraints, **options))
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops/{top_ref}")
def read_album_top(request: Request, top_ref: str):
    try:
        if request.query_params:
            raise AlbumTopError("invalid_command")
        context, constraints = _context(request, BROWSE)
        # Fail before database work if the private UI identity cannot be established.
        _context_ref(request)
        return _response(request, _service(request).read(context, top_ref=top_ref, constraints=constraints))
    except AlbumTopError as error:
        return _error(error)


async def _mutate(request, action, top_ref=None):
    try:
        if request.query_params:
            raise AlbumTopError("invalid_command")
        context, constraints = _context(request, CREATE if action == "create" else BROWSE)
        _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=MAX_TOP_COMMAND_BYTES)
        command = normalize_top_command(action, payload, top_ref=top_ref)
        value = await run_in_threadpool(_service(request).execute, context, command, constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError("command_too_large", 413))
    except AlbumTopError as error:
        return _error(error)


@router.post("/album-tops")
async def create_album_top(request: Request):
    return await _mutate(request, "create")


@router.post("/album-tops/{top_ref}/{action}")
async def mutate_album_top(request: Request, top_ref: str, action: str):
    if action not in {"save", "add", "remove", "reorder", "delete", "visibility", "grant_editor",
                      "revoke_editor", "request_edit", "decide_edit_request", "copy", "set_manual_completion"}:
        return _error(AlbumTopError("invalid_command"))
    return await _mutate(request, action, top_ref)


@router.post("/album-top-catalog/inventory")
async def admit_album_top_inventory(request: Request):
    try:
        if request.query_params:
            raise AlbumTopError("invalid_command")
        context, constraints = _context(request, CREATE)
        _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=1024)
        if type(payload) is not dict or set(payload) != {"album_id"}:
            raise AlbumTopError("invalid_command")
        value = await run_in_threadpool(_service(request).admit_inventory_album,
            context, album_id=payload["album_id"], constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError("command_too_large", 413))
    except AlbumTopError as error:
        return _error(error)
