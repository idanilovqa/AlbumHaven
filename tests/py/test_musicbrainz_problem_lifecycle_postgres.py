from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_enrichment_postgres import (
    MusicBrainzEnrichmentPostgresRepository,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    MIGRATION_PATH,
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
)


NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
GERMAN = "00000000-0000-4000-8000-000000000021"
TRANCE = "00000000-0000-4000-8000-000000000022"


def _problems(connection, artist_id):
    return connection.execute(
        """
        select reason_code, lifecycle_state, candidate_count, resolution_source,
               related_job_id is not null as has_job
        from library.metadata_enrichment_problems
        where local_artist_id = %s
        order by id
        """,
        (artist_id,),
    ).fetchall()


def _active(connection, artist_id):
    return [row["reason_code"] for row in _problems(connection, artist_id)
            if row["lifecycle_state"] == "active"]


def test_problem_lifecycle_follows_stored_matches_on_real_postgres(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(MIGRATION_PATH.read_text(encoding="utf-8"))
        library_id = connection.execute(
            """
            select library.libraries.id
            from app.bootstrap_owners
            join library.libraries
              on library.libraries.owner_account_id = app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone()["id"]
        owner_id = connection.execute(
            "select account_id from app.bootstrap_owners where owner_key = 'local-bootstrap-owner'"
        ).fetchone()["account_id"]
        artist_id = connection.execute(
            """
            insert into library.local_artists (library_id, artist_key, name, metadata)
            values (%s, 'lifecycle-axxis', 'Axxis', '{}'::jsonb) returning id
            """,
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            """
            insert into library.local_albums (library_id, artist_id, album_key, title, metadata)
            values (%s, %s, 'lifecycle-kingdom', 'Kingdom of the Night', '{}'::jsonb) returning id
            """,
            (library_id, artist_id),
        ).fetchone()["id"]
        connection.execute(
            """
            insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata)
            values (%s, %s, %s, 'lifecycle-track', 'Track', '{}'::jsonb)
            """,
            (library_id, album_id, artist_id),
        )

    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )

    candidate_count = repository.replace_candidates(
        local_artist_id=artist_id,
        candidates=[
            {"artist_mbid": GERMAN, "canonical_name": "Axxis", "candidate_score": 1,
             "evidence_summary": "1 of 1 album agree", "disambiguation": "German hard rock band",
             "artist_kind": "Group", "country_code": "DE"},
            {"artist_mbid": TRANCE, "canonical_name": "Axxis", "candidate_score": 1,
             "evidence_summary": "Name only", "artist_kind": "Group"},
        ],
        match_state="ambiguous",
        evidence_summary="MusicBrainz candidates require manual review.",
        observed_at=NOW,
    )
    assert candidate_count == 2
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_artist_ambiguous"]
        assert _problems(connection, artist_id)[0]["candidate_count"] == 2
        german = connection.execute(
            """
            select artists.disambiguation, artists.artist_kind, countries.country_code
            from integration.musicbrainz_artists artists
            left join integration.musicbrainz_artist_countries countries
              on countries.artist_mbid = artists.mbid
            where artists.mbid = %s
            """,
            (GERMAN,),
        ).fetchone()
        assert german == {"disambiguation": "German hard rock band", "artist_kind": "Group",
                          "country_code": "DE"}

    # Re-observing the same outcome updates the one active problem.
    repository.replace_candidates(
        local_artist_id=artist_id,
        candidates=[{"artist_mbid": GERMAN, "canonical_name": "Axxis", "candidate_score": 1,
                     "evidence_summary": "1 of 1 album agree"}],
        match_state="ambiguous",
        evidence_summary="MusicBrainz candidates require manual review.",
        observed_at=NOW + timedelta(minutes=1),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        rows = _problems(connection, artist_id)
        assert [row["reason_code"] for row in rows] == ["musicbrainz_artist_ambiguous"]
        assert rows[0]["candidate_count"] == 1

    detail = repository.get_artist_problem(local_artist_id=artist_id)
    assert detail["unresolved_reason"] == "MBID: Multiple matches"
    assert detail["problem_reason_code"] == "musicbrainz_artist_ambiguous"
    assert detail["problem_occurrence_id"] is not None
    assert detail["local_album_count"] == 1
    assert [candidate["artist_mbid"] for candidate in detail["candidates"]] == [GERMAN]
    assert detail["candidates"][0]["disambiguation"] == "German hard rock band"
    assert detail["candidates"][0]["country"] == "DE"
    assert detail["candidates"][0]["musicbrainz_url"] == f"https://musicbrainz.org/artist/{GERMAN}"
    [review] = repository.list_present_artist_review()
    assert review["problem_occurrence_id"] == detail["problem_occurrence_id"]

    # A provider failure during a retry never replaces a durable identity problem.
    repository.enqueue_artist(local_artist_id=artist_id, reason="authorized_retry", observed_at=NOW)
    job = repository.claim_due_job(worker_id="worker-a", now=NOW + timedelta(minutes=2),
                                   lease_duration=timedelta(minutes=5))
    assert job and int(job["local_artist_id"]) == artist_id
    assert repository.schedule_retry(
        job_id=job["id"], worker_id="worker-a", classification="provider_unavailable",
        retry_at=NOW + timedelta(minutes=20), safe_error="MusicBrainz provider is temporarily unavailable.",
        observed_at=NOW + timedelta(minutes=2),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_artist_ambiguous"]

    # Manual assignment resolves the active problem with its source.
    assert repository.assign_manual_match(
        local_artist_id=artist_id,
        actor_account_id=owner_id,
        artist={"mbid": GERMAN, "canonical_name": "Axxis", "artist_type": "Group",
                "disambiguation": "German hard rock band", "country_code": "DE"},
        confidence=1,
        evidence_summary="Owner selected the German hard rock band.",
        observed_at=NOW + timedelta(minutes=3),
        request_ref="lifecycle-manual-1",
    )
    with isolatedPostgres._connect(setup_url) as connection:
        rows = _problems(connection, artist_id)
        assert _active(connection, artist_id) == []
        assert rows[-1]["resolution_source"] == "manual_match"

    detail = repository.get_artist_problem(local_artist_id=artist_id)
    assert detail["match_state"] == "matched"
    assert detail["unresolved_reason"] is None
    assert detail["artist_mbid"] == GERMAN
    assert detail["country"] == "DE"

    # Later automatic outcomes cannot reopen a problem over the manual decision.
    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="not_found", artist=None, confidence=0,
        evidence_summary="All bounded search pages completed.", observed_at=NOW + timedelta(minutes=4),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == []


def test_provider_problem_opens_only_without_an_identity_outcome(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(MIGRATION_PATH.read_text(encoding="utf-8"))
        library_id = connection.execute(
            """
            select library.libraries.id from app.bootstrap_owners
            join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone()["id"]
        artist_id = connection.execute(
            """
            insert into library.local_artists (library_id, artist_key, name, metadata)
            values (%s, 'lifecycle-10cc', '10cc', '{}'::jsonb) returning id
            """,
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            """
            insert into library.local_albums (library_id, artist_id, album_key, title, metadata)
            values (%s, %s, 'lifecycle-sheet-music', 'Sheet Music', '{}'::jsonb) returning id
            """,
            (library_id, artist_id),
        ).fetchone()["id"]
        connection.execute(
            """
            insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata)
            values (%s, %s, %s, 'lifecycle-10cc-track', 'Track', '{}'::jsonb)
            """,
            (library_id, album_id, artist_id),
        )
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )

    repository.enqueue_artist(local_artist_id=artist_id, reason="authorized_retry", observed_at=NOW)
    job = repository.claim_due_job(worker_id="worker-b", now=NOW, lease_duration=timedelta(minutes=5))
    repository.schedule_retry(
        job_id=job["id"], worker_id="worker-b", classification="catch_up_pending",
        retry_at=NOW + timedelta(minutes=1), safe_error="MusicBrainz mirror is catching up.",
        observed_at=NOW,
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_mirror_replication_pending"]

    pending = repository.get_artist_problem(local_artist_id=artist_id)
    assert pending["unresolved_reason"] == "MusicBrainz: Metadata pending"
    assert pending["next_attempt_at"] is not None

    job = repository.claim_due_job(worker_id="worker-b", now=NOW + timedelta(minutes=2),
                                   lease_duration=timedelta(minutes=5))
    repository.complete_job(
        job_id=job["id"], worker_id="worker-b", state="exhausted", classification="provider_unavailable",
        safe_error="MusicBrainz provider is temporarily unavailable.", observed_at=NOW + timedelta(minutes=2),
        preserve_existing=True,
    )
    with isolatedPostgres._connect(setup_url) as connection:
        rows = _problems(connection, artist_id)
        assert _active(connection, artist_id) == ["musicbrainz_provider_retry_exhausted"]
        assert [row["resolution_source"] for row in rows if row["lifecycle_state"] == "resolved"] == ["reclassified"]
        assert all(row["has_job"] for row in rows)
    unavailable = repository.get_artist_problem(local_artist_id=artist_id)
    assert unavailable["unresolved_reason"] == "MusicBrainz: Provider unavailable"
    assert unavailable["last_attempt_at"] is not None
    assert unavailable["next_attempt_at"] is None
