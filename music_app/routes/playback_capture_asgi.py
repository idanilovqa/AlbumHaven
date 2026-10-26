"""Private, bounded checkpoint transport for app-reported consumption."""
import hmac
import json
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


def _top_presentation_enabled(request):
    config=getattr(request.app.state,'config',{})
    if not isinstance(config,Mapping) or config.get('ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED') is not True:
        raise CaptureError('capture_unavailable',503)


async def _top_listening_authority(request):
    # This combined projection is a Top browse operation, not a playback grant.
    # The measured component separately rechecks MEDIA inside its transaction.
    await require_action('library.browse.read', refresh_actor=True)(request)
    actor=request.state.current_actor
    context=PolicyContext.build(actor=actor,action='library.browse.read',library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    resolver=getattr(request.app.state,'policy_constraint_resolver',None)
    if resolver is not None and not callable(resolver):raise RuntimeError('Invalid policy resolver.')
    config=getattr(request.app.state,'config',{})
    url=config.get('ALBUM_HAVEN_APP_DATABASE_URL') if isinstance(config,Mapping) else None
    if not isinstance(url,str) or not url.strip():raise CaptureError('capture_unavailable',503)
    return context,resolver,url,capture_scope(context,getattr(request.app.state,'auth_policy_config',{}))


async def _top_listening(request, *, advance):
    from music_app.services.album_top_current_listening import PostgresTopCurrentListening
    from music_app.services.owned_album_tops import AlbumTopError
    from music_app.services.private_ui_context import private_ui_context_ref
    try:
        _top_presentation_enabled(request)
        context,constraints,database_url,scope=await _top_listening_authority(request)
        marker=private_ui_context_ref(request)
        supplied=request.headers.getlist('x-albumhaven-context')
        if (type(marker) is not str or len(marker)!=64 or len(supplied)!=1
            or not supplied[0].isascii() or not hmac.compare_digest(marker,supplied[0])):
            raise CaptureError('capture_scope_changed',409)
        if advance:
            if request.query_params:raise CaptureError('invalid_top_metrics',422)
            body=bytearray()
            async for chunk in request.stream():
                if len(body)+len(chunk)>2048:raise CaptureError('capture_too_large',413)
                body.extend(chunk)
            def unique(pairs):
                result={}
                for key,value in pairs:
                    if key in result:raise ValueError('duplicate')
                    result[key]=value
                return result
            try:value=json.loads(body,object_pairs_hook=unique)
            except (ValueError,UnicodeError):raise CaptureError('invalid_top_metrics',422)
            if type(value) is not dict or set(value)!={'top_ref','top_revision','item_ref','state_revision'}:
                raise CaptureError('invalid_top_metrics',422)
            revision=value['state_revision']
            if (type(revision) is not str or not revision.isascii() or not revision.isdecimal()
                or len(revision)>16 or str(int(revision))!=revision):
                raise CaptureError('invalid_top_metrics',422)
            revision=int(revision);refs=[value['item_ref']]
        else:
            if len(request.scope.get('query_string',b''))>1024:raise CaptureError('invalid_top_metrics',422)
            pairs=list(request.query_params.multi_items())
            if not 3<=len(pairs)<=6 or any(key not in {'top_ref','top_revision','item_ref'} for key,_ in pairs):
                raise CaptureError('invalid_top_metrics',422)
            if any(sum(key==wanted for key,_ in pairs)!=1 for wanted in ('top_ref','top_revision')):
                raise CaptureError('invalid_top_metrics',422)
            async for chunk in request.stream():
                if chunk:raise CaptureError('invalid_top_metrics',422)
            value=dict(pairs);refs=[v for k,v in pairs if k=='item_ref'];revision=None
        service=PostgresTopCurrentListening(request.app.state.config)
        enabled=lambda: (request.app.state.config.get('ALBUM_HAVEN_TOP_LISTENING_PRESENTATION_ENABLED') is True
            and private_ui_context_ref(request)==marker)
        result=await run_in_threadpool(service.project,context,top_ref=value['top_ref'],
            top_revision=value['top_revision'],item_refs=refs,advance=revision,constraints=constraints,enabled=enabled)
        _top_presentation_enabled(request)
        _context,_constraints,_url,fresh_scope=await _top_listening_authority(request)
        if fresh_scope!=scope or private_ui_context_ref(request)!=marker:
            raise CaptureError('capture_scope_changed',409)
        return JSONResponse(dict(result,context_ref=marker),headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code==401 else 'capture_forbidden',error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden',403)
    except AlbumTopError as error:
        return _error(error.code,error.status_code)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)


@router.get('/playback/capture/position/top-metrics')
async def playback_top_metrics(request: Request):
    return await _top_listening(request,advance=False)


@router.post('/playback/capture/position/top-metrics/advance')
async def playback_top_metrics_advance(request: Request):
    return await _top_listening(request,advance=True)


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


@router.post('/playback/capture/album-selection')
async def playback_album_selection(request: Request):
    """Bounded explicit play intent; existing private perimeter supplies CSRF."""
    try:
        context, constraints, database_url, _scope = await _authority(request)
        from music_app.services.private_ui_context import private_ui_context_ref
        marker = private_ui_context_ref(request)
        supplied = request.headers.getlist('x-albumhaven-context')
        if (type(marker) is not str or len(marker) != 64 or len(supplied) != 1
                or not supplied[0].isascii() or not hmac.compare_digest(marker, supplied[0])):
            raise CaptureError('capture_scope_changed', 409)
        if request.query_params:
            raise CaptureError('invalid_album_selection', 422)
        body = bytearray()
        async for chunk in request.stream():
            if len(body) + len(chunk) > 8192:
                raise CaptureError('capture_too_large', 413)
            body.extend(chunk)
        def pairs(values):
            result = {}
            for key, value in values:
                if key in result:
                    raise ValueError('duplicate key')
                result[key] = value
            return result
        try:
            value = json.loads(body, object_pairs_hook=pairs)
        except (ValueError, UnicodeError):
            raise CaptureError('invalid_album_selection', 422) from None
        if type(value) is not dict or set(value) != {'album_key'}:
            raise CaptureError('invalid_album_selection', 422)
        config = getattr(request.app.state, 'config', {})
        from music_app.services.playback_edition_selection import record_album_selection
        result = await run_in_threadpool(record_album_selection, database_url, context, value['album_key'],
            enabled=isinstance(config, Mapping) and config.get('ALBUM_HAVEN_LISTENING_SELECTIONS_ENABLED') is True,
            constraints=constraints)
        # Refresh the same current authority after the worker, then recompute the
        # server-owned UI marker. Never echo a client marker as proof.
        _context, _constraints, _database_url, fresh_scope = await _authority(request)
        if fresh_scope != _scope or private_ui_context_ref(request) != marker:
            raise CaptureError('capture_scope_changed', 409)
        return JSONResponse(dict(result, context_ref=marker), headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code == 401 else 'capture_forbidden', error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden', 403)
    except CaptureError as error:
        return _error(error.code, error.status)
    except Exception:
        return _error('capture_unavailable', 503)


def _position_enabled(request):
    config = getattr(request.app.state, 'config', {})
    if not isinstance(config, Mapping) or config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True:
        raise CaptureError('capture_unavailable', 503)
    return config


@router.get('/playback/capture/position/context')
async def playback_position_context(request: Request):
    try:
        context, constraints, database_url, scope = await _authority(request)
        config = _position_enabled(request)
        if request.query_params:
            raise CaptureError()
        from music_app.services.playback_position_transport import check_position_capture_context
        from music_app.services.playback_capture import POSITION_PROTOCOL
        capabilities = await run_in_threadpool(check_position_capture_context,database_url,context,
            constraints=constraints,selections=config.get('ALBUM_HAVEN_LISTENING_SELECTIONS_ENABLED') is True,include_observations=True)
        # Recheck the gate after async storage/current-authority work.
        _position_enabled(request)
        return JSONResponse(dict(ok=True,protocol=PROTOCOL,expected_scope=scope,source_rate=48000,
            output_rate=48000,supported_protocols=[POSITION_PROTOCOL],
            listening_selections_available=capabilities['selections'],
            decoded_observations_available=capabilities['observations']),headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code == 401 else 'capture_forbidden', error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden',403)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)


@router.post('/playback/capture/position/checkpoint')
async def playback_position_checkpoint(request: Request):
    try:
        context, constraints, database_url, scope = await _authority(request)
        _position_enabled(request)
        supplied = request.headers.get('x-playback-capture-scope','')
        if len(supplied)!=len(scope) or not supplied.isascii() or not hmac.compare_digest(supplied,scope):
            raise CaptureError('capture_scope_changed',409)
        if request.query_params:
            raise CaptureError()
        body=bytearray()
        async for chunk in request.stream():
            if len(body)+len(chunk)>BODY_LIMIT:
                raise CaptureError('capture_too_large',413)
            body.extend(chunk)
        _position_enabled(request)
        from music_app.services.playback_position_transport import parse_position_capture_body
        from music_app.services.playback_capture_postgres import _record_position_checkpoint
        envelope=parse_position_capture_body(body)
        result=await run_in_threadpool(_record_position_checkpoint,database_url,context,envelope,
            expected_scope=scope,constraints=constraints,require_position_storage_ready=True,
            position_enabled=lambda: _position_enabled(request) is not None)
        return JSONResponse(result,headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code == 401 else 'capture_forbidden',error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden',403)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)


@router.get('/playback/capture/position/album-metrics')
async def playback_local_album_metrics(request: Request):
    """One body-free, own-account Album Details read; no selection persistence."""
    try:
        _position_enabled(request)
        context,constraints,database_url,scope=await _authority(request)
        from music_app.services.private_ui_context import private_ui_context_ref
        marker=private_ui_context_ref(request)
        supplied=request.headers.getlist('x-albumhaven-context')
        if (type(marker) is not str or len(marker)!=64 or len(supplied)!=1
                or not supplied[0].isascii() or not hmac.compare_digest(marker,supplied[0])):
            raise CaptureError('capture_scope_changed',409)
        items=list(request.query_params.multi_items())
        if len(items)!=1 or items[0][0]!='album_key' or len(items[0][1].encode('utf-8'))>1024:
            raise CaptureError('invalid_album_key',422)
        async for chunk in request.stream():
            if chunk:raise CaptureError('invalid_album_key',422)
        from music_app.services.local_album_listening import read_local_album_metrics
        result=await run_in_threadpool(read_local_album_metrics,database_url,context,items[0][1],constraints=constraints)
        _position_enabled(request)
        _context,_constraints,_database_url,fresh_scope=await _authority(request)
        if fresh_scope!=scope or private_ui_context_ref(request)!=marker:
            raise CaptureError('capture_scope_changed',409)
        return JSONResponse(dict(result,context_ref=marker),headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code==401 else 'capture_forbidden',error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden',403)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)


@router.post('/playback/capture/position/album-metrics/advance')
async def playback_local_album_metrics_advance(request: Request):
    """One idempotent page of derived work, under existing private CSRF policy."""
    try:
        _position_enabled(request)
        context,constraints,database_url,scope=await _authority(request)
        from music_app.services.private_ui_context import private_ui_context_ref
        marker=private_ui_context_ref(request)
        supplied=request.headers.getlist('x-albumhaven-context')
        if (type(marker) is not str or len(marker)!=64 or len(supplied)!=1
                or not supplied[0].isascii() or not hmac.compare_digest(marker,supplied[0])):
            raise CaptureError('capture_scope_changed',409)
        if request.query_params:raise CaptureError('invalid_album_key',422)
        body=bytearray()
        async for chunk in request.stream():
            if len(body)+len(chunk)>2048:raise CaptureError('capture_too_large',413)
            body.extend(chunk)
        try:value=json.loads(body)
        except (ValueError,UnicodeError):raise CaptureError('invalid_album_key',422)
        if (type(value) is not dict or set(value)!={'album_key','state_revision'}
            or type(value['state_revision']) is not str or not value['state_revision'].isascii()
            or not value['state_revision'].isdigit() or len(value['state_revision'])>16):
            raise CaptureError('invalid_album_key',422)
        revision=int(value['state_revision'])
        if str(revision)!=value['state_revision']:raise CaptureError('invalid_album_key',422)
        from music_app.services.local_album_full_state import advance_local_album_full
        result=await run_in_threadpool(advance_local_album_full,database_url,context,value['album_key'],revision,constraints=constraints,
            enabled=lambda:(_position_enabled(request).get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is True
                and private_ui_context_ref(request)==marker))
        _position_enabled(request)
        _context,_constraints,_database_url,fresh_scope=await _authority(request)
        if fresh_scope!=scope or private_ui_context_ref(request)!=marker:raise CaptureError('capture_scope_changed',409)
        return JSONResponse(dict(result,context_ref=marker),headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code==401 else 'capture_forbidden',error.status_code)
    except PrivateLibraryAuthorityError:
        return _error('capture_forbidden',403)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)


@router.get('/playback/capture/account/history')
async def account_capture_history(request: Request):
    """Default-off personal raw evidence; no current-library or MEDIA grant."""
    from music_app.services.capture_history_authority import require_account_capture_history_read
    from music_app.services.capture_history_reader import read_account_capture_history
    from music_app.services.capture_history_ui_context import (
        capture_history_account_ui_context_ref, CAPTURE_HISTORY_ACCOUNT_CONTEXT_SCOPE)
    try:
        config=getattr(request.app.state,'config',{})
        if not isinstance(config,Mapping) or config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True:
            raise CaptureError('capture_unavailable',503)
        async def authorize():
            await require_action('account.self.capture.history.read',refresh_actor=True)(request)
            actor=request.state.current_actor
            context=PolicyContext.build(actor=actor,action='account.self.capture.history.read',
                target_account_id=actor.account_id,library_id=None,
                deployment_mode=_deployment_mode(request),request_origin=_request_origin(request),
                client_surface_class=client_surface_from_request(request))
            resolver=getattr(request.app.state,'policy_constraint_resolver',None)
            if resolver is not None and not callable(resolver):raise CaptureError('capture_unavailable',503)
            require_account_capture_history_read(context,resolver)
            return context,resolver,capture_history_account_ui_context_ref(request)
        context,constraints,marker=await authorize()
        pairs=list(request.query_params.multi_items())
        if len(pairs)>2 or len({k for k,v in pairs})!=len(pairs):raise CaptureError()
        values=dict(pairs)
        if not set(values)<={'after_session_id','session_id','after_sequence'}:raise CaptureError()
        def number(key,default=0):
            value=values.get(key,str(default))
            if not value.isascii() or not value.isdecimal() or len(value)>19 or str(int(value))!=value:
                raise CaptureError()
            return int(value)
        kwargs=dict(after_session_id=number('after_session_id'),after_sequence=number('after_sequence'),
            session_id=number('session_id') if 'session_id' in values else None)
        database_url=config.get('ALBUM_HAVEN_APP_DATABASE_URL')
        if not isinstance(database_url,str) or not database_url.strip():raise CaptureError('capture_unavailable',503)
        result=await run_in_threadpool(read_account_capture_history,database_url,context,
            constraints=constraints,**kwargs)
        fresh,_constraints,fresh_marker=await authorize()
        if marker!=fresh_marker or (fresh.actor.account_id,fresh.actor.session_id)!=(context.actor.account_id,context.actor.session_id):
            raise CaptureError('capture_scope_changed',409)
        if request.app.state.config.get('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED') is not True:
            raise CaptureError('capture_unavailable',503)
        return JSONResponse(dict(result,context_ref=marker,context_scope=CAPTURE_HISTORY_ACCOUNT_CONTEXT_SCOPE),headers=_HEADERS)
    except HTTPException as error:
        return _error('authentication_required' if error.status_code==401 else 'capture_forbidden',error.status_code)
    except CaptureError as error:
        return _error(error.code,error.status)
    except Exception:
        return _error('capture_unavailable',503)
