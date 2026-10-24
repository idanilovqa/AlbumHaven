"""Default-off bounded Last.fm import/read endpoints, separate from sends."""
import hmac

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from .activity_native_targets_asgi import native_activity_context
from .bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.allowed_actions import AllowedActions
from music_app.services.home_activity import HomeActivityError
from music_app.services.lastfm import LastfmError
from music_app.services.lastfm_history_import import LastfmHistoryImport
from music_app.services.lastfm_history_model import HistoryStale, HistoryUnavailable
from music_app.services.policy import ResourceScope
from music_app.services.private_native_targets import allows
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError

router = APIRouter()
_HEADERS = {'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}


def _failure(code,status):
    return JSONResponse({'error':code,'refresh_required':True},status_code=status,headers=_HEADERS)


async def _history_request(request, *, combined):
    try:
        if request.app.state.config.get('LASTFM_HISTORY_IMPORT_ENABLED') is not True:
            return _failure('lastfm_history_unavailable',503)
        context,constraints = native_activity_context(request)
        continuity = private_ui_context_ref(request)
        supplied = request.headers.get('x-albumhaven-context','')
        if continuity is None:
            return _failure('forbidden',403)
        if len(supplied)!=64 or not supplied.isascii() or not hmac.compare_digest(supplied,continuity):
            return _failure('stale_context',409)
        if request.query_params:
            return _failure('invalid_command',422)
        payload = await read_bounded_json_object(request,max_bytes=2048)
        if type(payload) is not dict:
            return _failure('invalid_command',422)
        service = LastfmHistoryImport(request.app.state.config)
        if combined:
            if set(payload)!={'range_start','range_end'}:
                return _failure('invalid_command',422)
            def allowed(kind,identity):
                granted = allows(context,'library.browse.read',ResourceScope(kind,str(identity)),constraints)
                return AllowedActions(('library.browse.read',) if granted else ())
            result = await run_in_threadpool(service.combined,context,**payload,
                allowed_actions_for_resource=allowed,constraints=constraints)
        elif set(payload)=={'command'} and payload['command'] in {'backfill_begin','backfill_pending'}:
            from music_app.services.lastfm_history_backfill import LastfmHistoryBackfill
            backfill=LastfmHistoryBackfill(request.app.state.config)
            operation=backfill.begin if payload['command']=='backfill_begin' else backfill.pending
            result=await run_in_threadpool(operation,context,constraints=constraints)
        elif set(payload)=={'command','plan','revision'} and payload['command'] in {
                'backfill_advance','backfill_pause','backfill_resume'}:
            from music_app.services.lastfm_history_backfill import LastfmHistoryBackfill
            backfill=LastfmHistoryBackfill(request.app.state.config)
            operation={'backfill_advance':backfill.advance,'backfill_pause':backfill.pause,
                'backfill_resume':backfill.resume}[payload['command']]
            result=await run_in_threadpool(operation,context,plan=payload['plan'],
                revision=payload['revision'],constraints=constraints)
        elif set(payload)=={'command','range_start','range_end'} and payload['command']=='begin':
            result = await run_in_threadpool(service.begin,context,range_start=payload['range_start'],
                range_end=payload['range_end'],constraints=constraints)
        elif set(payload)=={'command','generation','page'} and payload['command']=='advance':
            result = await run_in_threadpool(service.advance,context,generation=payload['generation'],
                page=payload['page'],constraints=constraints)
        elif set(payload)=={'command'} and payload['command']=='pending':
            result = await run_in_threadpool(service.pending,context,constraints=constraints)
        elif set(payload)=={'command','generation'} and payload['command']=='abandon':
            result = await run_in_threadpool(service.abandon,context,generation=payload['generation'],
                constraints=constraints)
        else:
            return _failure('invalid_command',422)
        actor = request.state.current_actor
        if (private_ui_context_ref(request)!=continuity
                or (actor.account_id,actor.session_id,actor.current_library_id)
                !=(context.actor.account_id,context.actor.session_id,context.library_id)):
            return _failure('stale_context',409)
        return JSONResponse({'status':'ready','data':result,'context_ref':continuity},headers=_HEADERS)
    except JSONBodyTooLarge:
        return _failure('command_too_large',413)
    except HistoryStale:
        return _failure('lastfm_history_changed',409)
    except (HomeActivityError,PrivateUIContextError) as error:
        return _failure('forbidden' if error.status_code==403 else 'lastfm_history_changed',
            403 if error.status_code==403 else 409)
    except (HistoryUnavailable,LastfmError):
        return _failure('lastfm_history_unavailable',503)
    except Exception:
        return _failure('lastfm_history_unavailable',503)


@router.post('/home/activity/lastfm/import')
async def lastfm_history_import(request:Request):
    return await _history_request(request,combined=False)


@router.post('/home/activity/lastfm/combined')
async def lastfm_history_combined(request:Request):
    return await _history_request(request,combined=True)
