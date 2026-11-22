"""An album keeps the name its release credits it to. A punctuation or typography-only
difference shows the artist's main name.

No database: one test per named case, with its negatives.
"""
from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace

import pytest

from music_app.services.library_browse_postgres import _album_musicbrainz_release
from music_app.services.musicbrainz_correction_display import apply_correction_display, project_correction_display
from music_app.services.musicbrainz_corrections_postgres import compare_stored_album


def _credit(name, main, join=""):
    return {"name": name, "artist_mbid": "m", "artist_name": main, "join_phrase": join}


CREDITED_DUO = [_credit("Quillmere Duo", "Brackenfold Choir")]
SHORTER_NAME = [_credit("Vellichor", "Vellichor of Ash")]
PUNCTUATION = [_credit("Night Ferry Black Lanterns!", "Night Ferry! Black Lanterns")]
SOLO_ALBUM = [_credit("Martin Vale", "Martin Vale")]
JOINT = [_credit("Ada North", "Ada North", " & "), _credit("Ben South", "Ben South")]


def _connection(rows, queries=None):
    def execute(sql, _params=None):
        if queries is not None:
            queries.append(sql)
        return SimpleNamespace(fetchall=lambda: rows)

    return SimpleNamespace(execute=execute)


# Data Correction --------------------------------------------------------------------------

def _artist_changes(tag, credit):
    compared = compare_stored_album({"title": "Album", "artist_name": tag, "release_title": "Album",
                                     "artist_credit": credit, "media": [], "tracks": []})
    return [row["proposed_value"] for row in compared["rows"] if row["field"] == "album_artist"]


@pytest.mark.parametrize(("tag", "credit"), [("Quillmere Duo", CREDITED_DUO), ("Vellichor", SHORTER_NAME)])
def test_data_correction_never_proposes_the_main_name_for_a_really_credited_name(tag, credit):
    assert _artist_changes(tag, credit) == []


def test_a_punctuation_only_credit_is_corrected_to_the_main_name():
    assert _artist_changes("Night Ferry Black Lanterns!", PUNCTUATION) == ["Night Ferry! Black Lanterns"]
    assert _artist_changes("Night Ferry! Black Lanterns", PUNCTUATION) == []


def test_a_solo_album_is_still_corrected_to_its_credit():
    assert _artist_changes("Martin Vale Project", SOLO_ALBUM) == ["Martin Vale"]


def test_a_joint_credit_is_compared_as_written():
    assert _artist_changes("Ada North", JOINT) == ["Ada North & Ben South"]


# Album Details ----------------------------------------------------------------------------

def _details(tag, main, credit, *, applied=(), group=None):
    artist = {"canonical_name": main, "tag_differs": tag != main, **({"group_label": group} if group else {})}
    album = {"album_artist": tag, "name": "Album", "tracks": [], "musicbrainz_artist": artist}
    if credit is not None:
        album["musicbrainz_release"] = _album_musicbrainz_release(_connection([{
            "state": "release", "release_group_mbid": "g", "release_mbid": "r", "artist_credit": credit,
        }]), 7, [])
    apply_correction_display(_connection(list(applied)), album, album_id=7)
    return album


@pytest.mark.parametrize(("tag", "main", "credit", "shown"), [
    ("Quillmere Duo", "Brackenfold Choir", CREDITED_DUO, "Quillmere Duo"),
    ("Brackenfold Choir", "Brackenfold Choir", CREDITED_DUO, "Quillmere Duo"),
    ("Vellichor", "Vellichor of Ash", SHORTER_NAME, "Vellichor"),
    ("Night Ferry Black Lanterns!", "Night Ferry! Black Lanterns", PUNCTUATION, "Night Ferry! Black Lanterns"),
])
def test_album_details_name_the_credited_artist(tag, main, credit, shown):
    album = _details(tag, main, credit)
    # Present even when it equals the tag: it must win over the main name of tag_differs.
    assert album["display_artist"] == shown
    assert album["album_artist"] == tag, "tags stay the tags"


def test_a_solo_album_and_an_album_without_a_stored_credit_keep_todays_correction():
    for credit in (SOLO_ALBUM, None, []):
        assert "display_artist" not in _details("Martin Vale Project", "Martin Vale", credit)


def test_an_applied_correction_still_wins():
    applied = [{"field": "album_artist", "disc_number": 0, "track_number": 0, "proposed_value": "Corrected"}]
    assert _details("Brackenfold Choir", "Brackenfold Choir", CREDITED_DUO, applied=applied)["display_artist"] == "Corrected"


def test_a_split_names_group_label_gives_way_only_to_a_really_different_credit():
    typographic = [_credit("TWIN NAME", "Twin Name")]
    assert "display_artist" not in _details("Twin Name", "Twin Name", typographic, group="Twin Name (North)")
    other = [_credit("Twin Name Trio", "Twin Name")]
    assert _details("Twin Name", "Twin Name", other, group="Twin Name (North)")["display_artist"] == "Twin Name Trio"


# Cards -----------------------------------------------------------------------------------

def test_cards_name_the_credited_artist_with_one_read_for_the_whole_page():
    rows = [
        {"album_key": "first", "artist_credit": CREDITED_DUO},
        {"album_key": "retagged", "artist_credit": CREDITED_DUO},
        {"album_key": "typography", "artist_credit": PUNCTUATION},
        {"album_key": "corrected", "artist_credit": CREDITED_DUO, "corrected_album_artist": "Corrected"},
    ]
    albums = [
        {"key": "first", "name": "First Embers", "album_artist": "Quillmere Duo"},
        {"key": "retagged", "name": "Second Embers", "album_artist": "Brackenfold Choir"},
        {"key": "typography", "name": "Album", "album_artist": "Night Ferry Black Lanterns!"},
        {"key": "corrected", "name": "Album", "album_artist": "Brackenfold Choir"},
        {"key": "no-credit", "name": "The Hidden Room", "album_artist": "Martin Vale Project"},
    ]
    queries = []
    project_correction_display({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://x"}, {"albums": albums},
                               connect=lambda _url: nullcontext(_connection(rows, queries)))

    assert [album.get("display_artist", album["album_artist"]) for album in albums] == [
        "Quillmere Duo", "Quillmere Duo", "Night Ferry! Black Lanterns", "Corrected", "Martin Vale Project"]
    assert "display_artist" not in albums[0], "no extra bytes where the tag already is the credit"
    assert len(queries) == 1, "no per-album query"


def test_a_name_of_symbols_alone_is_never_a_punctuation_difference():
    assert _artist_changes("!!!", [_credit("!!!", "???")]) == []
    assert _details("!!!", "???", [_credit("!!!", "???")])["display_artist"] == "!!!"


@pytest.mark.parametrize(("field", "kind"), [
    ("album_artist", "album_artist_renamed"), ("album", "album_title"), ("title", "track_title"),
])
def test_a_change_between_symbol_only_values_waits_for_review(field, kind):
    from music_app.services.musicbrainz_correction_kinds import classify

    assert classify(field, "!!!", "???") == kind
    assert classify(field, "! !", "!  !") == "spacing"
