"""Private, bounded checkpoint transport for app-reported consumption."""
import hmac
from collections.abc import Mapping

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.playback_capture import BODY_LIMIT, CaptureError, PROTOCOL, capture_scope, parse_capture_body
from music_app.services.playback_capture_postgres import check_capture_context, record_capture_checkpoint
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin, require_action
from music_app.services.private_library_authority import PrivateLibraryAuthorityError

router = APIRouter()
_HEADERS = {'Cache-Control': 'private, no-store'}


def _error(code, status):
    return JSONResponse({'ok': False, 'error': code, 'retryable': status in (429, 503)},
                        status_code=status, headers=_HEADERS)


async def _authority(request):
    await require_action('library.media.read', refresh_actor=True)(request)
    actor = request.state.current_actor
    context = PolicyContext.build(actor=actor, action='library.media.read', library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request), request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
    if resolver is not None and not callable(resolver):
        raise RuntimeError('Private library policy resolver is invalid.')
    config = getattr(request.app.state, 'config', {})
    database_url = config.get('ALBUM_HAVEN_APP_DATABASE_URL') if isinstance(config, Mapping) else None
    if not isinstance(database_url, str) or not database_url.strip():
        raise CaptureError('capture_unavailable', 503)
    scope = capture_scope(context, getattr(request.app.state, 'auth_policy_config', {}))
    return context, resolver, database_url, scope


@router.get('/playback/capture/context')
async def playback_capture_context(request: Request):
    try:
        context, constraints, database_url, scope = await _authority(request)
        if request.query_params:
            raise CaptureError()
        await run_in_threadpool(check_capture_context, database_url, context, constraints=constraints)
        return JSONResponse(dict(ok=True, protocol=PROTOCOL, expected_scope=scope,
                                 source_rate=48000, output_rate=48000), headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code == 401 else 'capture_forbidden', error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden', 403)
    except CaptureError as error:
        return _error(error.code, error.status)
    except Exception:
        # Driver, locator, auth and configuration details never reach a response.
        return _error('capture_unavailable', 503)


@router.post('/playback/capture/checkpoint')
async def playback_capture_checkpoint(request: Request):
    try:
        context, constraints, database_url, scope = await _authority(request)
        supplied = request.headers.get('x-playback-capture-scope', '')
        if len(supplied) != len(scope) or not supplied.isascii() or not hmac.compare_digest(supplied, scope):
            raise CaptureError('capture_scope_changed', 409)
        if request.query_params:
            raise CaptureError()
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > BODY_LIMIT:
                raise CaptureError('capture_too_large', 413)
            body.extend(chunk)
        envelope = parse_capture_body(body)
        result = await run_in_threadpool(record_capture_checkpoint, database_url, context, envelope,
                                        expected_scope=scope, constraints=constraints)
        return JSONResponse(result, headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code == 401 else 'capture_forbidden', error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden', 403)
    except CaptureError as error:
        return _error(error.code, error.status)
    except Exception:
        return _error('capture_unavailable', 503)
