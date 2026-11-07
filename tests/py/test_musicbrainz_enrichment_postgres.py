from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_enrichment_postgres import (
    MATCHER_VERSION,
    MusicBrainzEnrichmentPostgresRepository,
)


DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
ARTIST_MBID = "7456103f-3c42-42d2-a2bb-5618b5db6f1b"
OTHER_MBID = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d"


class FakeCursor:
    def __init__(self, *, row=None, rows=None):
        self._row = row
        self._rows = list(rows or [])

    def fetchone(self):
        return self._row

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, cursors):
        self._cursors = list(cursors)
        self.calls = []
        self.problem_syncs = []
        self.matcher_marks = []
        self.artist_locks = []
        self.transaction_count = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return None

    def transaction(self):
        self.transaction_count += 1
        return nullcontext()

    def execute(self, sql, params=None):
        if "pg_advisory_xact_lock" in sql:
            # The per-artist writer lock must come before any other statement.
            self.artist_locks.append((len(self.calls), params["local_artist_id"]))
            return FakeCursor()
        if "insert into library.metadata_enrichment_problems" in sql:
            self.problem_syncs.append(params)
            return FakeCursor()
        if "set matcher_version" in sql:
            self.matcher_marks.append(params)
            return FakeCursor()
        self.calls.append((sql, params))
        if not self._cursors:
            raise AssertionError(f"Unexpected SQL: {sql}")
        return self._cursors.pop(0)


def repository_for(connection):
    return MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL},
        connect=lambda database_url: connection,
    )


def normalized_sql(connection, index=0):
    return " ".join(connection.calls[index][0].lower().split())


def test_enqueue_eligible_artists_is_idempotent_artist_only_and_current_library_scoped():
    connection = FakeConnection([FakeCursor(row={"enqueued_count": 2})])

    result = repository_for(connection).enqueue_eligible_artists(
        reason="library_menu_sync",
        observed_at=NOW,
    )

    assert result == {"enqueued_count": 2}
    sql = normalized_sql(connection)
    assert "from app.bootstrap_owners" in sql
    assert "join library.libraries" in sql
    assert "owner_key = 'local-bootstrap-owner'" in sql
    assert "insert into ops.metadata_enrichment_jobs" in sql
    assert "target_kind" in sql and "'artist'" in sql
    assert "on conflict" in sql and "do nothing" in sql
    assert "library_id" not in connection.calls[0][1]


def test_enqueue_uses_distinct_present_artists_across_duplicate_roots_and_retained_rows():
    connection = FakeConnection([FakeCursor(row={"enqueued_count": 1})])

    repository_for(connection).enqueue_eligible_artists(
        reason="post_scan",
        observed_at=NOW,
    )

    sql = normalized_sql(connection)
    assert "library.local_artists" in sql
    assert "library.local_tracks" in sql
    assert "exists" in sql
    assert "distinct" in sql or "group by" in sql
    assert "private_path" not in sql
    assert "library.library_roots" not in sql


def test_enqueue_excludes_fresh_matched_and_manual_artists_without_deleting_retained_identity():
    connection = FakeConnection([FakeCursor(row={"enqueued_count": 0})])

    repository_for(connection).enqueue_eligible_artists(
        reason="startup_backfill",
        observed_at=NOW,
    )

    sql = normalized_sql(connection)
    assert "local_artist_musicbrainz_matches" in sql
    assert "decision_source = 'manual'" in sql
    assert "last_verified_at" in sql
    assert "delete from library.local_artist_musicbrainz_matches" not in sql
    assert "delete from integration.musicbrainz_artists" not in sql


def test_authorized_retry_enqueue_is_current_library_scoped_and_idempotent():
    connection = FakeConnection([FakeCursor(row={"enqueued": True})])

    result = repository_for(connection).enqueue_artist(
        local_artist_id=41,
        reason="authorized_retry",
        observed_at=NOW,
    )

    assert result == {"enqueued": True}
    sql, params = connection.calls[0]
    sql = " ".join(sql.lower().split())
    assert "from app.bootstrap_owners" in sql
    assert "join library.local_artists" in sql
    assert "insert into ops.metadata_enrichment_jobs" in sql
    assert "on conflict" in sql
    assert params["local_artist_id"] == 41
    assert "library_id" not in params


def test_claim_due_job_uses_skip_locked_and_recovers_an_expired_lease():
    job = {
        "id": 17,
        "library_id": 5,
        "local_artist_id": 41,
        "state": "leased",
        "attempt_count": 2,
        "lease_owner": "worker-a",
        "lease_expires_at": NOW + timedelta(minutes=5),
    }
    connection = FakeConnection([FakeCursor(row=job)])

    result = repository_for(connection).claim_due_job(
        worker_id="worker-a",
        now=NOW,
        lease_duration=timedelta(minutes=5),
    )

    assert result == job
    sql = normalized_sql(connection)
    assert "for update skip locked" in sql
    assert "state in ('queued', 'retry_wait')" in sql
    assert "state = 'leased'" in sql
    assert "lease_expires_at <= %(now)s" in sql
    assert "next_attempt_at <= %(now)s" in sql
    assert "update ops.metadata_enrichment_jobs" in sql
    assert "attempt_count =" in sql
    assert connection.calls[0][1]["worker_id"] == "worker-a"


def test_load_claimed_artist_context_is_safe_current_library_evidence_only():
    row = {
        "job_id": 17,
        "local_artist_id": 41,
        "local_name": "Guardian",
        "album_titles": ["First Watch"],
        "hinted_artist_mbids": [],
        "existing_artist_mbid": ARTIST_MBID,
        "existing_match_state": "matched",
        "manual_decision": True,
        "projection_is_fresh": True,
    }
    connection = FakeConnection([FakeCursor(row=row)])

    result = repository_for(connection).load_artist_context(
        job_id=17,
        worker_id="worker-a",
    )

    assert result == row
    sql, params = connection.calls[0]
    sql = " ".join(sql.lower().split())
    assert "from app.bootstrap_owners" in sql
    assert "ops.metadata_enrichment_jobs" in sql
    assert "library.local_artists" in sql
    assert "library.local_albums" in sql
    assert "lease_owner = %(worker_id)s" in sql
    assert "private_path" not in sql
    assert "source_payload" not in sql and "provider_payload" not in sql
    assert params == {"job_id": 17, "worker_id": "worker-a"}


def test_retry_wait_records_bounded_safe_failure_and_not_before_time():
    retry_at = NOW + timedelta(minutes=15)
    connection = FakeConnection([FakeCursor(row={"updated": True, "local_artist_id": 7})])

    updated = repository_for(connection).schedule_retry(
        job_id=17,
        worker_id="worker-a",
        classification="provider_unavailable",
        retry_at=retry_at,
        safe_error="MusicBrainz provider unavailable",
        observed_at=NOW,
    )

    assert updated is True
    sql, params = connection.calls[0]
    sql = " ".join(sql.lower().split())
    assert "state = 'retry_wait'" in sql
    assert "next_attempt_at = %(retry_at)s" in sql
    assert "lease_owner = null" in sql and "lease_expires_at = null" in sql
    assert "where" in sql and "lease_owner = %(worker_id)s" in sql
    assert params["retry_at"] == retry_at
    assert "password" not in repr(params).lower()


@pytest.mark.parametrize("state", ["succeeded", "needs_review", "exhausted"])
def test_terminal_completion_is_lease_owned_scoped_and_preserves_artist_data(state):
    connection = FakeConnection([FakeCursor(row={"updated": True, "local_artist_id": 7})])

    updated = repository_for(connection).complete_job(
        job_id=17,
        worker_id="worker-a",
        state=state,
        classification="found" if state == "succeeded" else "ambiguous",
        safe_error=None,
        observed_at=NOW,
        preserve_existing=True,
    )

    assert updated is True
    sql, params = connection.calls[0]
    sql = " ".join(sql.lower().split())
    assert "from app.bootstrap_owners" in sql
    assert "update ops.metadata_enrichment_jobs" in sql
    assert "lease_owner = %(worker_id)s" in sql
    assert "state = 'leased'" in sql
    assert "lease_owner = null" in sql and "lease_expires_at = null" in sql
    assert "completed_at" in sql
    assert "local_artist_musicbrainz_matches" not in sql
    assert "integration.musicbrainz_artists" not in sql
    assert params["state"] == state


def test_candidate_replacement_is_atomic_scoped_and_replaces_the_complete_set():
    candidates = [
        {
            "artist_mbid": ARTIST_MBID,
            "canonical_name": "Nightwish",
            "candidate_score": 0.91,
            "evidence_summary": "Name and local album evidence agree.",
        },
        {
            "artist_mbid": OTHER_MBID,
            "canonical_name": "Nightwish (other)",
            "candidate_score": 0.87,
            "evidence_summary": "Name agrees; local album evidence differs.",
        },
    ]
    connection = FakeConnection(
        [FakeCursor(), FakeCursor(), FakeCursor(), FakeCursor(row={"candidate_count": 2})]
    )

    count = repository_for(connection).replace_candidates(
        local_artist_id=41,
        candidates=candidates,
        match_state="ambiguous",
        evidence_summary="Two equally plausible artist identities.",
        observed_at=NOW,
    )

    assert count == 2
    assert connection.transaction_count == 1
    assert [index for index, _artist in connection.artist_locks] == [0], "writers lock the artist first"
    combined_sql = " ".join(sql.lower() for sql, _params in connection.calls)
    assert "delete from library.local_artist_musicbrainz_candidates" in combined_sql
    assert "insert into integration.musicbrainz_artists" in combined_sql
    assert "insert into library.local_artist_musicbrainz_candidates" in combined_sql
    assert "local_artist_musicbrainz_matches" in combined_sql
    assert "from app.bootstrap_owners" in combined_sql
    assert all(
        params is None or params.get("library_id") is None
        for _sql, params in connection.calls
    )


@pytest.mark.parametrize("provider_state", ["not_found", "provider_unavailable"])
def test_automatic_outcomes_never_replace_an_accepted_manual_match(provider_state):
    connection = FakeConnection([FakeCursor(row={"protected": True})])

    result = repository_for(connection).record_automatic_outcome(
        local_artist_id=41,
        state=provider_state,
        artist=None,
        confidence=0,
        evidence_summary="Provider supplied no usable artist projection.",
        observed_at=NOW,
    )

    assert result == {"protected": True}
    sql = normalized_sql(connection)
    assert "decision_source = 'manual'" in sql
    assert "do update" in sql
    assert "where" in sql
    assert "decision_source <> 'manual'" in sql or "decision_source = 'automatic'" in sql
    assert "artist_mbid = null" not in sql


@pytest.mark.parametrize("provider_state", ["not_found", "provider_unavailable"])
def test_automatic_outcomes_preserve_an_existing_accepted_automatic_match(provider_state):
    connection = FakeConnection([FakeCursor(row={"protected": True})])

    result = repository_for(connection).record_automatic_outcome(
        local_artist_id=41,
        state=provider_state,
        artist=None,
        confidence=0,
        evidence_summary="Provider supplied no usable artist projection.",
        observed_at=NOW,
    )

    assert result == {"protected": True}
    sql = normalized_sql(connection)
    assert "state = 'matched'" in sql
    assert "artist_mbid is not null" in sql
    assert "artist_mbid = null" not in sql
    # The kept match is stamped as checked by the current matcher, so the
    # re-check backfill does not queue it again.
    assert [mark["matcher_version"] for mark in connection.matcher_marks] == [MATCHER_VERSION]


def test_automatic_outcome_preserves_prior_projection_through_disappearance_and_reappearance():
    connection = FakeConnection([FakeCursor(row={"protected": True})])

    repository_for(connection).record_automatic_outcome(
        local_artist_id=41,
        state="not_present",
        artist=None,
        confidence=0,
        evidence_summary="Artist currently has no local tracks.",
        observed_at=NOW,
    )

    sql = normalized_sql(connection)
    assert "delete from integration.musicbrainz_artists" not in sql
    assert "delete from library.local_artist_musicbrainz_matches" not in sql
    assert "artist_mbid = null" not in sql
    assert "local_tracks" in sql


def test_manual_assignment_commits_canonical_projection_decision_assertion_and_audit_together():
    artist = {
        "mbid": ARTIST_MBID,
        "canonical_name": "Änglagård",
        "preferred_native_name": "Änglagård",
        "sort_name": "Anglagard",
        "country_code": "SE",
        "country_name": "Sweden",
        "aliases": [{"name": "Anglagard", "normalized": "anglagard"}],
        "tags": [
            {
                "name": "Progressive Rock",
                "normalized": "progressive rock",
                "count": 7,
                "is_genre": True,
            },
            {
                "name": "Symphonic",
                "normalized": "symphonic",
                "count": 0,
                "is_genre": False,
            },
        ],
    }
    connection = FakeConnection(
        [
            FakeCursor(),
            FakeCursor(),
            FakeCursor(),
            FakeCursor(),
            FakeCursor(),
            FakeCursor(),
            FakeCursor(row={"assigned": True}),
        ]
    )

    assigned = repository_for(connection).assign_manual_match(
        local_artist_id=41,
        actor_account_id=9,
        artist=artist,
        confidence=1,
        evidence_summary="Owner selected the validated MusicBrainz artist.",
        observed_at=NOW,
        request_ref="request-87",
    )

    assert assigned is True
    assert connection.transaction_count == 1
    combined_sql = " ".join(sql.lower() for sql, _params in connection.calls)
    assert "insert into integration.musicbrainz_artists" in combined_sql
    assert "integration.musicbrainz_artist_aliases" in combined_sql
    assert "integration.musicbrainz_artist_countries" in combined_sql
    assert "integration.musicbrainz_artist_tags" in combined_sql
    assert "local_artist_musicbrainz_matches" in combined_sql
    assert "decision_source" in combined_sql and "manual" in combined_sql
    assert "library.local_artist_mbid_assertions" in combined_sql
    assert "app.security_audit_events" in combined_sql
    assert connection.calls[-1][1]["actor_account_id"] == 9


def test_projection_replacement_retains_every_normalized_tag_including_zero_and_negative_votes():
    tags = [
        {
            "name": "Heavy Metal",
            "normalized": "heavy metal",
            "count": 18,
            "is_genre": True,
        },
        {"name": "Epic", "normalized": "epic", "count": 0, "is_genre": False},
        {"name": "Noise", "normalized": "noise", "count": -2, "is_genre": True},
    ]
    connection = FakeConnection(
        [FakeCursor(), FakeCursor(), FakeCursor(row={"stored_tag_count": 3})]
    )

    count = repository_for(connection).replace_artist_tags(
        artist_mbid=ARTIST_MBID,
        tags=tags,
        observed_at=NOW,
    )

    assert count == 3
    assert connection.transaction_count == 1
    insert_sql, insert_params = connection.calls[1]
    assert "insert into integration.musicbrainz_artist_tags" in insert_sql.lower()
    assert insert_params["tags"] == tags
    assert [tag["count"] for tag in insert_params["tags"]] == [18, 0, -2]


def test_complete_present_artist_review_is_library_scoped_bounded_and_safe():
    rows = [
        {
            "local_artist_id": 41,
            "local_artist_name": "Кипелов",
            "match_state": "matched",
            "artist_mbid": ARTIST_MBID,
            "canonical_name": "Кипелов",
            "native_name": "Кипелов",
            "country": "Russia",
            "genres": ["Heavy Metal"],
            "confidence": 0.98,
            "evidence_summary": "Canonical name and album evidence agree.",
            "unresolved_reason": None,
            "musicbrainz_url": f"https://musicbrainz.org/artist/{ARTIST_MBID}",
        },
        {
            "local_artist_id": 42,
            "local_artist_name": "Unknown Artist",
            "match_state": "not_found",
            "artist_mbid": None,
            "canonical_name": None,
            "native_name": None,
            "country": None,
            "genres": [],
            "confidence": 0,
            "evidence_summary": "All bounded search pages completed without a candidate.",
            "unresolved_reason": "MBID: Not found",
            "musicbrainz_url": None,
        },
    ]
    connection = FakeConnection([FakeCursor(rows=rows)])

    result = repository_for(connection).list_present_artist_review()

    assert [{key: row[key] for key in expected} for row, expected in zip(result, rows)] == rows
    assert all(row["problem_occurrence_id"] is None for row in result)
    sql = normalized_sql(connection)
    assert "from app.bootstrap_owners" in sql
    assert "join library.libraries" in sql
    assert "library.local_tracks" in sql and "exists" in sql
    assert "local_artist_musicbrainz_matches" in sql
    assert "musicbrainz_artist_display_genres" in sql
    assert "metadata_enrichment_problems" in sql
    assert "https://musicbrainz.org/artist/" in sql
    assert "private_path" not in sql
    assert "raw_payload" not in sql and "provider_payload" not in sql
    assert "password" not in sql and "credential" not in sql and "token" not in sql
    assert "order by" in sql


def test_review_projection_whitelists_fields_even_if_driver_row_contains_secrets():
    connection = FakeConnection(
        [
            FakeCursor(
                rows=[
                    {
                        "local_artist_id": 41,
                        "local_artist_name": "Guardian",
                        "match_state": "ambiguous",
                        "artist_mbid": None,
                        "canonical_name": None,
                        "native_name": None,
                        "country": None,
                        "genres": [],
                        "confidence": 0.74,
                        "evidence_summary": "x" * 3000,
                        "unresolved_reason": "MBID: Multiple matches",
                        "musicbrainz_url": None,
                        "private_path": "C:/private/music/guardian.flac",
                        "provider_payload": {"token": "secret"},
                        "library_id": 99,
                    }
                ]
            )
        ]
    )

    row = repository_for(connection).list_present_artist_review()[0]

    assert set(row) == {
        "local_artist_id",
        "local_artist_name",
        "match_state",
        "artist_mbid",
        "canonical_name",
        "native_name",
        "country",
        "genres",
        "confidence",
        "evidence_summary",
        "unresolved_reason",
        "musicbrainz_url",
        "disambiguation",
        "artist_kind",
        "problem_occurrence_id",
        "problem_reason_code",
        "local_album_count",
        "last_checked_at",
        "last_attempt_at",
        "next_attempt_at",
    }
    assert "private_path" not in repr(row)
    assert "secret" not in repr(row)
    assert "library_id" not in row
    assert len(row["evidence_summary"]) <= 2048


@pytest.mark.parametrize(
    ("classification", "expected_reason"),
    [
        ("catch_up_pending", "musicbrainz_mirror_replication_pending"),
        ("provider_unavailable", "musicbrainz_provider_retry_exhausted"),
        ("rate_limited", "musicbrainz_provider_retry_exhausted"),
    ],
)
def test_retry_wait_syncs_the_provider_problem_in_the_same_transaction(classification, expected_reason):
    connection = FakeConnection([FakeCursor(row={"updated": True, "local_artist_id": 7})])

    repository_for(connection).schedule_retry(
        job_id=17,
        worker_id="worker-a",
        classification=classification,
        retry_at=NOW + timedelta(minutes=5),
        safe_error="MusicBrainz provider is temporarily unavailable.",
        observed_at=NOW,
    )

    assert connection.transaction_count == 1
    [sync] = connection.problem_syncs
    assert sync["local_artist_id"] == 7
    assert sync["job_id"] == 17
    assert sync["provider_reason"] == expected_reason


@pytest.mark.parametrize(
    ("state", "classification", "expected_reason"),
    [
        ("exhausted", "provider_unavailable", "musicbrainz_provider_retry_exhausted"),
        ("succeeded", "found", None),
        ("needs_review", "ambiguous", None),
    ],
)
def test_job_completion_opens_provider_problems_only_on_exhaustion(state, classification, expected_reason):
    connection = FakeConnection([FakeCursor(row={"updated": True, "local_artist_id": 7})])

    repository_for(connection).complete_job(
        job_id=17,
        worker_id="worker-a",
        state=state,
        classification=classification,
        safe_error=None,
        observed_at=NOW,
        preserve_existing=True,
    )

    [sync] = connection.problem_syncs
    assert sync["provider_reason"] == expected_reason


def test_lost_lease_does_not_touch_problems():
    connection = FakeConnection([FakeCursor(row=None)])

    updated = repository_for(connection).complete_job(
        job_id=17,
        worker_id="worker-a",
        state="exhausted",
        classification="provider_unavailable",
        safe_error=None,
        observed_at=NOW,
        preserve_existing=True,
    )

    assert updated is False
    assert connection.problem_syncs == []


def test_problem_sync_derives_identity_reasons_from_the_stored_match():
    from music_app.services.musicbrainz_enrichment_postgres import _sync_problem_sql

    sql = " ".join(_sync_problem_sql().lower().split())
    for state, reason in (
        ("not_found", "musicbrainz_artist_not_found"),
        ("ambiguous", "musicbrainz_artist_ambiguous"),
        ("conflict", "musicbrainz_artist_metadata_conflict"),
    ):
        assert f"when matches.state = '{state}' then '{reason}'" in sql
    assert "when desired.match_state = 'matched'" in sql
    assert "on conflict (library_id, local_artist_id, reason_code) where lifecycle_state = 'active'" in sql
