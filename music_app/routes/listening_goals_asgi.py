"""Private account Goals API. Local-library selection is not admission proof."""
import asyncio
import hmac
from contextlib import suppress
from threading import Event

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.account_goals_context import (
    ACCOUNT_GOALS_CONTEXT_SCOPE, AccountGoalsContextError, account_goals_context_ref,
)
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command
from music_app.services.listening_goal_bonus_settings import normalize_bonus_settings
from music_app.services.listening_goal_bonus import normalize_bonus_draw
from music_app.services.listening_goal_transition import normalize_goal_transition
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService, READ, WRITE
from music_app.services.policy import PolicyContext
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints

router = APIRouter()
NO_STORE = {'Cache-Control': 'private, no-store'}
MAX_BODY_BYTES = 8192


def _context(request, action):
    actor = getattr(request.state, 'current_actor', None)
    if actor is None:
        raise GoalsError('forbidden', 403)
    try:
        context = PolicyContext.build(actor=actor, action=action, library_id=None,
            target_account_id=actor.account_id, deployment_mode=_deployment_mode(request),
            request_origin=_request_origin(request), client_surface_class=client_surface_from_request(request))
    except ValueError:
        raise GoalsError('forbidden', 403) from None
    # Account entry opts into an account/session-only continuity fence. This
    # value is never authority; the real session, policy and repository still
    # authorize the request. Never substitute a client-provided identity.
    account_supplied = request.headers.getlist('x-albumhaven-account-context')
    supplied = request.headers.getlist('x-albumhaven-context')
    marker = None
    scope = None
    if account_supplied:
        if len(account_supplied) != 1 or supplied:
            raise GoalsError('stale_context', 409)
        try:
            marker = account_goals_context_ref(request)
        except AccountGoalsContextError as error:
            raise GoalsError(error.code, error.status_code) from None
        value = account_supplied[0]
        if (marker is None or len(value) != 64 or not value.isascii()
                or not hmac.compare_digest(value, marker)):
            raise GoalsError('stale_context', 409)
        scope = ACCOUNT_GOALS_CONTEXT_SCOPE
    else:
        # Preserve the existing optional Home fence and headerless account API.
        # Their library-bound signer and write-only check remain unchanged.
        library_id = actor.current_library_id
        if type(library_id) is int and library_id > 0:
            try:
                marker = private_ui_context_ref(request)
            except PrivateUIContextError as error:
                raise GoalsError(error.code, error.status_code) from None
        if action == WRITE:
            if supplied and (len(supplied) != 1 or marker is None
                    or len(supplied[0]) != 64 or not supplied[0].isascii()
                    or not hmac.compare_digest(supplied[0], marker)):
                raise GoalsError('stale_context', 409)
    request.state.goals_ui_context_ref = marker
    request.state.goals_ui_context_scope = scope
    resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
    return context, resolver if callable(resolver) else PolicyEvaluationConstraints()


def _service(request):
    service = getattr(request.app.state, 'listening_goals_service', None)
    if service is not None:
        return service
    return PostgresListeningGoalsService(request.app.state.config,
        user_agent=request.app.state.config.get('MUSICBRAINZ_USER_AGENT'))


def _response(request, value):
    payload = {'status': 'ready', 'data': value}
    marker = getattr(request.state, 'goals_ui_context_ref', None)
    if marker is not None:
        payload['context_ref'] = marker
    scope = getattr(request.state, 'goals_ui_context_scope', None)
    if scope is not None:
        payload['context_scope'] = scope
    return JSONResponse(payload, headers=NO_STORE)


def _error(error):
    return JSONResponse({'ok': False, 'error': error.code}, status_code=error.status, headers=NO_STORE)


def _query(request, allowed=()):
    params = request.query_params
    if set(params) - set(allowed) or len(params.multi_items()) != len(params):
        raise GoalsError('invalid_query', 400)
    return params


async def _body(request):
    _query(request)
    try:
        return await read_bounded_json_object(request, max_bytes=MAX_BODY_BYTES)
    except JSONBodyTooLarge:
        raise GoalsError('body_too_large', 413) from None
    except (ValueError, TypeError):
        raise GoalsError('invalid_command', 400) from None


@router.get('/account/goals')
def read_goals(request: Request):
    try:
        _query(request)
        context, constraints = _context(request, READ)
        return _response(request, _service(request).read(context, constraints=constraints))
    except GoalsError as error:
        return _error(error)


@router.get('/account/goals/history')
def read_goal_history(request: Request):
    try:
        params = _query(request, ('period', 'cursor', 'limit'))
        limit = params.get('limit', '25')
        if not limit.isascii() or not limit.isdecimal() or len(limit) > 3:
            raise GoalsError('invalid_query', 400)
        context, constraints = _context(request, READ)
        value = _service(request).history(context, period=params.get('period'), cursor=params.get('cursor'),
            limit=int(limit), cursor_secret=request.app.state.auth_policy_config['hmac']['secret'],
            constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.get('/account/goals/operations/{request_key}')
def read_goal_operation(request: Request, request_key: str):
    try:
        _query(request)
        context, constraints = _context(request, READ)
        return _response(request, _service(request).read_operation(context, request_key, constraints=constraints))
    except GoalsError as error:
        return _error(error)


async def _watch_disconnect(request, cancelled):
    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.1)


async def _remote_lookup(request, *, search):
    cancelled = Event()
    watcher = None
    try:
        payload = await _body(request)
        fields = {'title', 'artist'} if search else {'release_group_id'}
        if type(payload) is not dict or set(payload) != fields:
            raise GoalsError('invalid_command', 400)
        context, constraints = _context(request, WRITE)
        watcher = asyncio.create_task(_watch_disconnect(request, cancelled))
        service = _service(request)
        method = service.search_candidates if search else service.acquire_evidence
        args = (payload['title'], payload['artist']) if search else (payload['release_group_id'],)
        value = await run_in_threadpool(method, context, *args,
            constraints=constraints, should_cancel=cancelled.is_set)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)
    finally:
        cancelled.set()
        if watcher is not None:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher


@router.post('/account/goals/remote-search')
async def search_goal_candidates(request: Request):
    return await _remote_lookup(request, search=True)


@router.post('/account/goals/remote-evidence')
async def acquire_goal_evidence(request: Request):
    return await _remote_lookup(request, search=False)


async def _execute(request, action):
    try:
        command = normalize_goal_command(action, await _body(request))
        context, constraints = _context(request, WRITE)
        value = await run_in_threadpool(_service(request).execute, context, command, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/add')
async def add_goal(request: Request):
    return await _execute(request, 'add')


@router.get('/account/goals/bonus-settings')
async def read_goal_bonus_settings(request: Request):
    try:
        _query(request)
        context, constraints = _context(request, READ)
        value = await run_in_threadpool(_service(request).read_bonus_settings, context, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/transition')
async def transition_goal_period(request: Request):
    try:
        command = normalize_goal_transition(await _body(request))
        context, constraints = _context(request, WRITE)
        value = await run_in_threadpool(_service(request).transition, context, command, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.get('/account/goals/bonus')
async def read_goal_bonus(request: Request):
    try:
        _query(request)
        context, constraints = _context(request, READ)
        value = await run_in_threadpool(_service(request).read_current_bonus, context, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/bonus/draw')
async def draw_goal_bonus(request: Request):
    try:
        command = normalize_bonus_draw(await _body(request))
        context, constraints = _context(request, WRITE)
        value = await run_in_threadpool(_service(request).draw_bonus, context, command, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/bonus-settings')
async def save_goal_bonus_settings(request: Request):
    try:
        command = normalize_bonus_settings(await _body(request))
        context, constraints = _context(request, WRITE)
        value = await run_in_threadpool(_service(request).save_bonus_settings, context, command, constraints=constraints)
        return _response(request, value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/reset')
async def reset_goal(request: Request):
    return await _execute(request, 'reset')


@router.post('/account/goals/completion')
async def set_goal_completion(request: Request):
    return await _execute(request, 'completion')


@router.post('/account/goals/remove')
async def remove_goal(request: Request):
    return await _execute(request, 'remove')
