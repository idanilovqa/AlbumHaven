from __future__ import annotations

import random
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.musicbrainz_client import name_match_key, release_title_key
from music_app.services.musicbrainz_matching import candidate_names, match_artist


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
        if classification == "found":
            self._repository.record_automatic_outcome(
                local_artist_id=local_artist_id,
                state="matched",
                artist=outcome.get("artist"),
                confidence=outcome.get("confidence", 0),
                evidence_summary=evidence_summary,
                observed_at=observed_at,
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


def resolve_artist(context: dict[str, object], *, client) -> dict[str, object]:
    local = dict(context)
    local_name = context.get("local_name")
    album_titles = [str(title) for title in context.get("album_titles") or [] if str(title or "").strip()]
    local["name"] = local_name
    local["release_credits"] = [
        {"title": title, "credited_artist": local_name} for title in album_titles
    ]
    embedded = list(context.get("embedded_artist_mbids") or [])
    if embedded:
        local["embedded_mbid"] = embedded[0]
        lookup = client.lookup_artist(embedded[0])
        if lookup.get("classification") != "matched":
            return _provider_outcome(lookup)
        candidates = [lookup["artist"]]
    else:
        named, failure = _name_matching_candidates(client, local_name)
        if failure is not None:
            return failure
        if not named:
            return {
                "classification": "not_found",
                "evidence_summary": "No MusicBrainz artist has this name.",
            }
        candidates = []
        for candidate in named:
            lookup = client.lookup_artist(candidate.get("mbid"), discovered_by_search=True)
            if lookup.get("classification") != "matched":
                return _provider_outcome(lookup)
            artist = dict(lookup["artist"])
            artist["score"] = candidate.get("score", 0)
            browse = client.browse_release_group_titles(artist["mbid"], wanted_titles=album_titles)
            if browse.get("classification") != "complete":
                return _provider_outcome(browse)
            artist["release_titles"] = browse.get("titles") or []
            candidates.append(artist)

    match = match_artist(local, candidates)
    if match.get("classification") == "matched":
        selected = next(
            candidate
            for candidate in candidates
            if candidate.get("mbid") == match.get("selected_mbid")
        )
        selected = dict(selected)
        selected["preferred_native_name"] = match.get("preferred_native_name")
        return {
            "classification": "found",
            "artist": selected,
            "confidence": 1,
            "evidence_summary": f"MusicBrainz {match.get('evidence_path')} evidence agreed.",
        }
    classification = match.get("classification", "invalid_response")
    return {
        "classification": classification,
        "candidates": [
            _candidate_for_storage(candidate, album_titles)
            for candidate in match.get("candidates") or []
        ],
        "evidence_summary": (
            "One MusicBrainz artist has this name, but none of your albums confirm it."
            if classification == "unconfirmed"
            else "MusicBrainz candidates require manual review."
        ),
    }


def _name_matching_candidates(
    client, local_name: object
) -> tuple[list[dict[str, Any]], dict[str, object] | None]:
    """Search candidates whose name, sort name or alias agrees with the local name.

    Only these can ever be selected, so others cost no lookup or release-group
    requests. The exact-phrase search runs first; when it yields no name match,
    one page of an escaped plain search catches punctuation and spacing variants.
    The second value is the provider outcome when the mirror cannot answer.
    """
    local_key = name_match_key(local_name)
    for options in ({}, {"phrase": False, "max_pages": 1}):
        search = client.search_artists(local_name, **options)
        if search.get("classification") not in {"complete", "not_found"}:
            return [], _provider_outcome(search)
        named = [
            candidate for candidate in search.get("candidates") or []
            if local_key in candidate_names(candidate)
        ]
        if named:
            return named, None
    return [], None


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


def _album_agreement(candidate: dict[str, Any], album_titles: list[str]) -> str:
    if "release_titles" not in candidate or not album_titles:
        return "Name only"
    remote = {release_title_key(title) for title in candidate.get("release_titles") or []}
    local = {release_title_key(title) for title in album_titles} - {""}
    agreed = len(local & remote)
    return f"{agreed} of {len(local)} album{'' if len(local) == 1 else 's'} agree"


def _candidate_for_storage(candidate: dict[str, Any], album_titles: list[str]) -> dict[str, object]:
    try:
        score = float(candidate.get("score") or 0)
    except (TypeError, ValueError):
        score = 0
    if score > 1:
        score /= 100
    return {
        "artist_mbid": candidate.get("mbid"),
        "canonical_name": candidate.get("canonical_name"),
        "disambiguation": candidate.get("disambiguation"),
        "artist_kind": candidate.get("artist_type"),
        "country_code": candidate.get("country_code"),
        "candidate_score": max(0, min(score, 1)),
        "evidence_summary": _album_agreement(candidate, album_titles),
    }
