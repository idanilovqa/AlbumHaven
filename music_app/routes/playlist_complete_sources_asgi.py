"""Bounded server-confirmed selections for the existing complete Create flow."""
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.routes.owned_playlists_asgi import _context, _service, _response, _error, _require_context_header
from music_app.services.owned_playlists import CREATE, COMPLETE_INVENTORY_PROTOCOL, MAX_PLAYLIST_COMMAND_BYTES, PlaylistError
from music_app.services.playlist_complete_sources import CompletePlaylistSources

router=APIRouter()


@router.post("/playlists/creation-source/selection")
async def playlist_selected_inventory_source(request: Request):
    try:
        context,constraints=_context(request,CREATE)
        _require_context_header(request)
        payload=await read_bounded_json_object(request,max_bytes=MAX_PLAYLIST_COMMAND_BYTES)
        if not isinstance(payload,dict) or set(payload)!={"track_refs"}:
            raise PlaylistError("invalid_command")
        source=CompletePlaylistSources(playlists=_service(request))
        result=await run_in_threadpool(source.from_inventory,context,payload["track_refs"],constraints=constraints)
        return _response(request,result)
    except JSONBodyTooLarge:
        return _error(PlaylistError("command_too_large",413))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/creation-source/complete")
def playlist_complete_source(request: Request):
    try:
        if (set(request.query_params)-{"source_ref","source_revision","source_protocol"}
                or not {"source_ref","source_revision"}<=set(request.query_params)):
            raise PlaylistError("invalid_source_query")
        context,constraints=_context(request,CREATE)
        source=CompletePlaylistSources(playlists=_service(request))
        result=source.read(context,ref=request.query_params["source_ref"],
            revision=request.query_params["source_revision"],protocol=request.query_params.get("source_protocol",COMPLETE_INVENTORY_PROTOCOL),constraints=constraints)
        return _response(request,result)
    except PlaylistError as error:
        return _error(error)


@router.post("/playlists/creation-source/activity")
async def playlist_activity_selection_source(request: Request):
    try:
        context,constraints=_context(request,CREATE)
        _require_context_header(request)
        payload=await read_bounded_json_object(request,max_bytes=MAX_PLAYLIST_COMMAND_BYTES)
        if not isinstance(payload,dict) or set(payload)!={"origin","row_refs"}:
            raise PlaylistError("invalid_command")
        source=CompletePlaylistSources(playlists=_service(request))
        result=await run_in_threadpool(source.from_activity,context,payload["origin"],payload["row_refs"],constraints=constraints)
        return _response(request,result)
    except JSONBodyTooLarge:
        return _error(PlaylistError("command_too_large",413))
    except PlaylistError as error:
        return _error(error)


@router.get("/playlists/{playlist_ref}/missing-source")
def playlist_missing_source(request: Request, playlist_ref: str):
    try:
        context,constraints=_context(request,CREATE)
        _require_context_header(request)
        if set(request.query_params) not in ({"revision"},{"revision","capture_ref"}):
            raise PlaylistError("invalid_source_query")
        from music_app.services.playlist_missing_sources import inspect,read_capture
        if 'capture_ref' in request.query_params:
            result=read_capture(_service(request),context,playlist_ref,request.query_params['revision'],
                request.query_params['capture_ref'],constraints=constraints)
        else:
            result=inspect(_service(request),context,playlist_ref,request.query_params['revision'],constraints=constraints)
        return _response(request,result)
    except PlaylistError as error:
        return _error(error)


async def _match(request, *, accept=False):
    from music_app.services import playlist_local_matches as matches
    try:
        context,constraints=_context(request,CREATE)
        _require_context_header(request)
        if request.query_params:raise PlaylistError('invalid_command')
        payload=await read_bounded_json_object(request,max_bytes=matches.MATCH_BODY_BYTES)
        payload=matches.normalize_request(payload,accept=accept)
        action=matches.accept if accept else matches.review
        result=await run_in_threadpool(action,_service(request),context,payload,constraints=constraints)
        return _response(request,result)
    except JSONBodyTooLarge:
        return _error(PlaylistError('command_too_large',413))
    except PlaylistError as error:
        return _error(error)


@router.post('/playlists/creation-source/match-candidates')
async def playlist_match_candidates(request: Request):
    return await _match(request)


@router.post('/playlists/creation-source/accept-match')
async def playlist_accept_match(request: Request):
    return await _match(request,accept=True)
