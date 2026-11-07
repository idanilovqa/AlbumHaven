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
