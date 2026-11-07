from __future__ import annotations

import copy
import random
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.musicbrainz_evidence import (
    album_level,
    album_signals,
    best_title_match,
    candidate_name_keys,
    decide,
    fold,
    name_keys,
    title_agreement,
    title_keys,
)
from music_app.services.musicbrainz_matching import native_name


APPROVED_TRIGGERS = frozenset(
    {
        "full_scan",
        "periodic_scan",
        "new_album",
        "startup_backfill",
        "stale_refresh",
        "authorized_retry",
    }
)
_TRANSIENT_CLASSIFICATIONS = frozenset(
    {"rate_limited", "provider_unavailable", "catch_up_pending"}
)
# Outcomes that store their candidates for an owner decision. A single name
# match without album agreement is "manual_review": not several matches.
_CANDIDATE_MATCH_STATES = {"ambiguous": "ambiguous", "unconfirmed": "manual_review"}


class MusicBrainzEnrichmentScheduler:
    def __init__(self, repository, *, now: Callable[[], datetime] | None = None) -> None:
        self._repository = repository
        self._now = now or (lambda: datetime.now(timezone.utc))

    def schedule(self, trigger: str, *, local_artist_id: int | None = None):
        if trigger not in APPROVED_TRIGGERS:
            raise ValueError("Unsupported MusicBrainz enrichment trigger.")
        observed_at = self._now()
        if trigger == "authorized_retry":
            if (
                isinstance(local_artist_id, bool)
                or not isinstance(local_artist_id, int)
                or local_artist_id < 1
            ):
                raise ValueError("An artist is required for authorized MusicBrainz retry.")
            return self._repository.enqueue_artist(
                local_artist_id=local_artist_id,
                reason=trigger,
                observed_at=observed_at,
            )
        return self._repository.enqueue_eligible_artists(
            reason=trigger,
            observed_at=observed_at,
        )


def retry_delay(
    classification: str,
    *,
    attempt_count: int,
    retry_after_seconds: object = None,
    jitter: Callable[[float], float] | None = None,
) -> timedelta | None:
    if classification not in _TRANSIENT_CLASSIFICATIONS:
        return None
    attempt = max(1, int(attempt_count))
    seconds = min(30 * (2 ** min(attempt - 1, 5)), 15 * 60)
    if classification == "rate_limited":
        try:
            seconds = max(seconds, float(retry_after_seconds or 0))
        except (TypeError, ValueError):
            pass
    add_jitter = jitter or (lambda upper_bound: random.uniform(0, upper_bound))
    seconds = min(15 * 60, max(30, seconds + float(add_jitter(seconds * 0.1))))
    return timedelta(seconds=seconds)


class MusicBrainzArtistEnrichmentProcessor:
    def __init__(
        self,
        *,
        repository,
        client,
        resolve_artist: Callable[..., dict[str, object]],
        now: Callable[[], datetime] | None = None,
        jitter: Callable[[float], float] | None = None,
        lease_duration: timedelta = timedelta(minutes=5),
        max_attempts: int = 6,
    ) -> None:
        self._repository = repository
        self._client = client
        self._resolve_artist = resolve_artist
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._jitter = jitter
        self._lease_duration = lease_duration
        self._max_attempts = max(1, int(max_attempts))

    def process_next(self, *, worker_id: str) -> dict[str, object]:
        observed_at = self._now()
        job = self._repository.claim_due_job(
            worker_id=worker_id,
            now=observed_at,
            lease_duration=self._lease_duration,
        )
        if not job:
            return {"processed": False, "state": "idle"}

        job_id = int(job["id"])
        context = self._repository.load_artist_context(
            job_id=job_id,
            worker_id=worker_id,
        )
        if not context:
            raise RuntimeError("Claimed MusicBrainz job has no accessible artist context.")

        if context.get("manual_decision") and context.get("projection_is_fresh"):
            self._repository.complete_job(
                job_id=job_id,
                worker_id=worker_id,
                state="succeeded",
                classification="found",
                safe_error=None,
                observed_at=observed_at,
                preserve_existing=True,
            )
            return {"processed": True, "state": "succeeded", "job_id": job_id}

        outcome = self._resolve_artist(context, client=self._client)
        classification = str(outcome.get("classification") or "invalid_response")
        safe_error = str(outcome.get("safe_error") or "")[:1024] or None
        attempt_count = int(job.get("attempt_count") or 0)

        delay = retry_delay(
            classification,
            attempt_count=attempt_count,
            retry_after_seconds=outcome.get("retry_after_seconds"),
            jitter=self._jitter,
        )
        if delay is not None:
            if attempt_count >= self._max_attempts:
                self._repository.complete_job(
                    job_id=job_id,
                    worker_id=worker_id,
                    state="exhausted",
                    classification=classification,
                    safe_error=safe_error,
                    observed_at=observed_at,
                    preserve_existing=True,
                )
                return {
                    "processed": True,
                    "state": "exhausted",
                    "classification": classification,
                    "job_id": job_id,
                }
            self._repository.schedule_retry(
                job_id=job_id,
                worker_id=worker_id,
                classification=classification,
                retry_at=observed_at + delay,
                safe_error=safe_error or "MusicBrainz provider retry scheduled.",
                observed_at=observed_at,
            )
            result = {
                "processed": True,
                "state": "retry_wait",
                "classification": classification,
                "job_id": job_id,
            }
            if classification == "rate_limited":
                result["cooldown_seconds"] = delay.total_seconds()
            return result

        local_artist_id = int(context.get("local_artist_id") or job["local_artist_id"])
        evidence_summary = str(
            outcome.get("evidence_summary")
            or safe_error
            or "MusicBrainz evidence requires review."
        )
        terminal_state = "succeeded" if classification == "found" else "needs_review"
        found_mbid = str((outcome.get("artist") or {}).get("mbid") or "").lower()
        stored_mbid = str(context.get("existing_artist_mbid") or "").lower()
        if (
            classification == "found"
            and not context.get("manual_decision")
            and context.get("existing_match_state") == "matched"
            and stored_mbid
            and found_mbid != stored_mbid
        ):
            # A re-check that finds another artist never replaces a match silently:
            # both go to the owner as a conflict.
            artist = outcome.get("artist") or {}
            self._repository.replace_candidates(
                local_artist_id=local_artist_id,
                candidates=[
                    {"artist_mbid": stored_mbid, "canonical_name": context.get("existing_canonical_name") or "Current match",
                     "candidate_score": 1, "evidence_summary": "Current match"},
                    {"artist_mbid": found_mbid, "canonical_name": artist.get("canonical_name"),
                     "disambiguation": artist.get("disambiguation"), "artist_kind": artist.get("artist_type"),
                     "country_code": artist.get("country_code"), "candidate_score": 1,
                     "evidence_summary": "Album evidence now agrees"},
                ],
                match_state="conflict",
                evidence_summary="Album evidence now points to another MusicBrainz artist than the current match.",
                observed_at=observed_at,
            )
            terminal_state = "needs_review"
        elif classification == "found":
            self._repository.record_automatic_outcome(
                local_artist_id=local_artist_id,
                state="matched",
                artist=outcome.get("artist"),
                confidence=outcome.get("confidence", 0),
                evidence_summary=evidence_summary,
                observed_at=observed_at,
                credit_name=outcome.get("credit_name"),
            )
        elif classification in _CANDIDATE_MATCH_STATES or (
            classification == "permanent_mismatch" and outcome.get("candidates")
        ):
            # Contradicted identities keep their candidates so the owner can
            # compare and choose instead of facing an empty conflict.
            self._repository.replace_candidates(
                local_artist_id=local_artist_id,
                candidates=list(outcome.get("candidates") or []),
                match_state=_CANDIDATE_MATCH_STATES.get(classification, "conflict"),
                evidence_summary=evidence_summary,
                observed_at=observed_at,
            )
        else:
            self._repository.record_automatic_outcome(
                local_artist_id=local_artist_id,
                state="not_found" if classification == "not_found" else "conflict",
                artist=None,
                confidence=outcome.get("confidence", 0),
                evidence_summary=evidence_summary,
                observed_at=observed_at,
            )
        self._repository.complete_job(
            job_id=job_id,
            worker_id=worker_id,
            state=terminal_state,
            classification=classification,
            safe_error=safe_error,
            observed_at=observed_at,
            preserve_existing=bool(context.get("existing_artist_mbid")),
        )
        return {"processed": True, "state": terminal_state, "job_id": job_id}


# Bounds per artist, so one artist can never stall the queue: every mirror
# request counts, and evidence gathering stops once the budget is spent.
_MAX_REQUESTS_PER_ARTIST = 80
_MAX_CANDIDATES = 15
_MAX_ALBUM_SEARCHES = 6
_MAX_TRACKLISTS_PER_CANDIDATE = 3
_ARTICLE_PREFIX = re.compile(r"^(?:the|a|an)\s+", re.IGNORECASE)


class _ProviderFailure(Exception):
    def __init__(self, result: dict[str, object]) -> None:
        super().__init__("MusicBrainz provider outcome")
        self.outcome = _provider_outcome(result)


class _Mirror:
    """The client behind a per-artist budget of mirror requests; a provider failure stops the artist."""

    def __init__(self, client, budget: int) -> None:
        self.remaining = budget
        self._client = copy.copy(client)
        get_json = client.get_json

        def counted(*args, **kwargs):
            self.remaining -= 1
            return get_json(*args, **kwargs)

        self._client.get_json = counted

    def call(self, method: str, *args, accept=("complete", "not_found"), **kwargs):
        if self.remaining <= 0:
            return None
        result = getattr(self._client, method)(*args, **kwargs)
        if result.get("classification") not in accept:
            raise _ProviderFailure(result)
        return result


def _local_albums(context: dict[str, object]) -> list[dict[str, object]]:
    albums = [dict(album) for album in context.get("albums") or [] if isinstance(album, dict) and album.get("title")]
    if not albums:
        albums = [{"title": str(title)} for title in context.get("album_titles") or [] if str(title or "").strip()]
    # Albums with the most tracks carry the most evidence.
    return sorted(albums, key=lambda album: -len(album.get("tracks") or []))


def _name_queries(local_name: str) -> list[str]:
    """The local name, then its variants without a repeated value or a leading article."""
    queries = [local_name]
    parts = [part for part in re.split(r"\s*(?:/|;)\s*", local_name) if part]
    if len(parts) > 1 and len({fold(part) for part in parts}) == 1:
        queries.append(parts[0])
    for query in list(queries):
        stripped = _ARTICLE_PREFIX.sub("", query).rstrip(".")
        if stripped and stripped != query:
            queries.append(stripped)
    return list(dict.fromkeys(queries))


def resolve_artist(context: dict[str, object], *, client) -> dict[str, object]:
    """Find the artist on album evidence; names only retrieve candidates."""
    try:
        return _resolve_artist(context, _Mirror(client, _MAX_REQUESTS_PER_ARTIST))
    except _ProviderFailure as failure:
        return failure.outcome


def _resolve_artist(context: dict[str, object], mirror: _Mirror) -> dict[str, object]:
    local_name = str(context.get("local_name") or "").strip()
    local_keys = name_keys(local_name)
    albums = _local_albums(context)
    pool: dict[str, dict[str, object]] = {}
    unscored: list[dict[str, object]] = []

    def add(candidate: dict[str, object], origin: str) -> dict[str, object]:
        entry = pool.setdefault(candidate["mbid"], {**candidate, "credits": {}, "releases": {}})
        entry[origin] = True
        return entry

    def evaluate() -> dict[str, object]:
        ranked = sorted(pool.values(), key=lambda entry: (
            not entry.get("named"), -len(entry["credits"]), -int(entry.get("score") or 0)))
        for candidate in ranked[:_MAX_CANDIDATES]:
            if "albums" in candidate or candidate.get("skipped"):
                continue
            if not candidate.get("canonical_name"):
                lookup = mirror.call("lookup_artist", candidate["mbid"], accept=("matched", "not_found"))
                if not lookup or lookup.get("classification") != "matched":
                    candidate["skipped"] = True
                    continue
                candidate.update(lookup["artist"])
            _gather_album_evidence(candidate, albums, local_name, mirror)
            if candidate.get("albums") is None:
                unscored.append(candidate)
                continue
            evidence = candidate["albums"]
            candidate["name_agrees"] = bool(candidate_name_keys(candidate) & local_keys)
            agreeing = [index for index, album in enumerate(evidence) if album["level"] in {"strong", "agree"}]
            candidate["credit_agrees"] = bool(agreeing) and all(
                any(name_keys(name) & local_keys for name in candidate["credits"].get(index, ()))
                for index in agreeing
            ) and any(evidence[index]["signals"] & {"track_list", "durations"} for index in agreeing)
        decision = decide([candidate for candidate in pool.values() if candidate.get("albums") is not None])
        if decision["classification"] == "matched" and unscored:
            # The request budget ran out before every candidate was scored: never decide early.
            return {"classification": "ambiguous", "candidates": [*decision["candidates"], *unscored]}
        return decision

    # 1. Names: exact phrases for the local name and its variants, then one plain page.
    queries = [(name, {}) for name in _name_queries(local_name)]
    queries.append((local_name, {"phrase": False, "max_pages": 1}))
    for query, options in queries:
        search = mirror.call("search_artists", query, **options)
        if search is None:
            break
        for candidate in search.get("candidates") or []:
            if candidate_name_keys(candidate) & local_keys:
                add(candidate, "named")
        if pool:
            break
    # The stored Last.fm MBID is only a hint candidate.
    hint = next((str(mbid).strip().lower() for mbid in context.get("hinted_artist_mbids") or []
                 if str(mbid or "").strip()), "")
    if hint and hint not in pool:
        add({"mbid": hint, "canonical_name": "", "score": 0}, "hinted")
    decision = evaluate()

    # 2. Albums, only when names did not decide: releases titled like a local
    # album, walked back to their credited artists.
    if decision["classification"] != "matched":
        for index, album in enumerate(albums[:_MAX_ALBUM_SEARCHES]):
            hits = []
            for credit_name, phrase in ((local_name, True), (local_name, False), (None, True), (None, False)):
                found = mirror.call("search_releases", album["title"], credit_name=credit_name, phrase=phrase)
                if found is None:
                    break
                hits = [release for release in found.get("releases") or []
                        if title_agreement(album["title"], release.get("title"), (local_name,))]
                if hits:
                    break
            for release in hits:
                for credit in release.get("credits") or []:
                    entry = add({"mbid": credit["artist_mbid"], "canonical_name": credit["artist_name"],
                                 "score": 0}, "album_found")
                    entry["credits"].setdefault(index, set()).add(credit["name"])
                    entry["releases"].setdefault(index, release)
                    # New credit evidence for an artist already scored: score it again.
                    entry.pop("albums", None)
        decision = evaluate()

    classification = decision["classification"]
    if classification == "matched":
        selected = decision["selected"]
        lookup = mirror.call("lookup_artist", selected["mbid"], accept=("matched",))
        if lookup is None:
            return {"classification": "provider_unavailable",
                    "safe_error": "The MusicBrainz request budget ran out before the match was confirmed."}
        artist = dict(lookup["artist"])
        artist["preferred_native_name"] = native_name({**context, "name": local_name}, artist)
        outcome = {
            "classification": "found",
            "artist": artist,
            "confidence": 1,
            "evidence_summary": "MusicBrainz {} evidence agreed.".format(
                "search" if selected.get("name_agrees") else "release credit"),
        }
        if not selected.get("name_agrees"):
            # Shown as "credited as <local name>" in the panel and Problematic Files.
            outcome["credit_name"] = local_name
        return outcome
    if classification == "not_found":
        return {"classification": "not_found",
                "evidence_summary": "No MusicBrainz artist has this name or one of your albums."}
    candidates = decision["candidates"]
    if classification == "unconfirmed" and candidates and not candidates[0].get("name_agrees"):
        summary = "Your albums point to a MusicBrainz artist with another name."
    elif classification == "unconfirmed":
        summary = "One MusicBrainz artist has this name, but none of your albums confirm it."
    else:
        summary = "MusicBrainz candidates require manual review."
    return {"classification": classification,
            "candidates": [_candidate_for_storage(candidate) for candidate in candidates],
            "evidence_summary": summary}


def _gather_album_evidence(candidate, albums, local_name, mirror) -> None:
    """Score each local album against the candidate's release groups and, when that
    leaves it short of strong, against the tracks of the closest release."""
    browse = mirror.call("browse_release_group_titles", candidate["mbid"],
                         wanted_titles=[album["title"] for album in albums])
    if browse is None:
        return
    names = tuple(name for name in (local_name, candidate.get("canonical_name")) if name)
    groups = [(group, title_keys(group.get("title"), names)) for group in browse.get("groups") or []]
    candidate["albums"] = []
    for index, album in enumerate(albums):
        best, best_title = best_title_match(album["title"], groups, names)
        # A release found by title counts only when it belongs to the matched group.
        release = candidate["releases"].get(index) or {}
        if not best or release.get("release_group_id") != best.get("id"):
            release = {}
        remote = {"first_release_date": (best or {}).get("first_release_date") or release.get("date"),
                  "track_count": release.get("track_count")}
        signals = album_signals(album, remote) if best_title else set()
        candidate["albums"].append({"title": best_title, "group": best, "remote": remote,
                                    "signals": signals, "level": album_level(best_title, signals)})
    fetched = 0
    for index, evidence in enumerate(candidate["albums"]):
        if fetched >= _MAX_TRACKLISTS_PER_CANDIDATE:
            break
        # Tracks raise an album to strong, and a credit-name match needs them as well.
        credited_without_tracks = index in candidate["credits"] and not evidence["signals"] & {"track_list", "durations"}
        if evidence["level"] is None or (evidence["level"] == "strong" and not credited_without_tracks):
            continue
        if not evidence["group"] or not albums[index].get("tracks"):
            continue
        tracks = mirror.call("release_group_tracks", evidence["group"]["id"],
                             track_count=len(albums[index]["tracks"]))
        if tracks is None:
            break
        fetched += 1
        evidence["remote"]["tracks"] = tracks.get("tracks") or []
        evidence["signals"] = album_signals(albums[index], evidence["remote"])
        evidence["level"] = album_level(evidence["title"], evidence["signals"])


def _provider_outcome(result: dict[str, object]) -> dict[str, object]:
    transport = (
        result.get("transport")
        if isinstance(result.get("transport"), dict)
        else {}
    )
    return {
        "classification": result.get("classification", "invalid_response"),
        "retry_after_seconds": transport.get("retry_after_seconds"),
        "safe_error": "MusicBrainz mirror is catching up."
        if result.get("classification") == "catch_up_pending"
        else "MusicBrainz provider is temporarily unavailable.",
    }


def _candidate_for_storage(candidate: dict[str, Any]) -> dict[str, object]:
    try:
        score = float(candidate.get("score") or 0)
    except (TypeError, ValueError):
        score = 0
    if score > 1:
        score /= 100
    albums = candidate.get("albums") or []
    agreeing = sum(album.get("level") in {"strong", "agree"} for album in albums)
    summary = f"{agreeing} of {len(albums)} album{'' if len(albums) == 1 else 's'} agree" if albums else "Name only"
    # Releases credited under another name: Problematic Files says "credited as …".
    credited = sorted({name for names in (candidate.get("credits") or {}).values() for name in names}
                      - {candidate.get("canonical_name")})
    if credited:
        summary += " · credited as " + ", ".join(credited)
    return {
        "artist_mbid": candidate.get("mbid"),
        "canonical_name": candidate.get("canonical_name"),
        "disambiguation": candidate.get("disambiguation"),
        "artist_kind": candidate.get("artist_type"),
        "country_code": candidate.get("country_code"),
        "candidate_score": max(0, min(score, 1)),
        "evidence_summary": summary,
    }
