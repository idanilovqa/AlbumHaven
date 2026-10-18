"""Personal global Search admission, before transient or ordinary browse."""
import hmac
import json

from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import require_private_action, PrivateLibraryAuthorityError
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.view_search import PrivateSearchError, normalize_private_search_request
from music_app.services.private_search_postgres import (
    PostgresPrivateSearchService, normalize_native_search_command, normalize_native_search_batch_command,
)
from music_app.services.social_cursors import decode_search_cursor, SearchCursorScopeError
from music_app.services.private_search_contract import ListenerSearchRequest
from music_app.services.private_listener_search_postgres import PostgresListenerSearch, normalize_listener_native_command

_NO_STORE = {'Cache-Control': 'private, no-store'}
_NATIVE_QUERY_KEYS = frozenset({'q', 'surface', 'artist', 'all_artists',
                              'search_presentation', 'gallery_scope', 'category'})
_NATIVE_BODY_LIMIT = 1024
_NATIVE_BATCH_BODY_LIMIT = 16 * 1024


def _private_search_context(request):
    """The existing own-love context/policy rules, shared by reads and actions."""
    try:
        context_ref = private_ui_context_ref(request)
    except PrivateUIContextError as error:
        raise PrivateSearchError(error.code, error.status_code) from None
    actor = getattr(request.state, 'current_actor', None)
    if actor is None or not actor.is_authenticated:
        raise PrivateSearchError('private_search_forbidden', 403)
    if context_ref is None:
        raise PrivateSearchError('private_search_forbidden', 403)
    supplied = request.headers.get('x-albumhaven-context', '')
    if (len(supplied) != 64 or not supplied.isascii()
            or not hmac.compare_digest(supplied, context_ref)):
        raise PrivateSearchError('stale_context', 409)
    try:
        context = PolicyContext.build(actor=actor, action='library.browse.read',
            library_id=actor.current_library_id, deployment_mode=_deployment_mode(request),
            request_origin=_request_origin(request), client_surface_class=client_surface_from_request(request))
    except ValueError:
        raise PrivateSearchError('private_search_forbidden', 403) from None
    resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
    constraints = resolver if callable(resolver) else PolicyEvaluationConstraints()
    require_private_action(context, 'library.browse.read', constraints=constraints)
    return context, context_ref, constraints, request.app.state.auth_policy_config['hmac']['secret']


def _error_response(error):
    return JSONResponse({'ok': False, 'error_code': error.code, 'error': str(error),
                         'location': error.location}, status_code=error.status_code, headers=_NO_STORE)


def _native_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise PrivateSearchError()
        result[key] = value
    return result


async def _native_command(request, *, batch=False):
    limit = _NATIVE_BATCH_BODY_LIMIT if batch else _NATIVE_BODY_LIMIT
    command = await _native_json(request, limit=limit)
    key = 'resource_refs' if batch else 'resource_ref'
    if type(command) is not dict or set(command) != {key, 'intent'}:
        raise PrivateSearchError()
    normalizer = normalize_native_search_batch_command if batch else normalize_native_search_command
    normalizer(command[key], command['intent'])
    return command


async def _native_json(request, *, limit):
    if request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
        raise PrivateSearchError()
    length = request.headers.get('content-length')
    if length is not None and (not length.isascii() or not length.isdecimal()
                               or len(length) > len(str(limit)) or int(length) > limit):
        raise PrivateSearchError()
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise PrivateSearchError()
        body.extend(chunk)
    try:
        command = json.loads(body.decode('utf-8'), object_pairs_hook=_native_object)
    except (ValueError, UnicodeError, RecursionError):
        raise PrivateSearchError() from None
    return command


async def private_search_native_target_response(request):
    try:
        if set(request.query_params) - _NATIVE_QUERY_KEYS:
            raise PrivateSearchError()
        query = normalize_private_search_request(request.query_params)
        if type(query) is ListenerSearchRequest:
            raise PrivateSearchError()
        if (query.artist is None) == (not query.all_artists):
            raise PrivateSearchError()
        context, context_ref, constraints, secret = _private_search_context(request)
        command = await _native_command(request)
        service = getattr(request.app.state, 'private_search_service', None)
        if service is None:
            service = PostgresPrivateSearchService(request.app.state.config)
        payload = await run_in_threadpool(service.resolve_native_target, context, request=query,
            context_ref=context_ref, cursor_secret=secret, constraints=constraints, **command)
        return JSONResponse(payload, headers=_NO_STORE)
    except PrivateLibraryAuthorityError:
        error = PrivateSearchError('private_search_forbidden', 403)
    except PrivateSearchError as caught:
        error = caught
    except Exception:
        error = PrivateSearchError('private_search_unavailable', 503)
    return _error_response(error)


async def private_search_native_targets_response(request):
    try:
        if set(request.query_params) - _NATIVE_QUERY_KEYS:
            raise PrivateSearchError()
        query = normalize_private_search_request(request.query_params)
        if type(query) is ListenerSearchRequest:
            raise PrivateSearchError()
        if query.presentation != 'tracks' or (query.artist is None) == (not query.all_artists):
            raise PrivateSearchError()
        context, context_ref, constraints, secret = _private_search_context(request)
        command = await _native_command(request, batch=True)
        service = getattr(request.app.state, 'private_search_service', None)
        if service is None:
            service = PostgresPrivateSearchService(request.app.state.config)
        payload = await run_in_threadpool(service.resolve_native_targets, context, request=query,
            context_ref=context_ref, cursor_secret=secret, constraints=constraints, **command)
        return JSONResponse(payload, headers=_NO_STORE)
    except PrivateLibraryAuthorityError:
        error = PrivateSearchError('private_search_forbidden', 403)
    except PrivateSearchError as caught:
        error = caught
    except Exception:
        error = PrivateSearchError('private_search_unavailable', 503)
    return _error_response(error)


def private_search_view_response(request):
    try:
        query = normalize_private_search_request(request.query_params)
        context, context_ref, constraints, secret = _private_search_context(request)
        if type(query) is ListenerSearchRequest:
            service = getattr(request.app.state, 'private_listener_search_service', None)
            if service is None:
                service = PostgresListenerSearch(request.app.state.config)
            payload = service.read_live(context, request=query, context_ref=context_ref,
                                        cursor_secret=secret, constraints=constraints)
            return JSONResponse(payload, headers=_NO_STORE)
        # Reject malformed encoding before a database read, while the guarded
        # read validates scope and live anchors after current authority refresh.
        for token in (query.cursor, query.sidebar_cursor):
            try:
                decoded = decode_search_cursor(token, secret=secret)
                if (query.sidebar_only and decoded is not None
                        and decoded['selection']['state'] not in {'selected', 'all_artists'}):
                    raise PrivateSearchError()
            except SearchCursorScopeError:
                raise PrivateSearchError('search_cursor_restart_required', 409) from None
            except ValueError:
                raise PrivateSearchError() from None
        service = getattr(request.app.state, 'private_search_service', None)
        if service is None:
            service = PostgresPrivateSearchService(request.app.state.config)
        payload = service.read(context, request=query, context_ref=context_ref,
                               cursor_secret=secret, constraints=constraints)
        return JSONResponse(payload, headers=_NO_STORE)
    except PrivateLibraryAuthorityError:
        error = PrivateSearchError('private_search_forbidden', 403)
    except PrivateSearchError as caught:
        error = caught
    except Exception:
        # A failed infrastructure read is never a ready/empty result and never
        # routes into ordinary browse. Do not include SQL or private row values.
        error = PrivateSearchError('private_search_unavailable', 503)
    return _error_response(error)


async def _listener_native_response(request, *, operation):
    try:
        if request.query_params:
            raise PrivateSearchError()
        context, context_ref, constraints, secret = _private_search_context(request)
        command = await _native_json(request, limit=_NATIVE_BATCH_BODY_LIMIT)
        keys = ({'result_token', 'row_ref', 'intent'} if operation == 'single'
                else {'result_token', 'row_refs'} | ({'intent'} if operation == 'batch' else set()))
        if (type(command) is not dict or set(command) not in (keys, keys | {'target_kind'} if operation == 'single' else keys)
                or type(command.get('result_token')) is not str or not 1 <= len(command['result_token']) <= 4096):
            raise PrivateSearchError()
        if ('target_kind' in command and (type(command['target_kind']) is not str
                or command['target_kind'] not in {'album', 'artist'} or command.get('intent') != 'details')):
            raise PrivateSearchError('invalid_command', 422)
        refs = [command['row_ref']] if operation == 'single' else command['row_refs']
        normalize_listener_native_command(refs, operation=operation, intent=command.get('intent'),
                                          target_kind=command.get('target_kind'))
        service = getattr(request.app.state, 'private_listener_search_service', None)
        if service is None:
            service = PostgresListenerSearch(request.app.state.config)
        method = {'bindings': service.project_live_bindings, 'single': service.resolve_live_target,
                  'batch': service.resolve_live_targets}[operation]
        payload = await run_in_threadpool(method, context, context_ref=context_ref,
            cursor_secret=secret, constraints=constraints, **command)
        return JSONResponse(payload, headers=_NO_STORE)
    except PrivateLibraryAuthorityError:
        error = PrivateSearchError('private_search_forbidden', 403)
    except PrivateSearchError as caught:
        error = caught
    except Exception:
        error = PrivateSearchError('private_search_unavailable', 503)
    return _error_response(error)


async def listener_search_native_bindings_response(request):
    return await _listener_native_response(request, operation='bindings')


async def listener_search_native_target_response(request):
    return await _listener_native_response(request, operation='single')


async def listener_search_native_targets_response(request):
    return await _listener_native_response(request, operation='batch')
