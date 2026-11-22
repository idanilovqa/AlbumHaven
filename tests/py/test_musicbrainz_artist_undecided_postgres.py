""""MusicBrainz: artist undecided" on real isolated PostgreSQL: the approved row and its negatives."""
from __future__ import annotations

from datetime import timedelta

import pytest

from music_app.services.musicbrainz_album_identity_postgres import MusicBrainzAlbumIdentityPostgresRepository
from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository
from tests.e2e.support import isolatedPostgres
from tests.py.test_musicbrainz_artist_migration_postgres import (
    _dedicated_database_urls_or_skip,
    leave_setup_database_migrated,
)
from tests.py.test_musicbrainz_problem_lifecycle_postgres import GERMAN, NOW, TRANCE, _seed_present_artist

pytestmark = pytest.mark.usefixtures("leave_setup_database_migrated")

ARTISTS = [{"mbid": GERMAN, "canonical_name": "Axxis"}, {"mbid": TRANCE, "canonical_name": "Axxis"}]


def _suggestion(album_id, *, favoured=GERMAN, found=(1, 0)):
    return {"local_album_id": album_id, "favoured_mbid": favoured, "artists": [
        {"artist_mbid": GERMAN, "found": found[0], "sampled": 3, "folder_album": None},
        {"artist_mbid": TRANCE, "found": found[1], "sampled": 3, "folder_album": "Dancefloor Mix"}]}


@pytest.fixture
def split(monkeypatch):
    """A split name with one undecided album (undecided-album) and one album of no evidence."""
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    library_id, artist_id = _seed_present_artist(setup_url, "undecided")
    with isolatedPostgres._connect(setup_url) as connection:
        album_id = connection.execute(
            "select id from library.local_albums where album_key = 'undecided-album'").fetchone()["id"]
        other_id = connection.execute(
            "insert into library.local_albums (library_id, artist_id, album_key, title, metadata)"
            " values (%s, %s, 'undecided-other', 'Other', '{}'::jsonb) returning id",
            (library_id, artist_id)).fetchone()["id"]
        connection.execute(
            "insert into library.local_tracks (library_id, album_id, artist_id, track_key, title, metadata)"
            " values (%s, %s, %s, 'undecided-other-track', 'Track', '{}'::jsonb)", (library_id, other_id, artist_id))
        owner = connection.execute(
            "select account_id from app.bootstrap_owners where owner_key = 'local-bootstrap-owner'").fetchone()["account_id"]
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
    connect = lambda _url: isolatedPostgres._connect(runtime_url)
    matcher = MusicBrainzEnrichmentPostgresRepository(config, connect=connect)
    identities = MusicBrainzAlbumIdentityPostgresRepository(config, connect=connect)

    def recheck(suggestions=(), *, decided=(), unchecked=(), at=NOW):
        matcher.record_automatic_outcome(
            local_artist_id=artist_id, state="per_album", artist=None, confidence=1, observed_at=at,
            evidence_summary="Your albums belong to 2 MusicBrainz artists.", identity_artists=ARTISTS,
            album_identities=list(decided), album_suggestions=list(suggestions),
            album_suggestions_unchecked=list(unchecked))

    def rows(sql):
        with isolatedPostgres._connect(setup_url) as connection:
            return connection.execute(sql).fetchall()

    return {"album": album_id, "owner": owner, "artist": artist_id, "recheck": recheck, "rows": rows,
            "listed": lambda: [row for row in matcher.list_album_attention() if row.get("artist_undecided")],
            "assign": lambda mbid=GERMAN, actor=None: identities.assign_suggested_artist(
                album_key="undecided-album", artist_mbid=mbid, actor_account_id=actor or owner,
                observed_at=NOW, request_ref="test")}


def test_a_suggestion_lists_the_album_and_decides_nothing(split):
    split["recheck"]([_suggestion(split["album"])])

    (listed,) = split["listed"]()
    candidates = listed["artist_undecided"]["candidates"]
    assert listed["album_key"] == "undecided-album", "negative 2: the album without evidence has no entry"
    assert [(item["artist_mbid"], item["favoured"]) for item in candidates] == [(GERMAN, True), (TRANCE, False)]
    assert split["rows"]("select 1 from library.local_album_artist_identities") == []


def test_evidence_that_favours_neither_is_listed_with_no_favourite(split):
    split["recheck"]([_suggestion(split["album"], favoured=None, found=(2, 2))])

    (listed,) = split["listed"]()
    assert not any(item["favoured"] for item in listed["artist_undecided"]["candidates"]), "negative 1"


def test_a_decided_album_has_no_entry(split):
    split["recheck"]([_suggestion(split["album"])], decided=[{"local_album_id": split["album"], "artist_mbid": GERMAN}])

    assert split["listed"]() == [], "negative 3"
    assert split["rows"]("select 1 from library.local_album_artist_suggestions") == []


def test_a_recheck_replaces_suggestions_and_keeps_an_unchecked_album_s(split):
    split["recheck"]([_suggestion(split["album"])])
    split["recheck"](unchecked=[split["album"]], at=NOW + timedelta(days=1))
    assert len(split["listed"]()) == 1

    split["recheck"]([_suggestion(split["album"], favoured=TRANCE, found=(0, 1))], at=NOW + timedelta(days=2))
    (listed,) = split["listed"]()
    assert listed["artist_undecided"]["candidates"][0]["artist_mbid"] == TRANCE, "the favourite moves"

    split["recheck"](at=NOW + timedelta(days=3))
    assert split["listed"]() == []


def test_assign_files_that_album_as_a_manual_choice_that_rechecks_keep(split):
    split["recheck"]([_suggestion(split["album"])])

    assert split["assign"]() == "assigned"
    assert split["listed"]() == [], "negative 4: an album with a manual choice has no entry"

    split["recheck"]([_suggestion(split["album"], favoured=TRANCE, found=(0, 1))],
                     decided=[{"local_album_id": split["album"], "artist_mbid": TRANCE}], at=NOW + timedelta(days=1))
    stored = split["rows"](
        "select album_key, artist_mbid::text, decision_source from library.local_album_artist_identities")
    assert [tuple(row[key] for key in ("album_key", "artist_mbid", "decision_source")) for row in stored] == [
        ("undecided-album", GERMAN, "manual")], "negative 4: the choice is never changed, and only that album moved"
    assert split["listed"]() == []
    assert split["assign"](TRANCE) == "changed"
    assert split["rows"]("select state from library.local_artist_musicbrainz_matches")[0]["state"] == "per_album"
    assert len(split["rows"]("select 1 from app.security_audit_events"
                             " where reason_code = 'musicbrainz_album_artist_manual_assignment'")) == 1


def test_an_unknown_actor_and_an_unproposed_artist_write_nothing(split):
    split["recheck"]([_suggestion(split["album"])])

    assert split["assign"](actor=987654) == "not_found"
    assert split["assign"]("00000000-0000-4000-8000-000000000099") == "changed"
    assert split["rows"]("select 1 from library.local_album_artist_identities") == []
