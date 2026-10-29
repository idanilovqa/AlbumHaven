"""Private recommendation transport on the existing session/CSRF boundary."""
import json
from fastapi import APIRouter, Request, Query, HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import read_bounded_json_object, JSONBodyTooLarge
from music_app.routes.owned_playlists_asgi import _context, _context_ref
from music_app.routes.owned_album_tops_asgi import _require_context
from music_app.routes.friends_asgi import get_friends
from music_app.services.friends_postgres import FriendScopeError
from music_app.services.owned_playlists import BROWSE, PlaylistError
from music_app.services.owned_album_tops import AlbumTopError
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.recommendations import RecommendationError
from music_app.services.recommendations_postgres import PostgresRecommendations

router = APIRouter()
_HEADERS = {'Cache-Control': 'private, no-store'}


def _service(request):
    configured = getattr(request.app.state, 'recommendations_service', None)
    return configured if configured is not None else PostgresRecommendations(request.app.state.config)


def _response(request, value):
    return JSONResponse({**value, 'context_ref': _context_ref(request)}, headers=_HEADERS)


def _error(error):
    if isinstance(error, (RecommendationError, PlaylistError, AlbumTopError)):
        code, status = error.code, error.status_code
    elif isinstance(error, (FriendScopeError, PrivateLibraryAuthorityError)):
        code, status = 'forbidden', 403
    else:
        code, status = 'recommendations_unavailable', 503
    return JSONResponse({'ok': False, 'error': code}, status_code=status, headers=_HEADERS)


@router.get('/recommendations/friends')
async def friends(request: Request, cursor: str | None = Query(None, max_length=4096)):
    # Preserve the existing signed cursor, account-resource policy and fresh
    # session boundary rather than exposing an independent account directory.
    try:
        response = await get_friends(request, mode='accepted', cursor=cursor, limit=100)
        value = json.loads(response.body)
        return _response(request, {'friends': [
            {'account_ref': row['account_ref'], 'display_name': row['display_name']}
            for row in value['members']], 'next_cursor': value['next_cursor']})
    except HTTPException as error:
        return JSONResponse({'ok': False, 'error': error.detail}, status_code=error.status_code, headers=_HEADERS)
    except Exception as error:
        return _error(error)


async def _write(request, manual):
    try:
        _require_context(request)
        context, constraints = _context(request, BROWSE)
        payload = await read_bounded_json_object(request, max_bytes=4096)
        value = await run_in_threadpool(_service(request).execute, context, payload,
                                       manual=manual, constraints=constraints)
        return _response(request, value)
    except JSONBodyTooLarge:
        return JSONResponse({'ok': False, 'error': 'request_too_large'}, status_code=413, headers=_HEADERS)
    except Exception as error:
        return _error(error)


@router.post('/recommendations')
async def recommend(request: Request):
    return await _write(request, False)


@router.post('/recommendations/manual')
async def add_manual(request: Request):
    return await _write(request, True)


@router.get('/recommendations/album/{album_id}')
async def album(request: Request, album_id: int):
    try:
        _context_ref(request)
        context, constraints = _context(request, BROWSE)
        value = await run_in_threadpool(_service(request).album_attributions, context, album_id, constraints=constraints)
        return _response(request, value)
    except Exception as error:
        return _error(error)
