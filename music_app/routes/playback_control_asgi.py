"""Authenticated, bounded playback references and ownership contracts."""

import asyncio
from contextlib import asynccontextmanager
import logging
from pathlib import Path
import time

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
from music_app.services.mp3_stream_map import mp3_stream_map
from music_app.services.playback_references import PlaybackContractError, PlaybackReferenceService
from music_app.services.playback_claims_postgres import PostgresPlaybackClaims, validate_taker
from music_app.services.playback_session_payloads import normalize_playback_track_payload
from music_app.services.policy_asgi import allowed_actions_for_request, require_action


router = APIRouter()
logger = logging.getLogger(__name__)
_SESSION_COOKIE = "__Host-album_haven_session"
_SCROBBLING_ACTIONS = ("integration.lastfm.now_playing", "integration.lastfm.scrobble")
_SCROBBLE_ACTION = "integration.lastfm.scrobble"
# The Android 13+ media card fills its width with the artwork; larger only costs bytes.
_NOTIFICATION_ARTWORK_EDGE = 768
# A claim heartbeat every ten seconds is logged only when it is this slow.
_QUIET_STEP_LOG_MS = 1000
# How long Play here waits for the playing client to say anything before it is refused.
HANDOVER_ANSWER_SECONDS = 1.5
# How long a plain press waits for a paused holder's word that nothing of it sounds: its output's drain.
YIELD_ANSWER_SECONDS = 1.5
ARTWORK_PREFIX = "/playback/artwork/"
# A resume token never expires, and its payload names library files.
redact_access_log_paths(ARTWORK_PREFIX)


def playback_config(request):
    return {**request.app.state.config, **request.app.state.auth_policy_config}


async def playback_call(function, *args, **kwargs):
    try:
        return await run_in_threadpool(function, *args, **kwargs)
    except PlaybackContractError as error:
        headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
        raise HTTPException(error.status_code, str(error), headers=headers) from None


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


@asynccontextmanager
async def timed_playback_step(step: str, *keys: str):
    """Logs one path-free line with the step's answer status, elapsed milliseconds and ``keys``.

    The caller sets each key to a count or flag, never a name or token, in the yielded dict; a key
    left unset logs ``-``, so every line of a step has the same keys. Setting ``quiet`` skips a step
    answered within ``_QUIET_STEP_LOG_MS``, as a claim heartbeat is. A refusal logs its HTTP
    status, any other failure 500.
    """
    fields: dict[str, object] = dict.fromkeys(keys, "-")
    started_at = time.perf_counter()
    status = 500
    try:
        yield fields
        status = 200
    except HTTPException as error:
        status = error.status_code
        raise
    finally:
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        if not (fields.pop("quiet", False) and elapsed_ms < _QUIET_STEP_LOG_MS):
            extra = "".join(f" {key}={value}" for key, value in fields.items())
            logger.info("Playback %s timing status=%s elapsed_ms=%s%s", step, status, elapsed_ms, extra)


@router.post("/playback/refs")
async def playback_refs(request: Request) -> JSONResponse:
    async with timed_playback_step("refs", "tracks") as timing:
        payload = await playback_payload(request)
        tracks = payload.get("tracks")
        if not isinstance(tracks, list) or not 1 <= len(tracks) <= 100:
            raise HTTPException(400, "Invalid playback reference batch.")
        timing["tracks"] = len(tracks)
        media: list[Path] = []
        result = await reference_call(request, lambda service: service.issue_batch(
            request.state.current_actor, tracks, on_media=media.append))
    # The queue's tracks are what plays next: their MP3 maps are read now, in the background, so a
    # start or a jump to any of them streams at once instead of scanning the file first.
    _prepare_streams(media)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


_preparing: set[asyncio.Task[None]] = set()


def _prepare_streams(paths: list[Path]) -> None:
    mp3_paths = [path for path in paths if path.suffix.lower() == ".mp3"]
    if not mp3_paths:
        return

    async def prepare() -> None:
        for path in mp3_paths:
            await asyncio.to_thread(mp3_stream_map, path)

    task = asyncio.create_task(prepare())
    _preparing.add(task)
    task.add_done_callback(_preparing.discard)


@router.post("/playback/refs/resume")
async def resume_playback_refs(request: Request) -> JSONResponse:
    """Fresh references for the resume tokens a native player persisted instead of references."""
    async with timed_playback_step("refs resume"):
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
async def playback_state(request: Request, client_id: str = "", include_path: bool = False):
    result = await playback_call(PostgresPlaybackClaims(playback_config(request)).get,
        request.state.current_actor, client_id, include_path=include_path)
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@router.put("/playback/state")
async def acquire_playback(request: Request):
    # A first claim gates a start's first sound; a heartbeat renews one already held.
    async with timed_playback_step("claim", "renew", "scrobbling_ms") as timing:
        payload = await playback_payload(request)
        # "paused": a renewal of a holder that keeps its claim through a pause.
        if payload.get("state") not in ("playing", "paused"):
            raise HTTPException(400, "Invalid playback state.")
        if payload.get("confirm") is not None:
            if (payload["confirm"] is not True or payload.get("takeover") is not True or payload["state"] != "playing"
                    or type(payload.get("silencesItself", False)) is not bool
                    or payload.keys() - {"protocol", "state", "clientId", "clientSurface", "takeover", "confirm",
                                         "silencesItself"}):
                raise HTTPException(400, "Invalid playback handover.")
            return await _confirmed_takeover(request, payload)
        renews = payload.get("claimToken") is not None
        timing["renew"] = timing["quiet"] = renews
        track, reference = await _claimed_track(request, payload)
        claims = PostgresPlaybackClaims(playback_config(request))

        def acquire(**yielded):
            return playback_call(claims.acquire, request.state.current_actor, client_id=payload.get("clientId"),
                client_surface=payload.get("clientSurface"), track=track,
                claim_token=payload.get("claimToken"), handoff=payload.get("handoff"),
                takeover=payload.get("takeover", False), position=payload.get("position"),
                silences_itself=payload.get("silencesItself", False), paused=payload["state"] == "paused",
                **yielded)

        try:
            result = await acquire()
        except HTTPException as refused:
            # A start refused for a holder (no draining page to wait for) asks it once whether it is paused.
            if refused.status_code != 409 or refused.headers or renews or payload.get("handoff") is not None:
                raise
            result = await _start_over_paused_holder(request, claims, payload.get("clientId"), acquire, refused)
        scrobbling = {}
        if renews:
            claimed_at = time.perf_counter()
            scrobbling = await _scrobbling_status(request)
            timing["scrobbling_ms"] = round((time.perf_counter() - claimed_at) * 1000)
    return JSONResponse({**result, **reference, **scrobbling}, headers={"Cache-Control": "no-store"})


async def _start_over_paused_holder(request, claims, client_id, acquire, refused):
    """A holder that paused keeps its claim a few seconds, so its own Play sounds at once with no request. A
    plain press elsewhere meanwhile asks it over its socket: it starts only on that holder's word that
    nothing of it sounds (given from its output's real state, its claim dropped as it says so), and over that
    holder's claim only. A holder that plays declines; one that cannot answer is no proof: refused as before.
    """
    hub = request.app.state.playback_pcm_registry.handover
    observed = await playback_call(claims.holder, request.state.current_actor)
    if observed["client_id"] in (None, client_id) or observed["silent"]:
        raise refused
    holder = (observed["account_id"], observed["library_id"], observed["client_id"])
    taken = False
    try:
        if not await hub.yielded(*holder, timeout=YIELD_ANSWER_SECONDS):
            raise refused
        result = await acquire(yielded_digest=observed["digest"])
        taken = True
        return result
    finally:
        await hub.settled(*holder, taken=taken)


async def _claimed_track(request, payload):
    """The claim's track and what the answer adds to it. A start is one request (the
    shortened wait): a browser without a reference names its song by path and is issued one in the same call.
    """
    track = payload.get("track")
    if not isinstance(track, dict) or "path" not in track:
        return track, {}
    if payload.get("clientSurface") != "private_web" or "playbackRef" in track:
        raise HTTPException(400, "Invalid playback request.")
    media: list[Path] = []
    issued = await reference_call(request, lambda service: service.issue_batch(
        request.state.current_actor, [{"clientKey": "claim", "path": track["path"]}], on_media=media.append))
    _prepare_streams(media)
    reference = issued["tracks"][0]["playbackRef"]
    named = {key: value for key, value in track.items() if key != "path"}
    return {**named, "playbackRef": reference}, {"playbackRef": reference, "referenceExpiresAt": issued["expiresAt"]}


async def _confirmed_takeover(request, payload):
    """playback.claim.takeover, confirmed: the holder stops and says what sounds and where. Without its word
    that it is silent the press is refused: nothing starts without an answer."""
    claims, actor = PostgresPlaybackClaims(playback_config(request)), request.state.current_actor
    hub = request.app.state.playback_pcm_registry.handover
    client_id = payload.get("clientId")
    async with timed_playback_step("handover", "confirmed", "ask_ms") as timing:
        await playback_call(validate_taker, client_id, payload.get("clientSurface"))
        observed = await playback_call(claims.holder, actor)
        # A pause gives the claim back while the other tab still shows Play here: it is asked all the same.
        # With no claim but a last-played record nobody is asked: its song goes on where it was last heard.
        paused = observed["client_id"] is None and not observed["silent"]
        if paused:
            released = hub.released(observed["account_id"], observed["library_id"])
            if released is None:
                return JSONResponse(await playback_call(claims.get, actor, client_id),
                    headers={"Cache-Control": "no-store"})
            observed = {**observed, "client_id": released[0], "digest": released[1]}
        holder = (observed["account_id"], observed["library_id"], observed["client_id"])
        asked_at = time.perf_counter()
        answer = None
        taken = False
        if observed["client_id"] != client_id and not observed.get("silent"):
            answer = await hub.ask(*holder, accepts=lambda token: claims.holds(observed, token),
                timeout=HANDOVER_ANSWER_SECONDS)
        timing["ask_ms"] = round((time.perf_counter() - asked_at) * 1000)
        try:
            if paused and not (answer and answer["track"]):
                return JSONResponse(await playback_call(claims.get, actor, client_id),
                    headers={"Cache-Control": "no-store"})
            if answer is None and not observed.get("silent"):
                raise HTTPException(409, "Playback is active on another client.")
            result = await playback_call(claims.hand_over, actor, client_id=client_id,
                client_surface=payload.get("clientSurface"), observed=observed, answer=answer,
                silences_itself=payload.get("silencesItself", False))
            taken = True
        finally:
            await hub.settled(*holder, taken=taken)
        timing["confirmed"] = result["confirmed"]
        # A client of this same account and library: the one tab the taker may silence in its own browser.
        result = {**result, "previousClientId": observed["client_id"]}
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


async def _scrobbling_status(request):
    """`scrobbling.available`: whether this claim's now-playing and scrobble writes can reach Last.fm.

    Only a renewal says it: a start is answered without waiting for the lookup, which took over half of a
    claim's time (the shortened wait).

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
        if not isinstance(completion, dict):
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
    released = await playback_call(PostgresPlaybackClaims(playback_config(request)).release,
        request.state.current_actor, client_id=payload.get("clientId"), claim_token=payload.get("claimToken"))
    if released:
        request.app.state.playback_pcm_registry.handover.remember_release(**released)
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
