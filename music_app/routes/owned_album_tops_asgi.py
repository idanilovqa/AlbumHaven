"""Authenticated Album Top transport; playback authority stays independent."""
import asyncio
import hmac
from collections.abc import Mapping
from contextlib import suppress
from html import escape
from threading import Event
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.owned_album_tops import (
    AlbumTopError, BROWSE, CREATE, ACCESS, MAX_TOP_COMMAND_BYTES, normalize_top_command,
    require_top_authority, top_uuid, normalize_top_publication_preview,
)
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService
from music_app.services.album_top_native_targets import AlbumTopNativeTargets
from music_app.services.album_top_native_queue import AlbumTopNativeQueue
from music_app.services.album_top_remote_acquisition import TopRemoteAcquisitionService
from music_app.services.album_top_artwork_owner import TopArtworkOwnerService
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from music_app.services.album_top_artwork_review import _json_size as artwork_json_size
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



def _source_import_service(request):
    from music_app.services.album_top_source_imports import TopSourceImports
    service = getattr(request.app.state, 'album_top_source_import_service', None)
    return service if service is not None else TopSourceImports(_service(request))


async def _source_import_request(request, operation, job_ref=None):
    try:
        admitted = _require_context(request)
        context, constraints = _context(request, CREATE)
        params = request.query_params
        allowed = {'cursor'} if operation == 'list' else set()
        if set(params) - allowed or len(params.multi_items()) != len(params):
            raise AlbumTopError('invalid_query')
        arguments = {}
        try:
            if operation == 'submit':
                arguments['payload'] = await read_bounded_json_object(request, max_bytes=MAX_TOP_COMMAND_BYTES)
            elif operation in ('process', 'cancel'):
                payload = await read_bounded_json_object(request, max_bytes=1024)
                if payload != {}:
                    raise AlbumTopError('invalid_command')
        except JSONBodyTooLarge:
            raise
        except (ValueError, TypeError):
            raise AlbumTopError('invalid_command') from None
        if job_ref is not None:
            arguments['ref'] = top_uuid(job_ref)
        if operation == 'list':
            arguments['cursor'] = params.get('cursor')
        if _context_ref(request) != admitted:
            raise AlbumTopError('stale_context', 409)
        value = await run_in_threadpool(getattr(_source_import_service(request), operation),
            context, constraints=constraints, **arguments)
        if _context_ref(request) != admitted:
            raise AlbumTopError('stale_context', 409)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)


@router.get('/album-tops/source-imports')
async def list_album_top_source_imports(request: Request):
    return await _source_import_request(request, 'list')


@router.post('/album-tops/source-imports')
async def submit_album_top_source_import(request: Request):
    return await _source_import_request(request, 'submit')


@router.get('/album-tops/source-imports/{job_ref}')
async def read_album_top_source_import(request: Request, job_ref: str):
    return await _source_import_request(request, 'read', job_ref)


@router.post('/album-tops/source-imports/{job_ref}/process')
async def process_album_top_source_import(request: Request, job_ref: str):
    return await _source_import_request(request, 'process', job_ref)


@router.post('/album-tops/source-imports/{job_ref}/cancel')
async def cancel_album_top_source_import(request: Request, job_ref: str):
    return await _source_import_request(request, 'cancel', job_ref)


@router.get("/album-tops/{top_ref}")
def read_album_top(request: Request, top_ref: str):
    try:
        if request.query_params:
            raise AlbumTopError("invalid_command")
        context, constraints = _context(request, BROWSE)
        # Fail before database work if the private UI identity cannot be established.
        context_ref = _context_ref(request)
        return _response(request, _service(request).read(context, top_ref=top_ref,
            constraints=constraints, context_ref=context_ref))
    except AlbumTopError as error:
        return _error(error)


@router.get("/album-tops/{top_ref}/items/{item_ref}/native-target")
def read_album_top_native_target(request: Request, top_ref: str, item_ref: str):
    try:
        params = request.query_params
        if set(params) != {'revision', 'inventory_album_ref'} or len(params.multi_items()) != len(params):
            raise AlbumTopError('invalid_query', 422)
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        value = AlbumTopNativeTargets(_service(request)).resolve(context, top_ref=top_ref,
            item_ref=item_ref, revision=params['revision'], inventory_album_ref=params['inventory_album_ref'],
            context_ref=context_ref, constraints=constraints)
        return _response(request, value)
    except AlbumTopError as error:
        return _error(error)


async def _native_playback(request, top_ref, *, resolve):
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command', 422)
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=MAX_TOP_COMMAND_BYTES)
        service = AlbumTopNativeQueue(_service(request))
        action = service.resolve if resolve else service.capture
        value = await run_in_threadpool(action, context, top_ref=top_ref,
            payload=payload, context_ref=context_ref, constraints=constraints)
        if _require_context(request) != context_ref:
            raise AlbumTopError('stale_context', 409)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)


@router.post('/album-tops/{top_ref}/native-queue')
async def capture_album_top_native_queue(request: Request, top_ref: str):
    return await _native_playback(request, top_ref, resolve=False)


@router.post('/album-tops/{top_ref}/native-playback-target')
async def resolve_album_top_native_playback(request: Request, top_ref: str):
    return await _native_playback(request, top_ref, resolve=True)


async def _mutate(request, action, top_ref=None):
    try:
        if request.query_params:
            raise AlbumTopError("invalid_command")
        context, constraints = _context(request, CREATE if action == "create" else BROWSE)
        context_ref = _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=MAX_TOP_COMMAND_BYTES)
        command = normalize_top_command(action, payload, top_ref=top_ref)
        value = await run_in_threadpool(_service(request).execute, context, command,
            constraints=constraints, context_ref=context_ref)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError("command_too_large", 413))
    except AlbumTopError as error:
        return _error(error)


@router.post("/album-tops")
async def create_album_top(request: Request):
    return await _mutate(request, "create")


@router.post('/album-tops/playlist-previews/{playlist_ref}')
async def capture_playlist_album_top(request: Request, playlist_ref: str):
    from music_app.services.playlist_album_top_previews import PlaylistAlbumTopPreviews
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command')
        context, constraints = _context(request, CREATE)
        context_ref = _require_context(request)
        payload = await read_bounded_json_object(request, max_bytes=4096)
        value = await run_in_threadpool(PlaylistAlbumTopPreviews(_service(request)).capture,
            context, playlist_ref=playlist_ref, payload=payload, context_ref=context_ref, constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)


@router.get('/album-tops/playlist-previews/{preview_ref}/albums/{album_ref}/native-target')
async def resolve_playlist_album_top_member(request: Request, preview_ref: str, album_ref: str):
    from music_app.services.playlist_album_top_previews import PlaylistAlbumTopPreviews
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command')
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        value = await run_in_threadpool(PlaylistAlbumTopPreviews(_service(request)).resolve_album,
            context, preview_ref=preview_ref, album_ref=album_ref, context_ref=context_ref, constraints=constraints)
        return _response(request, value)
    except AlbumTopError as error:
        return _error(error)


@router.delete('/album-tops/playlist-previews/{preview_ref}')
async def discard_playlist_album_top(request: Request, preview_ref: str):
    from music_app.services.playlist_album_top_previews import PlaylistAlbumTopPreviews
    try:
        if request.query_params:
            raise AlbumTopError('invalid_command')
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        value = await run_in_threadpool(PlaylistAlbumTopPreviews(_service(request)).discard,
            context, preview_ref=preview_ref, context_ref=context_ref, constraints=constraints)
        return _response(request, value)
    except AlbumTopError as error:
        return _error(error)


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
        if search:
            valid = type(payload) is dict and {'destination', 'title'} <= set(payload) <= {'destination', 'title', 'artist'}
        else:
            valid = type(payload) is dict and (set(payload) == {'request_key', 'destination', 'release_group_id'}
                or (set(payload) == {'version', 'preparation_ref', 'request_key', 'destination', 'release_group_id'}
                    and type(payload['version']) is int and payload['version'] == 2))
        if not valid:
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
        return _remote_response(request, value, context_ref)
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


def _remote_response(request, value, context_ref):
    # Only this private remote family has preparation/attempt statuses. Generic
    # Top mutations keep their existing response and continuity contracts.
    if _require_context(request) != context_ref:
        raise AlbumTopError('stale_context', 409)
    status = {'in_flight': 202, 'failed': 503, 'maintenance_required': 409, 'limit': 429}.get(value.get('state'), 200)
    return JSONResponse({'status': 'ready', 'data': value, 'context_ref': context_ref},
                        status_code=status, headers=_NO_STORE)


async def _remote_preparation(request, *, operation, preparation_ref=None):
    cancelled = Event()
    watcher = None
    try:
        if request.query_params or request.scope.get('query_string', b''):
            raise AlbumTopError('invalid_command')
        context, constraints = _context(request, BROWSE)
        context_ref = _require_context(request)
        service = _remote_service(request)
        options = {'context_ref': context_ref, 'constraints': constraints, 'should_cancel': cancelled.is_set}
        if operation == 'status':
            method = service.preparation_status
        else:
            payload = await read_bounded_json_object(request, max_bytes=4096)
            required = {'destination', 'form_ref'} if operation == 'begin' else {'mode'} if operation == 'maintain' else set()
            if type(payload) is not dict or set(payload) != required:
                raise AlbumTopError('invalid_command')
            options['payload'] = payload
            if operation == 'begin':
                method = service.begin_preparation
            elif operation == 'maintain':
                method = service.maintain_preparations
            else:
                options['preparation_ref'] = top_uuid(preparation_ref)
                method = service.close_preparation
        # One bounded observer, retired on every exit. Status can also wait on
        # current authority; disconnect must retire that response without DML.
        watcher = asyncio.create_task(_watch_remote_disconnect(request, cancelled))
        value = await run_in_threadpool(method, context, **options)
        if cancelled.is_set():
            raise AlbumTopError('provider_cancelled', 503)
        return _remote_response(request, value, context_ref)
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


@router.post('/album-top-catalog/remote-preparations')
async def begin_album_top_remote_preparation(request: Request):
    return await _remote_preparation(request, operation='begin')


@router.get('/album-top-catalog/remote-preparations')
async def read_album_top_remote_preparations(request: Request):
    return await _remote_preparation(request, operation='status')


@router.post('/album-top-catalog/remote-preparations/maintain')
async def maintain_album_top_remote_preparations(request: Request):
    return await _remote_preparation(request, operation='maintain')


@router.post('/album-top-catalog/remote-preparations/{preparation_ref}/close')
async def close_album_top_remote_preparation(request: Request, preparation_ref: str):
    return await _remote_preparation(request, operation='close', preparation_ref=preparation_ref)


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

# Fixed native artwork family. These routes are composed only with the accepted
# preparation/publication service and native source, never a dynamic provider.
_ARTWORK_COMMAND_BYTES = 2 * 1024 * 1024
_ARTWORK_SMALL_BYTES = 16 * 1024
_ARTWORK_RESPONSE_BYTES = 2 * 1024 * 1024 + 1024
_ARTWORK_REVIEW_BYTES = 36 * 1024 * 1024 + 1024


def _artwork_key(request):
    # Optional collaborator forwarding preserves service receipt-first semantics.
    # Actual HTTP admission above still requires a valid current context key.
    settings = getattr(request.app.state, 'auth_policy_config', None)
    hmac_settings = settings.get('hmac') if isinstance(settings, Mapping) else None
    return hmac_settings.get('secret') if isinstance(hmac_settings, Mapping) else None


def _artwork_identity(request, top_ref, kind=None, preparation_ref=None):
    if request.scope.get('query_string', b'') != b'' or request.query_params:
        raise AlbumTopError('invalid_query')
    captured = _require_context(request)
    context, constraints = _context(request, BROWSE)
    ref = top_uuid(top_ref)
    if ref == '00000000-0000-0000-0000-000000000000':
        raise AlbumTopError('invalid_command')
    if kind is not None and kind not in ('saved', 'draft'):
        raise AlbumTopError('invalid_command')
    if preparation_ref is not None:
        prep = top_uuid(preparation_ref)
        if prep == '00000000-0000-0000-0000-000000000000':
            raise AlbumTopError('invalid_command')
    return context, constraints, captured, ref


def _artwork_response(request, value, captured, *, review=False):
    payload = {'status': 'ready', 'data': value, 'context_ref': captured}
    artwork_json_size(payload, _ARTWORK_REVIEW_BYTES if review else _ARTWORK_RESPONSE_BYTES)
    response = JSONResponse(payload, headers=_NO_STORE)
    if not hmac.compare_digest(_require_context(request), captured):
        raise AlbumTopError('stale_context', 409)
    return response


async def _artwork_payload(request, kind, operation):
    additions = {'status': {'after', 'limit'}, 'advance': {'preparation_revision', 'request_key'},
        'review': {'preparation_revision', 'title', 'description', 'action'},
        'preview': {'preparation_revision', 'review_witness', 'row_ref', 'asset_ref'}}
    expected = {'top_revision'} | ({'draft_ref', 'draft_revision'} if kind == 'draft' else set()) | additions[operation]
    payload = await read_bounded_json_object(request, max_bytes=_ARTWORK_SMALL_BYTES)
    if type(payload) is not dict or set(payload) != expected:
        raise AlbumTopError('invalid_command')
    return payload


@router.get('/album-tops/{top_ref}/artwork-publication')
async def read_album_top_artwork_state(request: Request, top_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref)
        async for chunk in request.stream():
            if chunk:
                raise AlbumTopError('invalid_command')
        value = await run_in_threadpool(TopArtworkOwnerService(_service(request)).read_state,
            context, top_ref=ref, context_ref=captured, constraints=constraints)
        return _artwork_response(request, value, captured)
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-publication/sources')
async def read_album_top_artwork_sources(request: Request, top_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref)
        payload = await read_bounded_json_object(request, max_bytes=_ARTWORK_SMALL_BYTES)
        value = await run_in_threadpool(TopArtworkOwnerService(_service(request)).read_sources,
            context, top_ref=ref, payload=payload, context_ref=captured,
            cursor_secret=_artwork_key(request), constraints=constraints)
        return _artwork_response(request, value, captured)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-preparations/{kind}/start')
async def start_album_top_artwork(request: Request, top_ref: str, kind: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref, kind)
        payload = await read_bounded_json_object(request, max_bytes=_ARTWORK_COMMAND_BYTES)
        service = TopArtworkPreparationService(_service(request))
        if kind == 'saved':
            value = await run_in_threadpool(service.start, context, top_ref=ref, payload=payload,
                context_ref=captured, constraints=constraints)
        else:
            value = await run_in_threadpool(service.start_draft, context, top_ref=ref, payload=payload,
                context_ref=captured, constraints=constraints)
        return _artwork_response(request, value, captured)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-preparations/{kind}/{preparation_ref}/status')
async def read_album_top_artwork_preparation(request: Request, top_ref: str, kind: str, preparation_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref, kind, preparation_ref)
        payload = await _artwork_payload(request, kind, 'status')
        payload['top_revision_value'] = payload.pop('top_revision')
        service = TopArtworkPreparationService(_service(request))
        if kind == 'saved':
            value = await run_in_threadpool(service.read, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, constraints=constraints, **payload)
        else:
            value = await run_in_threadpool(service.read_draft, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, constraints=constraints, **payload)
        return _artwork_response(request, value, captured)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-preparations/{kind}/{preparation_ref}/advance')
async def advance_album_top_artwork_preparation(request: Request, top_ref: str, kind: str, preparation_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref, kind, preparation_ref)
        payload = await _artwork_payload(request, kind, 'advance')
        payload['top_revision_value'] = payload.pop('top_revision')
        service = TopArtworkPreparationService(_service(request))
        if kind == 'saved':
            value = await run_in_threadpool(service.advance, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, constraints=constraints, **payload)
        else:
            value = await run_in_threadpool(service.advance_draft, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, constraints=constraints, **payload)
        return _artwork_response(request, value, captured)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-preparations/{kind}/{preparation_ref}/review')
async def review_album_top_artwork_publication(request: Request, top_ref: str, kind: str, preparation_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref, kind, preparation_ref)
        payload = await _artwork_payload(request, kind, 'review')
        service = TopArtworkPreparationService(_service(request))
        if kind == 'saved':
            value = await run_in_threadpool(service.review_publication_saved, context, top_ref=ref,
                preparation_ref=preparation_ref, context_ref=captured, cursor_secret=_artwork_key(request),
                constraints=constraints, **payload)
        else:
            value = await run_in_threadpool(service.review_publication_draft, context, top_ref=ref,
                preparation_ref=preparation_ref, context_ref=captured, cursor_secret=_artwork_key(request),
                constraints=constraints, **payload)
        return _artwork_response(request, value, captured, review=True)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-preparations/{kind}/{preparation_ref}/preview')
async def read_album_top_artwork_preview(request: Request, top_ref: str, kind: str, preparation_ref: str):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref, kind, preparation_ref)
        payload = await _artwork_payload(request, kind, 'preview')
        service = TopArtworkPreparationService(_service(request))
        if kind == 'saved':
            value = await run_in_threadpool(service.read_saved_png, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, cursor_secret=_artwork_key(request), head_only=False, constraints=constraints, **payload)
        else:
            value = await run_in_threadpool(service.read_draft_png, context, top_ref=ref, preparation_ref=preparation_ref,
                context_ref=captured, cursor_secret=_artwork_key(request), head_only=False, constraints=constraints, **payload)
        if (type(value) is not dict or set(value) != {'body', 'content_type', 'content_length', 'cache_control',
                'x_content_type_options', 'referrer_policy'} or type(value['body']) is not bytes
                or type(value['content_length']) is not int or not 0 < value['content_length'] <= 327680
                or len(value['body']) != value['content_length'] or value['content_type'] != 'image/png'
                or value['cache_control'] != 'private, no-store' or value['x_content_type_options'] != 'nosniff'
                or value['referrer_policy'] != 'no-referrer'):
            raise AlbumTopError('unavailable', 503)
        response = Response(value['body'], media_type='image/png', headers={**_NO_STORE,
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
            'Content-Encoding': 'identity', 'X-AlbumHaven-Context': captured})
        if not hmac.compare_digest(_require_context(request), captured):
            raise AlbumTopError('stale_context', 409)
        return response
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


async def _publish_album_top_artwork(request, top_ref, action):
    try:
        context, constraints, captured, ref = _artwork_identity(request, top_ref)
        payload = await read_bounded_json_object(request, max_bytes=_ARTWORK_COMMAND_BYTES)
        if type(payload) is not dict or set(payload) != {'request_key', 'revision', 'title', 'description', 'items', 'evidence_revision', 'artwork_publication'}:
            raise AlbumTopError('invalid_command')
        command = normalize_top_command(action, payload, top_ref=ref)
        # No state/prepare/review/token or original-context preflight can stand
        # between current HTTP admission and the service's exact receipt replay.
        value = await run_in_threadpool(_service(request).execute, context, command,
            constraints=constraints, context_ref=captured, cursor_secret=_artwork_key(request))
        return _artwork_response(request, value, captured)
    except JSONBodyTooLarge:
        return _error(AlbumTopError('command_too_large', 413))
    except AlbumTopError as error:
        return _error(error)
    except Exception:
        return _error(AlbumTopError('unavailable', 503))


@router.post('/album-tops/{top_ref}/artwork-publication/save')
async def save_album_top_artwork_publication(request: Request, top_ref: str):
    return await _publish_album_top_artwork(request, top_ref, 'save')


@router.post('/album-tops/{top_ref}/artwork-publication/enable')
async def enable_album_top_artwork_publication(request: Request, top_ref: str):
    return await _publish_album_top_artwork(request, top_ref, 'enable_external')
