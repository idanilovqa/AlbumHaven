"""Private per-account preference, not a listening qualification endpoint."""
import hmac
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.album_top_listening_settings import ListeningSettingsError, normalize_settings
from music_app.services.album_top_listening_settings_postgres import PostgresAlbumTopListeningSettings, READ, WRITE
from music_app.services.album_top_settings_context import (
    ALBUM_TOP_SETTINGS_CONTEXT_SCOPE, AlbumTopSettingsContextError, album_top_settings_context_ref,
)
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin, require_action
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_route_boundary import _valid_session_csrf

router = APIRouter()
NO_STORE = {'Cache-Control': 'private, no-store'}


def _context(request, action):
    actor = getattr(request.state, 'current_actor', None)
    if actor is None or not actor.is_authenticated:
        raise ListeningSettingsError('forbidden', 403)
    try:
        context = PolicyContext.build(actor=actor, action=action, library_id=None,
            target_account_id=actor.account_id, deployment_mode=_deployment_mode(request),
            request_origin=_request_origin(request), client_surface_class=client_surface_from_request(request))
        marker = album_top_settings_context_ref(request)
    except AlbumTopSettingsContextError as error:
        raise ListeningSettingsError(error.code, error.status_code) from None
    except ValueError:
        raise ListeningSettingsError('forbidden', 403) from None
    if marker is None:
        raise ListeningSettingsError('forbidden', 403)
    raw = request.scope.get('headers', ())
    supplied = [v.decode('latin1') for k, v in raw if k.lower() == b'x-albumhaven-account-context']
    if any(k.lower() == b'x-albumhaven-context' for k, _ in raw):
        raise ListeningSettingsError('stale_context', 409)
    if action == WRITE or supplied:
        if (len(supplied) != 1 or len(supplied[0]) != 64 or not supplied[0].isascii()
                or not hmac.compare_digest(supplied[0], marker)):
            raise ListeningSettingsError('stale_context', 409)
    if action == WRITE:
        # Defense in depth as well as the registered private-route boundary.
        if sum(k.lower() == b'x-album-haven-csrf' for k, _ in raw) != 1 or not _valid_session_csrf(request):
            raise ListeningSettingsError('csrf_invalid', 403)
    resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
    return context, resolver if callable(resolver) else PolicyEvaluationConstraints(), marker


def _service(request):
    service = getattr(request.app.state, 'album_top_listening_settings_service', None)
    return service if service is not None else PostgresAlbumTopListeningSettings(request.app.state.config)


def _query(request):
    if request.scope.get('query_string', b'') or request.query_params:
        raise ListeningSettingsError('invalid_query')


def _response(value, marker):
    return JSONResponse({'status': 'ready', 'data': value, 'context_ref': marker,
                         'context_scope': ALBUM_TOP_SETTINGS_CONTEXT_SCOPE}, headers=NO_STORE)


def _error(error):
    return JSONResponse({'ok': False, 'error': error.code}, status_code=error.status, headers=NO_STORE)


@router.get('/account/album-top-listening-settings')
async def read_settings(request: Request):
    try:
        _query(request)
        await require_action(READ, refresh_actor=True)(request)
        context, constraints, marker = _context(request, READ)
        value = await run_in_threadpool(_service(request).read, context, constraints=constraints)
        await require_action(READ, refresh_actor=True)(request)
        if album_top_settings_context_ref(request) != marker:
            raise ListeningSettingsError('stale_context', 409)
        return _response(value, marker)
    except HTTPException as error:
        return _error(ListeningSettingsError('forbidden', error.status_code))
    except ListeningSettingsError as error:
        return _error(error)
    except Exception:
        return _error(ListeningSettingsError('settings_unavailable', 503))


@router.put('/account/album-top-listening-settings')
async def save_settings(request: Request):
    try:
        _query(request)
        await require_action(WRITE, refresh_actor=True)(request)
        context, constraints, marker = _context(request, WRITE)
        try:
            command = normalize_settings(await read_bounded_json_object(request, max_bytes=1024))
        except JSONBodyTooLarge:
            raise ListeningSettingsError('body_too_large', 413) from None
        except (ValueError, TypeError):
            raise ListeningSettingsError('invalid_command') from None
        value = await run_in_threadpool(_service(request).save, context, command, constraints=constraints)
        await require_action(WRITE, refresh_actor=True)(request)
        if album_top_settings_context_ref(request) != marker:
            raise ListeningSettingsError('stale_context', 409)
        return _response(value, marker)
    except HTTPException as error:
        return _error(ListeningSettingsError('forbidden', error.status_code))
    except ListeningSettingsError as error:
        return _error(error)
    except Exception:
        return _error(ListeningSettingsError('settings_unavailable', 503))
