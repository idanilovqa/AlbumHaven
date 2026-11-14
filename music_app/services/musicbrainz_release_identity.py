"""Local album → MusicBrainz release group and release (Delivery 2).

Each local album of a matched artist is compared with that artist's releases by the same
evidence rules that decide the artist (matcher 5): tracks first (count, titles, lengths),
then the title, never a cleaned-up title alone.

- ``release``: the album certainly is one release (title, track titles and track count
  agree), so its release group, types, genres, media and track credits are known.
- ``release_group``: the title and one or more other signals agree with a release group,
  but no release's tracks prove which one.
- ``unresolved``: kept with a diagnostic saying why.

Nothing here creates gallery entries or writes media tags: the results enrich local albums
only, and are display data until the owner approves a correction.
"""
from __future__ import annotations

import re

from music_app.services.musicbrainz_evidence import (
    _compact,
    _starts_remote_title,
    _track_title_forms,
    album_signals,
    fold,
)
from music_app.services.musicbrainz_enrichment import (
    _MAX_BROWSE_PAGES,
    _Mirror,
    _ProviderFailure,
    _compare_tracks,
    _fetch_tracks,
    _gather_album_evidence,
    _match_box_set_discs,
    _match_release_titles,
    _match_tracks_alone,
)

RELEASE_MATCHER_VERSION = 1
# Per artist group: the shared browses plus, per album, its tracklists and the lookups of
# the chosen release group and release.
_BASE_REQUESTS = 40
_REQUESTS_PER_ALBUM = 6
_MAX_REQUESTS = 400
_CERTAIN_SIGNALS = frozenset({"track_list", "track_count"})

DIAGNOSTICS = {
    "no_title_match": "No release of this artist on MusicBrainz has this album's title.",
    "tracks_differ": "A release with this title exists, but its tracks differ from this album's.",
    "title_only": "Only the title agrees; the year, track count and tracks do not confirm it.",
    "budget_exhausted": "MusicBrainz was not asked about this album yet; it is retried on the next sync.",
}


def resolve_album_releases(context: dict[str, object], *, client) -> dict[str, object]:
    """Decide the release of each album in ``context['albums']`` for one MusicBrainz artist
    (``artist_mbid``, ``canonical_name``), named locally ``local_name``."""
    albums = [dict(album) for album in context.get("albums") or [] if isinstance(album, dict) and album.get("title")]
    budget = min(_MAX_REQUESTS, _BASE_REQUESTS + _REQUESTS_PER_ALBUM * len(albums))
    mirror = _Mirror(client, budget)
    try:
        return _resolve(context, albums, mirror)
    except _ProviderFailure as failure:
        return failure.outcome


def _resolve(context: dict[str, object], albums: list[dict[str, object]], mirror: _Mirror) -> dict[str, object]:
    local_name = str(context.get("local_name") or "").strip()
    candidate = {"mbid": str(context["artist_mbid"]).lower(), "canonical_name": context.get("canonical_name") or "",
                 "credits": {}, "releases": {}}
    names = tuple(name for name in (local_name, candidate["canonical_name"]) if name)
    _gather_album_evidence(candidate, albums, local_name, mirror, pages=_MAX_BROWSE_PAGES)
    if candidate.get("albums") is None:
        return {"classification": "complete", "albums": [_unresolved(album, "budget_exhausted") for album in albums],
                "release_groups": {}, "releases": {}}
    _match_release_titles(candidate, albums, names, mirror)
    _compare_tracks(candidate, albums, mirror)
    _match_tracks_alone(candidate, albums, mirror)
    _match_box_set_discs(candidate, albums, local_name, mirror)
    # The artist matcher stops comparing an album once its year and track count agree; a
    # release is certain only on its tracks, so every titled album gets its tracklist.
    for album, evidence in zip(albums, candidate["albums"]):
        if evidence.get("title") and evidence.get("level") and not (evidence.get("remote") or {}).get("tracks") \
                and _fetch_tracks(evidence, album, mirror) is None:
            break

    results, release_groups, releases = [], {}, {}
    for album, evidence in zip(albums, candidate["albums"]):
        result = _decision(album, evidence)
        results.append(result)
        group_id = result.get("release_group_mbid")
        if group_id and group_id not in release_groups:
            found = mirror.call("lookup_release_group", group_id)
            if found and found.get("release_group"):
                release_groups[group_id] = found["release_group"]
        release_id = result.get("release_mbid")
        if release_id and release_id not in releases:
            found = mirror.call("lookup_release_tracklist", release_id)
            if found and found.get("release"):
                releases[release_id] = found["release"]
    for result in results:
        if result.get("release_group_mbid") and result["release_group_mbid"] not in release_groups:
            # Without the group's own data the album is retried rather than half-stored.
            result.update(_unresolved({"id": result["local_album_id"], "title": result["local_title"]},
                                      "budget_exhausted"))
        elif result.get("release_mbid") and result["release_mbid"] not in releases:
            result.update(state="release_group", release_mbid=None)
    for album, result in zip(albums, results):
        release = releases.get(result.get("release_mbid") or "")
        if not release:
            continue
        result["track_artists"] = display_track_artists(album.get("tracks") or [], release)
        discs = local_discs(album.get("tracks") or [])
        original = None
        if len(discs) > 1 and not result.get("disc_position"):
            found = mirror.call("original_release_id", result["release_group_mbid"])
            original_id = (found or {}).get("release_id")
            if original_id and original_id not in releases:
                looked_up = mirror.call("lookup_release_tracklist", original_id)
                if looked_up and looked_up.get("release"):
                    releases[original_id] = looked_up["release"]
            original = releases.get(original_id or "")
            if original:
                result["original_release_mbid"] = original_id
        result["main_disc"] = main_disc_count(discs, original=original, matched=release)
    return {"classification": "complete", "albums": results, "release_groups": release_groups, "releases": releases}


def _unresolved(album: dict[str, object], diagnostic: str) -> dict[str, object]:
    return {"local_album_id": album.get("id"), "local_title": album.get("title"), "state": "unresolved",
            "release_group_mbid": None, "release_mbid": None, "disc_position": None, "signals": [],
            "diagnostic": diagnostic}


def _decision(album: dict[str, object], evidence: dict[str, object]) -> dict[str, object]:
    signals = set(evidence.get("signals") or ())
    level = evidence.get("level")
    if not evidence.get("title") or not evidence.get("group"):
        return _unresolved(album, "no_title_match")
    if "tracks_differ" in signals and level is None:
        return _unresolved(album, "tracks_differ")
    if level not in {"strong", "agree"}:
        return _unresolved(album, "title_only")
    certain = level == "strong" and _CERTAIN_SIGNALS <= signals and evidence.get("release_id")
    return {"local_album_id": album.get("id"), "local_title": album.get("title"),
            "state": "release" if certain else "release_group",
            "release_group_mbid": evidence["group"].get("id"),
            "release_mbid": evidence.get("release_id") if certain else None,
            "disc_position": evidence.get("disc"), "signals": sorted(signals), "diagnostic": None}


# A medium that is not part of the original album: "Bonus Disc", "Bonus CD", "Extras",
# "Live at …" on a deluxe edition. Plain "CD 2" says nothing.
_BONUS_MEDIUM = re.compile(r"\b(?:bonus|extras?|bonus\s+tracks?|b-sides|rarities|demos?)\b", re.IGNORECASE)


def _disc_agrees(local_tracks: list[dict[str, object]], medium: dict[str, object]) -> bool:
    remote = {"tracks": [{"title": track.get("title"), "length": track.get("length")}
                         for track in medium.get("tracks") or []]}
    if not remote["tracks"]:
        remote["track_count"] = medium.get("track_count")
        return bool(local_tracks) and abs(len(local_tracks) - int(medium.get("track_count") or 0)) <= 1
    signals = album_signals({"tracks": local_tracks}, remote)
    return "track_count" in signals and bool(signals & {"track_list", "durations"})


def local_discs(tracks: list[dict[str, object]]) -> list[list[dict[str, object]]]:
    """The album's tracks grouped by disc number (an untagged disc counts as disc 1), in order."""
    discs: dict[int, list[dict[str, object]]] = {}
    for track in tracks:
        discs.setdefault(int(track.get("disc_number") or 1), []).append(track)
    return [sorted(discs[number], key=lambda track: int(track.get("track_number") or 0)) for number in sorted(discs)]


def main_disc_count(local_discs: list[list[dict[str, object]]], *, original: dict[str, object] | None,
                    matched: dict[str, object] | None) -> dict[str, object] | None:
    """How many of the local album's discs, in order, are the main album (owner 2026-11-08).

    ``local_discs`` holds each local disc's tracks in disc order. Evidence order:
    1. the release group's original release: its media, matched to the local discs by
       track count and titles or lengths, are the main album and any later local disc is a
       bonus;
    2. medium titles on the matched release: media after the last one without bonus wording.
    None keeps today's local guess (no match, or no clear answer)."""
    if not local_discs:
        return None
    if len(local_discs) == 1:
        return {"main_disc_count": 1, "source": "single_disc"}
    media = (original or {}).get("media") or []
    if media and len(media) <= len(local_discs) and all(
            _disc_agrees(local_discs[index], medium) for index, medium in enumerate(media)):
        return {"main_disc_count": len(media), "source": "original_release"}
    matched_media = (matched or {}).get("media") or []
    if len(matched_media) == len(local_discs) and all(
            _disc_agrees(local, medium) for local, medium in zip(local_discs, matched_media)):
        bonus = [bool(_BONUS_MEDIUM.search(str(medium.get("title") or ""))) for medium in matched_media]
        if any(bonus) and not bonus[0] and bonus == sorted(bonus):
            # Main discs first, then only bonus discs.
            return {"main_disc_count": bonus.index(True), "source": "medium_titles"}
    return None


# A track artist the tag lost: only question marks or replacement characters ("??" in
# Latin-1 for 天門), or empty.
_LOST_TEXT = re.compile(r"^[\s?�]*$")


def credit_text(credit: list[dict[str, object]]) -> str:
    """An artist credit as MusicBrainz writes it: each name followed by its join phrase."""
    return "".join(f"{part.get('name') or part.get('artist_name') or ''}{part.get('join_phrase') or ''}"
                   for part in credit or []).strip()


def _same_track_title(local: object, remote: object) -> bool:
    """The matcher's own track-title agreement: brackets, spacing and ID3v1 truncation aside."""
    return bool(_track_title_forms(local) & _track_title_forms(remote)) or _starts_remote_title(
        local, {_compact(fold(remote))} - {""})


def display_track_artists(local_tracks: list[dict[str, object]], release: dict[str, object]) -> list[dict[str, object]]:
    """Track artists to show instead of unreadable tags, from the certainly matched release.

    A local track takes the release track at its own disc and position, only when the
    titles agree; readable local artists are never replaced. Display only: tags change
    through an approved correction (Delivery 3)."""
    by_position = {(int(medium.get("position") or 1), int(track.get("position") or 0)): track
                   for medium in release.get("media") or [] for track in medium.get("tracks") or []}
    shown = []
    for track in local_tracks:
        if not _LOST_TEXT.match(str(track.get("artist") or "")):
            continue
        remote = by_position.get((int(track.get("disc_number") or 1), int(track.get("track_number") or 0)))
        if not remote or not _same_track_title(track.get("title"), remote.get("title")):
            continue
        text = credit_text(remote.get("artist_credit") or [])
        if text:
            shown.append({"disc_number": int(track.get("disc_number") or 1),
                          "track_number": int(track.get("track_number") or 0), "artist": text,
                          "artist_mbids": [part["artist_mbid"] for part in remote.get("artist_credit") or []]})
    return shown


def resulting_type(primary_type: object, secondary_types: list[object] | None) -> str | None:
    """The type shown for a local release: the primary type, then its secondary types
    ("Album + Live"). Raw values are stored as MusicBrainz gives them."""
    parts = [str(primary_type)] if primary_type else []
    parts += [str(kind) for kind in secondary_types or [] if kind]
    return " + ".join(parts) or None


class MusicBrainzAlbumReleaseProcessor:
    """Runs one album-release job: the leased artist's albums, per MusicBrainz artist."""

    def __init__(self, *, repository, client, now=None, lease_duration=None, max_attempts: int = 6,
                 sweep_interval=None) -> None:
        from datetime import datetime, timedelta, timezone

        self._repository = repository
        self._client = client
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lease_duration = lease_duration or timedelta(minutes=10)
        self._max_attempts = max_attempts
        self._sweep_interval = sweep_interval or timedelta(minutes=15)
        self._last_sweep = None

    def queue_artist(self, local_artist_id: int) -> None:
        """The artist's own match was just decided: compare its albums again."""
        self._repository.enqueue(reason="artist_identity_changed", observed_at=self._now(),
                                 local_artist_id=local_artist_id, force=True)

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        from music_app.services.musicbrainz_enrichment import retry_delay

        observed_at = self._now()
        job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at,
                                             lease_duration=self._lease_duration)
        if not job and (self._last_sweep is None or observed_at - self._last_sweep >= self._sweep_interval):
            # New identities, new albums, an older matcher or stale decisions.
            self._last_sweep = observed_at
            if self._repository.enqueue(reason="album_release_sweep", observed_at=observed_at):
                job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at,
                                                     lease_duration=self._lease_duration)
        if not job:
            return {"processed": False, "state": "idle"}
        job_id = int(job["id"])
        outcomes = []
        for context in self._repository.load_context(job_id=job_id, worker_id=worker_id):
            outcome = resolve_album_releases(context, client=self._client)
            classification = str(outcome.get("classification") or "invalid_response")
            if classification != "complete":
                delay = retry_delay(classification, attempt_count=int(job.get("attempt_count") or 0),
                                    retry_after_seconds=outcome.get("retry_after_seconds"))
                exhausted = delay is None or int(job.get("attempt_count") or 0) >= self._max_attempts
                self._repository.finish(job_id=job_id, worker_id=worker_id,
                                        state="exhausted" if exhausted else "retry_wait",
                                        classification=classification, observed_at=observed_at,
                                        retry_at=None if exhausted else observed_at + delay,
                                        safe_error=str(outcome.get("safe_error") or "")[:1024] or None)
                result = {"processed": True, "state": "exhausted" if exhausted else "retry_wait",
                          "classification": classification, "job_id": job_id}
                if classification == "rate_limited" and delay is not None:
                    result["cooldown_seconds"] = delay.total_seconds()
                return result
            outcomes.append({**outcome, "artist_mbid": context.get("artist_mbid")})
        self._repository.record(job_id=job_id, worker_id=worker_id, outcomes=outcomes, observed_at=observed_at)
        self._repository.finish(job_id=job_id, worker_id=worker_id, state="succeeded", classification="complete",
                                observed_at=observed_at)
        return {"processed": True, "state": "succeeded", "job_id": job_id}


class ArtistThenAlbumProcessor:
    """Artists first (Delivery 1), then their albums (Delivery 2), in one enrichment queue."""

    def __init__(self, artist_processor, album_processor) -> None:
        self._artists = artist_processor
        self._albums = album_processor

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        result = self._artists.process_next(worker_id=worker_id)
        if result.get("processed"):
            if result.get("state") == "succeeded" and result.get("local_artist_id"):
                self._albums.queue_artist(int(result["local_artist_id"]))
            return result
        return self._albums.process_next(worker_id=worker_id)
