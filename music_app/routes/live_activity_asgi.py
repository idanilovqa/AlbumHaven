"""Private read-only social presence and current-owner publisher transport."""
import hmac

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.activity_native_targets_asgi import native_activity_context
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.friends_postgres import FriendScopeError
from music_app.services.home_activity import HomeActivityError
from music_app.services.live_activity_postgres import LiveActivityPostgres, PresenceError
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError

router=APIRouter()
_HEADERS={'Cache-Control':'private, no-store'}


def _failure(error):
    if isinstance(error,JSONBodyTooLarge):return JSONResponse({'error':'command_too_large'},status_code=413,headers=_HEADERS)
    if isinstance(error,(FriendScopeError,PrivateLibraryAuthorityError)):
        return JSONResponse({'error':'activity_denied'},status_code=403,headers=_HEADERS)
    if isinstance(error,(PresenceError,HomeActivityError,PrivateUIContextError)):
        return JSONResponse({'error':error.code},status_code=error.status_code,headers=_HEADERS)
    return JSONResponse({'error':'presence_unavailable'},status_code=503,headers=_HEADERS)


@router.get('/home/activity/now-playing')
async def now_playing(request:Request):
    try:
        await current_actor_from_request(request)
        if any(key!='subject_ref' for key in request.query_params) or len(request.query_params.getlist('subject_ref'))>1:
            raise PresenceError()
        context,constraints=native_activity_context(request)
        current=private_ui_context_ref(request)
        result=await run_in_threadpool(LiveActivityPostgres(request.app.state.config).read,context,
            subject_ref=request.query_params.get('subject_ref'),constraints=constraints)
        return JSONResponse({'status':'ready','data':result,'context_ref':current},headers=_HEADERS)
    except Exception as error:return _failure(error)


async def _publish(request,method):
    try:
        await current_actor_from_request(request)
        context,constraints=native_activity_context(request)
        current=private_ui_context_ref(request)
        supplied=request.headers.get('x-albumhaven-context','')
        if current is None or len(supplied)!=64 or not supplied.isascii() or not hmac.compare_digest(supplied,current):
            raise PresenceError('stale_context',409)
        payload=await read_bounded_json_object(request)
        service=LiveActivityPostgres(request.app.state.config)
        result=await run_in_threadpool(getattr(service,method),context,payload,constraints=constraints)
        return JSONResponse({'status':'ready','data':result,'context_ref':current},headers=_HEADERS)
    except Exception as error:return _failure(error)


@router.post('/playback/session/presence-source')
async def presence_source(request:Request):
    return await _publish(request,'source')


@router.post('/playback/session/presence')
async def presence_update(request:Request):
    return await _publish(request,'update')
