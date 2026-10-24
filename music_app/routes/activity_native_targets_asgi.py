"""Resolve exact receipt rows through native owners without exposing path DTOs to React."""
import hmac
import re

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.activity_native_targets import ActivityNativeTargets
from music_app.services.activity_native_targets import normalize_native_origin
from music_app.services.recent_scrobble_retry import RecentScrobbleRetry
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.home_activity import HomeActivityError
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_native_targets import NativeTargetError
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError

router=APIRouter()
_HEADERS={'Cache-Control':'private, no-store'}
_RETRY_HEADERS={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}
_RECENT_ROW=re.compile(r'activity_[a-f0-9]{64}\Z', re.ASCII)
_RETRY_RESULTS=frozenset({'attempted','not_submitted','retry_blocked','connection_unavailable','claim_changed'})


def native_activity_context(request):
    actor=request.state.current_actor
    context=PolicyContext.build(actor=actor,action='library.browse.read',library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver=getattr(request.app.state,'policy_constraint_resolver',None)
    return context,resolver if callable(resolver) else PolicyEvaluationConstraints()


@router.post('/home/activity/native-target')
async def activity_native_target(request:Request):
    try:
        context,constraints=native_activity_context(request)
        current=private_ui_context_ref(request)
        supplied=request.headers.get('x-albumhaven-context','')
        if current is None:raise NativeTargetError('forbidden',403)
        if len(supplied)!=64 or not supplied.isascii() or not hmac.compare_digest(supplied,current):
            raise NativeTargetError('stale_context',409)
        payload=await read_bounded_json_object(request)
        if not isinstance(payload,dict) or set(payload) not in ({'origin','row_ref','intent'},{'origin','row_ref','intent','target_kind'}):
            raise NativeTargetError('invalid_command',422)
        if 'target_kind' in payload and (not isinstance(payload['target_kind'],str) or payload['target_kind'] not in {'album','artist'} or payload['intent']!='details'):
            raise NativeTargetError('invalid_command',422)
        result=await run_in_threadpool(ActivityNativeTargets(request.app.state.config).resolve,context,
            origin=payload['origin'],row_ref=payload['row_ref'],intent=payload['intent'],target_kind=payload.get('target_kind'),constraints=constraints)
        return JSONResponse(jsonable_encoder({'status':'ready','data':result,'context_ref':current}),headers=_HEADERS)
    except JSONBodyTooLarge:
        return JSONResponse({'error':'command_too_large'},status_code=413,headers=_HEADERS)
    except PrivateLibraryAuthorityError:
        return JSONResponse({'error':'forbidden'},status_code=403,headers=_HEADERS)
    except (NativeTargetError,HomeActivityError,PrivateUIContextError) as error:
        return JSONResponse({'error':error.code},status_code=error.status_code,headers=_HEADERS)
    except Exception:
        return JSONResponse({'error':'native_target_unavailable'},status_code=503,headers=_HEADERS)


@router.post('/home/activity/scrobbles/retry')
async def recent_scrobble_retry(request:Request):
    """Retry one opaque own occurrence; never reconcile or batch-submit."""
    def failure(code, status):
        # A transport/handler failure may follow a committed claim/provider
        # attempt. Never imply not_sent, retryable, or attempted=False here.
        return JSONResponse({'error':code,'refresh_required':True},
            status_code=status,headers=_RETRY_HEADERS)
    try:
        context,constraints=native_activity_context(request)
        current=private_ui_context_ref(request)
        supplied=request.headers.get('x-albumhaven-context','')
        if current is None:
            return failure('forbidden',403)
        if len(supplied)!=64 or not supplied.isascii() or not hmac.compare_digest(supplied,current):
            return failure('stale_context',409)
        if request.query_params:
            return failure('invalid_command',422)
        payload=await read_bounded_json_object(request,max_bytes=2048)
        if not isinstance(payload,dict) or set(payload)!={'origin','row_ref'}:
            return failure('invalid_command',422)
        if type(payload['row_ref']) is not str or not _RECENT_ROW.fullmatch(payload['row_ref']):
            return failure('invalid_command',422)
        origin,query=normalize_native_origin(payload['origin'])
        if origin['audience']!='own' or query.kind!='listens':
            return failure('invalid_command',422)
        result=await run_in_threadpool(RecentScrobbleRetry(request.app.state.config).submit,
            context,origin=origin,row_ref=payload['row_ref'],constraints=constraints)
        actor=request.state.current_actor
        if (private_ui_context_ref(request)!=current
                or (actor.account_id,actor.session_id,actor.current_library_id)
                !=(context.actor.account_id,context.actor.session_id,context.library_id)):
            return failure('stale_context',409)
        if (not isinstance(result,dict) or type(result.get('attempted')) is not bool
                or type(result.get('result')) is not str or result['result'] not in _RETRY_RESULTS
                or (result['result']=='attempted') is not result['attempted']):
            return failure('scrobble_outcome_unconfirmed',503)
        # Never publish the sender's possibly stale local delivery state.
        # The next fresh Home snapshot owns that closed delivery DTO.
        return JSONResponse({'status':'ready','data':{
            'attempted':result['attempted'],'result':result['result']},
            'context_ref':current,'refresh_required':True},headers=_RETRY_HEADERS)
    except JSONBodyTooLarge:
        return failure('command_too_large',413)
    except PrivateLibraryAuthorityError:
        return failure('forbidden',403)
    except (NativeTargetError,HomeActivityError,PrivateUIContextError) as error:
        code,status={403:('forbidden',403),409:('occurrence_unavailable',409),
            410:('occurrence_unavailable',410),422:('invalid_command',422)}.get(
                error.status_code,('scrobble_outcome_unconfirmed',503))
        return failure(code,status)
    except Exception:
        return failure('scrobble_outcome_unconfirmed',503)
