"""Album Discogs lookups (0272) on real isolated PostgreSQL, rule by rule."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_album_discogs_lookup_postgres import AlbumDiscogsLookupPostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
    leave_setup_database_migrated,
)

pytestmark = pytest.mark.usefixtures("leave_setup_database_migrated")

NOW = datetime(2026, 11, 22, 8, 0, tzinfo=timezone.utc)
BAND = "b5c6e1ad-4f5a-4b1a-9a1e-0123456789ab"


@pytest.fixture
def seeded(monkeypatch):
    setup_url, _runtime = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    _apply_pre_delivery_migrations(setup_url)
    isolatedPostgres.seed_bootstrap_owner_and_library(setup_url)
    artists, albums = {}, {}
    with isolatedPostgres._connect(setup_url) as connection:
        apply_delivery_migrations(connection)
        library_id = connection.execute(
            "select library.libraries.id from app.bootstrap_owners join library.libraries"
            " on library.libraries.owner_account_id = app.bootstrap_owners.account_id"
            " where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'").fetchone()["id"]
        connection.execute(
            "insert into integration.musicbrainz_artists (mbid, canonical_name, sort_name, artist_kind, refreshed_at)"
            " values (%s, 'Vela', 'Vela', 'Group', %s)", (BAND, NOW))
        for key, state in (("matched", "matched"), ("unknown", "not_found"), ("other", "matched")):
            artists[key] = connection.execute(
                "insert into library.local_artists (library_id, artist_key, name, metadata)"
                " values (%s, %s, %s, '{}'::jsonb) returning id",
                (library_id, f"dl-{key}", f"Vela {key}")).fetchone()["id"]
            connection.execute(
                "insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, state,"
                " artist_mbid, decision_source, confidence, evidence_summary, matcher_version, first_observed_at,"
                " last_observed_at, created_at, updated_at)"
                " values (%s, %s, %s, %s, 'automatic', %s, 'x', 5, %s, %s, %s, %s)",
                (library_id, artists[key], state, BAND if state == "matched" else None,
                 1 if state == "matched" else 0, NOW, NOW, NOW, NOW))
        for key, artist, diagnostic in (
            ("lacking", "matched", "no_title_match"), ("waiting", "matched", "budget_exhausted"),
            ("undecided", "matched", None), ("unknown", "unknown", "no_title_match"),
            ("elsewhere", "other", "no_title_match"),
        ):
            albums[key] = connection.execute(
                "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
                " values (%s, %s, %s, %s, '{}'::jsonb) returning id",
                (library_id, artists[artist], f"dl-{key}", f"Album {key}")).fetchone()["id"]
            connection.execute(
                "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, track_number,"
                " duration_seconds, metadata) values (%s, %s, %s, %s, 'Opening', 1, 200, '{}'::jsonb)",
                (library_id, albums[key], artists[artist], f"dl-{key}-1"))
            if diagnostic:
                connection.execute(
                    "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, diagnostic,"
                    " matcher_version, observed_at) values (%s, %s, 'unresolved', %s, 1, %s)",
                    (library_id, f"dl-{key}", diagnostic, NOW))
        connection.commit()
    repository = AlbumDiscogsLookupPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, repository, artists, albums


def _queue_and_load(repository, artist_id, now=NOW):
    if not repository.enqueue(local_artist_id=artist_id, reason="test", observed_at=now):
        return None, []
    job = repository.claim_due_job(worker_id="worker", now=now, lease_duration=timedelta(minutes=10))
    return job, repository.load_albums(job_id=job["id"], worker_id="worker", limit=20, observed_at=now)


def _answer(repository, artist_id, found=None):
    job, albums = _queue_and_load(repository, artist_id)
    repository.record(job_id=job["id"], worker_id="worker", album=albums[0], found=found, observed_at=NOW)
    repository.finish(job_id=job["id"], worker_id="worker", state="succeeded", classification="complete",
                      observed_at=NOW)


def test_only_this_artists_albums_musicbrainz_lacks_are_asked(seeded):
    _url, repository, artists, albums = seeded
    _job, due = _queue_and_load(repository, artists["matched"])
    assert [album["id"] for album in due] == [albums["lacking"]]
    assert due[0]["canonical_name"] == "Vela"
    assert due[0]["tracks"][0]["title"] == "Opening"


def test_an_artist_musicbrainz_did_not_find_stays_with_the_artist_fallback(seeded):
    _url, repository, artists, _albums = seeded
    assert _queue_and_load(repository, artists["unknown"]) == (None, [])


def test_an_answer_rests_thirty_days(seeded):
    _url, repository, artists, _albums = seeded
    _answer(repository, artists["matched"])
    assert _queue_and_load(repository, artists["matched"], NOW + timedelta(days=29))[1] == []
    assert len(_queue_and_load(repository, artists["matched"], NOW + timedelta(days=31))[1]) == 1


def test_a_retagged_album_is_waiting_again(seeded):
    url, repository, artists, albums = seeded
    _answer(repository, artists["matched"])
    with isolatedPostgres._connect(url) as connection:
        connection.execute("update library.local_albums set title = 'Album retagged' where id = %s",
                           (albums["lacking"],))
        connection.commit()
    assert len(_queue_and_load(repository, artists["matched"])[1]) == 1


def test_a_found_release_is_stored_with_the_answer(seeded):
    url, repository, artists, _albums = seeded
    _answer(repository, artists["matched"], found={
        "discogs_release_id": 600, "discogs_title": "Album lacking", "tracks": [], "barcodes": []})
    with isolatedPostgres._connect(url) as connection:
        stored = connection.execute(
            "select state, discogs_release_id from library.local_album_discogs_lookups").fetchall()
    assert [(row["state"], row["discogs_release_id"]) for row in stored] == [("found", 600)]
