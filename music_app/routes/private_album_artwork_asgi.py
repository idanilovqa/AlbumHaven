"""Reuse the native image-only renderer behind current ID-scoped authority."""
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import Response

from music_app.routes.activity_native_targets_asgi import native_activity_context
from music_app.services.private_album_artwork import PrivateAlbumArtwork
from music_app.services.private_library_authority import PrivateLibraryAuthorityError
from music_app.services.private_native_targets import NativeTargetError

router=APIRouter()
_HEADERS={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}


@router.get('/library/album-artwork/{album_ref}')
async def private_album_artwork(request:Request,album_ref:str):
    try:
        if request.query_params:raise NativeTargetError('invalid_command',422)
        context,constraints=native_activity_context(request)
        return await run_in_threadpool(PrivateAlbumArtwork(request.app.state.config).read,
            context,album_ref,constraints=constraints)
    except PrivateLibraryAuthorityError:
        return Response(status_code=403,headers=_HEADERS)
    except (NativeTargetError,HTTPException) as error:
        return Response(status_code=error.status_code,headers=_HEADERS)
    except Exception:
        return Response(status_code=503,headers=_HEADERS)
