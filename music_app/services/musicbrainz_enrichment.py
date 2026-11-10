from __future__ import annotations

import copy
import random
import re
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services.musicbrainz_evidence import (
    SPECIAL_PURPOSE_ARTISTS,
    album_level,
    album_rank,
    TITLE_RANK,
    album_signals,
    group_title_keys,
    ranked_title_matches,
    candidate_name_keys,
    contested_albums,
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
        terminal_state = "succeeded" if classification in {"found", "per_album"} else "needs_review"
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
                album_evidence=outcome.get("album_evidence"),
                album_identities=outcome.get("album_identities"),
                # A person's albums credited to their band keep the band's MBID.
                identity_artists=outcome.get("artists"),
                associated_artist_mbids=outcome.get("associated_artists"),
            )
        elif classification == "per_album":
            # Several MusicBrainz artists share this local name; each album keeps its own.
            self._repository.record_automatic_outcome(
                local_artist_id=local_artist_id,
                state="per_album",
                artist=None,
                confidence=outcome.get("confidence", 0),
                evidence_summary=evidence_summary,
                observed_at=observed_at,
                album_identities=outcome.get("album_identities"),
                identity_artists=outcome.get("artists"),
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
# Same-named artists with no album link: at most this many are scored, with
# fewer browse pages, and requests stay reserved for the album searches.
_MAX_NAME_ONLY_CANDIDATES = 5
_CROWDED_NAME = 3
_ALBUM_SEARCH_RESERVE = 30
_MAX_BROWSE_PAGES = 5
_NAME_ONLY_BROWSE_PAGES = 2
_MAX_ALBUM_SEARCHES = 6
_MAX_TRACKLISTS_PER_CANDIDATE = 8
# Other release groups whose title agrees, tried when the first one's tracks differ.
_MAX_ALTERNATIVE_GROUPS = 2
# Other releases of one group compared when the closest one's tracks differ.
_MAX_OTHER_RELEASES = 2
_RETRY_RESERVE = 30
# Releases of the same length compared by their tracks alone, for a same-named artist.
_MAX_TRACK_ONLY_PER_ALBUM = 3
_MAX_TRACK_ONLY_PER_CANDIDATE = 6
# After a split, undecided albums are compared by their tracks with this extra budget.
_SPLIT_REQUESTS_PER_ALBUM = 2
_MAX_SPLIT_REQUESTS = 40
# A disc tagged as its own album under a generic name: "Bonus EP", "Disc 2".
_GENERIC_DISC_TITLE = re.compile(
    r"^\s*(?:(?:bonus|extra)(?:\s+(?:ep|disc|cd|tracks?|material))?|(?:dis[ck]|cd)\s*\d+)\s*$", re.IGNORECASE)
# A disc's format after a box-set title: "Contain Us 10"", "Title CD2".
_FORMAT_SUFFIX = re.compile(
    r"""\s*[\(\[]?\s*(?:\d{1,2}(?:"|''|”|-inch| inch)|cd\s*\d+|dis[ck]\s*\d+|bonus(?: disc| cd)?|vinyl|lp)\s*[\)\]]?\s*$""",
    re.IGNORECASE,
)
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
    name_only_scored = [0]
    split_budget = [0]

    def add(candidate: dict[str, object], origin: str) -> dict[str, object] | None:
        mbid = str(candidate.get("mbid") or "").lower()
        if not mbid or mbid in SPECIAL_PURPOSE_ARTISTS:
            return None
        entry = pool.setdefault(mbid, {**candidate, "mbid": mbid, "credits": {}, "releases": {}})
        entry[origin] = True
        return entry

    def proven(candidate: dict[str, object]) -> bool:
        # Found through one of the albums, or already matched for this name.
        return bool(candidate["credits"]) or bool(candidate.get("sibling"))

    def evaluate(reserve: int = 0, name_pages: int = _MAX_BROWSE_PAGES,
                 score_namesakes: bool = True) -> dict[str, object]:
        ranked = sorted(pool.values(), key=lambda entry: (
            not proven(entry), -len(entry["credits"]), not entry.get("named"), -int(entry.get("score") or 0)))
        for candidate in ranked[:_MAX_CANDIDATES]:
            if "albums" in candidate or candidate.get("skipped"):
                continue
            if not proven(candidate):
                # Same-named artists with no album link are scored last and few, so
                # the budget reaches the album searches.
                if (not score_namesakes or name_only_scored[0] >= _MAX_NAME_ONLY_CANDIDATES
                        or mirror.remaining <= reserve):
                    continue
                name_only_scored[0] += 1
            if not candidate.get("canonical_name"):
                lookup = mirror.call("lookup_artist", candidate["mbid"], accept=("matched", "not_found"))
                if not lookup or lookup.get("classification") != "matched":
                    candidate["skipped"] = lookup is not None
                    continue
                current = str(lookup["artist"].get("mbid") or "").lower()
                if current and current != candidate["mbid"]:
                    # A merged MusicBrainz artist answers under its current MBID
                    # (Shamaani Duo's Last.fm MBID is Korpiklaani's): one candidate, not two.
                    if current in pool:
                        candidate["skipped"] = True
                        continue
                    pool[current] = pool.pop(candidate["mbid"])
                candidate.update(lookup["artist"])
            candidate["name_agrees"] = bool(candidate_name_keys(candidate) & local_keys)
            _gather_album_evidence(candidate, albums, local_name, mirror,
                                   pages=_MAX_BROWSE_PAGES if proven(candidate) else name_pages)
            if candidate.get("albums") is None:
                continue
            evidence = candidate["albums"]
            agreeing = [index for index, album in enumerate(evidence) if album["level"] in {"strong", "agree"}]
            candidate["credit_agrees"] = bool(agreeing) and all(
                any(name_keys(name) & local_keys for name in candidate["credits"].get(index, ()))
                for index in agreeing
            ) and any(evidence[index]["signals"] & {"track_list", "durations"} for index in agreeing)
            # An agreeing album whose release credits several artists makes the
            # local artist a collaboration, whatever separators its name has.
            # A split release ("Amestigon / Angizia") of the artist named like the tag is not.
            candidate["joint_credit"] = not candidate["name_agrees"] and any(
                len({credit["artist_mbid"] for credit in (candidate["releases"].get(index) or {}).get("credits") or []}) > 1
                for index in agreeing)
        scored = [candidate for candidate in pool.values() if candidate.get("albums") is not None]
        _settle_shared_albums(scored, albums, mirror)
        decision = decide(scored, local_name)
        # Albums with no same-titled release group may be discs of a box set: checked
        # for every possible owner while undecided, and for a winner so its disc
        # evidence is kept.
        if decision["classification"] != "matched" or decision.get("sibling_only"):
            owners = [candidate for candidate in scored if candidate.get("name_agrees") or proven(candidate)]
        else:
            owners = [decision["selected"]]
        checked = [candidate for candidate in owners if not candidate.get("discs_checked")
                   and any(map(_improvable, candidate["albums"]))]
        for candidate in checked:
            candidate["discs_checked"] = True
            # Undecided: every release's own title, then the tracks alone for the artist
            # named like the tag, then the discs of box sets. The deeper comparisons
            # wait until every artist an album pointed to is scored, and keep a reserve.
            if mirror.remaining > _RETRY_RESERVE and not any(
                    proven(entry) and entry.get("albums") is None and not entry.get("skipped")
                    for entry in pool.values()):
                names = tuple(name for name in (local_name, candidate.get("canonical_name")) if name)
                _match_release_titles(candidate, albums, names, mirror)
                _compare_tracks(candidate, albums, mirror)
                if candidate.get("name_agrees"):
                    _match_tracks_alone(candidate, albums, mirror)
            _match_box_set_discs(candidate, albums, local_name, mirror)
        if checked:
            _settle_shared_albums(scored, albums, mirror)
            decision = decide(scored, local_name)
        if decision["classification"] == "per_album" and not split_budget[0] and not reserve:
            # Each undecided album of a split artist gets its tracks compared (Alice
            # Cooper's solo albums were left on their year alone), once the album
            # searches no longer need their reserve.
            undecided = len(albums) - len(decision.get("certain") or {})
            split_budget[0] = min(_MAX_SPLIT_REQUESTS, _SPLIT_REQUESTS_PER_ALBUM * undecided)
            mirror.remaining += split_budget[0]
        leading = decision["candidates"] if decision["classification"] == "per_album" else decision["candidates"][:2]
        if decision["classification"] in {"ambiguous", "per_album"} and _compare_capped_albums(
                leading, albums, mirror, keep=max(len(decision["candidates"]) + 1, reserve)):
            # Tracklists were capped: albums compared on the year alone may still be
            # certain, for a split artist's identities as for the margin.
            decision = decide(scored, local_name)
        unscored =[candidate for candidate in pool.values() if proven(candidate) and candidate.get("albums") is None]
        if decision["classification"] in {"matched", "per_album"} and unscored:
            # The budget ran out before a candidate found through an album was scored:
            # it could hold the same albums, so never decide early. Same-named
            # artists without an album link cannot outweigh album evidence.
            return {"classification": "ambiguous", "candidates": [*decision["candidates"], *unscored]}
        if decision["classification"] == "not_found":
            # Candidates the budget never reached are not evidence of absence.
            unreached = [candidate for candidate in pool.values()
                         if candidate.get("albums") is None and not candidate.get("skipped")]
            if unreached:
                return {"classification": "ambiguous" if len(unreached) > 1 else "unconfirmed",
                        "candidates": unreached[:_MAX_CANDIDATES]}
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
    # The stored Last.fm artist MBID is only a hint candidate.
    hint = next((str(mbid).strip().lower() for mbid in context.get("hinted_artist_mbids") or []
                 if str(mbid or "").strip()), "")
    if hint and hint not in pool:
        add({"mbid": hint, "canonical_name": "", "score": 0}, "hinted")
    # A local artist already matched under another spelling of this name.
    for sibling in context.get("sibling_matches") or []:
        if isinstance(sibling, dict) and name_keys(sibling.get("name")) & local_keys:
            add({"mbid": sibling.get("mbid"), "canonical_name": sibling.get("canonical_name") or "", "score": 0},
                "sibling")
    # A local album's Last.fm release identifier, once the release's title agrees with
    # it; as few lookups as album searches, so a large discography keeps its budget.
    identified = [(index, album) for index, album in enumerate(albums) if album.get("lastfm_release_mbid")]
    for index, album in identified[:_MAX_ALBUM_SEARCHES]:
        found = mirror.call("lookup_release", album["lastfm_release_mbid"])
        if found is None:
            break
        release = found.get("release") or {}
        if title_agreement(album["title"], release.get("release_group_title") or release.get("title"), (local_name,)):
            _add_release_credits(add, index, release)
    crowded = sum(1 for entry in pool.values() if entry.get("named")) > _CROWDED_NAME
    decision = None if crowded else evaluate(reserve=_ALBUM_SEARCH_RESERVE)

    # 2. Albums: releases titled like a local album, walked back to their credited
    # artists. First when the name is shared by many artists, else when names did not decide.
    # A sibling no album confirms waits for the album searches: one may point elsewhere.
    if decision is None or decision["classification"] != "matched" or decision.get("sibling_only"):
        for index, album in enumerate(albums[:_MAX_ALBUM_SEARCHES]):
            hits, loose = [], []
            for credit_name, phrase in ((local_name, True), (local_name, False), (None, True), (None, False)):
                found = mirror.call("search_releases", album["title"], credit_name=credit_name, phrase=phrase)
                if found is None:
                    break
                agreements = [(release, title_agreement(album["title"], release.get("title"), (local_name,)))
                              for release in found.get("releases") or []]
                hits = [release for release, agreement in agreements if agreement in {"exact", "fuzzy"}]
                if hits:
                    break
                # A typo or partial title keeps the search going: an exact one may follow
                # ("It's a Murder Scene" before Chris Buck's "It's a Murder").
                loose = loose or [release for release, agreement in agreements if agreement]
            for release in hits or loose:
                _add_release_credits(add, index, release)
        # Among many namesakes, the ones the album searches credited decide; the
        # rest are scored only when no album found anyone.
        decision = evaluate(name_pages=_NAME_ONLY_BROWSE_PAGES if crowded else _MAX_BROWSE_PAGES,
                            score_namesakes=not crowded or not any(proven(entry) for entry in pool.values()))

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
                "search" if selected.get("name_agrees") else
                "release credit" if selected.get("credit_agrees") else
                "album" if (selected.get("evidence") or (0,))[0] else "matched artist"),
        }
        if not selected.get("name_agrees"):
            # Shown as "credited as <local name>".
            outcome["credit_name"] = local_name
        # The albums a data-correction list can propose fixing, so it needs no new match.
        evidence = _album_evidence(selected, albums, credited=not selected.get("name_agrees"))
        if evidence:
            outcome["album_evidence"] = evidence
        identities = _album_identities(decision.get("certain") or {}, albums)
        if identities:
            outcome["album_identities"] = identities
        return outcome
    if classification == "per_album":
        # The local name covers several MusicBrainz artists; each certain album keeps its own.
        # Naming them and checking a person's bands never fails for lack of budget.
        mirror.remaining = max(mirror.remaining, len(decision["candidates"]) + 1)
        artists = []
        for owner in decision["candidates"]:
            lookup = mirror.call("lookup_artist", owner["mbid"], accept=("matched",))
            # With the budget spent, the name the albums' credits gave is enough to list it.
            artists.append(dict(lookup["artist"]) if lookup else {
                key: owner.get(key) for key in ("mbid", "canonical_name", "disambiguation", "artist_type")})
        person = _person_of_member_bands(artists, mirror) if all(
            owner.get("name_agrees") for owner in decision["candidates"]) else None
        if person is not None:
            # Owner 2026-11-09: a person and the same-named groups they belong to are one
            # artist (Alice Cooper and his 1969-74 band). The person is the artist; each
            # album keeps its certain MBID, and the groups are stored so those resolve.
            person["preferred_native_name"] = native_name({**context, "name": local_name}, person)
            return {"classification": "found", "artist": person, "artists": artists, "confidence": 1,
                    "associated_artists": [artist["mbid"] for artist in artists if artist["mbid"] != person["mbid"]],
                    "album_identities": _album_identities(decision["certain"], albums),
                    "evidence_summary": "MusicBrainz album evidence agreed."}
        return {"classification": "per_album", "artists": artists, "confidence": 1,
                "album_identities": _album_identities(decision["certain"], albums),
                "evidence_summary": f"Your albums belong to {len(artists)} MusicBrainz artists."}
    if classification == "not_found":
        return {"classification": "not_found",
                "evidence_summary": "No MusicBrainz artist has this name or one of your albums."}
    candidates = decision["candidates"]
    if classification == "unconfirmed" and candidates and candidates[0].get("release_group_count") == 0:
        # An empty discography is not a disagreement: there is nothing to compare yet.
        summary = (f"MusicBrainz lists no releases for {candidates[0].get('canonical_name') or 'this artist'}, "
                   "so your albums cannot confirm it yet.")
    elif classification == "unconfirmed" and candidates and not candidates[0].get("name_agrees"):
        summary = "Your albums point to a MusicBrainz artist with another name."
    elif classification == "unconfirmed":
        summary = "One MusicBrainz artist has this name, but none of your albums confirm it."
    else:
        summary = "MusicBrainz candidates require manual review."
    return {"classification": classification,
            "candidates": [_candidate_for_storage(candidate) for candidate in candidates],
            "evidence_summary": summary}


def _person_of_member_bands(artists: list[dict[str, object]], mirror) -> dict[str, object] | None:
    """The one person among a split's same-named artists when every other one is a group
    that person is a member of on MusicBrainz; None for unrelated artists (Amarok's two
    bands)."""
    people = [artist for artist in artists if str(artist.get("artist_type") or "").lower() == "person"]
    if len(people) != 1 or len(artists) < 2:
        return None
    others = {str(artist.get("mbid")) for artist in artists if artist is not people[0]}
    memberships = mirror.call("band_memberships", people[0]["mbid"])
    return dict(people[0]) if memberships and others <= set(memberships.get("groups") or ()) else None


def _album_identities(certain: dict[int, dict[str, object]], albums: list[dict[str, object]]) -> list[dict[str, object]]:
    """Each album a MusicBrainz artist certainly holds, with the release it matched. An
    artist named unlike the local tag marks the album for a tag correction (display only)."""
    identities = []
    for index, owner in sorted(certain.items()):
        evidence = owner["albums"][index]
        identities.append({
            "local_album_id": albums[index].get("id"), "local_title": albums[index].get("title"),
            "artist_mbid": owner["mbid"], "release_group_mbid": (evidence.get("group") or {}).get("id"),
            "release_mbid": evidence.get("release_id"), "disc_position": evidence.get("disc"),
            "signals": sorted(evidence.get("signals") or ()), "tag_differs": not owner.get("name_agrees"),
        })
    return identities


def _add_release_credits(add, index: int, release: dict[str, object]) -> None:
    for credit in release.get("credits") or []:
        entry = add({"mbid": credit["artist_mbid"], "canonical_name": credit["artist_name"], "score": 0},
                    "album_found")
        if entry is None:
            continue
        entry["credits"].setdefault(index, set()).add(credit["name"])
        entry["releases"].setdefault(index, release)
        # New credit evidence for an artist already scored: score it again, discs included.
        entry.pop("albums", None)
        entry.pop("discs_checked", None)


def _gather_album_evidence(candidate, albums, local_name, mirror, *, pages: int = _MAX_BROWSE_PAGES) -> None:
    """Score each local album against the candidate's release groups, then box-set
    discs, and, when that leaves it short of strong, against the closest release's tracks."""
    browse = mirror.call("browse_release_group_titles", candidate["mbid"],
                         wanted_titles=[album["title"] for album in albums], max_pages=pages)
    if browse is None:
        return
    names = tuple(name for name in (local_name, candidate.get("canonical_name")) if name)
    groups = [(group, group_title_keys(group, names)) for group in browse.get("groups") or []]
    candidate["release_group_count"] = len(groups)
    candidate["albums"] = []
    for index, album in enumerate(albums):
        ranked = ranked_title_matches(album["title"], groups, names)
        best, best_title = ranked[0] if ranked else (None, None)
        # A release found by title counts only for its own group. When browsing
        # stopped before that group, the release's own titles still count.
        release = candidate["releases"].get(index) or {}
        release_title = title_agreement(album["title"], release.get("release_group_title") or release.get("title"),
                                        names) if release.get("release_group_id") else None
        if release_title and (not best or TITLE_RANK[release_title] < TITLE_RANK[best_title]):
            # The searched release agrees better than any group title (an English
            # pseudo-release of a soundtrack beside a single "from" it).
            best, best_title = {"id": release["release_group_id"],
                                "title": release.get("release_group_title") or release.get("title"),
                                "first_release_date": release.get("date")}, release_title
        if not best or release.get("release_group_id") != best.get("id"):
            release = {}
        remote = {"first_release_date": (best or {}).get("first_release_date") or release.get("date"),
                  "track_count": release.get("track_count")}
        signals = album_signals(album, remote) if best_title else set()
        candidate["albums"].append({"title": best_title, "group": best, "remote": remote, "signals": signals,
                                    "level": album_level(best_title, signals), "release_id": release.get("id"),
                                    "disc": None, "alternatives": [
                                        match for match in ranked if match[0].get("id") != (best or {}).get("id")
                                    ][:_MAX_ALTERNATIVE_GROUPS]})
    _compare_tracks(candidate, albums, mirror)


def _compare_tracks(candidate, albums, mirror) -> None:
    fetched = 0
    for index, evidence in enumerate(candidate["albums"]):
        if fetched >= _MAX_TRACKLISTS_PER_CANDIDATE:
            break
        # Tracks raise an album to strong, and a credit-name match needs them as well.
        credited_without_tracks = index in candidate["credits"] and not evidence["signals"] & {"track_list", "durations"}
        # A typo or partial title has no level until its tracks are compared.
        if not evidence["title"] or (evidence["level"] == "strong" and not credited_without_tracks):
            continue
        if _fetch_tracks(evidence, albums[index], mirror) is None:
            break
        fetched += 1


def _open_to_other_releases(evidence: dict[str, object]) -> bool:
    """No evidence yet, or a same-titled release whose tracks differ."""
    return not evidence["level"] or (evidence["level"] != "strong" and "tracks_differ" in evidence["signals"])


def _improvable(evidence: dict[str, object]) -> bool:
    """Open to other releases, or held only by a partial title another release may beat
    ("Contain Us 10"" is a disc, not the whole "Contain Us")."""
    return _open_to_other_releases(evidence) or evidence["title"] == "partial"


def _better_than(entry: dict[str, object], evidence: dict[str, object]) -> bool:
    return _open_to_other_releases(evidence) or TITLE_RANK[entry["title"]] < TITLE_RANK[evidence["title"]]


def _as_group(release: dict[str, object]) -> dict[str, object]:
    return {"id": release.get("release_group_id"), "title": release.get("title"),
            "first_release_date": release.get("date")}


def _artist_releases(candidate, mirror) -> list[dict[str, object]] | None:
    """The candidate's releases with their discs, fetched once for release titles,
    tracklist comparisons and box sets. None when the budget is spent."""
    if "release_browse" not in candidate:
        found = mirror.call("browse_release_discs", candidate["mbid"], max_pages=2)
        if found is None:
            return None
        candidate["release_browse"] = found.get("releases") or []
    return candidate["release_browse"]


def _release_evidence(album, release, title) -> dict[str, object]:
    remote = {"first_release_date": release.get("date"),
              "track_count": sum(int(disc.get("track_count") or 0) for disc in release.get("discs") or []) or None}
    signals = album_signals(album, remote)
    return {"title": title, "group": _as_group(release), "remote": remote, "signals": signals, "level": album_level(title, signals),
            "release_id": release.get("id"), "disc": None, "alternatives": []}


def _match_release_titles(candidate, albums, names, mirror) -> None:
    """Albums no release group's title agrees with, against every release's own title:
    localized, original-script and re-release titles of the group ("Ẁurdah Ïtah"
    released under Christian Vander's name inside Magma's group)."""
    releases = _artist_releases(candidate, mirror)
    if not releases:
        return
    keyed = [(release, title_keys(release.get("title"), names)) for release in releases
             if release.get("release_group_id")]
    for index, evidence in enumerate(candidate["albums"]):
        if not _improvable(evidence):
            continue
        ranked = ranked_title_matches(albums[index]["title"], keyed, names)
        # A release titled exactly like the album (an English pseudo-release of a
        # soundtrack) wins over a group that only contains its title.
        if ranked and _better_than({"title": ranked[0][1]}, evidence):
            release, title = ranked[0]
            candidate["albums"][index] = {**_release_evidence(albums[index], release, title), "alternatives": [
                (_as_group(other), agreement) for other, agreement in ranked[1:1 + _MAX_ALTERNATIVE_GROUPS]]}


def _match_tracks_alone(candidate, albums, mirror) -> None:
    """For the artist named like the tag, albums still without evidence against its
    releases of the same length, by their tracks alone (Тампль's "finrod-song")."""
    releases = _artist_releases(candidate, mirror)
    if not releases:
        return
    compared = 0
    for index, evidence in enumerate(candidate["albums"]):
        album = albums[index]
        count = len(album.get("tracks") or [])
        # Also an album whose same-titled release has other tracks (Amestigon's split
        # release, not its "Mysterious Realms").
        if not _open_to_other_releases(evidence) or not count:
            continue
        same_length = [release for release in releases if release.get("release_group_id") and sum(
            int(disc.get("track_count") or 0) for disc in release.get("discs") or []) == count]
        seen: set[str] = set()
        for release in same_length:
            if release["release_group_id"] in seen or len(seen) >= _MAX_TRACK_ONLY_PER_ALBUM:
                continue
            if compared >= _MAX_TRACK_ONLY_PER_CANDIDATE or mirror.remaining <= _RETRY_RESERVE:
                return
            seen.add(release["release_group_id"])
            trial = _release_evidence(album, release, "tracks")
            fetched = _fetch_tracks(trial, album, mirror)
            if fetched is None:
                return
            compared += 1
            if trial["level"]:
                candidate["albums"][index] = trial
                break


def _fetch_tracks(evidence: dict[str, object], album: dict[str, object], mirror) -> bool | None:
    """Compare one album with the tracks of its release group's closest release.
    None when the budget is spent; False when there is nothing to compare."""
    if evidence.get("disc") or not evidence.get("group") or not evidence["group"].get("id") \
            or not album.get("tracks") or evidence["remote"].get("tracks"):
        return False
    tried: list[str] = []
    while True:
        tracks = mirror.call("release_group_tracks", evidence["group"]["id"], track_count=len(album["tracks"]),
                             exclude=tuple(tried))
        if tracks is None:
            return None
        evidence["remote"]["tracks"] = tracks.get("tracks") or []
        evidence["release_id"] = tracks.get("release_id") or evidence.get("release_id")
        evidence["signals"] = album_signals(album, evidence["remote"])
        evidence["level"] = album_level(evidence["title"], evidence["signals"])
        if evidence["signals"] & {"track_list", "durations"} or mirror.remaining <= _RETRY_RESERVE:
            # Retries never spend the budget other candidates and the final lookups need.
            return True
        if tracks.get("release_id") and len(tried) < _MAX_OTHER_RELEASES and tracks.get("other_releases"):
            # The closest release may be another arrangement (Dessiderium's 9-track
            # edition, a remaster with swapped parts): the next ones are compared.
            tried.append(tracks["release_id"])
            continue
        tried = []
        alternatives = evidence.get("alternatives") or []
        if not alternatives:
            return True
        # Its tracks differ: the next group whose title agrees may be the album (a
        # compilation's group came first).
        group, title = alternatives.pop(0)
        evidence.update({"title": title, "group": group, "remote": {"first_release_date": group.get("first_release_date")},
                         "release_id": None})


def _match_box_set_discs(candidate, albums, local_name, mirror) -> None:
    """Albums without a same-titled release group, against the discs of the
    candidate's multi-disc releases: by the disc's title ("Stuff That Was Almost
    Stuff" in "Contain Us"), by the release title and the disc's format ("Contain
    Us 10""), or, for a disc tagged only "Bonus EP", by a release titled like
    another local album ("Silent Running", disc 2)."""
    releases = _artist_releases(candidate, mirror)
    if releases is None:
        return
    names = tuple(name for name in (local_name, candidate.get("canonical_name")) if name)
    for index, evidence in enumerate(candidate["albums"]):
        if not _improvable(evidence):
            continue
        album = albums[index]
        local_count = len(album.get("tracks") or [])
        # "Contain Us 10"" is the release title plus the disc's format.
        without_format = _FORMAT_SUFFIX.sub("", album["title"]).strip()
        format_words = fold(album["title"][len(without_format):])
        generic = bool(_GENERIC_DISC_TITLE.match(album["title"]))
        other_titles = [other["title"] for position, other in enumerate(albums) if position != index]
        best, best_rank = None, None
        for release in releases:
            discs = release.get("discs") or []
            for disc in discs:
                title = title_agreement(album["title"], disc.get("title"), names) if len(discs) > 1 else None
                same_count = bool(local_count) and abs(int(disc.get("track_count") or 0) - local_count) <= 1
                if not title and without_format != album["title"] and same_count:
                    title = title_agreement(without_format, release.get("title"), names)
                if not title and generic and same_count and len(discs) > 1 and any(
                        title_agreement(other, release.get("title"), names) for other in other_titles):
                    title = "exact"
                if not title:
                    continue
                remote = {"first_release_date": release.get("date"), "track_count": disc.get("track_count")}
                signals = album_signals(album, remote)
                entry = {"title": title, "group": {"id": release.get("release_group_id"), "title": release.get("title"),
                                                   "first_release_date": release.get("date")},
                         "remote": remote, "signals": signals, "level": album_level(title, signals),
                         "release_id": release.get("id"), "disc": disc.get("position") or None}
                rank = (album_rank(entry), bool(format_words) and format_words in fold(disc.get("format")),
                        generic and int(disc.get("position") or 0) > 1)
                if best is None or rank > best_rank:
                    best, best_rank = entry, rank
        if best and _better_than(best, evidence):
            candidate["albums"][index] = best


def _compare_capped_albums(candidates, albums, mirror, *, keep: int) -> bool:
    """Compare the leading candidates' remaining agreeing albums (strong ones included,
    since only tracks make an album certain) with their tracks,
    keeping ``keep`` requests (the album searches, the final artist lookup). True
    when any album was compared."""
    compared = False
    for candidate in candidates:
        for index, evidence in enumerate(candidate["albums"]):
            if evidence["level"] not in {"strong", "agree"} or evidence["remote"].get("tracks"):
                continue
            if mirror.remaining <= keep:
                return compared
            fetched = _fetch_tracks(evidence, albums[index], mirror)
            if fetched is None:
                return compared
            compared = compared or fetched
    return compared


def _settle_shared_albums(candidates, albums, mirror) -> None:
    """Where several candidates agree on one album, compare each with its tracks
    (beyond the per-candidate cap) so the album goes to the one it really is."""
    for index in sorted(contested_albums(candidates)):
        for candidate in candidates:
            evidence = candidate["albums"][index]
            if evidence["level"] in {"strong", "agree"} and _fetch_tracks(evidence, albums[index], mirror) is None:
                return


def _album_evidence(candidate: dict[str, object], albums: list[dict[str, object]], *,
                    credited: bool) -> list[dict[str, object]]:
    """Every agreeing album of a match under another credited name; otherwise only
    albums that matched one disc of a release (a bonus EP tagged as its own album)."""
    return [{"local_album_id": albums[index].get("id"), "local_title": albums[index].get("title"),
             "release_group_mbid": (evidence.get("group") or {}).get("id"),
             "release_mbid": evidence.get("release_id"), "disc_position": evidence.get("disc"),
             "signals": sorted(evidence.get("signals") or ())}
            for index, evidence in enumerate(candidate.get("albums") or [])
            if evidence.get("assigned", True) and evidence.get("level") in {"strong", "agree"}
            and (credited or evidence.get("disc"))]


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
    if candidate.get("release_group_count") == 0:
        summary = "No releases on MusicBrainz"
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
