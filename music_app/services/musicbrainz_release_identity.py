"""Local album → MusicBrainz release group and release (Delivery 2).

Each local album of a matched artist is compared with that artist's releases by the same
evidence rules that decide the artist (matcher 5): tracks first (count, titles, lengths),
then the title, never a cleaned-up title alone.

- ``release``: the album certainly is one release (title, track titles and track count
  agree), so its release group, types, genres, media and track credits are known.
- ``release_group``: the title and one or more other signals agree with a release group,
  but no release's tracks prove which one.
- ``unresolved``: kept with a diagnostic saying why.

A local artist with no MusicBrainz identity (a collaboration, a credited performer, "Various
Artists") has each album searched by its title instead; a certain release's artist credit
then names the album's artists (Delivery 2, S2).

Nothing here creates gallery entries or writes media tags: the results enrich local albums
only, and are display data until the owner approves a correction.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from music_app.services.musicbrainz_evidence import (
    TITLE_RANK,
    album_level,
    album_rank,
    album_signals,
    title_agreement,
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
    retry_delay,
)
from music_app.services.musicbrainz_discogs_fallback import search_certain_release
from music_app.services.musicbrainz_track_order import pair_tracks, same_track_title
from music_app.services.track_transliteration import needs_transliteration, transliteration_media
from music_app.services.tracklist_sections import (
    discogs_sections,
    local_discs,
    musicbrainz_sections,
    section_retry_at,
    wants_discogs_sections,
)

# 2: release groups and releases are looked up with the series they are part of (S6), so
# decisions stored before that are made again. 3: tracklist sub-sections (S8). 4: the edition
# whose track order matches the local files, and the track pairing (owner 2026-11-16).
RELEASE_MATCHER_VERSION = 4
# Per artist group: the shared browses plus, per album, its tracklists and the lookups of
# the chosen release group and release.
_BASE_REQUESTS = 40
_REQUESTS_PER_ALBUM = 10
_MAX_REQUESTS = 800
_CERTAIN_SIGNALS = frozenset({"track_list", "track_count"})
# Release searches for an album of an artist without an identity, in the artist matcher's
# order: (with the local name as the credited name, as a phrase); then the closest releases.
_CREDIT_SEARCHES = ((True, True), (True, False), (False, True), (False, False))
_MAX_CREDIT_RELEASES = 3
_SERIES_SIZED_PER_JOB = 10

DIAGNOSTICS = {
    "no_title_match": "No release of this artist on MusicBrainz has this album's title.",
    "tracks_differ": "A release with this title exists, but its tracks differ from this album's.",
    "title_only": "Only the title agrees; the year, track count and tracks do not confirm it.",
    "budget_exhausted": "MusicBrainz was not asked about this album yet; it is retried on the next sync.",
}


def resolve_album_releases(context: dict[str, object], *, client) -> dict[str, object]:
    """Decide the release of each album in ``context['albums']`` for one MusicBrainz artist
    (``artist_mbid``, ``canonical_name``), named locally ``local_name``; without an
    ``artist_mbid``, by each album's release credits."""
    albums = [dict(album) for album in context.get("albums") or [] if isinstance(album, dict) and album.get("title")]
    budget = min(_MAX_REQUESTS, _BASE_REQUESTS + _REQUESTS_PER_ALBUM * len(albums))
    mirror = _Mirror(client, budget)
    try:
        return _resolve(context, albums, mirror)
    except _ProviderFailure as failure:
        return failure.outcome


def _resolve(context: dict[str, object], albums: list[dict[str, object]], mirror: _Mirror) -> dict[str, object]:
    local_name = str(context.get("local_name") or "").strip()
    if not context.get("artist_mbid"):
        return _resolve_by_credit(albums, local_name, mirror)
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

    return _complete(albums, [_decision(album, evidence) for album, evidence in zip(albums, candidate["albums"])],
                     mirror, {})


def _complete(albums: list[dict[str, object]], results: list[dict[str, object]], mirror: _Mirror,
              releases: dict[str, dict[str, object]]) -> dict[str, object]:
    """Each decided album's release group and release data, its main-album end and the
    track artists its tags lost. ``releases`` holds tracklists already fetched."""
    release_groups = {}
    for result in results:
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
    # Albums of one release group share its answers: each lookup is asked once per resolve.
    asked: dict[tuple[str, str], object] = {}
    for album, result in zip(albums, results):
        release = releases.get(result.get("release_mbid") or "")
        if not release:
            continue
        release = _choose_edition(album, result, release, mirror, releases, asked)
        result["track_artists"] = display_track_artists(album.get("tracks") or [], release,
                                                        pairing=result["edition"]["track_pairing"])
        discs = local_discs(album.get("tracks") or [])
        result["track_sections"] = musicbrainz_sections(discs, release)
        original, fewest_discs = None, None
        if len(discs) > 1 and not result.get("disc_position"):
            found = _ask_once(asked, mirror, "original_release_id", result["release_group_mbid"])
            fewest_discs = (found or {}).get("fewest_discs")
            original_id = (found or {}).get("release_id")
            if original_id and original_id not in releases:
                looked_up = _ask_once(asked, mirror, "lookup_release_tracklist", original_id)
                if looked_up and looked_up.get("release"):
                    releases[original_id] = looked_up["release"]
            original = releases.get(original_id or "")
            if original:
                result["original_release_mbid"] = original_id
        result["main_disc"] = main_disc_count(discs, original=original, matched=release, fewest_discs=fewest_discs)
    return {"classification": "complete", "albums": results, "release_groups": release_groups, "releases": releases}


# Same-length editions whose tracklists the order choice fetches, nearest length first.
_MAX_EDITIONS = 3


def _edition_rank(paired: dict[str, object]) -> tuple[bool, bool, int]:
    return paired["quality"] == "order_exact", paired["quality"] != "ambiguous", paired["aligned"]


def _ask_once(asked: dict[tuple[str, str], object], mirror: _Mirror, method: str, mbid: str):
    """One mirror answer per (lookup, MBID) within a resolve; a lookup the budget skipped
    (None) is asked again by the next album."""
    if (method, mbid) not in asked:
        found = mirror.call(method, mbid)
        if found is None:
            return None
        asked[(method, mbid)] = found
    return asked[(method, mbid)]


def _choose_edition(album: dict[str, object], result: dict[str, object], release: dict[str, object],
                    mirror: _Mirror, releases: dict[str, dict[str, object]],
                    asked: dict[tuple[str, str], object]) -> dict[str, object]:
    """The edition whose track order best matches the local files (owner 2026-11-16): the
    certainly matched release unless another release of its group is certain too and keeps
    the local order better; then the existing choice. Only same-length editions' tracklists
    are fetched, and only when the first choice is not in the local order. One disc of a
    larger release is compared with its own medium and keeps its release."""
    tracks = [track for disc in local_discs(album.get("tracks") or []) for track in disc]
    disc = result.get("disc_position")
    medium = next((part for part in release.get("media") or [] if int(part.get("position") or 0) == disc), None)
    best_release, best = release, pair_tracks(tracks, {"media": [medium]} if medium else release)
    if best["quality"] != "order_exact" and not disc:
        listing = _ask_once(asked, mirror, "release_group_editions", result["release_group_mbid"]) or {}
        editions = sorted((edition for edition in listing.get("releases") or []
                           if edition["id"] != release["id"] and abs(edition["track_count"] - len(tracks)) <= 1),
                          key=lambda edition: (abs(edition["track_count"] - len(tracks)), edition["date"] or "9999"))
        for edition in editions[:_MAX_EDITIONS]:
            found = _ask_once(asked, mirror, "lookup_release_tracklist", edition["id"])
            if found is None:
                break
            candidate = found.get("release")
            remote = [track for part in (candidate or {}).get("media") or [] for track in part.get("tracks") or []]
            if not candidate or not _CERTAIN_SIGNALS <= album_signals({"tracks": tracks}, {"tracks": remote}):
                continue
            paired = pair_tracks(tracks, candidate)
            if _edition_rank(paired) > _edition_rank(best):
                best_release, best = candidate, paired
            if best["quality"] == "order_exact":
                break
    releases[best_release["id"]] = best_release
    result["release_mbid"] = best_release["id"]
    result["edition"] = {"match_quality": best["quality"], "track_pairing": best["pairing"],
                         "track_order_differs": best["quality"] != "order_exact"}
    return best_release


def _resolve_by_credit(albums: list[dict[str, object]], local_name: str, mirror: _Mirror) -> dict[str, object]:
    """Albums of a local artist with no MusicBrainz identity of its own: a collaboration
    ("Anderson/Wakeman"), a performer MusicBrainz credits with a composer ("Inna Poroshina"
    beside Dvořák) or a display name ("Various Artists"). Each album is searched by its
    title, the credited name first, then the title alone, as the artist matcher searches,
    and is compared with the closest releases' tracks. A certain release's artist credit
    then names the album's artists, in MusicBrainz's order; the local name never does."""
    results, releases = [], {}
    for album in albums:
        result, release = _credited_release(album, local_name, mirror)
        results.append(result)
        if release:
            releases[release["id"]] = release
    return _complete(albums, results, mirror, releases)


def _credited_release(album: dict[str, object], local_name: str,
                      mirror: _Mirror) -> tuple[dict[str, object], dict[str, object] | None]:
    hits = []
    for credit_name, phrase in _CREDIT_SEARCHES:
        found = mirror.call("search_releases", album["title"], credit_name=local_name if credit_name else None,
                            phrase=phrase)
        if found is None:
            return _unresolved(album, "budget_exhausted"), None
        for release in found.get("releases") or []:
            # A credited name may lead the title, as a composer does ("Dvořák: Complete Piano Works").
            credited = tuple(name for name in (local_name, *(part.get(key) for part in release.get("credits") or []
                                                             for key in ("name", "artist_name"))) if name)
            agreements = {title_agreement(album["title"], title, credited)
                          for title in (release.get("title"), release.get("release_group_title")) if title}
            agreement = next((level for level in ("exact", "fuzzy") if level in agreements), None)
            if agreement and release.get("id") and release.get("release_group_id"):
                hits.append((release, agreement))
        if hits:
            break
    if not hits:
        return _unresolved(album, "no_title_match"), None
    count = len(album.get("tracks") or [])
    hits.sort(key=lambda hit: (abs(int(hit[0].get("track_count") or 0) - count), TITLE_RANK[hit[1]]))
    best, best_release = None, None
    for release, agreement in hits[:_MAX_CREDIT_RELEASES]:
        found = mirror.call("lookup_release_tracklist", release["id"])
        if found is None:
            return _unresolved(album, "budget_exhausted"), None
        full = found.get("release")
        if not full:
            continue
        remote = {"first_release_date": release.get("date"),
                  "tracks": [track for medium in full.get("media") or [] for track in medium.get("tracks") or []]}
        signals = album_signals(album, remote)
        evidence = {"title": agreement, "group": {"id": release["release_group_id"]}, "signals": signals,
                    "level": album_level(agreement, signals), "release_id": release["id"], "disc": None}
        certain = evidence["level"] == "strong" and _CERTAIN_SIGNALS <= signals
        if certain or best is None or album_rank(evidence) > album_rank(best):
            best, best_release = evidence, full
        if certain:
            break
    if best is None:
        return _unresolved(album, "no_title_match"), None
    result = _decision(album, best)
    return result, best_release if result["state"] == "release" else None


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


def main_disc_count(local_discs: list[list[dict[str, object]]], *, original: dict[str, object] | None,
                    matched: dict[str, object] | None, fewest_discs: int | None = None) -> dict[str, object] | None:
    """How many of the local album's discs, in order, are the main album (owner 2026-11-08,
    2026-11-16).

    ``local_discs`` holds each local disc's tracks in disc order. Evidence order:
    0. the fewest audio discs any release of the group has: a one-disc version makes every
       later disc a bonus disc; when every version has two discs, both are the main album;
    1. the release group's original release: its media, matched to the local discs by
       track count and titles or lengths, are the main album and any later local disc is a
       bonus;
    2. medium titles on the matched release: media after the last one without bonus wording.
    None keeps today's local guess (no match, or no clear answer)."""
    if not local_discs:
        return None
    if len(local_discs) == 1:
        return {"main_disc_count": 1, "source": "single_disc"}
    if fewest_discs:
        return {"main_disc_count": min(fewest_discs, len(local_discs)), "source": "fewest_discs"}
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


def release_type_label(primary_type: object, secondary_types: object) -> str | None:
    """The release type album details show (owner 2026-11-15): an Album with secondary types
    is only those ("Live", "Compilation"), a plain Album is "Album", and any other primary type
    stays first ("EP • Live", "Single"). None without types, so the local tag keeps showing."""
    primary = str(primary_type or "").strip()
    secondary = [str(kind).strip() for kind in secondary_types if str(kind or "").strip()] \
        if isinstance(secondary_types, (list, tuple)) else []
    parts = secondary if secondary and primary.casefold() == "album" else [primary, *secondary]
    return " • ".join(part for part in parts if part) or None


def display_track_artists(local_tracks: list[dict[str, object]], release: dict[str, object], *,
                          pairing: list[dict[str, object]] | None = None) -> list[dict[str, object]]:
    """Track artists to show instead of unreadable tags, from the certainly matched release.

    A reordered album's local track takes the release track its stored ``pairing`` names
    (owner 2026-11-16); without a pairing, the release track at its own disc and position,
    only when the titles agree. Readable local artists are never replaced. Display only:
    tags change through an approved correction."""
    by_position = {(int(medium.get("position") or 1), int(track.get("position") or 0)): track
                   for medium in release.get("media") or [] for track in medium.get("tracks") or []}
    paired = {(int(item["disc_number"]), int(item["track_number"])): (item["release_disc"], item["release_position"])
              for item in pairing or []}
    shown = []
    for track in local_tracks:
        if not _LOST_TEXT.match(str(track.get("artist") or "")):
            continue
        local = (int(track.get("disc_number") or 1), int(track.get("track_number") or 0))
        if paired:
            remote = by_position.get(paired.get(local))
        else:
            remote = by_position.get(local)
            if remote and not same_track_title(track.get("title"), remote.get("title")):
                continue
        if not remote:
            continue
        text = credit_text(remote.get("artist_credit") or [])
        if text:
            shown.append({"disc_number": int(track.get("disc_number") or 1),
                          "track_number": int(track.get("track_number") or 0), "artist": text,
                          "artist_mbids": [part["artist_mbid"] for part in remote.get("artist_credit") or []]})
    return shown


class MusicBrainzAlbumReleaseProcessor:
    """Runs one album-release job: the leased artist's albums, per MusicBrainz artist."""

    def __init__(self, *, repository, client, discogs=None, now=None, lease_duration=None, max_attempts: int = 6,
                 sweep_interval=None) -> None:
        self._repository = repository
        self._client = client
        # Only with the operator's Discogs key: sub-section headings MusicBrainz lacks (S8).
        self._discogs = discogs
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._lease_duration = lease_duration or timedelta(minutes=10)
        self._max_attempts = max_attempts
        self._sweep_interval = sweep_interval or timedelta(minutes=15)
        self._last_sweep = None

    def queue_artist(self, local_artist_id: int) -> None:
        """The artist's own match was just decided: compare its albums again."""
        self._repository.enqueue(reason="artist_identity_changed", observed_at=self._now(),
                                 local_artist_id=local_artist_id, force=True)

    def process_next(self, *, worker_id: str, min_priority: int | None = None) -> dict[str, object]:
        """The next due job; with ``min_priority`` only the owner's manual lookups, and no sweep."""
        observed_at = self._now()
        job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at,
                                             lease_duration=self._lease_duration, min_priority=min_priority)
        if min_priority is not None and not job:
            return {"processed": False, "state": "idle"}
        if not job and (self._last_sweep is None or observed_at - self._last_sweep >= self._sweep_interval):
            # New identities, new albums, an older matcher or stale decisions.
            self._last_sweep = observed_at
            if self._repository.enqueue(reason="album_release_sweep", observed_at=observed_at):
                job = self._repository.claim_due_job(worker_id=worker_id, now=observed_at,
                                                     lease_duration=self._lease_duration)
        if not job:
            retried = self._retry_discogs_sections(observed_at)
            if retried["processed"]:
                return retried
            stored = self._store_transliteration(observed_at)
            if stored["processed"]:
                return stored
            # Network-free: the Latin titles search finds tracks by (0255).
            refreshed = self._repository.refresh_latin_titles()
            return {"processed": True, "state": "succeeded"} if refreshed else stored
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
            self._add_discogs_sections(context, outcome)
            outcomes.append({**outcome, "artist_mbid": context.get("artist_mbid")})
        self._repository.record(job_id=job_id, worker_id=worker_id, outcomes=outcomes, observed_at=observed_at)
        self._repository.finish(job_id=job_id, worker_id=worker_id, state="succeeded", classification="complete",
                                observed_at=observed_at)
        self._size_new_series(observed_at)
        return {"processed": True, "state": "succeeded", "job_id": job_id}

    def _add_discogs_sections(self, context: dict[str, object], outcome: dict[str, object]) -> None:
        """A certainly matched album titled "A / B" whose MusicBrainz release names no media
        takes its sub-sections from Discogs. When Discogs (or the link lookup) is unavailable,
        the album is marked for the hourly retry and keeps what it had."""
        if self._discogs is None:
            return
        albums = {album.get("id"): album for album in context.get("albums") or [] if isinstance(album, dict)}
        for result in outcome.get("albums") or []:
            album = albums.get(result.get("local_album_id")) or {}
            release = (outcome.get("releases") or {}).get(result.get("release_mbid") or "")
            if not release or not wants_discogs_sections(album.get("title"), release):
                continue
            sections = self._discogs_sections(album, result["release_mbid"], release.get("barcode"),
                                              str(context.get("local_name") or ""))
            if sections is None:
                result["discogs_sections_unavailable"] = True
            else:
                result["track_sections"] = sections

    def _discogs_sections(self, album: dict[str, object], release_mbid: str, barcode: object,
                          artist_name: str) -> list[dict[str, object]] | None:
        """Sub-sections from the Discogs release MusicBrainz links to, else from the release a
        Discogs search certainly finds (barcode, then artist and title). ``[]`` is a
        definitive answer; None means a provider did not answer (timeout, 5xx, rate limit)."""
        link = self._client.lookup_release_discogs_id(release_mbid)
        if link.get("classification") not in {"complete", "not_found"}:
            return [] if link.get("classification") == "invalid_request" else None
        discs = local_discs(album.get("tracks") or [])
        if link.get("discogs_release_id"):
            found = self._discogs.release(link["discogs_release_id"])
            if found.get("classification") == "provider_unavailable":
                return None
            return discogs_sections(discs, found["release"]["tracks"]) if found.get("classification") == "complete" else []
        searched = search_certain_release(album, artist_name=artist_name, barcode=str(barcode or "") or None,
                                          discogs=self._discogs)
        if searched["classification"] == "provider_unavailable":
            return None
        # Only the matched disc's headings, when the album is one disc of the release.
        return searched["album"]["track_sections"] if searched["classification"] == "found" else []

    def _retry_discogs_sections(self, observed_at) -> dict[str, object]:
        """One " / " album whose Discogs check is due again (owner 2026-11-16)."""
        due = self._repository.claim_section_retry(now=observed_at) if self._discogs is not None else None
        if not due:
            return {"processed": False, "state": "idle"}
        sections = self._discogs_sections(due, due["release_mbid"], due.get("barcode"), str(due.get("local_name") or ""))
        self._repository.store_section_retry(
            row=due, track_sections=sections, observed_at=observed_at,
            retry_at=None if sections is not None else section_retry_at(due["first_failed_at"], observed_at))
        return {"processed": True, "state": "succeeded"}

    def _store_transliteration(self, observed_at) -> dict[str, object]:
        """One certain release whose Latin tracklist is due (S7, owner 2026-11-17): its
        "transl-tracklisting" link, then the linked pseudo-release's tracklist, each asked
        once per release and reused for 30 days. A release none of whose local track or album
        titles needs a Latin form is stored as having none without asking; an album title alone
        asks too, for the release's language (0256). A failed ask stores nothing:
        the release rests a day and this pass ends."""
        due = self._repository.claim_transliteration(now=observed_at)
        if not due:
            return {"processed": False, "state": "idle"}
        transliteration_mbid, media, language = None, [], ""
        titles = [*(due.get("titles") or []), *(due.get("album_titles") or [])]
        if any(needs_transliteration(title) for title in titles):
            linked = self._client.lookup_release_transliteration(due["release_mbid"])
            if linked.get("classification") != "complete":
                return {"processed": False, "state": "idle"}
            transliteration_mbid, language = linked.get("transliteration_mbid"), linked.get("language") or ""
            if transliteration_mbid:
                found = self._client.lookup_release_tracklist(transliteration_mbid)
                if found.get("classification") != "complete":
                    return {"processed": False, "state": "idle"}
                media = transliteration_media(found["release"])
        self._repository.store_transliteration(release_mbid=due["release_mbid"], transliteration_mbid=transliteration_mbid,
                                               media=media, language=language, observed_at=observed_at)
        return {"processed": True, "state": "succeeded"}

    def _size_new_series(self, observed_at) -> None:
        """A list or an award names far more albums than a real album series (owner
        2026-11-15; 50 or more is "Featured In"). A series its type and name leave undecided
        is counted at most once per 30 days, up to the cutoff, however many albums share it;
        a failed count waits a day. An album's own series never needs this lookup."""
        for mbid in self._repository.unsized_series(limit=_SERIES_SIZED_PER_JOB, now=observed_at):
            found = self._client.lookup_series(mbid)
            complete = found.get("classification") == "complete"
            self._repository.store_series_size(
                mbid=mbid, member_count=found["series"]["member_count"] if complete else None,
                observed_at=observed_at)
            if not complete:
                return
