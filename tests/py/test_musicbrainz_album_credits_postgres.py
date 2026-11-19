"""Album credits and same-name artist groups on real isolated PostgreSQL (Delivery 2, S2).

One test per rule plus its negative. Each test owns a freshly migrated isolated database.
"""
from __future__ import annotations

from datetime import datetime, timezone

from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _apply_pre_delivery_migrations,
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    apply_delivery_migrations,
)

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=timezone.utc)
MENKEN = "0f8ae2f4-4b3a-4f33-8f0c-b5eae4a54e95"
ASHMAN = "1e9a4c0b-9f34-4a3b-9cb6-2b1d3e4f5a6b"
GROUP = "067d7c43-0000-4000-8000-000000000001"
RELEASE = "130c7791-2b1b-4065-bfde-65228c7d88c6"
AMAROK_PL = "6b1f0c2e-1111-4000-8000-000000000001"
AMAROK_ES = "6b1f0c2e-2222-4000-8000-000000000002"
COOPER_PERSON = "ee58c59f-8e7f-4430-b8ca-236c4d3745ae"
COOPER_BAND = "4d7928cd-7ed2-4282-8c29-c0c9f966f1bd"
ANGRA = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3"


def _database(monkeypatch):
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
    return setup_url, library_id


def _artist(connection, library_id, name, *, state=None, mbid=None, source="automatic"):
    artist_id = connection.execute(
        "insert into library.local_artists (library_id, artist_key, name, metadata)"
        " values (%s, %s, %s, '{}'::jsonb) returning id", (library_id, f"s2-{name}", name)).fetchone()["id"]
    if state:
        connection.execute(
            "insert into library.local_artist_musicbrainz_matches (library_id, local_artist_id, artist_mbid, state,"
            " decision_source, decided_by_account_id, confidence, evidence_summary, matcher_version,"
            " first_observed_at, last_observed_at, created_at, updated_at)"
            " values (%s, %s, %s, %s, %s, null, 0, 'test', 5, %s, %s, %s, %s)",
            (library_id, artist_id, mbid, state, source, NOW, NOW, NOW, NOW))
    return artist_id


def _album(connection, library_id, artist_id, key, title):
    album_id = connection.execute(
        "insert into library.local_albums (library_id, artist_id, album_key, title, release_year, metadata)"
        " values (%s, %s, %s, %s, 1989, '{}'::jsonb) returning id", (library_id, artist_id, key, title)).fetchone()["id"]
    connection.execute(
        "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, disc_number,"
        " track_number, duration_seconds, metadata) values (%s, %s, %s, %s, 'Song', 1, 1, 200, '{}'::jsonb)",
        (library_id, album_id, artist_id, f"{key}-1"))
    return album_id


def _remote_artist(connection, mbid, name, *, disambiguation=None, country=None):
    connection.execute(
        "insert into integration.musicbrainz_artists (mbid, canonical_name, disambiguation, refreshed_at)"
        " values (%s, %s, %s, %s)", (mbid, name, disambiguation, NOW))
    if country:
        connection.execute(
            "insert into integration.musicbrainz_artist_countries (artist_mbid, country_code, country_name,"
            " provenance, observed_at) values (%s, %s, %s, 'test', %s)", (mbid, *country, NOW))


def _identity(connection, library_id, key, mbid):
    connection.execute(
        "insert into library.local_album_artist_identities (library_id, album_key, artist_mbid, matcher_version)"
        " values (%s, %s, %s, 5)", (library_id, key, mbid))


# Rule 1 (with 3): albums of an artist the matcher left without an identity are found by
# their release credits, and each album lists the release's credit in MusicBrainz's order.

def test_a_collaboration_without_an_identity_gets_its_releases_credit_per_album_in_order(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        duo = _artist(connection, library_id, "Alan Menken & Howard Ashman", state="manual_review")
        _album(connection, library_id, duo, "s2-mermaid", "The Little Mermaid")
        _album(connection, library_id, duo, "s2-other", "Other Songs")
    seen = []

    def resolve(context, client):
        seen.append(context)
        mermaid, other = sorted(context["albums"], key=lambda album: album["title"] != "The Little Mermaid")
        return {"classification": "complete", "albums": [
            {"local_album_id": mermaid["id"], "local_title": mermaid["title"], "state": "release",
             "release_group_mbid": GROUP, "release_mbid": RELEASE, "disc_position": None,
             "signals": ["track_count", "track_list"], "diagnostic": None},
            {"local_album_id": other["id"], "local_title": other["title"], "state": "release_group",
             "release_group_mbid": GROUP, "release_mbid": None, "disc_position": None,
             "signals": ["year"], "diagnostic": None}],
            "release_groups": {GROUP: {"id": GROUP, "title": "The Little Mermaid"}},
            "releases": {RELEASE: {"id": RELEASE, "title": "The Little Mermaid", "release_group_id": GROUP,
                                   "artist_credit": [
                                       {"name": "Alan Menken", "artist_mbid": MENKEN, "artist_name": "Alan Menken",
                                        "join_phrase": " & "},
                                       {"name": "Howard Ashman", "artist_mbid": ASHMAN,
                                        "artist_name": "Howard Ashman", "join_phrase": ""}], "media": []}}}

    from music_app.services import musicbrainz_release_identity as module
    monkeypatch.setattr(module, "resolve_album_releases", resolve)
    repository = MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    assert repository.enqueue(reason="test", observed_at=NOW) == 1
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=object(), now=lambda: NOW)
    assert processor.process_next(worker_id="w")["state"] == "succeeded"

    [context] = seen
    assert (context["local_name"], context["artist_mbid"]) == ("Alan Menken & Howard Ashman", None)
    with isolatedPostgres._connect(setup_url) as connection:
        credits = connection.execute(
            "select album_key, position, artist_mbid::text, credited_name, join_phrase"
            " from library.local_album_musicbrainz_credits order by album_key, position").fetchall()
        # The credit names no matched artist of ours: the album row keeps no artist link.
        assert connection.execute("select artist_mbid from library.local_album_musicbrainz_releases"
                                  " where album_key = 's2-mermaid'").fetchone()["artist_mbid"] is None
    assert [tuple(row.values()) for row in credits] == [
        ("s2-mermaid", 1, MENKEN, "Alan Menken", " & "), ("s2-mermaid", 2, ASHMAN, "Howard Ashman", "")]


def test_owner_decisions_split_names_and_undecided_artists_are_not_searched_by_credit(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        owner = _artist(connection, library_id, "Owner & Said No", state="not_found", source="manual")
        _album(connection, library_id, owner, "s2-owner", "Owner Album")
        split = _artist(connection, library_id, "Amarok", state="per_album")
        _album(connection, library_id, split, "s2-undecided", "Undecided")
        pending = _artist(connection, library_id, "Pending & Co", state="pending")
        _album(connection, library_id, pending, "s2-pending", "Pending Album")
        never = _artist(connection, library_id, "Never Checked & Co")
        _album(connection, library_id, never, "s2-never", "Never Album")
    repository = MusicBrainzReleaseIdentityPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url}, connect=lambda _url: isolatedPostgres._connect(setup_url))
    assert repository.enqueue(reason="test", observed_at=NOW) == 0


# Rule 4: a split local name's albums group per proven MusicBrainz artist.

def test_proven_split_groups_are_named_by_country_and_undecided_albums_keep_the_plain_name(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        _remote_artist(connection, AMAROK_PL, "Amarok", disambiguation="Polish progressive rock", country=("PL", "Poland"))
        _remote_artist(connection, AMAROK_ES, "Amarok", disambiguation="Spanish band", country=("ES", "Spain"))
        amarok = _artist(connection, library_id, "Amarok", state="per_album")
        for key, mbid in (("s2-pl", AMAROK_PL), ("s2-es", AMAROK_ES), ("s2-es2", AMAROK_ES), ("s2-open", None)):
            _album(connection, library_id, amarok, key, key)
            if mbid:
                _identity(connection, library_id, key, mbid)
        groups = {row["album_key"]: row for row in connection.execute(
            "select album_key, artist_mbid::text, group_key, group_label from library.local_album_artist_groups"
        ).fetchall()}
    assert {key: groups[key]["group_label"] for key in groups} == {
        "s2-pl": "Amarok (Poland)", "s2-es": "Amarok (Spain)", "s2-es2": "Amarok (Spain)", "s2-open": "Amarok"}
    assert groups["s2-es"]["group_key"] == groups["s2-es2"]["group_key"] == f"musicbrainz:{AMAROK_ES}"
    assert (groups["s2-open"]["group_key"], groups["s2-open"]["artist_mbid"]) == (f"artist:{amarok}", None)


def test_a_person_and_a_same_named_band_of_one_country_are_told_apart_by_disambiguation(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        _remote_artist(connection, COOPER_PERSON, "Alice Cooper", disambiguation="US singer",
                       country=("US", "United States"))
        _remote_artist(connection, COOPER_BAND, "Alice Cooper", disambiguation="US band, 1964-1975",
                       country=("US", "United States"))
        cooper = _artist(connection, library_id, "Alice Cooper", state="per_album")
        for key, mbid in (("s2-person", COOPER_PERSON), ("s2-band", COOPER_BAND)):
            _album(connection, library_id, cooper, key, key)
            _identity(connection, library_id, key, mbid)
        labels = {row["album_key"]: row["group_label"] for row in connection.execute(
            "select album_key, group_label from library.local_album_artist_groups")}
    assert labels == {"s2-person": "Alice Cooper (US singer)", "s2-band": "Alice Cooper (US band, 1964-1975)"}


def test_an_artist_matched_as_one_identity_is_never_split(monkeypatch):
    setup_url, library_id = _database(monkeypatch)
    with isolatedPostgres._connect(setup_url) as connection:
        _remote_artist(connection, ANGRA, "Angra", country=("BR", "Brazil"))
        angra = _artist(connection, library_id, "Angra", state="matched", mbid=ANGRA)
        for key in ("s2-cry", "s2-holy"):
            _album(connection, library_id, angra, key, key)
        # A certain album of a matched artist is no split either.
        _identity(connection, library_id, "s2-cry", ANGRA)
        rows = connection.execute(
            "select artist_mbid::text, group_key, group_label from library.local_album_artist_groups").fetchall()
    assert {(row["artist_mbid"], row["group_key"], row["group_label"]) for row in rows} == {
        (ANGRA, f"artist:{angra}", "Angra")}
