"""Album release identity on real isolated PostgreSQL (Delivery 2, S1), rule by rule.

Each test owns a freshly migrated isolated database (schemas dropped and re-applied).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.musicbrainz_enrichment_worker import MusicBrainzEnrichmentChain
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.musicbrainz_release_identity_postgres import (
    JOB_KIND,
    MusicBrainzReleaseIdentityPostgresRepository,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
)

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=timezone.utc)
ANGRA = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3"
OTHER = "00000000-0000-4000-8000-000000000099"
GROUP = "10d43270-60cb-3779-9fb9-e431d2da5e5a"
RELEASE = "050e7238-9751-4521-91b6-89c672eac590"


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
        ids = {}
        for key, name in (("angra", "Angra"), ("other", "Other"), ("unmatched", "Nobody")):
            ids[key] = connection.execute(
                "insert into library.local_artists (library_id, artist_key, name, metadata)"
                " values (%s, %s, %s, '{}'::jsonb) returning id", (library_id, f"rel-{key}", name)).fetchone()["id"]
        albums = {}
        for artist, album, title in (("angra", "cry", "Angels Cry"), ("angra", "holy", "Holy Land"),
                                     ("other", "else", "Elsewhere"), ("unmatched", "none", "Nothing")):
            albums[album] = connection.execute(
                "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, metadata)"
                " values (%s, %s, %s, %s, 1993, '{}'::jsonb) returning id",
                (library_id, ids[artist], f"rel-{album}", title)).fetchone()["id"]
            for number in (1, 2):
                connection.execute(
                    "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
                    " track_number, duration_seconds, metadata) values (%s, %s, %s, %s, %s, 1, %s, 200, '{}'::jsonb)",
                    (library_id, albums[album], ids[artist], f"rel-{album}-{number}", f"Song {number}", number))
        connection.execute(
            "insert into integration.musicbrainz_artists (mbid, canonical_name, refreshed_at)"
            " values (%s, 'Angra', %s), (%s, 'Other', %s)", (ANGRA, NOW, OTHER, NOW))
        for artist, mbid in (("angra", ANGRA), ("other", OTHER)):
            connection.execute(
                "insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, artist_mbid, state,"
                " decision_source, confidence, evidence_summary, matcher_version, first_observed_at, last_observed_at,"
                " created_at, updated_at, selected_at, last_verified_at)"
                " values (%s, %s, %s, 'matched', 'automatic', 1, 'ok', 5, %s, %s, %s, %s, %s, %s)",
                (library_id, ids[artist], mbid, NOW, NOW, NOW, NOW, NOW, NOW))
    repository = MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    return setup_url, repository, ids, albums


class FakeResolverClient:
    """Stands in for resolve_album_releases' mirror: the module function is patched."""


def _outcome(context):
    by_title = {album["title"]: album for album in context["albums"]}
    albums = []
    if "Angels Cry" in by_title:
        albums.append({"local_album_id": by_title["Angels Cry"]["id"], "local_title": "Angels Cry", "state": "release",
                       "release_group_mbid": GROUP, "release_mbid": RELEASE, "disc_position": None,
                       "signals": ["track_count", "track_list", "year"], "diagnostic": None,
                       "main_disc": {"main_disc_count": 1, "source": "single_disc"},
                       "track_artists": [{"disc_number": 1, "track_number": 1, "artist": "Angra",
                                          "artist_mbids": [ANGRA]}]})
    if "Holy Land" in by_title:
        albums.append({"local_album_id": by_title["Holy Land"]["id"], "local_title": "Holy Land", "state": "unresolved",
                       "release_group_mbid": None, "release_mbid": None, "disc_position": None, "signals": [],
                       "diagnostic": "tracks_differ"})
    if "Elsewhere" in by_title:
        albums.append({"local_album_id": by_title["Elsewhere"]["id"], "local_title": "Elsewhere", "state": "unresolved",
                       "release_group_mbid": None, "release_mbid": None, "disc_position": None, "signals": [],
                       "diagnostic": "no_title_match"})
    return {"classification": "complete", "albums": albums,
            "release_groups": {GROUP: {"id": GROUP, "title": "Angels Cry", "primary_type": "Album",
                                       "secondary_types": [], "first_release_date": "1993-11-03",
                                       "genres": [{"name": "power metal", "count": 2}]}} if "Angels Cry" in by_title else {},
            "releases": {RELEASE: {"id": RELEASE, "title": "Angels Cry", "date": "1993-11-03", "barcode": "4988002285211",
                                   "release_group_id": GROUP, "artist_credit": [], "media": []}}
            if "Angels Cry" in by_title else {}}


def _rows(setup_url):
    with isolatedPostgres._connect(setup_url) as connection:
        return {row["album_key"]: row for row in connection.execute(
            "select album_key, state, release_group_mbid::text, release_mbid::text, diagnostic, main_disc_count,"
            " main_disc_source, track_artists, decision_source, artist_mbid::text"
            " from library.local_album_musicbrainz_releases").fetchall()}


def test_matched_artists_albums_get_a_release_or_a_stated_reason_and_nothing_else_changes(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: _outcome(context))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)

    # Only artists with an identity are queued; the unmatched one is not.
    assert repository.enqueue(reason="test", observed_at=NOW) == 2
    assert processor.process_next(worker_id="w")["state"] == "succeeded"
    assert processor.process_next(worker_id="w")["state"] == "succeeded"
    assert processor.process_next(worker_id="w") == {"processed": False, "state": "idle"}

    rows = _rows(setup_url)
    assert set(rows) == {"rel-cry", "rel-holy", "rel-else"}
    cry = rows["rel-cry"]
    assert (cry["state"], cry["release_group_mbid"], cry["release_mbid"], cry["artist_mbid"]) == (
        "release", GROUP, RELEASE, ANGRA)
    assert (cry["main_disc_count"], cry["main_disc_source"]) == (1, "single_disc")
    assert cry["track_artists"][0]["artist"] == "Angra"
    assert (rows["rel-holy"]["state"], rows["rel-holy"]["diagnostic"]) == ("unresolved", "tracks_differ")
    with isolatedPostgres._connect(setup_url) as connection:
        group = connection.execute("select primary_type, genres from integration.musicbrainz_release_groups").fetchone()
        assert (group["primary_type"], group["genres"][0]["name"]) == ("Album", "power metal")
        assert connection.execute("select barcode from integration.musicbrainz_releases").fetchone()["barcode"] == \
            "4988002285211"
        # Remote releases never become local albums.
        assert connection.execute("select count(*) as n from library.local_albums").fetchone()["n"] == 4

    # Current decisions are not queued again; a changed artist match is.
    assert repository.enqueue(reason="test", observed_at=NOW) == 0
    processor.queue_artist(ids["angra"])
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute("select count(*) as n from ops.metadata_enrichment_jobs where job_kind = %s"
                                  " and state = 'queued'", (JOB_KIND,)).fetchone()["n"] == 1


def test_an_owners_manual_release_choice_is_never_replaced(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: _outcome(context))
    with isolatedPostgres._connect(setup_url) as connection:
        library_id = connection.execute("select library_id from library.local_albums limit 1").fetchone()["library_id"]
        connection.execute(
            "insert into library.local_album_musicbrainz_releases (library_id, album_key, state, diagnostic,"
            " decision_source, matcher_version, observed_at) values (%s, 'rel-cry', 'unresolved', 'title_only',"
            " 'manual', 1, %s)", (library_id, NOW))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    assert processor.process_next(worker_id="w")["state"] == "succeeded"
    assert (_rows(setup_url)["rel-cry"]["decision_source"], _rows(setup_url)["rel-cry"]["state"]) == (
        "manual", "unresolved")


def test_a_provider_failure_retries_the_job_and_stores_nothing(monkeypatch):
    setup_url, repository, ids, _albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases",
                        lambda context, client: {"classification": "provider_unavailable", "safe_error": "down"})
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    assert processor.process_next(worker_id="w")["state"] == "retry_wait"
    assert _rows(setup_url) == {}


def test_the_album_queue_waits_until_no_artist_job_is_due(monkeypatch):
    calls = []

    class Artists:
        def __init__(self):
            self.results = [{"processed": True, "state": "succeeded", "local_artist_id": 7},
                            {"processed": False, "state": "idle"}]

        def process_next(self, *, worker_id):
            calls.append("artist")
            return self.results.pop(0)

    class Albums:
        def queue_artist(self, local_artist_id):
            calls.append(("queue", local_artist_id))

        def process_next(self, *, worker_id):
            calls.append("album")
            return {"processed": True, "state": "succeeded"}

    combined = MusicBrainzEnrichmentChain(Artists(), Albums())
    combined.process_next(worker_id="w")
    combined.process_next(worker_id="w")
    assert calls == ["artist", ("queue", 7), "artist", "album"]


def test_album_details_name_the_last_main_disc_only_when_musicbrainz_decided(monkeypatch):
    from music_app.services.library_browse_postgres import _album_musicbrainz_release

    setup_url, repository, ids, albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module

    def outcome(context):
        result = _outcome(context)
        for album in result["albums"]:
            if album["state"] == "release":
                album["main_disc"] = {"main_disc_count": 2, "source": "original_release"}
        return result

    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: outcome(context))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    processor.process_next(worker_id="w")
    three_discs = [{"disc_number": 1}, {"disc_number": 2}, {"disc_number": 3}]
    with isolatedPostgres._connect(setup_url) as connection:
        release = _album_musicbrainz_release(connection, albums["cry"], three_discs)
        assert (release["state"], release["release_mbid"], release["last_main_disc_number"]) == ("release", RELEASE, 2)
        assert release["track_artists"][0]["artist"] == "Angra"
        # Every local disc is main: nothing to split.
        assert _album_musicbrainz_release(connection, albums["cry"], three_discs[:2])["last_main_disc_number"] is None
        # Unresolved and undecided albums keep the local guess.
        assert _album_musicbrainz_release(connection, albums["holy"], three_discs) is None
        assert _album_musicbrainz_release(connection, albums["none"], three_discs) is None


def test_lost_track_artists_show_the_release_credit_and_readable_ones_stay():
    from music_app.services.library_browse_postgres import _apply_musicbrainz_track_artists

    album = {"album_artist": "天門", "musicbrainz_release": {"track_artists": [
        {"disc_number": 1, "track_number": 1, "artist": "天門"},
        {"disc_number": 1, "track_number": 2, "artist": "天門 & Guest"}]},
        "track_rows": [{"disc_number": 1, "track_number": 1, "secondary_artist": "??"},
                       {"disc_number": 1, "track_number": 2, "secondary_artist": "??"},
                       {"disc_number": 1, "track_number": 3, "secondary_artist": "Someone"}],
        "tracks": [{"artist": "??"}]}
    rows = _apply_musicbrainz_track_artists(album)["track_rows"]
    assert [row["secondary_artist"] for row in rows] == [None, "天門 & Guest", "Someone"]
    # The tags the editor reads are untouched.
    assert album["tracks"] == [{"artist": "??"}]
    assert _apply_musicbrainz_track_artists({"track_rows": [{"secondary_artist": "??"}]})["track_rows"] == [
        {"secondary_artist": "??"}]


def test_a_released_albums_sub_sections_are_stored_and_cleared_with_its_release(monkeypatch):
    """S8: sub-sections belong to a certainly matched release only."""
    from music_app.services.library_browse_postgres import _album_track_sections

    setup_url, repository, ids, albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    sections = [{"disc_number": 1, "track_number": 2, "section": "Where Dead Angels Lie"}]
    state = {"release": True}

    def outcome(context):
        result = _outcome(context)
        for album in result["albums"]:
            if album["state"] == "release":
                album["track_sections"] = sections
                if not state["release"]:
                    album.update(state="release_group", release_mbid=None, track_sections=[])
        return result

    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: outcome(context))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    processor.process_next(worker_id="w")
    with isolatedPostgres._connect(setup_url) as connection:
        assert _album_track_sections(connection, albums["cry"]) == sections
        assert _album_track_sections(connection, albums["holy"]) == []
    state["release"] = False
    repository.enqueue(reason="test", observed_at=NOW + timedelta(minutes=1), local_artist_id=ids["angra"], force=True)
    processor.process_next(worker_id="w")
    with isolatedPostgres._connect(setup_url) as connection:
        assert _album_track_sections(connection, albums["cry"]) == []


def test_an_unavailable_discogs_check_keeps_the_headings_and_is_retried_until_answered(monkeypatch):
    """Owner 2026-11-16: hourly retries for a Discogs outage; a definitive answer ends them."""
    from music_app.services.library_browse_postgres import _album_track_sections

    setup_url, repository, ids, albums = _seed(monkeypatch)
    from music_app.services import musicbrainz_release_identity as module
    sections = [{"disc_number": 1, "track_number": 2, "section": "Where Dead Angels Lie"}]
    state = {"unavailable": False}

    def outcome(context):
        result = _outcome(context)
        for album in result["albums"]:
            if album["state"] == "release":
                album["track_sections"] = [] if state["unavailable"] else sections
                album["discogs_sections_unavailable"] = state["unavailable"]
        return result

    monkeypatch.setattr(module, "resolve_album_releases", lambda context, client: outcome(context))
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=FakeResolverClient(), now=lambda: NOW)
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    processor.process_next(worker_id="w")
    state["unavailable"] = True
    repository.enqueue(reason="test", observed_at=NOW, local_artist_id=ids["angra"], force=True)
    processor.process_next(worker_id="w")
    with isolatedPostgres._connect(setup_url) as connection:
        assert _album_track_sections(connection, albums["cry"]) == sections
        row = connection.execute(
            "select discogs_section_attempts, discogs_section_first_failed_at, discogs_section_retry_at"
            " from library.local_album_musicbrainz_releases where album_key = 'rel-cry'").fetchone()
    assert (row["discogs_section_attempts"], row["discogs_section_first_failed_at"],
            row["discogs_section_retry_at"]) == (1, NOW, NOW + timedelta(hours=1))
    assert repository.claim_section_retry(now=NOW + timedelta(minutes=59)) is None
    due = repository.claim_section_retry(now=NOW + timedelta(hours=1))
    assert (due["release_mbid"], due["title"], due["first_failed_at"]) == (RELEASE, "Angels Cry", NOW)
    # Held: a second lane does not take it again.
    assert repository.claim_section_retry(now=NOW + timedelta(hours=1)) is None
    repository.store_section_retry(row=due, track_sections=None, retry_at=NOW + timedelta(hours=2),
                                   observed_at=NOW + timedelta(hours=1))
    repository.store_section_retry(row=due, track_sections=[], retry_at=None, observed_at=NOW + timedelta(hours=2))
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            "select discogs_section_attempts, discogs_section_retry_at, track_sections"
            " from library.local_album_musicbrainz_releases where album_key = 'rel-cry'").fetchone()
    assert (row["discogs_section_attempts"], row["discogs_section_retry_at"], row["track_sections"]) == (0, None, [])
