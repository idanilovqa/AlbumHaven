""""MusicBrainz: artist undecided" in Problematic Files (owner row approved 2026-11-21)."""
from __future__ import annotations

from contextlib import nullcontext

from music_app.routes.musicbrainz_enrichment_asgi import (
    load_problematic_album_items,
    project_album_problem_into_problematic_detail,
    project_album_problems_into_problematic_files,
)
from music_app.services.musicbrainz_enrichment_postgres import MusicBrainzEnrichmentPostgresRepository
from tests.py.test_musicbrainz_album_problems_projection import _request

LABEL = "MusicBrainz: artist undecided"
NO_INFO = "MusicBrainz has no info"
NORWAY = "166ef05e-53f7-44b8-a5d5-3944c188e12d"
UK = "3d77bd89-f6da-47f9-aecd-d092403d0986"
CANDIDATES = [
    {"artist_mbid": NORWAY, "canonical_name": "Ark", "disambiguation": "norwegian metal band",
     "artist_kind": "Group", "country": "NO", "found": 1, "sampled": 3, "folder_album": "Burn The Sun",
     "favoured": True},
    {"artist_mbid": UK, "canonical_name": "Ark", "disambiguation": "UK prog rock band", "artist_kind": "Group",
     "country": "GB", "found": 0, "sampled": 3, "folder_album": None, "favoured": False},
]
ARK = {"album_key": "ark", "album_title": "Ark", "year": 1999, "cover_path": None, "local_artist_id": 12,
       "artist_name": "Ark", "musicbrainz_has_no_info": False,
       "artist_undecided": {"track_count": 7, "candidates": CANDIDATES}}


def test_an_undecided_album_becomes_its_own_row_and_its_own_detail():
    (item,) = load_problematic_album_items(_request([ARK]))

    assert (item["key"], item["entity_kind"], item["detail_loaded"]) == (
        "musicbrainz-album:ark", "musicbrainz_album", False)
    assert item["problem_reasons"] == [LABEL]
    undecided = item["musicbrainz_artist_undecided"]
    assert (undecided["album_key"], undecided["artist_name"], undecided["track_count"]) == ("ark", "Ark", 7)
    assert undecided["candidates"][0] == {
        **CANDIDATES[0], "musicbrainz_url": f"https://musicbrainz.org/artist/{NORWAY}"}


def test_a_listed_album_gains_the_label_without_the_no_info_lookups():
    payload = {"items": [{"key": "ark::year::1999", "name": "Ark", "problem_reasons": ["Missing cover art"]}],
               "count": 1}

    project_album_problems_into_problematic_files(_request([ARK]), payload)

    (listed,) = payload["items"]
    assert listed["problem_reasons"] == ["Missing cover art", LABEL]
    assert listed["musicbrainz_artist_undecided"]["album_key"] == "ark"
    assert "musicbrainz_album_key" not in listed, "that key draws the no-info lookups"
    assert payload["count"] == 1


def test_an_album_that_is_both_keeps_both_labels():
    payload = {"items": [{"key": "ark", "name": "Ark", "problem_reasons": []}], "count": 1}

    project_album_problems_into_problematic_files(_request([{**ARK, "musicbrainz_has_no_info": True}]), payload)

    assert payload["items"][0]["problem_reasons"] == [NO_INFO, LABEL]
    assert payload["items"][0]["musicbrainz_album_key"] == "ark"


def test_a_loaded_detail_keeps_the_entry_and_a_non_owner_sees_none():
    detail = {"key": "ark::year::1999", "problem_reasons": []}
    project_album_problem_into_problematic_detail(_request([ARK]), detail)
    assert detail["problem_reasons"] == [LABEL]
    assert detail["musicbrainz_artist_undecided"]["candidates"][0]["favoured"] is True

    assert load_problematic_album_items(_request([ARK], owner=False)) == []


class _Connection:
    def __init__(self, results):
        self.results, self.statements = list(results), []

    def __enter__(self):
        return self

    def __exit__(self, *_error):
        return None

    def transaction(self):
        return nullcontext()

    def execute(self, sql, params=None):
        self.statements.append((" ".join(sql.split()), params))
        rows = self.results.pop(0)
        return type("Cursor", (), {"fetchall": lambda _self: rows})()


def _attention(connection, connects=None):
    def connect(_url):
        if connects is not None:
            connects.append(1)
        return connection

    return MusicBrainzEnrichmentPostgresRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/album_haven_test"},
        connect=connect).list_album_attention(album_key=None)


def test_both_album_problems_load_in_one_lease_and_two_statements_at_any_size():
    for size in (2, 2000):
        connects = []
        no_info = [{"album_key": f"album-{n}", "album_title": f"Album {n}", "artist_name": "Artist"} for n in range(size)]
        undecided = [{"album_key": "album-1", "album_title": "Album 1", "artist_name": "Artist", "track_count": 7,
                      "candidates": CANDIDATES}]
        connection = _Connection([no_info, undecided])

        rows = _attention(connection, connects)

        assert (len(connects), len(connection.statements), len(rows)) == (1, 2, size)
        both = next(row for row in rows if row["album_key"] == "album-1")
        assert both["musicbrainz_has_no_info"] is True
        assert both["artist_undecided"] == {"track_count": 7, "candidates": CANDIDATES}


def test_only_a_still_split_still_undecided_present_album_is_listed():
    connection = _Connection([[], []])
    _attention(connection)

    sql = connection.statements[1][0]
    assert "from active_library join library.local_album_artist_suggestions" in sql, "starts from the few suggestions"
    assert "state = 'per_album'" in sql
    assert "not exists ( select 1 from library.local_album_artist_identities" in sql, "decided or the owner's choice"
    assert "left join library.local_artists" in sql, "never an inner join on the album's artist"
    assert "from library.local_tracks" in sql
