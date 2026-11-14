from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.musicbrainz_enrichment_postgres import (
    APP_PROBLEM_LABELS,
    MusicBrainzEnrichmentPostgresRepository,
)


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
    "disambiguation",
    "artist_kind",
    "problem_occurrence_id",
    "problem_reason_code",
    "local_album_count",
    "last_checked_at",
    "last_attempt_at",
    "next_attempt_at",
    "gallery_artist",
)
_CANDIDATE_FIELDS = (
    "artist_mbid",
    "canonical_name",
    "native_name",
    "disambiguation",
    "artist_kind",
    "country",
    "genres",
    "confidence",
    "evidence_summary",
    "musicbrainz_url",
)
_STATUS_FIELDS = (
    "local_artist_id",
    "local_artist_name",
    "gallery_artist",
    "match_state",
    "problem_occurrence_id",
    "unresolved_reason",
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


@router.get("/status")
async def list_artist_status(request: Request):
    await _require_current_library_owner(request)
    rows = await _call_service(request, "list_artist_attention")
    if not isinstance(rows, (list, tuple)):
        raise _unavailable()
    return {"artists": [
        {
            **{field: row.get(field) for field in _STATUS_FIELDS},
            # The Gallery uses app wording, which differs from Problematic Files for pending metadata.
            "unresolved_reason": APP_PROBLEM_LABELS.get(row.get("problem_reason_code"), row.get("unresolved_reason")),
        }
        for row in rows if isinstance(row, Mapping)
    ]}


@router.get("/{local_artist_id}")
async def get_artist_problem(local_artist_id: int, request: Request):
    await _require_current_library_owner(request)
    service = getattr(request.app.state, "musicbrainz_enrichment_api_service", None)
    if callable(getattr(service, "get_artist_problem", None)):
        row = await _call_service(
            request,
            "get_artist_problem",
            local_artist_id=local_artist_id,
        )
    else:
        try:
            row = await run_in_threadpool(
                MusicBrainzEnrichmentPostgresRepository(
                    request.app.state.config
                ).get_artist_problem,
                local_artist_id=local_artist_id,
            )
        except Exception:
            logger = getattr(request.app.state, "logger", logging.getLogger(__name__))
            logger.warning("MusicBrainz artist problem details were unavailable.")
            raise _unavailable() from None
    if not isinstance(row, Mapping):
        raise _not_found()
    artist = _project_artist(row, include_candidates=True)
    artist["actions_available"] = all(
        callable(getattr(service, method_name, None))
        for method_name in ("enqueue_artist", "validate_manual_artist", "assign_manual_match")
    )
    return {"artist": artist}


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


def _is_current_library_owner(actor: object) -> bool:
    library_id = getattr(actor, "current_library_id", None)
    return (
        getattr(actor, "account_id", None) is not None
        and library_id is not None
        and any(
            relationship.library_id == library_id and relationship.is_primary_owner
            for relationship in getattr(actor, "library_relationships", ())
        )
    )


async def _require_current_library_owner(request: Request):
    actor = await current_actor_from_request(request)
    if not _is_current_library_owner(actor):
        raise HTTPException(403, "Action not permitted.")
    return actor


def load_problematic_artist_items(request: Request) -> list[dict[str, object]]:
    """The primary owner's unresolved artist identities as Problematic Files ``Artist`` rows.

    Owner-only, so they are added per request and never cached with the
    library-wide projection. A failure yields no rows.
    """
    if not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return []
    service = getattr(request.app.state, "musicbrainz_enrichment_api_service", None)
    list_attention = getattr(service, "list_artist_attention", None)
    try:
        rows = (
            list_attention(include_gallery_artist=False)
            if callable(list_attention)
            else MusicBrainzEnrichmentPostgresRepository(
                request.app.state.config
            ).list_artist_attention()
        )
    except Exception:
        logger = getattr(request.app.state, "logger", logging.getLogger(__name__))
        logger.warning("MusicBrainz artist problems were unavailable for Problematic Files.")
        return []
    return [
        _problematic_artist_item(row)
        for row in rows if isinstance(row, Mapping)
        and row.get("unresolved_reason") and row.get("problem_occurrence_id") is not None
    ]


def project_artist_problems_into_problematic_files(
    request: Request,
    payload: object,
    artist_items: list[dict[str, object]] | None = None,
) -> object:
    """Merge the owner's ``Artist`` rows into every page, the bounded first one
    included, so their filters are ready with the album filters."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        return payload
    if artist_items is None:
        artist_items = load_problematic_artist_items(request)
    if artist_items:
        # Stable sort by name keeps the existing Album/Folder order intact.
        payload["items"] = sorted(
            [*payload["items"], *artist_items],
            key=lambda item: str(item.get("name") or "").lower(),
        )
        payload["count"] = len(payload["items"])
    return payload


def _problematic_artist_item(row: Mapping[str, object]) -> dict[str, object]:
    name = str(row.get("local_artist_name") or "").strip() or "Unknown Artist"
    return {
        "key": f"musicbrainz-artist:{int(row['local_artist_id'])}",
        "entity_kind": "artist",
        "local_artist_id": int(row["local_artist_id"]),
        "musicbrainz_occurrence_id": str(row["problem_occurrence_id"]),
        "name": name,
        "album_artist": name,
        "problem_reasons": [str(row["unresolved_reason"])],
        "local_album_count": row.get("local_album_count"),
        # A summary row like every other; its detail comes from the MusicBrainz API.
        "detail_loaded": False,
    }


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
