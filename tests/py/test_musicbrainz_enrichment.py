from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module

import pytest


NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
ARTIST_MBID = "7456103f-3c42-42d2-a2bb-5618b5db6f1b"
APPROVED_TRIGGERS = (
    "full_scan",
    "periodic_scan",
    "new_album",
    "startup_backfill",
    "stale_refresh",
    "authorized_retry",
)


def enrichment_api():
    try:
        return import_module("music_app.services.musicbrainz_enrichment")
    except ModuleNotFoundError:
        pytest.fail("MusicBrainz enrichment scheduler is not implemented yet", pytrace=False)


class Repository:
    def __init__(self):
        self.enqueue_calls = []
        self.artist_enqueue_calls = []
        self.claims = []
        self.contexts = {}
        self.automatic_outcomes = []
        self.candidate_replacements = []
        self.projection_refreshes = []
        self.retry_calls = []
        self.completed = []

    def enqueue_eligible_artists(self, *, reason, observed_at):
        self.enqueue_calls.append((reason, observed_at))
        return {"enqueued_count": 1}

    def enqueue_artist(self, *, local_artist_id, reason, observed_at):
        self.artist_enqueue_calls.append((local_artist_id, reason, observed_at))
        return {"enqueued": True}

    def claim_due_job(self, *, worker_id, now, lease_duration):
        if not self.claims:
            return None
        return self.claims.pop(0)

    def load_artist_context(self, *, job_id, worker_id):
        return self.contexts[job_id]

    def record_automatic_outcome(self, **kwargs):
        self.automatic_outcomes.append(kwargs)
        return {"protected": kwargs.get("preserve_existing", False)}

    def replace_candidates(self, **kwargs):
        self.candidate_replacements.append(kwargs)
        return len(kwargs["candidates"])

    def refresh_artist_projection(self, **kwargs):
        self.projection_refreshes.append(kwargs)
        return True

    def schedule_retry(self, **kwargs):
        self.retry_calls.append(kwargs)
        return True

    def complete_job(self, **kwargs):
        self.completed.append(kwargs)
        return True


class Resolver:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def __call__(self, context, *, client):
        self.calls.append((context, client))
        return self.result


@pytest.mark.parametrize("trigger", APPROVED_TRIGGERS[:-1])
def test_scheduler_routes_every_background_trigger_to_one_idempotent_current_library_enqueue(
    trigger,
):
    api = enrichment_api()
    repository = Repository()
    scheduler = api.MusicBrainzEnrichmentScheduler(repository, now=lambda: NOW)

    assert scheduler.schedule(trigger) == {"enqueued_count": 1}
    assert repository.enqueue_calls == [(trigger, NOW)]
    assert repository.artist_enqueue_calls == []


def test_authorized_retry_enqueues_only_the_requested_current_library_artist():
    api = enrichment_api()
    repository = Repository()
    scheduler = api.MusicBrainzEnrichmentScheduler(repository, now=lambda: NOW)

    assert scheduler.schedule("authorized_retry", local_artist_id=41) == {
        "enqueued": True
    }
    assert repository.artist_enqueue_calls == [(41, "authorized_retry", NOW)]
    assert repository.enqueue_calls == []


def test_scheduler_rejects_unapproved_trigger_names_and_unscoped_retry():
    api = enrichment_api()
    scheduler = api.MusicBrainzEnrichmentScheduler(Repository(), now=lambda: NOW)

    with pytest.raises(ValueError, match="trigger"):
        scheduler.schedule("album_release_group")
    with pytest.raises(ValueError, match="artist"):
        scheduler.schedule("authorized_retry")


@pytest.mark.parametrize(
    ("classification", "attempt_count", "retry_after", "expected"),
    [
        ("provider_unavailable", 1, None, timedelta(seconds=30)),
        ("provider_unavailable", 4, None, timedelta(minutes=4)),
        ("catch_up_pending", 5, None, timedelta(minutes=8)),
        ("provider_unavailable", 8, None, timedelta(minutes=15)),
        ("rate_limited", 2, 420, timedelta(minutes=7)),
    ],
)
def test_retry_delay_is_bounded_exponential_and_honors_rate_limit_cooldown(
    classification,
    attempt_count,
    retry_after,
    expected,
):
    api = enrichment_api()

    delay = api.retry_delay(
        classification,
        attempt_count=attempt_count,
        retry_after_seconds=retry_after,
        jitter=lambda _upper_bound: 0,
    )

    assert delay == expected
    assert timedelta(seconds=30) <= delay <= timedelta(minutes=15)


@pytest.mark.parametrize(
    "classification",
    ["found", "not_found", "ambiguous", "invalid_response", "permanent_mismatch"],
)
def test_non_transient_results_never_receive_retry_backoff(classification):
    api = enrichment_api()

    assert api.retry_delay(
        classification,
        attempt_count=1,
        jitter=lambda _upper_bound: 0,
    ) is None


def test_processor_claims_one_lease_then_calls_provider_outside_repository_operation():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "local_name": "Änglagård",
        "manual_decision": False,
    }
    resolver = Resolver(
        {
            "classification": "found",
            "artist": {"mbid": ARTIST_MBID, "canonical_name": "Änglagård"},
            "confidence": 0.99,
            "evidence_summary": "Identifier and album evidence agree.",
        }
    )
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=resolver,
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result == {"processed": True, "state": "succeeded", "job_id": 17}
    assert resolver.calls[0][0] == repository.contexts[17]
    assert repository.automatic_outcomes[0]["artist"]["mbid"] == ARTIST_MBID
    assert repository.completed[0]["state"] == "succeeded"
    assert repository.retry_calls == []


def test_confirmed_not_found_records_explicit_review_state_without_retry():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "local_name": "Missing Artist",
        "manual_decision": False,
    }
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver(
            {
                "classification": "not_found",
                "artist": None,
                "confidence": 0,
                "evidence_summary": "All bounded search pages completed.",
            }
        ),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "needs_review"
    assert repository.automatic_outcomes[0]["state"] == "not_found"
    assert repository.completed[0]["state"] == "needs_review"
    assert repository.retry_calls == []


def test_ambiguous_result_atomically_replaces_candidates_and_needs_review():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "local_name": "Nightwish",
        "manual_decision": False,
    }
    candidates = [
        {"artist_mbid": ARTIST_MBID, "candidate_score": 0.91},
        {
            "artist_mbid": "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d",
            "candidate_score": 0.89,
        },
    ]
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver(
            {
                "classification": "ambiguous",
                "candidates": candidates,
                "evidence_summary": "Two candidates have equal evidence strength.",
            }
        ),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "needs_review"
    assert repository.candidate_replacements[0]["candidates"] == candidates
    assert repository.completed[0]["state"] == "needs_review"
    assert repository.retry_calls == []


def test_unconfirmed_single_name_match_is_stored_for_review_not_as_multiple_matches():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append({"id": 17, "local_artist_id": 41, "attempt_count": 1})
    repository.contexts[17] = {"local_artist_id": 41, "local_name": "A.A.Williams", "manual_decision": False}
    candidates = [{"artist_mbid": ARTIST_MBID, "candidate_score": 1}]
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver({"classification": "unconfirmed", "candidates": candidates,
                                 "evidence_summary": "One name match."}),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "needs_review"
    assert repository.candidate_replacements[0]["match_state"] == "manual_review"
    assert repository.candidate_replacements[0]["candidates"] == candidates


def test_unconfirmed_recheck_refreshes_the_complete_projection_for_the_preserved_match():
    artist = {
        "mbid": ARTIST_MBID,
        "canonical_name": "Compilation Signal Guest",
        "sort_name": "Compilation Signal Guest",
        "preferred_native_name": None,
        "artist_type": "Group",
        "disambiguation": "Finnish progressive rock band",
        "country_code": "FI",
        "source_url": f"https://musicbrainz.org/artist/{ARTIST_MBID}",
        "aliases": [{
            "name": "Compilation Signal",
            "normalized_name": "compilation signal",
            "sort_name": "Compilation Signal",
            "locale": "en",
            "type": None,
            "primary": True,
        }],
        "tags": [],
        "genres": [
            {"name": "progressive rock", "normalized_name": "progressive rock", "vote_count": 12},
            {"name": "art rock", "normalized_name": "art rock", "vote_count": 8},
        ],
        "discogs_artist_id": 218108,
    }
    _result, repository = _process(
        {"existing_artist_mbid": ARTIST_MBID, "existing_match_state": "matched"},
        {
            "classification": "unconfirmed",
            "candidates": [{"artist_mbid": ARTIST_MBID, "candidate_score": 1}],
            "refreshed_artist": artist,
            "evidence_summary": "One MusicBrainz artist has this name, but none of your albums confirm it.",
        },
    )

    assert repository.projection_refreshes == [{
        "local_artist_id": 41,
        "artist": artist,
        "observed_at": NOW,
    }]
    assert repository.candidate_replacements == []


def test_unconfirmed_recheck_does_not_refresh_from_an_incomplete_artist_snapshot():
    _result, repository = _process(
        {"existing_artist_mbid": ARTIST_MBID, "existing_match_state": "matched"},
        {
            "classification": "unconfirmed",
            "candidates": [{"artist_mbid": ARTIST_MBID, "candidate_score": 1}],
            "refreshed_artist": {
                "mbid": ARTIST_MBID,
                "canonical_name": "Compilation Signal Guest",
            },
            "evidence_summary": "One MusicBrainz artist has this name, but none of your albums confirm it.",
        },
    )

    assert repository.projection_refreshes == []


@pytest.mark.parametrize("classification", ["invalid_response", "permanent_mismatch"])
def test_invalid_or_contradictory_results_need_review_instead_of_retry(classification):
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "local_name": "Conflicted Artist",
        "manual_decision": False,
    }
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver(
            {
                "classification": classification,
                "artist": None,
                "safe_error": "Provider evidence requires manual review.",
            }
        ),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "needs_review"
    assert repository.retry_calls == []
    assert repository.completed[0]["classification"] == classification


@pytest.mark.parametrize(
    "classification",
    ["rate_limited", "provider_unavailable", "catch_up_pending"],
)
def test_transient_results_schedule_retry_without_clearing_prior_accepted_data(
    classification,
):
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 2}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "local_name": "Guardian",
        "existing_artist_mbid": ARTIST_MBID,
        "existing_match_state": "matched",
        "manual_decision": classification == "provider_unavailable",
    }
    resolver = Resolver(
        {
            "classification": classification,
            "artist": None,
            "safe_error": "MusicBrainz could not be reached.",
            "retry_after_seconds": 90 if classification == "rate_limited" else None,
        }
    )
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=resolver,
        now=lambda: NOW,
        jitter=lambda _upper_bound: 0,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "retry_wait"
    assert repository.retry_calls[0]["classification"] == classification
    assert repository.retry_calls[0]["retry_at"] > NOW
    assert repository.automatic_outcomes == []
    assert repository.candidate_replacements == []
    assert repository.completed == []


def test_search_hit_direct_404_remains_catch_up_pending_not_not_found():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "existing_artist_mbid": ARTIST_MBID,
        "existing_match_state": "matched",
        "manual_decision": True,
    }
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver(
            {
                "classification": "catch_up_pending",
                "artist": None,
                "safe_error": "MusicBrainz mirror is catching up.",
            }
        ),
        now=lambda: NOW,
        jitter=lambda _upper_bound: 0,
    )

    processor.process_next(worker_id="worker-a")

    assert repository.retry_calls[0]["classification"] == "catch_up_pending"
    assert "catching up" in repository.retry_calls[0]["safe_error"].lower()
    assert repository.automatic_outcomes == []


def test_retry_exhaustion_preserves_prior_match_and_records_last_classification():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 6}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "existing_artist_mbid": ARTIST_MBID,
        "existing_match_state": "matched",
        "manual_decision": True,
    }
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver(
            {
                "classification": "provider_unavailable",
                "artist": None,
                "safe_error": "MusicBrainz provider unavailable.",
            }
        ),
        now=lambda: NOW,
        max_attempts=6,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "exhausted"
    assert repository.completed == [
        {
            "job_id": 17,
            "worker_id": "worker-a",
            "state": "exhausted",
            "classification": "provider_unavailable",
            "safe_error": "MusicBrainz provider unavailable.",
            "observed_at": NOW,
            "preserve_existing": True,
        }
    ]
    assert repository.automatic_outcomes == []


def test_manual_decision_short_circuits_provider_and_finishes_without_replacement():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append(
        {"id": 17, "local_artist_id": 41, "attempt_count": 1}
    )
    repository.contexts[17] = {
        "local_artist_id": 41,
        "existing_artist_mbid": ARTIST_MBID,
        "existing_match_state": "matched",
        "manual_decision": True,
        "projection_is_fresh": True,
    }
    resolver = Resolver(None)

    def fail_if_called(*_args, **_kwargs):
        pytest.fail("manual fresh decisions must not call MusicBrainz")

    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=fail_if_called,
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "succeeded"
    assert repository.automatic_outcomes == []
    assert repository.completed[0]["preserve_existing"] is True


def test_contradicted_identity_keeps_candidates_for_conflict_review():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append({"id": 18, "local_artist_id": 42, "attempt_count": 1})
    repository.contexts[18] = {"local_artist_id": 42, "local_name": "Aria", "manual_decision": False}
    candidates = [{"artist_mbid": "00000000-0000-4000-8000-000000000031", "canonical_name": "Ария",
                   "candidate_score": 1, "evidence_summary": "37 of 38 albums agree"}]
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver({"classification": "permanent_mismatch", "candidates": candidates,
                                 "evidence_summary": "MusicBrainz candidates require manual review."}),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "needs_review"
    [replacement] = repository.candidate_replacements
    assert replacement["match_state"] == "conflict"
    assert replacement["candidates"] == candidates


def _process(context, outcome):
    api = enrichment_api()
    repository = Repository()
    repository.claims.append({"id": 17, "local_artist_id": 41, "attempt_count": 1})
    repository.contexts[17] = {"local_artist_id": 41, "local_name": "Shadowland", "manual_decision": False, **context}
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository, client=object(), resolve_artist=Resolver(outcome), now=lambda: NOW,
    )
    return processor.process_next(worker_id="worker-a"), repository


OTHER_MBID = "b3fd6f66-a24e-4336-9fdd-2fa249de6d3b"


def test_a_recheck_that_finds_another_artist_moves_the_match_to_conflict_never_replacing_it():
    result, repository = _process(
        {"existing_artist_mbid": ARTIST_MBID, "existing_match_state": "matched", "existing_canonical_name": "Shadowland"},
        {"classification": "found", "artist": {"mbid": OTHER_MBID, "canonical_name": "Shadowland",
                                               "disambiguation": "British prog rock"},
         "confidence": 1, "evidence_summary": "MusicBrainz search evidence agreed."},
    )

    assert result["state"] == "needs_review"
    assert repository.automatic_outcomes == [], "the stored match is never overwritten"
    replacement = repository.candidate_replacements[0]
    assert replacement["match_state"] == "conflict"
    assert [candidate["artist_mbid"] for candidate in replacement["candidates"]] == [ARTIST_MBID, OTHER_MBID]


def test_a_recheck_that_confirms_the_stored_match_records_it_again():
    _result, repository = _process(
        {"existing_artist_mbid": ARTIST_MBID, "existing_match_state": "matched"},
        {"classification": "found", "artist": {"mbid": ARTIST_MBID, "canonical_name": "Shadowland"},
         "confidence": 1, "evidence_summary": "MusicBrainz search evidence agreed."},
    )

    assert repository.automatic_outcomes[0]["state"] == "matched"
    assert repository.candidate_replacements == []


def test_a_release_credit_match_stores_the_local_credit_name():
    _result, repository = _process(
        {},
        {"classification": "found", "artist": {"mbid": OTHER_MBID, "canonical_name": "Chris Buck"},
         "confidence": 1, "evidence_summary": "MusicBrainz release credit evidence agreed.", "credit_name": "3 Crows"},
    )

    assert repository.automatic_outcomes[0]["credit_name"] == "3 Crows"


def test_a_manual_match_is_never_moved_to_conflict_by_a_recheck():
    _result, repository = _process(
        {"existing_artist_mbid": ARTIST_MBID, "existing_match_state": "matched", "manual_decision": True,
         "projection_is_fresh": False},
        {"classification": "found", "artist": {"mbid": OTHER_MBID, "canonical_name": "Shadowland"},
         "confidence": 1, "evidence_summary": "MusicBrainz search evidence agreed."},
    )

    assert repository.candidate_replacements == []


def test_albums_of_several_musicbrainz_artists_store_each_album_s_identity():
    api = enrichment_api()
    repository = Repository()
    repository.claims.append({"id": 18, "local_artist_id": 42, "attempt_count": 0})
    repository.contexts[18] = {"local_artist_id": 42, "local_name": "Amarok", "manual_decision": False}
    identities = [{"local_album_id": 1, "artist_mbid": "00000000-0000-4000-8000-000000000001"},
                  {"local_album_id": 2, "artist_mbid": "00000000-0000-4000-8000-000000000002"}]
    artists = [{"mbid": "00000000-0000-4000-8000-000000000001", "canonical_name": "Amarok"},
               {"mbid": "00000000-0000-4000-8000-000000000002", "canonical_name": "Amarok"}]
    processor = api.MusicBrainzArtistEnrichmentProcessor(
        repository=repository,
        client=object(),
        resolve_artist=Resolver({"classification": "per_album", "confidence": 1, "album_identities": identities,
                                 "artists": artists, "evidence_summary": "Your albums belong to 2 MusicBrainz artists."}),
        now=lambda: NOW,
    )

    result = processor.process_next(worker_id="worker-a")

    assert result["state"] == "succeeded"
    stored = repository.automatic_outcomes[0]
    assert (stored["state"], stored["artist"], stored["album_identities"], stored["identity_artists"]) == (
        "per_album", None, identities, artists)
    assert repository.candidate_replacements == []
