"""Explicit duplicate trash/recovery transport behind the existing Delete action."""
import hmac
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.client_surfaces import client_surface_from_request
from music_app.services.policy import PolicyContext
from music_app.services.policy_asgi import _deployment_mode, _request_origin
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.duplicate_folder_recovery import DuplicateFolderRecovery, ACTION
from music_app.services.duplicate_folder_files import DuplicateFolderError

router = APIRouter()
_HEADERS = {'Cache-Control': 'private, no-store'}


def _scope(request):
    actor = getattr(request.state, 'current_actor', None)
    if actor is None:
        raise DuplicateFolderError('forbidden', 403)
    ref = private_ui_context_ref(request)
    values = [value.decode('latin1') for name, value in request.scope.get('headers', ())
              if name.lower() == b'x-albumhaven-context']
    if not ref or len(values) != 1 or not values[0].isascii() or len(values[0]) != 64 or not hmac.compare_digest(values[0], ref):
        raise DuplicateFolderError('stale_context')
    context = PolicyContext.build(actor=actor, action=ACTION, library_id=actor.current_library_id,
        deployment_mode=_deployment_mode(request), request_origin=_request_origin(request),
        client_surface_class=client_surface_from_request(request))
    return context, getattr(request.app.state, 'policy_constraint_resolver', None), ref


async def _dispatch(request, kind):
    admitted = False
    body = None
    try:
        context, constraints, ref = _scope(request)
        body = await read_bounded_json_object(request, max_bytes=4096)
        required = {'album_key', 'keep_id', 'remove_id'} if kind == 'preview' else (
            {'album_key', 'keep_id', 'remove_id', 'fingerprint', 'operation_id'} if kind == 'trash' else
            {'operation_id'} if kind in ('restore', 'reconcile') else {'album_key'})
        if not isinstance(body, dict) or set(body) != required:
            raise DuplicateFolderError('invalid_request', 400)
        if 'album_key' in body and (not isinstance(body['album_key'], str) or not 1 <= len(body['album_key']) <= 1024):
            raise DuplicateFolderError('invalid_request', 400)
        service = DuplicateFolderRecovery(request.app.state.config)
        admitted = True
        if kind == 'preview':
            data = await run_in_threadpool(service.preview, context, constraints, **body)
        elif kind == 'trash':
            data = await run_in_threadpool(service.trash, context, constraints, body)
        elif kind in ('restore', 'reconcile'):
            data = await run_in_threadpool(service.recover, context, constraints, body['operation_id'], restore=kind == 'restore')
        else:
            data = await run_in_threadpool(service.choices, context, constraints, body['album_key'])
        if kind in ('trash', 'restore', 'reconcile') and data.get('library_revision'):
            from music_app.services.state import invalidate_targeted_library_projections
            await run_in_threadpool(invalidate_targeted_library_projections,
                request.app.state.library_state, request.app.state.config,
                revision=data['library_revision'], affected_album_keys=(data['album_key'],))
        return JSONResponse({'data': data, 'context_ref': ref}, headers=_HEADERS)
    except JSONBodyTooLarge:
        return JSONResponse({'error': 'request_too_large'}, status_code=413, headers=_HEADERS)
    except (PrivateLibraryAuthorityError, PrivateUIContextError):
        return JSONResponse({'error': 'forbidden'}, status_code=403, headers=_HEADERS)
    except DuplicateFolderError as error:
        return JSONResponse({'error': error.code}, status_code=error.status, headers=_HEADERS)
    except (OSError, RuntimeError):
        # A failed response never asserts that a previously committed intent did
        # not move. The recovery list retains it for explicit reconciliation.
        return JSONResponse({'error': 'outcome_unconfirmed'}, status_code=503, headers=_HEADERS)
    finally:
        if admitted and kind in ('trash', 'restore', 'reconcile'):
            # A committed intent can precede an error response; do not leave a
            # previously cached playable projection authoritative in that case.
            from music_app.services.state import invalidate_targeted_library_projections
            await run_in_threadpool(invalidate_targeted_library_projections,
                request.app.state.library_state, request.app.state.config, revision=0,
                affected_album_keys=(body['album_key'],) if body.get('album_key') else ())



@router.post('/api/library/duplicate-folders/choices')
async def duplicate_choices(request: Request):
    return await _dispatch(request, 'choices')


@router.post('/api/library/duplicate-folders/preview')
async def duplicate_preview(request: Request):
    return await _dispatch(request, 'preview')


@router.post('/api/library/duplicate-folders/trash')
async def duplicate_trash(request: Request):
    return await _dispatch(request, 'trash')


@router.post('/api/library/duplicate-folders/reconcile')
async def duplicate_reconcile(request: Request):
    return await _dispatch(request, 'reconcile')


@router.post('/api/library/duplicate-folders/restore')
async def duplicate_restore(request: Request):
    return await _dispatch(request, 'restore')
