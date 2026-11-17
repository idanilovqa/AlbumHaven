"""Discogs fallback for artists and albums MusicBrainz lacks, then MusicBrainz again
(MusicBrainz Delivery 2, S3; owner 2026-11-07 and 2026-11-09).

1. Discogs: the artist by name (Discogs numbers namesakes, "Amarok (2)"), then each local
   album against that artist's masters and releases by title ("original = translation"
   titles included) and, decisively, by tracks: the same bar as MusicBrainz, a release is
   certain on its title, track titles and track count.
2. MusicBrainz again, with what Discogs proved: a certain release's barcode leads to the
   MusicBrainz release and its credited artist; the Discogs artist's aliases, real name and
   name variations are searched as names.
3. What MusicBrainz still lacks keeps its Discogs IDs, marked Discogs-derived, and the
   artist is flagged "remote info update needed" for the future contribution feature.

MusicBrainz stays authoritative: a MusicBrainz artist found here is only a hint the artist
matcher still has to prove on album evidence. Nothing writes media tags.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services.discogs_metadata import DiscogsMetadataClient
from music_app.services.musicbrainz_enrichment import retry_delay
from music_app.services.musicbrainz_evidence import (
    SPECIAL_PURPOSE_ARTISTS,
    album_level,
    album_signals,
    candidate_name_keys,
    name_keys,
    title_agreement,
)
from music_app.services.tracklist_sections import discogs_sections, local_discs

_MAX_ARTISTS = 3
_MAX_RELEASES_PER_ALBUM = 2
# The search, the artist and its release list, then up to two releases per album.
_BASE_DISCOGS_REQUESTS = 6
_DISCOGS_REQUESTS_PER_ALBUM = 3
_MAX_DISCOGS_REQUESTS = 120
_MAX_BARCODES = 6
_MAX_NAME_SEARCHES = 4
_CERTAIN = frozenset({"track_list", "track_count"})


class _Budget:
    def __init__(self, requests: int) -> None:
        self.remaining = requests


class _Failure(Exception):
    def __init__(self, classification: str) -> None:
        super().__init__(classification)
        self.classification = classification


def _call(budget: _Budget, method, *args, **kwargs):
    if budget.remaining <= 0:
        return None
    budget.remaining -= 1
    result = method(*args, **kwargs)
    if result.get("classification") not in {"complete", "not_found"}:
        raise _Failure(str(result.get("classification") or "provider_unavailable"))
    return result


def _title_parts(title: str) -> list[str]:
    """A Discogs title and, for "original = translation", each side of it."""
    parts = [title] + [part.strip() for part in title.split(" = ")] if " = " in title else [title]
    return [part for part in dict.fromkeys(parts) if part]


def _agreement(local_title: str, remote_title: str, names: tuple[str, ...]) -> str | None:
    for part in _title_parts(remote_title):
        agreement = title_agreement(local_title, part, names)
        if agreement:
            return agreement
    return None


def resolve_with_discogs(context: dict[str, object], *, discogs: DiscogsMetadataClient, musicbrainz) -> dict[str, object]:
    """``context``: ``local_name`` and ``albums`` (id, title, year, tracks) of one local artist
    MusicBrainz could not identify."""
    try:
        albums = len(context.get("albums") or [])
        budget = min(_MAX_DISCOGS_REQUESTS, _BASE_DISCOGS_REQUESTS + _DISCOGS_REQUESTS_PER_ALBUM * albums)
        return _resolve(context, discogs, musicbrainz, _Budget(budget))
    except _Failure as failure:
        return {"classification": failure.classification}


def _resolve(context, discogs, musicbrainz, budget) -> dict[str, object]:
    local_name = str(context.get("local_name") or "").strip()
    local_keys = name_keys(local_name)
    albums = [album for album in context.get("albums") or [] if isinstance(album, dict) and album.get("title")]
    search = _call(budget, discogs.search_artists, local_name)
    named = [artist for artist in (search or {}).get("artists") or [] if name_keys(artist["name"]) & local_keys]
    best = None
    for candidate in named[:_MAX_ARTISTS]:
        found = _match_albums(candidate, albums, local_name, discogs, budget)
        if found and (best is None or len(found) > len(best[1])):
            best = (candidate, found)
    if best is None:
        return {"classification": "not_found", "albums": [], "musicbrainz_hints": [], "remote_info_needed": True,
                "evidence_summary": "Neither MusicBrainz nor Discogs has an artist with these albums."}
    candidate, matched = best
    detail = _call(budget, discogs.artist, candidate["id"])
    artist = (detail or {}).get("artist") or {"id": candidate["id"], "name": candidate["name"]}
    hints = _musicbrainz_hints(artist, matched, musicbrainz)
    return {
        "classification": "found", "discogs_artist": artist, "albums": matched, "musicbrainz_hints": hints,
        # Whatever MusicBrainz still lacks is collected for the future contribution feature.
        "remote_info_needed": not any(hint["via"] == "barcode" for hint in hints),
        "evidence_summary": (f"Found on Discogs with {len(matched)} of your album"
                             f"{'' if len(matched) == 1 else 's'}; " +
                             ("MusicBrainz has it under another name." if hints else "MusicBrainz does not have it yet.")),
    }


def _match_albums(candidate, albums, local_name, discogs, budget) -> list[dict[str, object]]:
    """Local albums one of the candidate's Discogs releases certainly is."""
    listing = _call(budget, discogs.artist_releases, candidate["id"])
    items = (listing or {}).get("releases") or []
    names = (local_name, candidate["name"])
    matched = []
    for album in albums:
        titled = [(item, _agreement(album["title"], item["title"], names)) for item in items]
        titled = [(item, agreement) for item, agreement in titled if agreement]
        for item, agreement in titled[:_MAX_RELEASES_PER_ALBUM]:
            release_id = item["main_release"] if item["kind"] == "master" else item["id"]
            if not release_id:
                continue
            found = _call(budget, discogs.release, release_id)
            release = (found or {}).get("release")
            if not release:
                continue
            found_album = _certain_album(album, agreement, release, release.get("year") or item.get("year"))
            if found_album:
                matched.append(found_album)
                break
    return matched


def _certain_album(album, agreement, release, year) -> dict[str, object] | None:
    """The release, or one disc of a multi-disc release (a local album of disc 1 of Keep
    Rockin's two CDs), when its title, track titles and track count agree."""
    discs = sorted({track["disc"] for track in release["tracks"]})
    candidates = [(None, release["tracks"])]
    if len(discs) > 1:
        candidates += [(disc, [track for track in release["tracks"] if track["disc"] == disc]) for disc in discs]
    for disc, tracks in candidates:
        signals = album_signals(album, {"first_release_date": year, "tracks": tracks})
        if album_level(agreement, signals) == "strong" and _CERTAIN <= signals:
            return {"local_album_id": album.get("id"), "local_title": album["title"],
                    "discogs_release_id": release["id"], "discogs_master_id": release.get("master_id"),
                    "discogs_title": release["title"], "discogs_year": release.get("year"), "disc_position": disc,
                    # The whole release is stored; ``disc_position`` names the disc that matched.
                    "barcodes": release["barcodes"], "signals": sorted(signals), "tracks": release["tracks"],
                    "track_sections": discogs_sections(local_discs(album.get("tracks") or []), tracks)}
    return None


# A barcode search, an artist and title search, and two releases from each.
_SEARCH_REQUESTS = 6
_SEARCH_RELEASES = 2


def search_certain_release(album: dict[str, object], *, artist_name: str, barcode: str | None,
                           discogs: DiscogsMetadataClient) -> dict[str, object]:
    """The Discogs release a local album certainly is, found by search (S8: a " / " album whose
    MusicBrainz release links to no Discogs release): the MusicBrainz barcode first, then the
    artist and title. A candidate counts only by the fallback's own rule (title, track titles
    and track count, a whole release or one disc). ``classification`` is "found" (with
    ``album``), "not_found" when nothing is certain, or why Discogs did not answer."""
    budget = _Budget(_SEARCH_REQUESTS)
    names = (artist_name,)
    # Discogs spells the apostrophe straight; local titles often carry the curly one (U+2019).
    searches = ([{"barcode": barcode}] if barcode else []) + [
        {"artist": artist_name, "title": str(album.get("title") or "").replace("’", "'")}]
    try:
        for search in searches:
            found = _call(budget, discogs.search_releases, **search)
            for candidate in ((found or {}).get("releases") or [])[:_SEARCH_RELEASES]:
                looked_up = _call(budget, discogs.release, candidate["id"])
                release = (looked_up or {}).get("release")
                agreement = release and _agreement(str(album.get("title") or ""), release["title"], names)
                certain = agreement and _certain_album(album, agreement, release, release.get("year"))
                if certain:
                    return {"classification": "found", "album": certain}
    except _Failure as failure:
        return {"classification": failure.classification}
    return {"classification": "not_found"}


def _musicbrainz(method, *args):
    """A MusicBrainz outage retries the fallback; it never reads as "MusicBrainz lacks it"."""
    result = method(*args)
    if result.get("classification") not in {"complete", "not_found", "invalid_request"}:
        raise _Failure(str(result.get("classification") or "provider_unavailable"))
    return result


def _musicbrainz_hints(artist, matched, musicbrainz) -> list[dict[str, object]]:
    """MusicBrainz artists Discogs leads to: by a certain release's barcode, then by the
    Discogs artist's other names. Hints only; the artist matcher still decides."""
    hints: dict[str, dict[str, object]] = {}
    barcodes = [barcode for album in matched for barcode in album["barcodes"]][:_MAX_BARCODES]
    for barcode in barcodes:
        found = _musicbrainz(musicbrainz.search_releases_by_barcode, barcode)
        for release in found.get("releases") or []:
            for credit in release.get("credits") or []:
                mbid = str(credit.get("artist_mbid") or "")
                if mbid and mbid not in SPECIAL_PURPOSE_ARTISTS and mbid not in hints:
                    hints[mbid] = {"artist_mbid": mbid, "via": "barcode", "barcode": barcode,
                                   "release_mbid": release["id"], "name": credit.get("artist_name")}
    other_names = [artist.get("real_name"), *(artist.get("name_variations") or []),
                   *(alias["name"] for alias in artist.get("aliases") or [])]
    for name in [name for name in dict.fromkeys(other_names) if name][:_MAX_NAME_SEARCHES]:
        found = _musicbrainz(musicbrainz.search_artists, name)
        for candidate in found.get("candidates") or []:
            mbid = str(candidate.get("mbid") or "")
            if mbid and mbid not in hints and mbid not in SPECIAL_PURPOSE_ARTISTS \
                    and candidate_name_keys(candidate) & name_keys(name):
                hints[mbid] = {"artist_mbid": mbid, "via": "name", "name": name}
    return list(hints.values())


class DiscogsFallbackProcessor:
    """Runs one fallback job: the leased artist MusicBrainz did not find, against Discogs."""

    def __init__(self, *, repository, discogs: DiscogsMetadataClient, musicbrainz, now=None, sweep_interval=None,
                 max_attempts: int = 6) -> None:
        self._repository = repository
        self._discogs = discogs
        self._musicbrainz = musicbrainz
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lease = timedelta(minutes=10)
        self._sweep_interval = sweep_interval or timedelta(minutes=30)
        self._max_attempts = max_attempts
        self._last_sweep = None

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        observed_at = self._now()
        job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at, lease_duration=self._lease)
        if not job and (self._last_sweep is None or observed_at - self._last_sweep >= self._sweep_interval):
            self._last_sweep = observed_at
            if self._repository.enqueue(reason="discogs_fallback_sweep", observed_at=observed_at):
                job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at, lease_duration=self._lease)
        if not job:
            return {"processed": False, "state": "idle"}
        job_id, attempts = int(job["id"]), int(job.get("attempt_count") or 0)
        context = self._repository.load_context(job_id=job_id, worker_id=worker_id) or {}
        outcome = resolve_with_discogs(context, discogs=self._discogs, musicbrainz=self._musicbrainz)
        classification = str(outcome.get("classification") or "provider_unavailable")
        if classification not in {"found", "not_found"}:
            # Discogs' rate limit and outages are transient: retry with backoff.
            delay = retry_delay("provider_unavailable" if classification != "rate_limited" else classification,
                                attempt_count=attempts)
            exhausted = delay is None or attempts >= self._max_attempts
            self._repository.finish(job_id=job_id, worker_id=worker_id, state="exhausted" if exhausted else "retry_wait",
                                    classification=classification, observed_at=observed_at,
                                    retry_at=None if exhausted else observed_at + delay)
            return {"processed": True, "state": "exhausted" if exhausted else "retry_wait",
                    "classification": classification, "job_id": job_id}
        self._repository.record(job_id=job_id, worker_id=worker_id, outcome=outcome, observed_at=observed_at)
        self._repository.finish(job_id=job_id, worker_id=worker_id, state="succeeded", classification=classification,
                                observed_at=observed_at)
        return {"processed": True, "state": "succeeded", "job_id": job_id}
