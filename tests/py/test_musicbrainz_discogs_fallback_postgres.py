"""Discogs fallback storage on real isolated PostgreSQL (Delivery 2, S3), rule by rule."""
from __future__ import annotations

from datetime import datetime, timezone

from music_app.services.musicbrainz_discogs_fallback import DiscogsFallbackProcessor
from music_app.services.musicbrainz_discogs_fallback_postgres import DiscogsFallbackPostgresRepository
from music_app.services.musicbrainz_enrichment_postgres import _JOB_KIND as ARTIST_JOB_KIND
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
)

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
HINT = "b5c6e1ad-4f5a-4b1a-9a1e-0123456789ab"


def _seed(monkeypatch):
    setup_url, _runtime = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            "select library.libraries.id from app.bootstrap_owners join library.libraries"
            " on library.libraries.owner_account_id = app.bootstrap_owners.account_id"
            " where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'").fetchone()["id"]
        ids, albums = {}, {}
        for key, name, state in (("crows", "3 Crows", "not_found"), ("found", "Angra", "manual_review")):
            ids[key] = connection.execute(
                "insert into library.local_artists (library_id, artist_key, name, metadata)"
                " values (%s, %s, %s, '{}'::jsonb) returning id", (library_id, f"dg-{key}", name)).fetchone()["id"]
            albums[key] = connection.execute(
                "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
                " values (%s, %s, %s, 'Kingdom', '{}'::jsonb) returning id",
                (library_id, ids[key], f"dg-{key}-album")).fetchone()["id"]
            connection.execute(
                "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, track_number,"
                " duration_seconds, metadata) values (%s, %s, %s, %s, 'Opening', 1, 200, '{}'::jsonb)",
                (library_id, albums[key], ids[key], f"dg-{key}-1"))
            connection.execute(
                "insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, state,"
                " decision_source, confidence, evidence_summary, matcher_version, first_observed_at, last_observed_at,"
                " created_at, updated_at) values (%s, %s, %s, 'automatic', 0, 'x', 5, %s, %s, %s, %s)",
                (library_id, ids[key], state, NOW, NOW, NOW, NOW))
    repository = DiscogsFallbackPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, repository, ids, albums


def _found(context, *, hints):
    album = context["albums"][0]
    return {"classification": "found", "discogs_artist": {"id": 101, "name": "3 Crows", "aliases": [{"id": 9, "name": "Chris Buck"}]},
            "albums": [{"local_album_id": album["id"], "local_title": album["title"], "discogs_release_id": 601,
                        "discogs_master_id": 501, "discogs_title": "Kingdom", "barcodes": ["0123456789012"],
                        "signals": ["track_count", "track_list"], "tracks": []}],
            "musicbrainz_hints": hints, "remote_info_needed": not hints, "evidence_summary": "Found on Discogs"}


def _run(monkeypatch, repository, outcome):
    from music_app.services import musicbrainz_discogs_fallback as module
    monkeypatch.setattr(module, "resolve_with_discogs", lambda context, discogs, musicbrainz: outcome(context))
    return DiscogsFallbackProcessor(repository=repository, discogs=None, musicbrainz=None, now=lambda: NOW)


def _state(setup_url, artist_id):
    with isolatedPostgres._connect(setup_url) as connection:
        identity = connection.execute("select state, discogs_artist_id, musicbrainz_hints from"
                                      " library.local_artist_discogs_identities where local_artist_id = %s",
                                      (artist_id,)).fetchone()
        albums = connection.execute("select discogs_release_id, discogs_master_id from library.local_album_discogs_releases"
                                    ).fetchall()
        flags = connection.execute("select target_kind, source, reason from library.musicbrainz_contribution_flags"
                                   " where local_artist_id = %s", (artist_id,)).fetchall()
        requeued = connection.execute("select count(*) as n from ops.metadata_enrichment_jobs where job_kind = %s"
                                      " and state = 'queued' and local_artist_id = %s",
                                      (ARTIST_JOB_KIND, artist_id)).fetchone()["n"]
    return identity, albums, flags, requeued


def test_only_artists_musicbrainz_did_not_find_are_asked_and_discogs_only_ones_are_flagged(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    processor = _run(monkeypatch, repository, lambda context: _found(context, hints=[]))
    assert processor.process_next(worker_id="w")["state"] == "succeeded"
    assert processor.process_next(worker_id="w") == {"processed": False, "state": "idle"}  # Angra is not "not found"
    identity, albums, flags, requeued = _state(setup_url, ids["crows"])
    assert (identity["state"], identity["discogs_artist_id"]) == ("found", 101)
    assert [(row["discogs_release_id"], row["discogs_master_id"]) for row in albums] == [(601, 501)]
    assert [tuple(row.values()) for row in flags] == [("artist", "automatic", "missing_from_musicbrainz")]
    assert requeued == 0
    # Answered within 30 days: not asked again.
    assert repository.enqueue(reason="test", observed_at=NOW) == 0


def test_a_musicbrainz_artist_found_through_discogs_requeues_the_match_with_that_hint(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    processor = _run(monkeypatch, repository, lambda context: _found(
        context, hints=[{"artist_mbid": HINT, "via": "barcode", "barcode": "0123456789012"}]))
    processor.process_next(worker_id="w")
    identity, _albums_rows, flags, requeued = _state(setup_url, ids["crows"])
    assert identity["musicbrainz_hints"][0]["artist_mbid"] == HINT
    assert flags == [] and requeued == 1
    # The artist matcher's context now carries the hint.
    from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository
    artists = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    job = artists.claim_due_job(worker_id="a", now=NOW, lease_duration=__import__("datetime").timedelta(minutes=5))
    context = artists.load_artist_context(job_id=job["id"], worker_id="a")
    assert context["hinted_artist_mbids"] == [HINT]


def test_nothing_on_discogs_either_keeps_the_artist_flagged_and_stores_no_ids(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    processor = _run(monkeypatch, repository, lambda context: {
        "classification": "not_found", "albums": [], "musicbrainz_hints": [], "remote_info_needed": True,
        "evidence_summary": "Neither"})
    processor.process_next(worker_id="w")
    identity, albums, flags, requeued = _state(setup_url, ids["crows"])
    assert (identity["state"], identity["discogs_artist_id"], albums, requeued) == ("not_found", None, [], 0)
    assert len(flags) == 1


def test_a_discogs_outage_retries_and_stores_nothing(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    processor = _run(monkeypatch, repository, lambda context: {"classification": "provider_unavailable"})
    assert processor.process_next(worker_id="w")["state"] == "retry_wait"
    identity, albums, flags, _requeued = _state(setup_url, ids["crows"])
    assert (identity, albums, flags) == (None, [], [])


def test_an_artist_whose_fallback_used_up_its_retries_rests_a_week(monkeypatch):
    from datetime import timedelta
    from music_app.services.musicbrainz_discogs_fallback_postgres import JOB_KIND

    setup_url, repository, ids, _albums = _seed(monkeypatch)
    assert repository.enqueue(reason="test", observed_at=NOW) == 1
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("update ops.metadata_enrichment_jobs set state = 'exhausted', updated_at = %s"
                           " where job_kind = %s", (NOW, JOB_KIND))
    assert repository.enqueue(reason="test", observed_at=NOW + timedelta(hours=1)) == 0
    # The negative: after a week it is tried again.
    assert repository.enqueue(reason="test", observed_at=NOW + timedelta(days=8)) == 1


def test_problematic_files_attention_says_musicbrainz_has_no_info_for_a_flagged_artist_only(monkeypatch):
    from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository

    setup_url, repository, ids, _albums = _seed(monkeypatch)
    assert _run(monkeypatch, repository, lambda context: _found(context, hints=[])).process_next(
        worker_id="w")["state"] == "succeeded"
    with isolatedPostgres._connect(setup_url) as connection:
        for artist_id in ids.values():  # Both artists need attention; only 3 Crows is flagged.
            connection.execute(
                "insert into ops.metadata_enrichment_jobs (library_id, local_artist_id, target_kind, job_kind, reason,"
                " state, next_attempt_at, created_at, updated_at) select library_id, id, 'artist', %s, 'test',"
                " 'queued', %s, %s, %s from library.local_artists where id = %s",
                (ARTIST_JOB_KIND, NOW, NOW, NOW, artist_id))
    attention = MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url),
    ).list_artist_attention()
    assert {row["local_artist_name"]: row["musicbrainz_has_no_info"] for row in attention} == {
        "3 Crows": True, "Angra": False}
