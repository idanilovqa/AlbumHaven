"""Authenticated, bounded playback references and ownership contracts."""

import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from music_app.routes.access_log_redaction import redact_access_log_paths
from music_app.routes.auth_asgi import _same_origin
from music_app.routes.bounded_json import JSONBodyTooLarge, read_bounded_json_object
from music_app.services.auth_session_csrf import matches_session_csrf
from music_app.services.capability_artwork import sanitized_artwork
from music_app.services.lastfm import get_saved_lastfm_session, lastfm_scrobbling_available, scrobble_track
from music_app.services.lastfm_sync_bridge import (
    persist_measured_playback_completion,
    prepare_handoff_completion,
    record_playback_session_complete,
)
from music_app.services.listen_history import (
    append_listen_history_entry,
    is_meaningful_listen_session,
    update_listen_history_entry,
)
from music_app.services.playback_references import PlaybackContractError, PlaybackReferenceService
from music_app.services.playback_claims_postgres import PostgresPlaybackClaims
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from music_app.services.policy_asgi import allowed_actions_for_request, require_action


router = APIRouter()
logger = logging.getLogger(__name__)
_SESSION_COOKIE = "__Host-album_haven_session"
_SCROBBLING_ACTIONS = ("integration.lastfm.now_playing", "integration.lastfm.scrobble")
_SCROBBLE_ACTION = "integration.lastfm.scrobble"
# The Android 13+ media card fills its width with the artwork; larger only costs bytes.
_NOTIFICATION_ARTWORK_EDGE = 768
ARTWORK_PREFIX = "/playback/artwork/"
# A resume token never expires, and its payload names library files.
redact_access_log_paths(ARTWORK_PREFIX)


def playback_config(request):
    return {**request.app.state.config, **request.app.state.auth_policy_config}


async def playback_call(function, *args, **kwargs):
    try:
        return await run_in_threadpool(function, *args, **kwargs)
    except PlaybackContractError as error:
        raise HTTPException(error.status_code, str(error)) from None


async def reference_call(request, call):
    """Runs ``call`` on a PlaybackReferenceService built inside the same guarded call, so a
    misconfigured reference key answers 503 instead of escaping as an unhandled error."""
    return await playback_call(lambda: call(PlaybackReferenceService(playback_config(request))))


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
    result = await reference_call(request, lambda service: service.issue_batch(request.state.current_actor, tracks))
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.post("/playback/refs/resume")
async def resume_playback_refs(request: Request) -> JSONResponse:
    """Fresh references for the resume tokens a native player persisted instead of references."""
    payload = await playback_payload(request)
    result = await reference_call(request, lambda service: service.exchange_resume_tokens(
        request.state.current_actor, payload.get("tracks")))
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.get(ARTWORK_PREFIX + "{resume_token}")
async def playback_artwork(request: Request, resume_token: str) -> Response:
    """A resume token's cover, re-encoded at media-notification size; no path in the URL or any answer."""
    path = await reference_call(request, lambda service: service.resolve_artwork(
        request.state.current_actor, resume_token))
    image = await run_in_threadpool(sanitized_artwork, path, max_edge=_NOTIFICATION_ARTWORK_EDGE, image_format="JPEG")
    # The token names a track, not an image revision, so a changed cover shows within the hour.
    return Response(image, media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


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
        claim_token=payload.get("claimToken"), handoff=payload.get("handoff"))
    scrobbling = await _scrobbling_status(request)
    return JSONResponse({**result, **scrobbling}, headers={"Cache-Control": "no-store"})


async def _scrobbling_status(request):
    """`scrobbling.available`: whether this claim's now-playing and scrobble writes can reach Last.fm.

    True only when the actor may send both, the Last.fm API is configured and the account holds a
    session; it reveals nothing else. Omitted when it cannot be read, so clients fall back to the
    writes' own `account_scoped_scrobble_unavailable` answer.
    """
    allowed = allowed_actions_for_request(request, _SCROBBLING_ACTIONS)
    if not all(allowed.allows(action) for action in _SCROBBLING_ACTIONS):
        return {"scrobbling": {"available": False}}
    try:
        available = await run_in_threadpool(lastfm_scrobbling_available, playback_config(request),
            account_id=request.state.current_actor.account_id)
    except Exception as error:
        logger.warning("Last.fm scrobbling availability could not be read for a playback claim (%s).",
            type(error).__name__)
        return {}
    return {"scrobbling": {"available": bool(available)}}


@router.post("/playback/state/handoff")
async def stage_playback_handoff(request: Request):
    payload = await playback_payload(request)
    config = playback_config(request)
    if (not _same_origin(request, config)
            or not matches_session_csrf(
                request.cookies.get(_SESSION_COOKIE), payload.get("csrf_token"), config
            )):
        raise HTTPException(400, "Invalid playback request.")
    handoff = payload.get("handoff")
    if not isinstance(handoff, dict) or set(handoff) != {"id", "token"}:
        raise HTTPException(400, "Invalid playback handoff.")
    if "completion" not in payload:
        raise HTTPException(400, "Invalid playback completion.")
    completion = payload.get("completion")
    if completion is not None:
        if (not isinstance(completion, dict)
                or completion.get("measurement_version") != "rendered-pcm-v1"
                or completion.get("finalized") is not True):
            raise HTTPException(400, "Invalid playback completion.")
        # Recording the listen is the same write as /playback/session/complete.
        await require_action("integration.lastfm.complete")(request)
    actor = request.state.current_actor
    try:
        entry, completion_digest = prepare_handoff_completion(
            completion,
            user_timezone="UTC",
            account_id=actor.account_id,
            library_id=actor.current_library_id,
            is_meaningful_listen_session=is_meaningful_listen_session,
        )
    except ValueError as error:
        raise HTTPException(getattr(error, "status_code", 400), str(error)) from None

    def persist_completion(connection, account_id, library_id):
        persist_measured_playback_completion(
            config, entry, account_id=account_id, library_id=library_id, connection=connection,
            append_listen_history_entry=append_listen_history_entry,
        )

    try:
        result = await playback_call(PostgresPlaybackClaims(config).stage_handoff,
            actor, client_id=payload.get("clientId"),
            claim_token=payload.get("claimToken"), handoff_id=handoff.get("id"),
            handoff_token=handoff.get("token"),
            completion_digest=completion_digest,
            persist_completion=persist_completion if entry is not None else None)
    except ValueError as error:
        raise HTTPException(getattr(error, "status_code", 400), "Invalid playback completion.") from None
    if entry is not None and allowed_actions_for_request(request, (_SCROBBLE_ACTION,)).allows(_SCROBBLE_ACTION):
        await _scrobble_staged_completion(config, completion, entry, actor)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


async def _scrobble_staged_completion(config, completion, entry, actor):
    """Submits a committed handoff listen to Last.fm; the handoff stays staged whatever happens.

    A failure leaves the stored listen marked as not yet scrobbled, for a later retry.
    """
    try:
        lastfm_session = await run_in_threadpool(get_saved_lastfm_session, config, account_id=actor.account_id)
        await run_in_threadpool(
            record_playback_session_complete,
            config,
            completion,
            account_id=actor.account_id,
            library_id=actor.current_library_id,
            lastfm_session=lastfm_session,
            user_timezone="UTC",
            normalize_playback_track_payload=normalize_playback_track_payload,
            is_meaningful_listen_session=is_meaningful_listen_session,
            append_listen_history_entry=append_listen_history_entry,
            update_listen_history_entry=update_listen_history_entry,
            scrobble_track=scrobble_track,
            log_lastfm_scrobble_event=lambda *_args, **_kwargs: None,
            persisted_entry=entry,
        )
    except Exception as error:
        logger.warning("A staged playback handoff's Last.fm submission failed (%s).", type(error).__name__)


@router.delete("/playback/state")
async def release_playback(request: Request):
    payload = await playback_payload(request)
    await playback_call(PostgresPlaybackClaims(playback_config(request)).release,
        request.state.current_actor, client_id=payload.get("clientId"), claim_token=payload.get("claimToken"))
    return JSONResponse({"protocol": 1}, headers={"Cache-Control": "no-store"})


async def require_playback_claim(request, payload):
    await playback_call(PostgresPlaybackClaims(playback_config(request)).require_claim,
        request.state.current_actor, client_id=payload.get("clientId"), claim_token=payload.get("claimToken"))


async def resolve_listen_track(request, payload):
    """A listen write names its track by the browser's `path` or by a native `playbackRef`, never both.

    A reference resolves exactly as a PCM open does and becomes the inventory path the browser
    sends for the same track, so the stored listen is identical. `cover_path` is never stored.
    """
    if "playbackRef" not in payload:
        return payload
    if "path" in payload or "cover_path" in payload:
        raise HTTPException(400, "Invalid playback request.")
    await require_action("library.media.read")(request)
    path = await reference_call(request, lambda service: service.resolve_library_path(
        request.state.current_actor, payload["playbackRef"]))
    return {**{key: value for key, value in payload.items() if key != "playbackRef"}, "path": path}
