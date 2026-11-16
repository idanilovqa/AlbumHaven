from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.services.current_actor_asgi import current_actor_from_request
from music_app.services.musicbrainz_enrichment_postgres import (
    APP_PROBLEM_LABELS,
    MUSICBRAINZ_HAS_NO_INFO_LABEL,
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


def load_problematic_album_items(request: Request, *, album_key: str | None = None) -> list[dict[str, object]]:
    """The primary owner's albums MusicBrainz has no info on, as Problematic Files rows
    (S5), owner-only like the artist rows. A failure yields no rows."""
    if not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return []
    service = getattr(request.app.state, "musicbrainz_enrichment_api_service", None)
    list_attention = getattr(service, "list_album_attention", None)
    try:
        rows = (list_attention if callable(list_attention) else MusicBrainzEnrichmentPostgresRepository(
            request.app.state.config).list_album_attention)(album_key=album_key)
    except Exception:
        logger = getattr(request.app.state, "logger", logging.getLogger(__name__))
        logger.warning("MusicBrainz album problems were unavailable for Problematic Files.")
        return []
    return [_problematic_album_item(row) for row in rows if isinstance(row, Mapping) and row.get("album_key")]


def project_album_problems_into_problematic_files(
    request: Request,
    payload: object,
    album_items: list[dict[str, object]] | None = None,
) -> object:
    """An album already listed gains the "MusicBrainz has no info" label and its lookups;
    any other flagged album is added as a row of its own, by name."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        return payload
    if album_items is None:
        album_items = load_problematic_album_items(request)
    by_key = {item["musicbrainz_album_key"]: item for item in album_items}
    for item in payload["items"]:
        flagged = by_key.pop(_problematic_album_key(item.get("key")), None)
        if flagged is not None:
            _label_flagged_album(item, flagged["musicbrainz_album_key"])
    if by_key:
        payload["items"] = sorted([*payload["items"], *by_key.values()],
                                  key=lambda item: str(item.get("name") or "").lower())
        payload["count"] = len(payload["items"])
    return payload


def project_album_problem_into_problematic_detail(request: Request, payload: object) -> object:
    """A loaded album detail keeps the label its summary row carried."""
    if isinstance(payload, dict) and payload.get("key"):
        album_key = _problematic_album_key(payload["key"])
        if load_problematic_album_items(request, album_key=album_key):
            _label_flagged_album(payload, album_key)
    return payload


def _problematic_album_key(key: object) -> str:
    # Problematic Files keys a separate release by its year.
    return re.sub(r"::year::\d{4}$", "", str(key or ""))


def _label_flagged_album(item: dict[str, object], album_key: str) -> None:
    reasons = list(item.get("problem_reasons") or [])
    if MUSICBRAINZ_HAS_NO_INFO_LABEL not in reasons:
        item["problem_reasons"] = [*reasons, MUSICBRAINZ_HAS_NO_INFO_LABEL]
    item["musicbrainz_album_key"] = album_key


def _problematic_album_item(row: Mapping[str, object]) -> dict[str, object]:
    album_key = str(row["album_key"])
    return {
        "key": f"musicbrainz-album:{album_key}",
        "entity_kind": "musicbrainz_album",
        "musicbrainz_album_key": album_key,
        "local_artist_id": row.get("local_artist_id"),
        "name": str(row.get("album_title") or "").strip() or "Unknown Album",
        "album_artist": str(row.get("artist_name") or "").strip() or "Unknown Artist",
        "year": row.get("year"),
        "cover_path": row.get("cover_path") or None,
        "problem_reasons": [MUSICBRAINZ_HAS_NO_INFO_LABEL],
        # A summary row like every other; its detail is the row itself.
        "detail_loaded": False,
    }


def _problematic_artist_item(row: Mapping[str, object]) -> dict[str, object]:
    name = str(row.get("local_artist_name") or "").strip() or "Unknown Artist"
    return {
        "key": f"musicbrainz-artist:{int(row['local_artist_id'])}",
        "entity_kind": "artist",
        "local_artist_id": int(row["local_artist_id"]),
        "musicbrainz_occurrence_id": str(row["problem_occurrence_id"]),
        "name": name,
        "album_artist": name,
        "problem_reasons": [str(row["unresolved_reason"]),
                            *([MUSICBRAINZ_HAS_NO_INFO_LABEL] if row.get("musicbrainz_has_no_info") else [])],
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


# The owner's manual MusicBrainz lookups (Delivery 2, S5): queue or search one artist or
# album, list the waiting queue and the batch notification cards, open and dismiss a batch.
lookup_router = APIRouter(prefix="/api/musicbrainz/lookups")

_LOOKUP_TARGET_KINDS = {"artist", "album"}
_LOOKUP_MODES = {"queue", "search"}
_QUEUED_FIELDS = (
    "request_id", "target_kind", "local_artist_id", "artist_name", "album_key", "album_title", "year",
    "requested_at",
)
_BATCH_FIELDS = (
    "batch_id", "started_at", "finished_at", "total", "matched", "not_matched", "artists", "albums",
    "single_title", "single_artist_name", "single_target_kind", "single_outcome", "single_problem_label",
)
_BATCH_ITEM_FIELDS = (
    "request_id", "target_kind", "local_artist_id", "artist_name", "album_key", "album_title", "year", "state",
    "outcome", "result_mbid", "result_entity", "problem_label", "problem_occurrence_id",
)
_TARGET_FIELDS = ("album_key", "local_artist_id", "artist_name", "artist_has_mbid", "album_has_mbid")


@lookup_router.post("")
async def request_lookup(request: Request):
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    target = _lookup_target(body)
    if target is None:
        raise HTTPException(400, "Invalid MusicBrainz lookup request.")
    result = await _call_service(request, "request_lookup", actor_account_id=actor.account_id, **target)
    if not isinstance(result, Mapping):
        raise HTTPException(404, "Artist or album was not found.")
    return JSONResponse(
        {field: result.get(field) for field in ("request_id", "state", "batch_id")}, status_code=202)


@lookup_router.get("")
async def list_lookups(request: Request):
    await _require_current_library_owner(request)
    result = await _call_service(request, "list_lookups")
    if not isinstance(result, Mapping):
        raise _unavailable()
    return {
        "queued": [_fields(row, _QUEUED_FIELDS) for row in result.get("queued") or ()],
        "queue_starts_at": result.get("queue_starts_at"),
        "batches": [_fields(row, _BATCH_FIELDS) for row in result.get("batches") or ()],
    }


@lookup_router.get("/target")
async def lookup_target(album_key: str, request: Request):
    await _require_current_library_owner(request)
    row = await _call_service(request, "lookup_target", album_key=album_key)
    if not isinstance(row, Mapping):
        raise HTTPException(404, "Album was not found.")
    return {"target": _fields(row, _TARGET_FIELDS)}


@lookup_router.get("/batches/{batch_id}")
async def get_lookup_batch(batch_id: int, request: Request):
    await _require_current_library_owner(request)
    batch = await _call_service(request, "get_lookup_batch", batch_id=batch_id)
    if not isinstance(batch, Mapping):
        raise HTTPException(404, "Lookup was not found.")
    return {"batch": {**_fields(batch, _BATCH_FIELDS),
                      "items": [_fields(item, _BATCH_ITEM_FIELDS) for item in batch.get("items") or ()]}}


@lookup_router.post("/batches/{batch_id}/dismiss")
async def dismiss_lookup_batch(batch_id: int, request: Request):
    await _require_current_library_owner(request)
    if await _request_object(request) != {}:
        raise HTTPException(400, "Invalid MusicBrainz lookup request.")
    result = await _call_service(request, "dismiss_lookup_batch", batch_id=batch_id)
    if not isinstance(result, Mapping) or result.get("dismissed") is not True:
        raise HTTPException(404, "Lookup was not found.")
    return {"dismissed": True}


def _lookup_target(body: object) -> dict[str, object] | None:
    """Exactly one artist (by id or by one of its albums) or one album (by key)."""
    if not isinstance(body, Mapping):
        return None
    target_kind, mode = body.get("target_kind"), body.get("mode")
    named = set(body) - {"target_kind", "mode"}
    if target_kind not in _LOOKUP_TARGET_KINDS or mode not in _LOOKUP_MODES or len(named) != 1:
        return None
    (name,) = named
    value = body[name]
    if name == "album_key" and isinstance(value, str) and 0 < len(value.strip()) <= 1024:
        return {"target_kind": target_kind, "mode": mode, "album_key": value}
    if (name == "local_artist_id" and target_kind == "artist" and isinstance(value, int)
            and not isinstance(value, bool) and value > 0):
        return {"target_kind": target_kind, "mode": mode, "local_artist_id": value}
    return None


def _fields(row: object, fields: tuple[str, ...]) -> dict[str, object]:
    source = row if isinstance(row, Mapping) else {}
    return {field: source.get(field) for field in fields}
