"""Authenticated Album Top transport; playback authority stays independent."""
import asyncio
import hmac
from contextlib import suppress
from html import escape
from threading import Event
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, CREATE, ACCESS, MAX_TOP_COMMAND_BYTES, normalize_top_command,
    require_top_authority, top_uuid, normalize_top_publication_preview,
)
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.album_top_remote_acquisition import TopRemoteAcquisitionService
from music_app.services.album_top_publication_sources import validate_request as validate_publication_source_request
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.private_route_boundary import album_top_working_request_path
from music_app.services.public_album_tops import public_ref
from music_app.services.playlist_read_seams import build_view_surface_payload
from music_app.services.shell_layout_seams import build_shell_layout_payload

router = APIRouter()
_NO_STORE = {"Cache-Control": "private, no-store"}
_WORKING_HEADERS = {**_NO_STORE, "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
                    "Vary": "Sec-Fetch-Dest"}


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
    # Count raw occurrences case-insensitively; no header collection may fold
    # duplicate values into one apparently valid continuity witness.
    supplied_values = [value.decode('latin1') for name, value in request.scope.get('headers', ())
                       if name.lower() == b'x-albumhaven-context']
    current = _context_ref(request)
    if len(supplied_values) != 1:
        raise AlbumTopError("stale_context", 409)
    supplied = supplied_values[0]
    if len(supplied) != 64 or not supplied.isascii() or not hmac.compare_digest(supplied, current):
        raise AlbumTopError("stale_context", 409)
    return current


def _service(request):
    service = getattr(request.app.state, "owned_album_tops_service", None)
    return service if service is not None else PostgresOwnedAlbumTopsService(request.app.state.config)


def _remote_service(request):
    service = getattr(request.app.state, 'album_top_remote_acquisition_service', None)
    return service if service is not None else TopRemoteAcquisitionService(_service(request),
        user_agent=request.app.state.config.get('MUSICBRAINZ_USER_AGENT'))


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


def _working_link_error(request, error, share_ref=None):
    if request.headers.get("sec-fetch-dest") == "document":
        back = ('<p><a href="' + escape("/public/album-tops/" + share_ref, quote=True)
                + '">Back to published Top</a></p>') if share_ref is not None else ""
        response = HTMLResponse('<!doctype html><html lang="en"><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            '<title>Album Top unavailable</title><body><main><h1>Album Top unavailable</h1>'
            '<p>This working Album Top is unavailable for your current account.</p>' + back
            + '</main></body></html>', status_code=error.status_code, headers=_WORKING_HEADERS)
    else:
        response = JSONResponse({"ok": False, "error": error.code},
                                status_code=error.status_code, headers=_WORKING_HEADERS)
    if request.method == "HEAD":
        response.body = b""
    return response


@router.api_route("/album-tops/public-link/{share_ref}", methods=["GET", "HEAD"])
async def open_public_album_top_working(request: Request, share_ref: str):
    ref = None
    try:
        ref = public_ref(share_ref)
        if request.scope.get("query_string", b"") != b"" or request.query_params:
            raise AlbumTopError("invalid_query", 400)
        path = album_top_working_request_path(request)
        if path is None:
            raise AlbumTopError("unavailable", 404)
        context, constraints = _context(request, BROWSE)
        _context_ref(request)
        top_ref = await run_in_threadpool(_service(request).resolve_public_link, context,
                                         share_ref=ref, constraints=constraints)
        if album_top_working_request_path(request) != path:
            raise AlbumTopError("unavailable", 404)
        # Only the current authorized canonical result reaches this fixed local
        # destination. It carries navigation intent, never a reusable grant.
        target = "/?" + urlencode({"surface": "album_tops", "top_ref": public_ref(top_ref)})
        return RedirectResponse(target, status_code=303, headers=_WORKING_HEADERS)
    except AlbumTopError as error:
        return _working_link_error(request, error, ref)
    except Exception:
        return _working_link_error(request, AlbumTopError("unavailable", 503), ref)


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


@router.post('/album-tops/{top_ref}/publication-preview')
async def preview_album_top_publication(request: Request, top_ref: str):
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command')
        ref = top_uuid(top_ref)
        context, constraints = _context(request, ACCESS)
        _require_context(request)
        payload = normalize_top_publication_preview(await read_bounded_json_object(request, max_bytes=MAX_TOP_COMMAND_BYTES))
        value = await run_in_threadpool(_service(request).publication_preview, context,
            top_ref=ref, payload=payload, constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)


@router.get('/album-tops/{top_ref}/items/{item_ref}/publication-sources')
def read_album_top_publication_sources(request: Request, top_ref: str, item_ref: str):
    try:
        params = request.query_params
        if (set(params) - {'revision', 'cursor', 'limit'} or 'revision' not in params
                or len(params.multi_items()) != len(params)):
            raise AlbumTopError('invalid_query')
        limit = params.get('limit', '50')
        if not limit.isascii() or not limit.isdecimal() or len(limit) > 3 or not 1 <= int(limit) <= 100:
            raise AlbumTopError('invalid_query')
        context, constraints = _context(request, BROWSE)
        options = validate_publication_source_request(top_ref=top_ref, item_ref=item_ref,
            revision=params['revision'], context_ref=_context_ref(request),
            cursor=params.get('cursor'), limit=int(limit))
        value = _service(request).read_publication_sources(context,
            cursor_secret=request.app.state.auth_policy_config['hmac']['secret'], constraints=constraints, **options)
        return _response(request, value)
    except AlbumTopError as error:
        return _error(error)


@router.post('/album-tops/{top_ref}/catalog/inventory')
async def admit_album_top_edit_inventory(request: Request, top_ref: str):
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command')
        ref = top_uuid(top_ref)
        context, constraints = _context(request, BROWSE)
        _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=1024)
        if type(payload) is not dict or set(payload) != {'album_id'}:
            raise AlbumTopError('invalid_command')
        value = await run_in_threadpool(_service(request).admit_inventory_album, context,
            album_id=payload['album_id'], top_ref=ref, constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)


@router.get('/album-top-catalog/search')
def search_album_top_inventory(request: Request):
    try:
        params = request.query_params
        if set(params) - {'q', 'cursor', 'limit', 'top_ref'} or len(params.multi_items()) != len(params):
            raise AlbumTopError('invalid_query')
        query, limit = params.get('q', ''), params.get('limit', '50')
        if (len(query) > 100 or '\0' in query or any('\ud800' <= char <= '\udfff' for char in query)
                or not limit.isascii() or not limit.isdecimal() or len(limit) > 3 or not 1 <= int(limit) <= 100):
            raise AlbumTopError('invalid_query')
        ref = top_uuid(params['top_ref']) if 'top_ref' in params else None
        context, constraints = _context(request, BROWSE)
        _context_ref(request)
        return _response(request, _service(request).search_inventory_albums(context,
            query=query.strip(), cursor=params.get('cursor'), limit=int(limit), top_ref=ref,
            cursor_secret=request.app.state.auth_policy_config['hmac']['secret'], constraints=constraints))
    except AlbumTopError as error:
        return _error(error)


async def _watch_remote_disconnect(request, cancelled):
    try:
        while not cancelled.is_set():
            if await request.is_disconnected():
                cancelled.set()
                return
            await asyncio.sleep(0.1)
    except Exception:
        # A failed disconnect observer cannot permit a later preparation write.
        cancelled.set()
    finally:
        # Cancellation itself still propagates, while an observer that has
        # stopped can never leave its worker believing the request is live.
        cancelled.set()


async def _remote_lookup(request, *, search):
    cancelled = Event()
    watcher = None
    try:
        if request.query_params or request.scope.get('query_string', b''):
            raise AlbumTopError('invalid_command')
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=4096)
        required = {'destination', 'title'} if search else {'request_key', 'destination', 'release_group_id'}
        allowed = required | {'artist'} if search else required
        if type(payload) is not dict or not required <= set(payload) <= allowed:
            raise AlbumTopError('invalid_command')
        service = _remote_service(request)
        watcher = asyncio.create_task(_watch_remote_disconnect(request, cancelled))
        options = {'context_ref': context_ref, 'constraints': constraints, 'should_cancel': cancelled.is_set}
        if search:
            value = await run_in_threadpool(service.search_candidates, context,
                destination=payload['destination'], title=payload['title'], artist=payload.get('artist', ''), **options)
        else:
            value = await run_in_threadpool(service.acquire, context, payload=payload, **options)
        if cancelled.is_set():
            raise AlbumTopError('provider_cancelled', 503)
        if _require_context(request) != context_ref:
            raise AlbumTopError('stale_context', 409)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('remote_acquisition_unavailable', 503))
    finally:
        cancelled.set()
        if watcher is not None:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher


@router.post('/album-top-catalog/remote-search')
async def search_album_top_remote(request: Request):
    return await _remote_lookup(request, search=True)


@router.post('/album-top-catalog/remote-acquisitions')
async def acquire_album_top_remote(request: Request):
    return await _remote_lookup(request, search=False)


@router.post("/album-tops/{top_ref}/{action}")
async def mutate_album_top(request: Request, top_ref: str, action: str):
    if action not in {"save", "enable_external", "revoke_external", "add", "remove", "reorder", "delete", "visibility", "grant_editor", "grant_viewer",
                      "revoke_editor", "request_edit", "decide_edit_request", "copy", "set_manual_completion", "set_activity"}:
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
