"""Discogs, asked about a matched band's album that MusicBrainz lacks (Delivery 2; owner
2026-11-21: "not found on MusicBrainz/Discogs" means found in neither).

The artist fallback asks only for artists MusicBrainz did not find, so this asks album by
album: the local artist name, then MusicBrainz's name, by the fallback's own rule for a
certain release. Only an answer is stored; an outage leaves the album waiting. A job covers
one artist and is queued for that artist alone: there is no sweep over the library.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services.musicbrainz_discogs_fallback import job_retry_delay, search_certain_release

# A search and two releases for each of the two names, so six requests an album.
MAX_ALBUMS_PER_JOB = 20


def lookup_album(album: dict[str, object], *, discogs) -> dict[str, object]:
    """``found`` with the release, ``not_found``, or why Discogs did not answer."""
    names = {}
    for value in (album.get("local_name"), album.get("canonical_name")):
        name = str(value or "").strip()
        if name:
            names.setdefault(name.casefold(), name)
    result = {"classification": "invalid_request"}
    for name in names.values():
        result = search_certain_release(album, artist_name=name, barcode=None, discogs=discogs)
        if result["classification"] != "not_found":
            break
    return result


class AlbumDiscogsLookupProcessor:
    """Runs one queued artist's lookups."""

    def __init__(self, *, repository, discogs, now=None, max_attempts: int = 6) -> None:
        self._repository = repository
        self._discogs = discogs
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lease = timedelta(minutes=10)
        self._max_attempts = max_attempts

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        observed_at = self._now()
        job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at, lease_duration=self._lease)
        if not job:
            return {"processed": False, "state": "idle"}
        job_id, attempts = int(job["id"]), int(job.get("attempt_count") or 0)
        albums = self._repository.load_albums(job_id=job_id, worker_id=worker_id, limit=MAX_ALBUMS_PER_JOB,
                                              observed_at=observed_at)
        for album in albums:
            result = lookup_album(album, discogs=self._discogs)
            classification = str(result["classification"])
            if classification not in {"found", "not_found"}:
                delay = job_retry_delay(classification, attempts=attempts, max_attempts=self._max_attempts)
                state = "exhausted" if delay is None else "retry_wait"
                self._repository.finish(job_id=job_id, worker_id=worker_id, state=state,
                                        classification=classification, observed_at=observed_at,
                                        retry_at=None if delay is None else observed_at + delay)
                return {"processed": True, "state": state, "classification": classification, "job_id": job_id}
            self._repository.record(job_id=job_id, worker_id=worker_id, album=album, found=result.get("album"),
                                    observed_at=observed_at)
        self._repository.finish(job_id=job_id, worker_id=worker_id, state="succeeded", classification="complete",
                                observed_at=observed_at)
        if len(albums) == MAX_ALBUMS_PER_JOB:
            self._repository.enqueue(local_artist_id=int(job["local_artist_id"]), observed_at=observed_at,
                                     reason="album_discogs_lookup_continues")
        return {"processed": True, "state": "succeeded", "job_id": job_id}
