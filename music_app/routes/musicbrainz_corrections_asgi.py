"""MusicBrainz data corrections in Problematic Files and the Edits Queue (Delivery 2, S4).

Owner-only, like every MusicBrainz action. Problematic Files labels an album "Data
Correction Needed" and shows its proposed correction; "Add to queue" keeps it for Bulk
Correction in Settings → Edits Queue. Nothing here writes tags.
"""
from __future__ import annotations

import logging
import re
from collections.abc import Mapping

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from music_app.routes.musicbrainz_enrichment_asgi import (
    _is_current_library_owner,
    _request_object,
    _require_current_library_owner,
)
from music_app.services.musicbrainz_corrections import (
    DATA_CORRECTION_LABEL,
    build_musicbrainz_correction_service,
)

router = APIRouter(prefix="/api/musicbrainz/corrections")

_UNAVAILABLE = "MusicBrainz corrections are unavailable."
_QUEUE_FIELDS = ("entry_id", "album_key", "album_title", "artist_name", "year", "cover_path", "release_mbid",
                 "corrections", "queued_at")
_CORRECTION_FIELDS = ("field", "label", "current", "proposed", "tracks")


@router.get("")
async def get_album_correction(album_key: str, request: Request):
    """One album's full correction, compared now, for its Problematic Files detail."""
    await _require_current_library_owner(request)
    if not 0 < len(album_key.strip()) <= 1024:
        raise HTTPException(400, "Invalid data correction request.")
    album = await _call(request, "get_correction", album_key=album_key)
    if not isinstance(album, Mapping):
        raise HTTPException(404, "This album has no data correction.")
    return {"correction": {**_correction_payload(album), "track_count": album.get("track_count"),
                           "file_types": list(album.get("file_types") or [])}}


@router.get("/queue")
async def list_correction_queue(request: Request):
    await _require_current_library_owner(request)
    result = await _call(request, "list_queue")
    if not isinstance(result, Mapping):
        raise _unavailable()
    settings = result.get("settings") or {}
    return {
        "items": [{**{field: row.get(field) for field in _QUEUE_FIELDS},
                   "corrections": _corrections(row.get("corrections"))}
                  for row in result.get("items") or () if isinstance(row, Mapping)],
        "settings": {"auto_submit_bulks": settings.get("auto_submit_bulks") is True,
                     "next_run_at": settings.get("next_run_at")},
    }


@router.post("/queue")
async def queue_correction(request: Request):
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    album_key = body.get("album_key") if isinstance(body, Mapping) and set(body) == {"album_key"} else None
    if not isinstance(album_key, str) or not 0 < len(album_key.strip()) <= 1024:
        raise HTTPException(400, "Invalid data correction request.")
    result = await _call(request, "queue_correction", album_key=album_key, actor_account_id=actor.account_id)
    if not isinstance(result, Mapping):
        raise HTTPException(404, "This album has no data correction.")
    return JSONResponse({"entry_id": result.get("entry_id"), "queued_at": result.get("queued_at")},
                        status_code=201)


@router.delete("/queue/{entry_id}")
async def remove_queued_correction(entry_id: int, request: Request):
    await _require_current_library_owner(request)
    if await _call(request, "remove_queued", entry_id=entry_id) is not True:
        raise HTTPException(404, "Queued correction was not found.")
    return {"removed": True}


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


def load_problematic_correction_items(request: Request) -> list[dict[str, object]]:
    """The primary owner's albums needing a data correction, as Problematic Files rows, from
    the stored counts (no comparison runs here). Owner-only, so never cached with the
    library-wide projection. A failure yields no rows."""
    if not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return []
    try:
        albums = _service(request).list_correction_summaries()
    except Exception:
        _logger(request).warning("MusicBrainz data corrections were unavailable for Problematic Files.")
        return []
    return [_problematic_correction_item(album) for album in albums if isinstance(album, Mapping)]


def project_correction_problems_into_problematic_files(
    request: Request,
    payload: object,
    correction_items: list[dict[str, object]] | None = None,
) -> object:
    """An album already listed gains the label; any other album needing a correction is
    added as a row of its own, by name, to the complete list only (the bounded first page
    stays bounded)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        return payload
    if correction_items is None:
        correction_items = load_problematic_correction_items(request)
    by_key = {item["musicbrainz_correction"]["album_key"]: item for item in correction_items}
    initial_detail = payload.get("initial_detail")
    for item in [*payload["items"], *([initial_detail] if isinstance(initial_detail, dict) else [])]:
        flagged = by_key.get(_album_key(item.get("key")))
        if flagged is not None and item.get("entity_kind") is None:
            _label(item, flagged["musicbrainz_correction"])
    if payload.get("complete") is False:
        return payload
    listed = {_album_key(item.get("key")) for item in payload["items"] if item.get("entity_kind") is None}
    added = [item for key, item in by_key.items() if key not in listed]
    if added:
        payload["items"] = sorted([*payload["items"], *added], key=lambda item: str(item.get("name") or "").lower())
        payload["count"] = len(payload["items"])
    return payload


def project_correction_into_problematic_detail(request: Request, payload: object) -> object:
    """A loaded album detail carries its label and full correction, compared for this album."""
    if not isinstance(payload, dict) or not payload.get("key") \
            or not _is_current_library_owner(getattr(request.state, "current_actor", None)):
        return payload
    try:
        album = _service(request).get_correction(album_key=_album_key(payload["key"]))
    except Exception:
        _logger(request).warning("MusicBrainz data correction was unavailable for an album detail.")
        return payload
    if isinstance(album, Mapping):
        _label(payload, _correction_payload(album))
    return payload


def _album_key(key: object) -> str:
    # Problematic Files keys a separate release by its year.
    return re.sub(r"::year::\d{4}$", "", str(key or ""))


def _label(item: dict[str, object], correction: dict[str, object]) -> None:
    reasons = list(item.get("problem_reasons") or [])
    if DATA_CORRECTION_LABEL not in reasons:
        item["problem_reasons"] = [*reasons, DATA_CORRECTION_LABEL]
    item["musicbrainz_correction"] = correction


def _correction_payload(album: Mapping[str, object]) -> dict[str, object]:
    """The correction a row carries: its count always, its changes once compared."""
    payload = {"album_key": str(album["album_key"]), "release_mbid": album.get("release_mbid"),
               "queued_at": album.get("queued_at"), "correction_count": album.get("correction_count")}
    if "corrections" in album:
        payload["corrections"] = _corrections(album.get("corrections"))
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


def _corrections(value: object) -> list[dict[str, object]]:
    return [{field: item.get(field) for field in _CORRECTION_FIELDS}
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
