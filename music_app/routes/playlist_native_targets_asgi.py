"""Native-only target read; media and Album Details keep their existing owners."""
from fastapi import APIRouter, Request

from music_app.routes.owned_playlists_asgi import _context, _service, _response, _error, _require_context_header
from music_app.services.owned_playlists import BROWSE, PlaylistError
from music_app.services.playlist_native_targets import PlaylistNativeTargets

router = APIRouter()


@router.get("/playlists/{playlist_ref}/items/{item_ref}/native-target")
def playlist_native_target(request: Request, playlist_ref: str, item_ref: str):
    try:
        if set(request.query_params) != {"intent"}:
            raise PlaylistError("invalid_command")
        context, constraints = _context(request, BROWSE)
        resolver = PlaylistNativeTargets(request.app.state.config, playlists=_service(request))
        result = resolver.resolve(context, playlist_ref=playlist_ref, item_ref=item_ref,
            intent=request.query_params["intent"], constraints=constraints)
        return _response(request, {"status": "ready", "data": result})
    except PlaylistError as error:
        return _error(error)


@router.post("/playlists/{playlist_ref}/native-queue")
async def playlist_native_queue(request: Request, playlist_ref: str):
    from starlette.concurrency import run_in_threadpool
    from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
    try:
        if request.query_params:raise PlaylistError('invalid_command')
        context,constraints=_context(request,BROWSE)
        _require_context_header(request)
        payload=await read_bounded_json_object(request,max_bytes=512*1024)
        if not isinstance(payload,dict) or set(payload)!={'revision','item_refs','starting_item_ref'}:
            raise PlaylistError('invalid_command')
        resolver=PlaylistNativeTargets(request.app.state.config,playlists=_service(request))
        result=await run_in_threadpool(resolver.queue,context,playlist_ref=playlist_ref,
            constraints=constraints,**payload)
        return _response(request,{'status':'ready','data':result})
    except JSONBodyTooLarge:
        return _error(PlaylistError('command_too_large',413))
    except PlaylistError as error:
        return _error(error)
