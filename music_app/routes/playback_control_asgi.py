"""Authenticated, bounded playback references and ownership contracts."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.playback_references import PlaybackContractError, PlaybackReferenceService
from music_app.services.playback_claims_postgres import PostgresPlaybackClaims


router = APIRouter()


def playback_config(request):
    return {**request.app.state.config, **request.app.state.auth_policy_config}


async def playback_call(function, *args, **kwargs):
    try:
        return await run_in_threadpool(function, *args, **kwargs)
    except PlaybackContractError as error:
        raise HTTPException(error.status_code, str(error)) from None


async def playback_payload(request: Request) -> dict:
    try:
        payload = await read_bounded_json_object(request)
    except JSONBodyTooLarge:
        raise HTTPException(413, "Playback request is too large.") from None
    if not payload or type(payload.get("protocol")) is not int or payload["protocol"] != 1:
        raise HTTPException(400, "Invalid playback request.")
    return payload


@router.post("/playback/refs")
async def playback_refs(request: Request) -> JSONResponse:
    payload = await playback_payload(request)
    tracks = payload.get("tracks")
    if not isinstance(tracks, list) or not 1 <= len(tracks) <= 100:
        raise HTTPException(400, "Invalid playback reference batch.")
    service = PlaybackReferenceService(playback_config(request))
    result = await playback_call(service.issue_batch, request.state.current_actor, tracks)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.get("/playback/state")
async def playback_state(request: Request, client_id: str = ""):
    result = await playback_call(PostgresPlaybackClaims(playback_config(request)).get,
        request.state.current_actor, client_id)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.put("/playback/state")
async def acquire_playback(request: Request):
    payload = await playback_payload(request)
    if payload.get("state") != "playing":
        raise HTTPException(400, "Invalid playback state.")
    result = await playback_call(PostgresPlaybackClaims(playback_config(request)).acquire,
        request.state.current_actor, client_id=payload.get("clientId"),
        client_surface=payload.get("clientSurface"), track=payload.get("track"),
        claim_token=payload.get("claimToken"))
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.delete("/playback/state")
async def release_playback(request: Request):
    payload = await playback_payload(request)
    await playback_call(PostgresPlaybackClaims(playback_config(request)).release,
        request.state.current_actor, client_id=payload.get("clientId"), claim_token=payload.get("claimToken"))
    return JSONResponse({"protocol": 1}, headers={"Cache-Control": "no-store"})


async def require_playback_claim(request, payload):
    await playback_call(PostgresPlaybackClaims(playback_config(request)).require_claim,
        request.state.current_actor, client_id=payload.get("clientId"), claim_token=payload.get("claimToken"))
