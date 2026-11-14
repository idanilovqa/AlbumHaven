from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_enrichment_postgres import (
    MusicBrainzEnrichmentPostgresRepository,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
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
        apply_delivery_migrations(connection)
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
    [attention] = repository.list_artist_attention()
    assert attention["problem_occurrence_id"] == detail["problem_occurrence_id"]
    assert attention["unresolved_reason"] == "MBID: Multiple matches"

    # One name match without album agreement is an unconfirmed match, not several.
    repository.replace_candidates(
        local_artist_id=artist_id,
        candidates=[{"artist_mbid": GERMAN, "canonical_name": "Axxis", "candidate_score": 1,
                     "evidence_summary": "0 of 1 album agree"}],
        match_state="manual_review",
        evidence_summary="One MusicBrainz artist has this name, but none of your albums confirm it.",
        observed_at=NOW + timedelta(minutes=1, seconds=30),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_manual_review_required"]
        assert _problems(connection, artist_id)[0]["lifecycle_state"] == "resolved"
    [attention] = repository.list_artist_attention()
    assert attention["unresolved_reason"] == "MBID: Unconfirmed match"
    assert repository.get_artist_problem(local_artist_id=artist_id)["match_state"] == "manual_review"

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
        assert _active(connection, artist_id) == ["musicbrainz_manual_review_required"]

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

    assert repository.list_artist_attention() == []
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
        apply_delivery_migrations(connection)
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
    [queued] = repository.list_artist_attention()
    assert queued["match_state"] == "pending" and queued["problem_occurrence_id"] is None
    job = repository.claim_due_job(worker_id="worker-b", now=NOW, lease_duration=timedelta(minutes=5))
    repository.schedule_retry(
        job_id=job["id"], worker_id="worker-b", classification="catch_up_pending",
        retry_at=NOW + timedelta(minutes=1), safe_error="MusicBrainz mirror is catching up.",
        observed_at=NOW,
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_mirror_replication_pending"]

    pending = repository.get_artist_problem(local_artist_id=artist_id)
    assert pending["unresolved_reason"] == "MBID: Metadata pending"
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


def test_background_triggers_cool_off_unresolved_artists_but_owner_sync_retries(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            """
            select library.libraries.id from app.bootstrap_owners
            join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone()["id"]
        artist_id = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, metadata) "
            "values (%s, 'cooloff-artist', 'Unknown Band', '{}'::jsonb) returning id",
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata) "
            "values (%s, %s, 'cooloff-album', 'Demo', '{}'::jsonb) returning id",
            (library_id, artist_id),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata) "
            "values (%s, %s, %s, 'cooloff-track', 'Track', '{}'::jsonb)",
            (library_id, album_id, artist_id),
        )
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )
    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="not_found", artist=None, confidence=0,
        evidence_summary="All bounded search pages completed.", observed_at=NOW,
    )

    later = NOW + timedelta(days=1)
    assert repository.enqueue_eligible_artists(reason="periodic_scan", observed_at=later) == {"enqueued_count": 0}
    assert repository.enqueue_eligible_artists(reason="library_menu_sync", observed_at=later) == {"enqueued_count": 1}

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("delete from ops.metadata_enrichment_jobs where local_artist_id = %s", (artist_id,))
    assert repository.enqueue_eligible_artists(
        reason="periodic_scan", observed_at=NOW + timedelta(days=8),
    ) == {"enqueued_count": 1}


def test_only_album_artists_are_queued_for_delivery_1(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            """
            select library.libraries.id from app.bootstrap_owners
            join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone()["id"]
        owner_id = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, metadata) "
            "values (%s, 'scope-owner', 'Neal Morse', '{}'::jsonb) returning id", (library_id,),
        ).fetchone()["id"]
        guest_id = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, metadata) "
            "values (%s, 'scope-guest', 'Guest Singer', '{}'::jsonb) returning id", (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata) "
            "values (%s, %s, 'scope-album', 'Sola Scriptura', '{}'::jsonb) returning id", (library_id, owner_id),
        ).fetchone()["id"]
        for key, artist in (("scope-track-1", owner_id), ("scope-track-2", guest_id)):
            connection.execute(
                "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata) "
                "values (%s, %s, %s, %s, 'Track', '{}'::jsonb)", (library_id, album_id, artist, key),
            )
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )

    assert repository.enqueue_eligible_artists(reason="startup_backfill", observed_at=NOW) == {"enqueued_count": 1}
    with isolatedPostgres._connect(setup_url) as connection:
        queued = [row["local_artist_id"] for row in connection.execute(
            "select local_artist_id from ops.metadata_enrichment_jobs").fetchall()]
    assert queued == [owner_id]
    assert [row["local_artist_name"] for row in repository.list_present_artist_review()] == ["Neal Morse"]


def _seed_present_artist(setup_url, artist_key):
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            "select library.libraries.id from app.bootstrap_owners join library.libraries"
            " on library.libraries.owner_account_id = app.bootstrap_owners.account_id"
            " where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'"
        ).fetchone()["id"]
        artist_id = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, metadata)"
            " values (%s, %s, 'Axxis', '{}'::jsonb) returning id",
            (library_id, artist_key),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " values (%s, %s, %s, 'Kingdom of the Night', '{}'::jsonb) returning id",
            (library_id, artist_id, f"{artist_key}-album"),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata)"
            " values (%s, %s, %s, %s, 'Track', '{}'::jsonb)",
            (library_id, album_id, artist_id, f"{artist_key}-track"),
        )
    return library_id, artist_id


def _scan_upsert(connection, library_id, artist_key):
    """The library scan's artist upsert, as in the 03:10 deadlock report."""
    connection.execute(
        "insert into library.local_artists (library_id, artist_key, name, sort_name, metadata)"
        " values (%s, %s, 'Axxis', 'Axxis', '{}'::jsonb)"
        " on conflict (library_id, artist_key) do update"
        " set last_seen_at = now(), metadata = library.local_artists.metadata || excluded.metadata",
        (library_id, artist_key),
    )


def _short_lock_timeout(url):
    connection = isolatedPostgres._connect(url)
    connection.execute("set lock_timeout = '2s'")
    return connection


def test_musicbrainz_outcome_never_waits_for_a_scan_upsert_of_the_artist(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "deadlock-scan-first")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=_short_lock_timeout,
    )

    with isolatedPostgres._connect(setup_url) as scan:
        with scan.transaction():
            _scan_upsert(scan, library_id, "deadlock-scan-first")
            # The scan still holds its row lock; a FOR UPDATE here timed out (or deadlocked).
            repository.record_automatic_outcome(
                local_artist_id=artist_id, state="not_found", artist=None, confidence=0,
                evidence_summary="No MusicBrainz artist has this name.", observed_at=NOW,
            )

    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_artist_not_found"]


def test_scan_upsert_never_waits_for_an_open_musicbrainz_outcome(monkeypatch: pytest.MonkeyPatch):
    import threading

    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "deadlock-enrichment-first")
    holding, release = threading.Event(), threading.Event()

    class HoldAfterOutcome:
        """Pauses the enrichment transaction after its outcome statement, before commit."""

        def __init__(self, connection):
            self._connection = connection

        def __getattr__(self, name):
            return getattr(self._connection, name)

        def __enter__(self):
            self._connection.__enter__()
            return self

        def __exit__(self, *exc):
            return self._connection.__exit__(*exc)

        def execute(self, statement, params=None):
            cursor = self._connection.execute(statement, params)
            if "upsert_artist as" in statement:
                holding.set()
                release.wait(10)
            return cursor

    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda url: HoldAfterOutcome(isolatedPostgres._connect(url)),
    )
    errors = []

    def enrich():
        try:
            repository.record_automatic_outcome(
                local_artist_id=artist_id, state="not_found", artist=None, confidence=0,
                evidence_summary="No MusicBrainz artist has this name.", observed_at=NOW,
            )
        except Exception as error:  # pragma: no cover - surfaced below
            errors.append(error)

    worker = threading.Thread(target=enrich)
    worker.start()
    try:
        assert holding.wait(10), "the enrichment transaction never reached its outcome statement"
        with _short_lock_timeout(setup_url) as scan:
            with scan.transaction():
                _scan_upsert(scan, library_id, "deadlock-enrichment-first")
    finally:
        release.set()
        worker.join(10)
    assert not worker.is_alive() and errors == []


def test_discogs_link_is_stored_with_the_match_and_refreshed_without_touching_it(monkeypatch: pytest.MonkeyPatch):
    from psycopg import errors

    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _library_id, artist_id = _seed_present_artist(setup_url, "discogs-link")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )
    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz search evidence agreed.",
        artist={"mbid": GERMAN, "canonical_name": "Axxis", "artist_type": "Group", "discogs_artist_id": 218108},
    )

    def stored():
        with isolatedPostgres._connect(setup_url) as connection:
            return connection.execute(
                "select artists.discogs_artist_id, matches.state, matches.decision_source, matches.updated_at"
                " from integration.musicbrainz_artists artists"
                " join library.local_artist_musicbrainz_matches matches on matches.artist_mbid = artists.mbid"
                " where artists.mbid = %s", (GERMAN,),
            ).fetchone()

    before = stored()
    assert before["discogs_artist_id"] == 218108 and before["state"] == "matched"
    assert repository.list_accepted_artist_mbids() == [GERMAN]

    assert repository.refresh_artist_external_links(artist_mbid=GERMAN, discogs_artist_id=999) is True
    assert repository.refresh_artist_external_links(artist_mbid=GERMAN, discogs_artist_id=999) is False
    after = stored()
    assert after["discogs_artist_id"] == 999
    assert {key: after[key] for key in ("state", "decision_source", "updated_at")} == {
        key: before[key] for key in ("state", "decision_source", "updated_at")
    }, "a link refresh never changes the artist's match"
    assert repository.refresh_artist_external_links(artist_mbid=GERMAN, discogs_artist_id=0) is True
    assert stored()["discogs_artist_id"] is None, "invalid IDs are stored as no link"

    with isolatedPostgres._connect(setup_url) as connection:
        with pytest.raises(errors.CheckViolation):
            connection.execute("update integration.musicbrainz_artists set discogs_artist_id = 0 where mbid = %s", (GERMAN,))


def test_automatic_outcome_persists_provider_genres_for_display(monkeypatch: pytest.MonkeyPatch):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _library_id, artist_id = _seed_present_artist(setup_url, "provider-genres")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )

    repository.record_automatic_outcome(
        local_artist_id=artist_id,
        state="matched",
        confidence=1,
        evidence_summary="MusicBrainz search evidence agreed.",
        observed_at=NOW,
        artist={
            "mbid": GERMAN,
            "canonical_name": "Compilation Signal Guest",
            "artist_type": "Group",
            "country_code": "FI",
            "tags": [],
            "genres": [
                {"name": "progressive rock", "normalized_name": "progressive rock", "vote_count": 12},
                {"name": "art rock", "normalized_name": "art rock", "vote_count": 8},
                {"name": "doom metal", "normalized_name": "doom metal", "vote_count": 4},
                {"name": "folk rock", "normalized_name": "folk rock", "vote_count": 2},
            ],
        },
    )

    with isolatedPostgres._connect(setup_url) as connection:
        stored = connection.execute(
            "select tag_name, vote_count, is_genre from integration.musicbrainz_artist_tags "
            "where artist_mbid = %s order by vote_count desc",
            (GERMAN,),
        ).fetchall()
        display = connection.execute(
            "select tag_name from integration.musicbrainz_artist_display_genres "
            "where artist_mbid = %s order by display_rank",
            (GERMAN,),
        ).fetchall()

    assert stored == [
        {"tag_name": "progressive rock", "vote_count": 12, "is_genre": True},
        {"tag_name": "art rock", "vote_count": 8, "is_genre": True},
        {"tag_name": "doom metal", "vote_count": 4, "is_genre": True},
        {"tag_name": "folk rock", "vote_count": 2, "is_genre": True},
    ]
    assert [row["tag_name"] for row in display] == ["progressive rock", "art rock", "doom metal"]


def test_projection_refresh_replaces_remote_metadata_without_rewriting_the_accepted_match(
    monkeypatch: pytest.MonkeyPatch,
):
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "projection-refresh")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute(
            "select id from library.local_albums where artist_id = %s", (artist_id,)
        ).fetchone()["id"]

    repository.record_automatic_outcome(
        local_artist_id=artist_id,
        state="matched",
        confidence=0.97,
        evidence_summary="MusicBrainz album evidence agreed.",
        observed_at=NOW,
        credit_name="Old Credit",
        album_evidence=[{"local_album_id": album_id, "local_title": "Kingdom of the Night"}],
        album_identities=[{"local_album_id": album_id, "artist_mbid": GERMAN}],
        associated_artist_mbids=[TRANCE],
        artist={
            "mbid": GERMAN,
            "canonical_name": "Old Name",
            "sort_name": "Name, Old",
            "preferred_native_name": "Old Native Name",
            "artist_type": "Person",
            "disambiguation": "stale",
            "country_code": "DE",
            "aliases": [{"name": "Old Alias", "normalized_name": "old alias"}],
            "tags": [{"name": "old tag", "normalized_name": "old tag", "vote_count": 4}],
            "genres": [],
            "discogs_artist_id": 218108,
        },
    )

    with isolatedPostgres._connect(setup_url) as connection:
        match_before = connection.execute(
            "select to_jsonb(matches) as value from library.local_artist_musicbrainz_matches matches "
            "where library_id = %s and local_artist_id = %s",
            (library_id, artist_id),
        ).fetchone()["value"]
        identities_before = connection.execute(
            "select to_jsonb(identities) as value from library.local_album_artist_identities identities "
            "where library_id = %s order by album_key",
            (library_id,),
        ).fetchall()

    refresh_observed_at = NOW + timedelta(days=31)
    assert repository.refresh_artist_projection(
        local_artist_id=artist_id,
        observed_at=refresh_observed_at,
        artist={
            "mbid": GERMAN,
            "canonical_name": "New Name",
            "sort_name": "New Name",
            "preferred_native_name": None,
            "artist_type": "Group",
            "disambiguation": None,
            "country_code": "FI",
            "source_url": f"https://musicbrainz.org/artist/{GERMAN}",
            "aliases": [],
            "tags": [{"name": "new tag", "normalized_name": "new tag", "vote_count": 0}],
            "genres": [{"name": "art rock", "normalized_name": "art rock", "vote_count": -2}],
            "discogs_artist_id": 999,
        },
    ) is True

    with isolatedPostgres._connect(setup_url) as connection:
        projection = connection.execute(
            "select artists.canonical_name, artists.sort_name, artists.preferred_native_name, "
            "artists.artist_kind, artists.disambiguation, artists.discogs_artist_id, "
            "countries.country_code "
            "from integration.musicbrainz_artists artists "
            "left join integration.musicbrainz_artist_countries countries on countries.artist_mbid = artists.mbid "
            "where artists.mbid = %s",
            (GERMAN,),
        ).fetchone()
        aliases = connection.execute(
            "select alias_name from integration.musicbrainz_artist_aliases where artist_mbid = %s",
            (GERMAN,),
        ).fetchall()
        tags = connection.execute(
            "select tag_name, vote_count, is_genre from integration.musicbrainz_artist_tags "
            "where artist_mbid = %s order by tag_name",
            (GERMAN,),
        ).fetchall()
        match_after = connection.execute(
            "select to_jsonb(matches) as value from library.local_artist_musicbrainz_matches matches "
            "where library_id = %s and local_artist_id = %s",
            (library_id, artist_id),
        ).fetchone()["value"]
        identities_after = connection.execute(
            "select to_jsonb(identities) as value from library.local_album_artist_identities identities "
            "where library_id = %s order by album_key",
            (library_id,),
        ).fetchall()

    assert projection == {
        "canonical_name": "New Name",
        "sort_name": "New Name",
        "preferred_native_name": None,
        "artist_kind": "Group",
        "disambiguation": None,
        "discogs_artist_id": 999,
        "country_code": "FI",
    }
    assert aliases == []
    assert tags == [
        {"tag_name": "art rock", "vote_count": -2, "is_genre": True},
        {"tag_name": "new tag", "vote_count": 0, "is_genre": False},
    ]
    preserved_match_fields = set(match_before) - {"last_verified_at", "updated_at"}
    assert {key: match_after[key] for key in preserved_match_fields} == {
        key: match_before[key] for key in preserved_match_fields
    }
    assert match_after["last_verified_at"] != match_before["last_verified_at"]
    assert identities_after == identities_before
    assert repository.enqueue_eligible_artists(
        reason="scheduled_sync",
        observed_at=refresh_observed_at,
    ) == {"enqueued_count": 0}


def test_stored_artist_mbid_recheck_removes_only_automatic_matches_from_that_path(monkeypatch: pytest.MonkeyPatch):
    """0173: Aina-style matches accepted from a stored (Last.fm) artist MBID are re-checked; nothing else."""
    from tests.py.test_musicbrainz_artist_migration_postgres import MIGRATIONS_ROOT

    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    recheck_sql = (MIGRATIONS_ROOT / "0173_recheck_musicbrainz_matches_from_stored_artist_mbids.sql").read_text(encoding="utf-8")
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id, owner_id = connection.execute(
            """
            select library.libraries.id, app.bootstrap_owners.account_id
            from app.bootstrap_owners
            join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id
            where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
            """
        ).fetchone().values()
        connection.execute(
            "insert into integration.musicbrainz_artists (mbid, canonical_name, refreshed_at) values (%s, 'Aina', %s), (%s, 'Aina', %s)",
            (GERMAN, NOW, TRANCE, NOW),
        )
        rows = {
            "lastfm-path": ("automatic", "MusicBrainz embedded evidence agreed.", None),
            "search-path": ("automatic", "MusicBrainz search evidence agreed.", None),
            "manual": ("manual", "MusicBrainz embedded evidence agreed.", owner_id),
        }
        artist_ids = {}
        for key, (source, evidence, decided_by) in rows.items():
            artist_ids[key] = connection.execute(
                "insert into library.local_artists (library_id, artist_key, name, metadata) values (%s, %s, %s, '{}'::jsonb) returning id",
                (library_id, f"recheck-{key}", f"Recheck {key}"),
            ).fetchone()["id"]
            connection.execute(
                """
                insert into library.local_artist_musicbrainz_matches
                  (library_id, local_artist_id, artist_mbid, state, decision_source, confidence, evidence_summary, decided_by_account_id)
                values (%s, %s, %s, 'matched', %s, 1, %s, %s)
                """,
                (library_id, artist_ids[key], GERMAN, source, evidence, decided_by),
            )

        connection.execute(recheck_sql)
        connection.execute(recheck_sql)  # Idempotent on re-run.
        remaining = {
            row["local_artist_id"]: (row["decision_source"], row["evidence_summary"])
            for row in connection.execute("select local_artist_id, decision_source, evidence_summary from library.local_artist_musicbrainz_matches")
        }

    assert artist_ids["lastfm-path"] not in remaining, "the stored-MBID match is re-checked"
    assert remaining[artist_ids["search-path"]] == ("automatic", "MusicBrainz search evidence agreed.")
    assert remaining[artist_ids["manual"]][0] == "manual", "a manual choice is never touched"


def test_album_evidence_matcher_rechecks_older_rows_and_never_silently_replaces_a_match(monkeypatch: pytest.MonkeyPatch):
    """0174: rows decided by an older matcher are re-queued; a different artist goes to conflict."""
    from music_app.services.musicbrainz_enrichment_postgres import MATCHER_VERSION

    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _library_id, artist_id = _seed_present_artist(setup_url, "matcher-version")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )

    def match():
        with isolatedPostgres._connect(setup_url) as connection:
            return connection.execute(
                "select state, artist_mbid::text as mbid, matcher_version, credit_name"
                " from library.local_artist_musicbrainz_matches where local_artist_id = %s", (artist_id,),
            ).fetchone()

    def clear_jobs():
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("delete from ops.metadata_enrichment_jobs where local_artist_id = %s", (artist_id,))

    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz release credit evidence agreed.", credit_name="3 Crows",
        artist={"mbid": GERMAN, "canonical_name": "Chris Buck", "artist_type": "Person"},
    )
    assert match() == {"state": "matched", "mbid": GERMAN, "matcher_version": MATCHER_VERSION, "credit_name": "3 Crows"}

    # A freshly verified match by the current matcher is not re-queued...
    assert repository.enqueue_eligible_artists(reason="periodic_scan", observed_at=NOW) == {"enqueued_count": 0}
    # ...but one decided by an older matcher is, however recently it was verified.
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_artist_musicbrainz_matches set matcher_version = 1 where local_artist_id = %s",
                           (artist_id,))
    assert repository.enqueue_eligible_artists(reason="periodic_scan", observed_at=NOW) == {"enqueued_count": 1}

    job = repository.claim_due_job(worker_id="worker-a", now=NOW, lease_duration=timedelta(minutes=5))
    context = repository.load_artist_context(job_id=job["id"], worker_id="worker-a")
    assert context["existing_canonical_name"] == "Chris Buck"
    assert [album["title"] for album in context["albums"]] == ["Kingdom of the Night"]
    assert [track["title"] for track in context["albums"][0]["tracks"]] == ["Track"]
    clear_jobs()

    # Weaker evidence keeps the match and stamps it as checked.
    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="not_found", artist=None, confidence=0, observed_at=NOW,
        evidence_summary="No MusicBrainz artist has this name or one of your albums.",
    )
    assert match()["state"] == "matched" and match()["matcher_version"] == MATCHER_VERSION

    # Another artist's album evidence moves the match to conflict, keeping the stored MBID.
    repository.replace_candidates(
        local_artist_id=artist_id, match_state="conflict", observed_at=NOW,
        evidence_summary="Album evidence now points to another MusicBrainz artist than the current match.",
        candidates=[
            {"artist_mbid": GERMAN, "canonical_name": "Chris Buck", "candidate_score": 1, "evidence_summary": "Current match"},
            {"artist_mbid": TRANCE, "canonical_name": "Axxis", "candidate_score": 1, "evidence_summary": "Album evidence now agrees"},
        ],
    )
    assert match()["state"] == "conflict" and match()["mbid"] == GERMAN
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, artist_id) == ["musicbrainz_artist_metadata_conflict"]


def _add_artist(setup_url, library_id, artist_key, name, *, album_mbid=None):
    with isolatedPostgres._connect(setup_url) as connection:
        artist_id = connection.execute(
            "insert into library.local_artists (library_id, artist_key, name, metadata)"
            " values (%s, %s, %s, '{}'::jsonb) returning id", (library_id, artist_key, name),
        ).fetchone()["id"]
        album_id = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata, mbid, evidence_source)"
            " values (%s, %s, %s, 'Contain Us', '{}'::jsonb, %s, %s) returning id",
            (library_id, artist_id, f"{artist_key}-album", album_mbid,
             "lastfm.public.albums" if album_mbid else None),
        ).fetchone()["id"]
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata)"
            " values (%s, %s, %s, %s, 'Track', '{}'::jsonb)", (library_id, album_id, artist_id, f"{artist_key}-track"),
        )
    return artist_id, album_id


def test_matcher_3_context_carries_siblings_and_album_identifiers_and_stores_credit_evidence(
        monkeypatch: pytest.MonkeyPatch):
    """0175: a credited or disc match keeps the albums that proved it; the context offers matched siblings."""
    setup_url, _runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, matched_id = _seed_present_artist(setup_url, "the-axxis")
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=lambda _url: isolatedPostgres._connect(setup_url),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update library.local_artists set name = 'The Àxxis' where id = %s", (matched_id,))
    repository.record_automatic_outcome(
        local_artist_id=matched_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz search evidence agreed.",
        artist={"mbid": GERMAN, "canonical_name": "Axxis", "artist_type": "Group"},
    )
    album_mbid = "00000000-0000-4000-8000-00000000c001"
    tag_id, tag_album_id = _add_artist(setup_url, library_id, "axxis-tag", "Axxis", album_mbid=album_mbid)

    repository.enqueue_eligible_artists(reason="startup_backfill", observed_at=NOW)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("delete from ops.metadata_enrichment_jobs where local_artist_id <> %s", (tag_id,))
    job = repository.claim_due_job(worker_id="worker-a", now=NOW, lease_duration=timedelta(minutes=5))
    context = repository.load_artist_context(job_id=job["id"], worker_id="worker-a")

    assert context["sibling_matches"] == [
        {"local_artist_id": matched_id, "name": "The Àxxis", "mbid": GERMAN, "canonical_name": "Axxis"}]
    assert context["albums"][0]["id"] == tag_album_id
    assert context["albums"][0]["lastfm_release_mbid"] == album_mbid

    evidence = [{"local_album_id": tag_album_id, "local_title": "Contain Us", "release_group_mbid": TRANCE,
                 "release_mbid": album_mbid, "disc_position": 5, "signals": ["year", "track_count", "bogus"]}]
    repository.record_automatic_outcome(
        local_artist_id=tag_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz album evidence agreed.", credit_name="Axxis",
        album_evidence=evidence, artist={"mbid": TRANCE, "canonical_name": "Axxis Duo", "artist_type": "Group"},
    )
    with isolatedPostgres._connect(setup_url) as connection:
        stored = connection.execute(
            "select credit_name, album_evidence from library.local_artist_musicbrainz_matches"
            " where local_artist_id = %s", (tag_id,)).fetchone()
    assert stored["credit_name"] == "Axxis"
    assert stored["album_evidence"] == [{
        "local_album_id": tag_album_id, "local_title": "Contain Us", "release_group_mbid": TRANCE,
        "release_mbid": album_mbid, "disc_position": 5, "signals": ["track_count", "year"]}]

    # A match without album evidence (a plain name match) clears it.
    repository.record_automatic_outcome(
        local_artist_id=tag_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz search evidence agreed.",
        artist={"mbid": TRANCE, "canonical_name": "Axxis", "artist_type": "Group"},
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select album_evidence from library.local_artist_musicbrainz_matches where local_artist_id = %s",
            (tag_id,)).fetchone()["album_evidence"] is None


def test_various_and_unknown_artists_are_never_queued_and_lose_automatic_outcomes(monkeypatch: pytest.MonkeyPatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, _artist_id = _seed_present_artist(setup_url, "real")
    # The runtime role, so the retirement needs no privilege the app lacks.
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url},
        connect=lambda _url: isolatedPostgres._connect(runtime_url),
    )
    various_id, _ = _add_artist(setup_url, library_id, "various", "Various")
    unknown_id, _ = _add_artist(setup_url, library_id, "unknown", " Unknown Artist ")
    for artist_id in (various_id, unknown_id):
        repository.replace_candidates(
            local_artist_id=artist_id, match_state="ambiguous", observed_at=NOW,
            evidence_summary="MusicBrainz candidates require manual review.",
            candidates=[
                {"artist_mbid": GERMAN, "canonical_name": "Various", "candidate_score": 1, "evidence_summary": "Name only"},
                {"artist_mbid": TRANCE, "canonical_name": "Various", "candidate_score": 1, "evidence_summary": "Name only"},
            ],
        )
    with isolatedPostgres._connect(setup_url) as connection:
        assert _active(connection, various_id) == ["musicbrainz_artist_ambiguous"]

    assert repository.enqueue_eligible_artists(reason="startup_backfill", observed_at=NOW) == {"enqueued_count": 1}

    with isolatedPostgres._connect(setup_url) as connection:
        queued = {row["local_artist_id"] for row in connection.execute(
            "select local_artist_id from ops.metadata_enrichment_jobs").fetchall()}
        # The runtime role cannot delete match rows: the outcome becomes "not found".
        remaining = connection.execute(
            "select count(*) as count from library.local_artist_musicbrainz_matches"
            " where local_artist_id = any(%s) and (state <> 'not_found' or artist_mbid is not null)",
            ([various_id, unknown_id],)).fetchone()["count"]
        candidates = connection.execute(
            "select count(*) as count from library.local_artist_musicbrainz_candidates where local_artist_id = any(%s)",
            ([various_id, unknown_id],)).fetchone()["count"]
        assert various_id not in queued and unknown_id not in queued
        assert remaining == 0 and candidates == 0
        assert _active(connection, various_id) == [] and _active(connection, unknown_id) == []
        resolved = connection.execute(
            "select distinct resolution_source from library.metadata_enrichment_problems where local_artist_id = %s",
            (various_id,)).fetchall()
        assert [row["resolution_source"] for row in resolved] == ["not_an_artist"]


def _identities(connection, library_id):
    return {row["album_key"]: (str(row["artist_mbid"]), row["decision_source"], row["tag_differs"])
            for row in connection.execute(
                "select album_key, artist_mbid, decision_source, tag_differs"
                " from library.local_album_artist_identities where library_id = %s", (library_id,)).fetchall()}


def test_albums_of_several_artists_store_their_identities_and_leave_problematic_files(monkeypatch: pytest.MonkeyPatch):
    """0177, owner decision 2026-11-08: each album takes the artist it certainly matches."""
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "amarok")
    with isolatedPostgres._connect(setup_url) as connection:
        second_album = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " values (%s, %s, 'amarok-second', 'Hope', '{}'::jsonb) returning id", (library_id, artist_id),
        ).fetchone()["id"]
        first_album = connection.execute(
            "select id from library.local_albums where album_key = 'amarok-album'").fetchone()["id"]
    # The runtime role writes and replaces identities.
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=lambda _url: isolatedPostgres._connect(runtime_url))
    repository.replace_candidates(
        local_artist_id=artist_id, match_state="ambiguous", observed_at=NOW,
        evidence_summary="MusicBrainz candidates require manual review.",
        candidates=[{"artist_mbid": GERMAN, "canonical_name": "Amarok", "candidate_score": 1, "evidence_summary": "1 of 2"},
                    {"artist_mbid": TRANCE, "canonical_name": "Amarok", "candidate_score": 1, "evidence_summary": "1 of 2"}])

    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="per_album", artist=None, confidence=1, observed_at=NOW,
        evidence_summary="Your albums belong to 2 MusicBrainz artists.",
        identity_artists=[{"mbid": GERMAN, "canonical_name": "Amarok", "disambiguation": "Spanish fusion band"},
                          {"mbid": TRANCE, "canonical_name": "Amarok", "disambiguation": "Polish progressive rock band"}],
        album_identities=[{"local_album_id": first_album, "artist_mbid": GERMAN, "local_title": "Kingdom of the Night",
                           "signals": ["track_count", "track_list", "bogus"]},
                          {"local_album_id": second_album, "artist_mbid": TRANCE, "tag_differs": True}])

    with isolatedPostgres._connect(setup_url) as connection:
        match = connection.execute(
            "select state, artist_mbid from library.local_artist_musicbrainz_matches where local_artist_id = %s",
            (artist_id,)).fetchone()
        assert (match["state"], match["artist_mbid"]) == ("per_album", None)
        assert _active(connection, artist_id) == []
        assert _identities(connection, library_id) == {
            "amarok-album": (GERMAN, "automatic", False), "amarok-second": (TRANCE, "automatic", True)}
        assert connection.execute(
            "select evidence from library.local_album_artist_identities where album_key = 'amarok-album'"
        ).fetchone()["evidence"]["signals"] == ["track_count", "track_list"]
        # An owner's own choice for one album survives the next re-check.
        connection.execute(
            "update library.local_album_artist_identities set decision_source = 'manual' where album_key = 'amarok-second'")
        # A re-key carries the identity with the album.
        connection.execute("update library.local_albums set album_key = 'amarok-renamed' where album_key = 'amarok-album'")
        assert _identities(connection, library_id)["amarok-renamed"] == (GERMAN, "automatic", False)

    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz album evidence agreed.",
        artist={"mbid": GERMAN, "canonical_name": "Amarok", "artist_type": "Group"},
        album_identities=[{"local_album_id": second_album, "artist_mbid": GERMAN}])

    with isolatedPostgres._connect(setup_url) as connection:
        assert _identities(connection, library_id) == {"amarok-second": (TRANCE, "manual", True)}
        connection.execute("update library.local_album_artist_identities set decision_source = 'automatic'")

    # A later re-check that finds no certain album clears the automatic identities.
    repository.replace_candidates(
        local_artist_id=artist_id, match_state="ambiguous", observed_at=NOW,
        evidence_summary="MusicBrainz candidates require manual review.",
        candidates=[{"artist_mbid": GERMAN, "canonical_name": "Amarok", "candidate_score": 1, "evidence_summary": "1 of 2"},
                    {"artist_mbid": TRANCE, "canonical_name": "Amarok", "candidate_score": 1, "evidence_summary": "1 of 2"}])
    with isolatedPostgres._connect(setup_url) as connection:
        assert _identities(connection, library_id) == {}


def test_a_person_matched_with_their_band_s_albums_stores_the_band_for_those_identities(
        monkeypatch: pytest.MonkeyPatch):
    """Owner 2026-11-09: Alice Cooper is one artist, the singer; the albums credited to the
    group he is a member of keep the group's MBID, which must exist for the identity."""
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "alice")
    with isolatedPostgres._connect(setup_url) as connection:
        band_album = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " values (%s, %s, 'alice-killer', 'Killer', '{}'::jsonb) returning id", (library_id, artist_id),
        ).fetchone()["id"]
        solo_album = connection.execute("select id from library.local_albums where album_key = 'alice-album'").fetchone()["id"]
    repository = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}, connect=lambda _url: isolatedPostgres._connect(runtime_url))

    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz album evidence agreed.",
        artist={"mbid": GERMAN, "canonical_name": "Alice Cooper", "artist_type": "Person"},
        identity_artists=[{"mbid": GERMAN, "canonical_name": "Alice Cooper", "artist_type": "Person"},
                          {"mbid": TRANCE, "canonical_name": "Alice Cooper", "artist_type": "Group",
                           "disambiguation": "the band"}],
        album_identities=[{"local_album_id": solo_album, "artist_mbid": GERMAN},
                          {"local_album_id": band_album, "artist_mbid": TRANCE}],
        associated_artist_mbids=[TRANCE])

    with isolatedPostgres._connect(setup_url) as connection:
        match = connection.execute(
            "select state, artist_mbid, associated_artist_mbids from library.local_artist_musicbrainz_matches"
            " where local_artist_id = %s", (artist_id,)).fetchone()
        assert (match["state"], str(match["artist_mbid"])) == ("matched", GERMAN)
        # One local artist, two MBIDs: the person, and the band the person belongs to.
        assert [str(mbid) for mbid in match["associated_artist_mbids"]] == [TRANCE]
        assert _identities(connection, library_id) == {
            "alice-album": (GERMAN, "automatic", False), "alice-killer": (TRANCE, "automatic", False)}
        assert _active(connection, artist_id) == []

    # A later match without the band clears it.
    repository.record_automatic_outcome(
        local_artist_id=artist_id, state="matched", confidence=1, observed_at=NOW,
        evidence_summary="MusicBrainz album evidence agreed.",
        artist={"mbid": GERMAN, "canonical_name": "Alice Cooper", "artist_type": "Person"})
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select associated_artist_mbids from library.local_artist_musicbrainz_matches where local_artist_id = %s",
            (artist_id,)).fetchone()["associated_artist_mbids"] is None
