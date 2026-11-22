"""The owner's manual album identity: "Assign artist" for an album whose artist is undecided."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from music_app.routes.musicbrainz_enrichment_asgi import (
    _artist_mbid,
    _request_object,
    _require_current_library_owner,
)

router = APIRouter(prefix="/api/musicbrainz/albums")


@router.put("/artist")
async def assign_album_artist(request: Request):
    """Body ``{"album_key", "artist_mbid"}``: one of the album's proposed artists."""
    actor = await _require_current_library_owner(request)
    body = await _request_object(request)
    if not isinstance(body, dict) or set(body) != {"album_key", "artist_mbid"}:
        raise HTTPException(400, "Invalid album artist request.")
    album_key, artist_mbid = body["album_key"], _artist_mbid(body["artist_mbid"])
    if not isinstance(album_key, str) or not album_key.strip() or artist_mbid is None:
        raise HTTPException(400, "Invalid album artist request.")
    try:
        outcome = await run_in_threadpool(
            _repository(request).assign_suggested_artist,
            album_key=album_key, artist_mbid=artist_mbid, actor_account_id=actor.account_id,
            observed_at=datetime.now(timezone.utc), request_ref=uuid4().hex,
        )
    except Exception:
        getattr(request.app.state, "logger", logging.getLogger(__name__)).warning(
            "The album's artist could not be assigned.")
        raise HTTPException(503, "The album's artist could not be saved. Try again shortly.") from None
    if outcome == "changed":
        raise HTTPException(409, "This album changed, so nothing was saved. Reload Problematic Files.")
    if outcome != "assigned":
        raise HTTPException(404, "Album was not found.")
    return {"assigned": True}


def _repository(request: Request):
    repository = getattr(request.app.state, "musicbrainz_album_identity_repository", None)
    if repository is not None:
        return repository
    from music_app.services.musicbrainz_album_identity_postgres import MusicBrainzAlbumIdentityPostgresRepository

    return MusicBrainzAlbumIdentityPostgresRepository(request.app.state.config)
