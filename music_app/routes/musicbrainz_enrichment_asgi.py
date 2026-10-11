from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.current_actor_asgi import current_actor_from_request


router = APIRouter(prefix="/api/musicbrainz/artists")

_ARTIST_FIELDS = (
    "local_artist_id",
    "local_artist_name",
    "match_state",
    "artist_mbid",
    "canonical_name",
    "native_name",
    "country",
    "genres",
    "confidence",
    "evidence_summary",
    "unresolved_reason",
    "musicbrainz_url",
)
_CANDIDATE_FIELDS = (
    "artist_mbid",
    "canonical_name",
    "native_name",
    "country",
    "genres",
    "confidence",
    "evidence_summary",
    "musicbrainz_url",
)
_UNAVAILABLE = "MusicBrainz enrichment is unavailable."
_NOT_FOUND = "Artist was not found."


@router.get("/review")
async def list_artist_review(request: Request):
    await _require_current_library_owner(request)
    rows = await _call_service(request, "list_present_artist_review")
    if not isinstance(rows, (list, tuple)):
        raise _unavailable()
    return {"artists": [_project_artist(row) for row in rows]}


@router.get("/{local_artist_id}")
async def get_artist_problem(local_artist_id: int, request: Request):
    await _require_current_library_owner(request)
    row = await _call_service(
        request,
        "get_artist_problem",
        local_artist_id=local_artist_id,
    )
    if not isinstance(row, Mapping):
        raise _not_found()
    return {"artist": _project_artist(row, include_candidates=True)}


@router.post("/sync")
async def sync_artists(request: Request):
    await _require_current_library_owner(request)
    if await _request_object(request) != {}:
        raise HTTPException(400, "Invalid MusicBrainz sync request.")
    result = await _call_service(
        request,
        "enqueue_eligible_artists",
        reason="library_menu_sync",
    )
    count = result.get("enqueued_count") if isinstance(result, Mapping) else None
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise _unavailable()
    return JSONResponse({"enqueued_count": count}, status_code=202)


@router.post("/{local_artist_id}/retry")
async def retry_artist(local_artist_id: int, request: Request):
    await _require_current_library_owner(request)
    if await _request_object(request) != {}:
        raise HTTPException(400, "Invalid MusicBrainz retry request.")
    result = await _call_service(
        request,
        "enqueue_artist",
        local_artist_id=local_artist_id,
        reason="authorized_retry",
    )
    enqueued = result.get("enqueued") if isinstance(result, Mapping) else None
    if enqueued is not True:
        raise _not_found()
    return JSONResponse({"enqueued": True}, status_code=202)


@router.post("/{local_artist_id}/validate")
async def validate_artist(local_artist_id: int, request: Request):
    await _require_current_library_owner(request)
    body = await _request_object(request)
    if body is None or set(body) != {"artist_reference"}:
        raise HTTPException(400, "Enter a valid MusicBrainz artist URL or MBID.")
    artist_reference = body.get("artist_reference")
    if _artist_mbid(artist_reference) is None:
        raise HTTPException(400, "Enter a valid MusicBrainz artist URL or MBID.")
    candidate = await _call_service(
        request,
        "validate_manual_artist",
        local_artist_id=local_artist_id,
        artist_reference=artist_reference,
    )
    if not isinstance(candidate, Mapping):
        raise _not_found()
    return {"candidate": _project_candidate(candidate)}


@router.put("/{local_artist_id}/match")
async def assign_artist_match(local_artist_id: int, request: Request):
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    if body is None or set(body) != {"artist_mbid", "evidence_summary"}:
        raise HTTPException(400, "Invalid MusicBrainz match request.")
    artist_mbid = _artist_mbid(body.get("artist_mbid"))
    evidence_summary = body.get("evidence_summary")
    if (
        artist_mbid is None
        or not isinstance(evidence_summary, str)
        or not evidence_summary.strip()
        or len(evidence_summary) > 2048
    ):
        raise HTTPException(400, "Invalid MusicBrainz match request.")
    result = await _call_service(
        request,
        "assign_manual_match",
        local_artist_id=local_artist_id,
        actor_account_id=actor.account_id,
        artist_mbid=artist_mbid,
        evidence_summary=evidence_summary.strip(),
        request_ref=uuid4().hex,
    )
    assigned = result.get("assigned") if isinstance(result, Mapping) else result
    if assigned is not True:
        raise _not_found()
    return {"assigned": True}


async def _require_current_library_owner(request: Request):
    actor = await current_actor_from_request(request)
    library_id = actor.current_library_id
    if actor.account_id is None or library_id is None or not any(
        relationship.library_id == library_id and relationship.is_primary_owner
        for relationship in actor.library_relationships
    ):
        raise HTTPException(403, "Action not permitted.")
    return actor


async def _request_object(request: Request) -> dict[str, object] | None:
    raw = await request.body()
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return body if isinstance(body, dict) else None


async def _call_service(request: Request, method_name: str, **kwargs):
    service = getattr(request.app.state, "musicbrainz_enrichment_api_service", None)
    method = getattr(service, method_name, None)
    if not callable(method):
        raise _unavailable()
    try:
        return await run_in_threadpool(method, **kwargs)
    except Exception:
        logger = getattr(request.app.state, "logger", logging.getLogger(__name__))
        logger.warning("MusicBrainz enrichment request failed safely.")
        raise _unavailable() from None


def _artist_mbid(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    prefix = "https://musicbrainz.org/artist/"
    if text.startswith(prefix):
        text = text.removeprefix(prefix).removesuffix("/")
    elif "://" in text or "/" in text:
        return None
    try:
        parsed = UUID(text)
    except ValueError:
        return None
    normalized = str(parsed)
    return normalized if parsed.int != 0 and text.lower() == normalized else None


def _project_artist(
    row: object,
    *,
    include_candidates: bool = False,
) -> dict[str, object]:
    source = row if isinstance(row, Mapping) else {}
    projected = {field: source.get(field) for field in _ARTIST_FIELDS}
    if include_candidates:
        candidates = source.get("candidates")
        projected["candidates"] = (
            [
                _project_candidate(candidate)
                for candidate in candidates
                if isinstance(candidate, Mapping)
            ]
            if isinstance(candidates, (list, tuple))
            else []
        )
    return projected


def _project_candidate(row: Mapping[str, object]) -> dict[str, object]:
    return {field: row.get(field) for field in _CANDIDATE_FIELDS}


def _not_found() -> HTTPException:
    return HTTPException(404, _NOT_FOUND)


def _unavailable() -> HTTPException:
    return HTTPException(503, _UNAVAILABLE)
