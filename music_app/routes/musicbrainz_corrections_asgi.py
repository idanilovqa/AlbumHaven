"""MusicBrainz data corrections in Problematic Files and the Edits Queue (Delivery 2, S4).

Owner-only, like every MusicBrainz action (owner 2026-11-16, "Data Correction flow").
Problematic Files labels an album "Data Correction Needed" and shows its changes; Settings →
Edits Queue lists the automatic ones ("Applied automatically", Undo per album) and those
waiting for approval (per kind, per album, or skip; artist changes per album only). Nothing
here writes tags.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.musicbrainz_enrichment_asgi import (
    _is_current_library_owner,
    _problematic_album_key,
    _request_object,
    _require_current_library_owner,
)
from music_app.services.musicbrainz_correction_kinds import ARTIST_KINDS, REVIEW_KINDS
from music_app.services.musicbrainz_corrections import (
    DATA_CORRECTION_LABEL,
    SECTIONS,
    build_musicbrainz_correction_service,
)

router = APIRouter(prefix="/api/musicbrainz/corrections")

_UNAVAILABLE = "MusicBrainz corrections are unavailable."
_PAGE_LIMIT = 200
_ROW_FIELDS = ("field", "label", "disc_number", "track_number", "current_value", "proposed_value", "kind", "mode",
               "state")
_ALBUM_ACTIONS = {"undo": "undo_album", "approve": "approve_album", "skip": "skip_album"}


@router.get("")
async def get_album_correction(album_key: str, request: Request):
    """One album's full correction, compared now, for its Problematic Files detail."""
    await _require_current_library_owner(request)
    if not 0 < len(album_key.strip()) <= 1024:
        raise HTTPException(400, "Invalid data correction request.")
    album = await _call(request, "get_correction", album_key=album_key)
    if not isinstance(album, Mapping):
        raise HTTPException(404, "This album has no data correction.")
    return {"correction": _correction_payload(album)}


@router.get("/albums")
async def list_correction_albums(request: Request, offset: int = 0, limit: int = 100):
    """A page of Problematic Files rows for albums needing a correction, in title order,
    for the "Data Correction Needed" filter."""
    await _require_current_library_owner(request)
    if offset < 0 or not 1 <= limit <= _PAGE_LIMIT:
        raise HTTPException(400, "Invalid page.")
    result = await _call(request, "list_correction_summaries", offset=offset, limit=limit)
    if not isinstance(result, Mapping):
        raise _unavailable()
    items = [_problematic_correction_item(row) for row in result.get("items") or () if isinstance(row, Mapping)]
    total = int(result.get("total") or 0)
    return {"items": items, "total": total,
            "next_offset": offset + len(items) if items and offset + len(items) < total else None}


@router.get("/edits")
async def get_edits_queue(request: Request, section: str = "applied"):
    """The Edits Queue's Data Correction tab: each kind with its album and row counts."""
    await _require_current_library_owner(request)
    if section not in SECTIONS:
        raise HTTPException(400, "Invalid Edits Queue section.")
    result = await _call(request, "edits_queue", section=section)
    settings = result.get("settings") or {}
    return {"section": section,
            "kinds": [{field: row.get(field) for field in ("kind", "albums", "rows")} for row in result.get("kinds") or ()],
            "settings": {"auto_submit_bulks": settings.get("auto_submit_bulks") is True,
                         "next_run_at": settings.get("next_run_at")}}


@router.get("/edits/{kind}")
async def get_edits_queue_page(kind: str, request: Request, section: str = "applied", offset: int = 0,
                               limit: int = 50):
    """A page of albums of one kind, each with its rows."""
    await _require_current_library_owner(request)
    if section not in SECTIONS or offset < 0 or not 1 <= limit <= _PAGE_LIMIT:
        raise HTTPException(400, "Invalid page.")
    albums = await _call(request, "edits_queue_page", section=section, kind=kind, offset=offset, limit=limit + 1)
    return {"albums": [{**{field: album.get(field) for field in ("album_key", "album_title", "artist_name", "year",
                                                                  "cover_path")},
                        "rows": _rows(album.get("rows"))} for album in albums[:limit]],
            "next_offset": offset + limit if len(albums) > limit else None}


@router.post("/albums/{action}")
async def decide_album(action: str, request: Request):
    """Undo an album's applied changes, or approve or skip its waiting ones; remembered."""
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    album_key = body.get("album_key") if isinstance(body, Mapping) and set(body) == {"album_key"} else None
    if action not in _ALBUM_ACTIONS or not isinstance(album_key, str) or not 0 < len(album_key.strip()) <= 1024:
        raise HTTPException(400, "Invalid data correction request.")
    decided = await _call(request, _ALBUM_ACTIONS[action], album_key=album_key, actor_account_id=actor.account_id)
    if not decided:
        raise HTTPException(404, "Nothing to change for this album.")
    return {"decided": decided}


@router.post("/kinds/{kind}/approve")
async def approve_kind(kind: str, request: Request):
    """Approve every waiting change of one kind. Artist changes are refused: per album only."""
    actor = await _require_current_library_owner(request)
    if kind not in REVIEW_KINDS or kind in ARTIST_KINDS or await _request_object(request) != {}:
        raise HTTPException(400, "This kind is approved per album only.")
    return {"decided": await _call(request, "approve_kind", kind=kind, actor_account_id=actor.account_id)}


@router.put("/settings")
async def save_correction_settings(request: Request):
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    if not isinstance(body, Mapping) or set(body) != {"auto_submit_bulks"} \
            or not isinstance(body["auto_submit_bulks"], bool):
        raise HTTPException(400, "Invalid Edits Queue settings.")
    settings = await _call(request, "save_settings", auto_submit_bulks=body["auto_submit_bulks"],
                           actor_account_id=actor.account_id)
    if not isinstance(settings, Mapping):
        raise _unavailable()
    return {"settings": {"auto_submit_bulks": settings.get("auto_submit_bulks") is True,
                         "next_run_at": settings.get("next_run_at")}}


def project_correction_problems_into_problematic_files(request: Request, payload: object) -> object:
    """Albums already listed gain the label from the stored counts, and the payload says how
    many albums need a correction in all (the filter offers it). Albums listed only for a
    correction are never part of this response: GET /api/musicbrainz/corrections/albums
    pages them when the filter asks. Owner-only; a failure leaves the payload unchanged."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list) \
            or not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return payload
    initial_detail = payload.get("initial_detail")
    albums = [item for item in [*payload["items"], *([initial_detail] if isinstance(initial_detail, dict) else [])]
              if item.get("entity_kind") is None]
    try:
        summaries = _service(request).list_correction_summaries(
            album_keys=[_problematic_album_key(item.get("key")) for item in albums])
    except Exception:
        _logger(request).warning("MusicBrainz data corrections were unavailable for Problematic Files.")
        return payload
    by_key = {str(row["album_key"]): row for row in summaries.get("items") or () if isinstance(row, Mapping)}
    for item in albums:
        summary = by_key.get(_problematic_album_key(item.get("key")))
        if summary is not None:
            _label(item, _correction_payload(summary))
    payload["musicbrainz_correction_album_count"] = int(summaries.get("total") or 0)
    return payload


def project_correction_into_problematic_detail(request: Request, payload: object) -> object:
    """A loaded album detail carries its label and its stored rows."""
    if not isinstance(payload, dict) or not payload.get("key") \
            or not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return payload
    try:
        album = _service(request).get_correction(album_key=_problematic_album_key(payload["key"]))
    except Exception:
        _logger(request).warning("MusicBrainz data correction was unavailable for an album detail.")
        return payload
    if isinstance(album, Mapping):
        _label(payload, _correction_payload(album))
    return payload


def _label(item: dict[str, object], correction: dict[str, object]) -> None:
    reasons = list(item.get("problem_reasons") or [])
    if DATA_CORRECTION_LABEL not in reasons:
        item["problem_reasons"] = [*reasons, DATA_CORRECTION_LABEL]
    item["musicbrainz_correction"] = correction


def _correction_payload(album: Mapping[str, object]) -> dict[str, object]:
    """The correction a row carries: its counts always, its rows once the album is opened."""
    payload = {"album_key": str(album["album_key"]),
               **{field: album.get(field) for field in ("correction_count", "auto_count", "review_count",
                                                        "review_whole") if field in album}}
    if "corrections" in album:
        payload["corrections"] = _rows(album.get("corrections"))
        payload["correction_count"] = len(payload["corrections"])
    return payload


def _problematic_correction_item(album: Mapping[str, object]) -> dict[str, object]:
    return {
        "key": f"musicbrainz-correction:{album['album_key']}",
        "entity_kind": "musicbrainz_correction",
        "name": str(album.get("album_title") or "").strip() or "Unknown Album",
        "album_artist": str(album.get("artist_name") or "").strip() or "Unknown Artist",
        "year": album.get("year"),
        "cover_path": album.get("cover_path") or None,
        "problem_reasons": [DATA_CORRECTION_LABEL],
        "musicbrainz_correction": _correction_payload(album),
        # A summary row like every other; its correction loads when it is opened.
        "detail_loaded": False,
    }


def _rows(value: object) -> list[dict[str, object]]:
    return [{field: item.get(field) for field in _ROW_FIELDS}
            for item in value or () if isinstance(item, Mapping)] if isinstance(value, (list, tuple)) else []


def _service(request: Request):
    service = getattr(request.app.state, "musicbrainz_correction_service", None)
    return service if service is not None else build_musicbrainz_correction_service(request.app.state.config)


async def _call(request: Request, method_name: str, **kwargs):
    try:
        return await run_in_threadpool(getattr(_service(request), method_name), **kwargs)
    except Exception:
        _logger(request).warning("MusicBrainz correction request failed safely.")
        raise _unavailable() from None


def _logger(request: Request) -> logging.Logger:
    return getattr(request.app.state, "logger", logging.getLogger(__name__))


def _unavailable() -> HTTPException:
    return HTTPException(503, _UNAVAILABLE)
