"""The owner's choice of a MusicBrainz series' kind (Delivery 2, S6; owner 2026-11-17, 5B).

Right-clicking a series in the Series tree marks it as Series or Featured In, or returns it
to the MusicBrainz default. Owner-only, like every MusicBrainz action; writes the database
only, never tags. "Hidden" is not offered (owner 2026-11-17).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from music_app.routes.musicbrainz_enrichment_asgi import _request_object, _require_current_library_owner

router = APIRouter(prefix="/api/musicbrainz/series")

_OWNER_KINDS = {"series", "featured_in", None}


@router.put("/{mbid}/kind")
async def set_series_kind(mbid: str, request: Request):
    """Body ``{"kind": "series" | "featured_in" | null}``; null uses the MusicBrainz default."""
    await _require_current_library_owner(request)
    body = await _request_object(request)
    kind = body["kind"] if isinstance(body, dict) and set(body) == {"kind"} else ""
    try:
        mbid = str(uuid.UUID(mbid))
    except ValueError:
        raise HTTPException(400, "Invalid series.") from None
    if not isinstance(kind, (str, type(None))) or kind not in _OWNER_KINDS:
        raise HTTPException(400, "A series is shown as Series or Featured In.")
    try:
        series = await run_in_threadpool(_repository(request).set_series_owner_kind, mbid=mbid, owner_kind=kind,
                                         observed_at=datetime.now(timezone.utc))
    except Exception:
        getattr(request.app.state, "logger", logging.getLogger(__name__)).warning(
            "MusicBrainz series kind could not be saved.")
        raise HTTPException(503, "MusicBrainz series are unavailable.") from None
    if series is None:
        raise HTTPException(404, "Unknown series.")
    return {"series": {"mbid": series["mbid"], "kind": series["kind"], "owner_kind": series["owner_kind"]}}


def _repository(request: Request):
    repository = getattr(request.app.state, "musicbrainz_series_repository", None)
    if repository is not None:
        return repository
    from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository

    return MusicBrainzReleaseIdentityPostgresRepository(request.app.state.config)
