"""Private account Goals API. Local-library selection is not admission proof."""
import asyncio
from contextlib import suppress
from threading import Event

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService, READ, WRITE
from music_app.services.musicbrainz_http import default_user_agent
from music_app.services.policy import PolicyContext
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
    resolver = getattr(request.app.state, 'policy_constraint_resolver', None)
    return context, resolver if callable(resolver) else PolicyEvaluationConstraints()


def _service(request):
    service = getattr(request.app.state, 'listening_goals_service', None)
    if service is not None:
        return service
    return PostgresListeningGoalsService(request.app.state.config,
        user_agent=default_user_agent('AlbumHaven', '0.0.0', ''))


def _response(value):
    return JSONResponse({'status': 'ready', 'data': value}, headers=NO_STORE)


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
        return _response(_service(request).read(context, constraints=constraints))
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
        return _response(value)
    except GoalsError as error:
        return _error(error)


@router.get('/account/goals/operations/{request_key}')
def read_goal_operation(request: Request, request_key: str):
    try:
        _query(request)
        context, constraints = _context(request, READ)
        return _response(_service(request).read_operation(context, request_key, constraints=constraints))
    except GoalsError as error:
        return _error(error)


async def _watch_disconnect(request, cancelled):
    while not cancelled.is_set():
        if await request.is_disconnected():
            cancelled.set()
            return
        await asyncio.sleep(0.1)


@router.post('/account/goals/remote-evidence')
async def acquire_goal_evidence(request: Request):
    cancelled = Event()
    watcher = None
    try:
        payload = await _body(request)
        if type(payload) is not dict or set(payload) != {'release_group_id'}:
            raise GoalsError('invalid_command', 400)
        context, constraints = _context(request, WRITE)
        watcher = asyncio.create_task(_watch_disconnect(request, cancelled))
        value = await run_in_threadpool(_service(request).acquire_evidence, context,
            payload['release_group_id'], constraints=constraints, should_cancel=cancelled.is_set)
        return _response(value)
    except GoalsError as error:
        return _error(error)
    finally:
        cancelled.set()
        if watcher is not None:
            watcher.cancel()
            with suppress(asyncio.CancelledError):
                await watcher


async def _execute(request, action):
    try:
        command = normalize_goal_command(action, await _body(request))
        context, constraints = _context(request, WRITE)
        value = await run_in_threadpool(_service(request).execute, context, command, constraints=constraints)
        return _response(value)
    except GoalsError as error:
        return _error(error)


@router.post('/account/goals/add')
async def add_goal(request: Request):
    return await _execute(request, 'add')


@router.post('/account/goals/reset')
async def reset_goal(request: Request):
    return await _execute(request, 'reset')
