"""Kinds of MusicBrainz data corrections, auto vs review, the guard and track pairing
(Delivery 2, S4; owner 2026-11-16, "Data Correction flow")."""
from __future__ import annotations

import pytest

from music_app.services.musicbrainz_correction_kinds import (
    ARTIST_KINDS,
    AUTO_KINDS,
    classify,
    compare_album,
)


@pytest.mark.parametrize("field,current,proposed,kind", [
    ("title", "South Side Of The Sky", "South Side of the Sky", "case"),
    ("title", "Banish  From Sanctuary", "Banish From Sanctuary", "spacing"),
    ("title", "Banish From Sanctuary ", "Banish From Sanctuary", "spacing"),
    ("title", "Legion Of The Damned  (New Version)", "Legion of the Damned (new version)", "case_spacing"),
    ("title", "Metamorphosis IV. Solace", "Metamorphosis: IV. Solace", "punctuation"),
    ("title", "Luz al Final del Tunel", "Luz al final del túnel", "accents"),
    ("title", "Endless Myster", "Endless Mystery", "small_edit"),
    ("title", "Siberian Divide (Feat. Cedric Bixler-Zavala)", "Siberian Divide", "edition_suffix"),
    ("title", "The Mirror", "Only for the Night", "track_title"),
    ("album", "Blasphemy/Purity", "Blasphemy", "album_title"),
    ("artist", "PFM", "Premiata Forneria Marconi", "track_artist_renamed"),
    ("artist", "Jeff Loomis", "Jeff Loomis & Ron Jarzombek", "track_artist_joined"),
    ("album_artist", "The Dixie Dregs", "The Dregs", "album_artist_renamed"),
    ("album_artist", "Aksak Maboul", "Marc Hollander & Aksak Maboul", "album_artist_joined"),
])
def test_each_kind(field, current, proposed, kind):
    assert classify(field, current, proposed) == kind


def test_trivial_kinds_apply_automatically_and_the_rest_wait_for_the_owner():
    assert AUTO_KINDS == {"case", "spacing", "case_spacing", "punctuation", "accents", "small_edit"}
    assert ARTIST_KINDS == {"track_artist_renamed", "track_artist_joined", "album_artist_renamed",
                            "album_artist_joined"}


def _album(tracks, remote, **extra):
    return {"title": "Album", "artist_name": "Band", "release_title": "Album", "release_credit": "Band",
            "media": [{"position": 1, "tracks": [{"position": index, "title": title,
                                                  "artist_credit": [{"name": "Band"}]}
                                                 for index, title in enumerate(remote, start=1)]}],
            "tracks": [{"disc_number": 1, "track_number": index, "title": title, "artist": "Band"}
                       for index, title in enumerate(tracks, start=1)], **extra}


ORDER_EXACT = {"match_quality": "order_exact", "pairing": {}}


@pytest.mark.parametrize("local,remote", [
    ("Don't Despair", "Don’t Despair"),
    ('The "Crazy" Ones', "The “Crazy” Ones"),
    ("Track - One", "Track – One"),
    ("Carry On", "Carry On"),
])
def test_curly_punctuation_and_identical_text_are_not_differences(local, remote):
    assert compare_album(_album([local], [remote], pairing=ORDER_EXACT))["rows"] == []


def test_trivial_rows_apply_automatically_on_an_ordinary_album():
    result = compare_album(_album(["carry on", "Nova Era", "Spread Your Fire"],
                                  ["Carry On", "Nova Era", "Spread Your Fire"], pairing=ORDER_EXACT))

    assert result["review_whole"] is False
    assert [(row["kind"], row["mode"]) for row in result["rows"]] == [("case", "auto")]


def test_the_dream_evil_shape_goes_to_review_whole_even_its_trivial_rows():
    local = ["the chosen ones", "The Mirror", "Children Of The Night", "Book Of Heavy Metal", "Kill Kill Kill"]
    remote = ["The Chosen Ones", "Only for the Night", "Book of Heavy Metal", "The Sinner", "Kill Kill Kill"]

    result = compare_album(_album(local, remote, pairing=ORDER_EXACT))

    assert result["review_whole"] is True
    assert {row["mode"] for row in result["rows"]} == {"review"}
    assert ("case", "review") in {(row["kind"], row["mode"]) for row in result["rows"]}


def test_one_substantial_title_in_ten_stays_below_the_guard():
    local = [f"Song {number}" for number in range(1, 10)] + ["Old Name"]
    remote = [f"Song {number}" for number in range(1, 10)] + ["Completely Different"]

    result = compare_album(_album(local, remote, pairing=ORDER_EXACT))

    assert result["review_whole"] is False
    assert [(row["kind"], row["mode"]) for row in result["rows"]] == [("track_title", "review")]


def test_an_ambiguous_pairing_compares_no_tracks_and_goes_to_review_whole():
    result = compare_album(_album(["a"], ["A"], title="album", pairing={"match_quality": "ambiguous", "pairing": {}}))

    assert result["review_whole"] is True
    assert [(row["field"], row["mode"]) for row in result["rows"]] == [("album", "review")]


def test_a_reordered_album_pairs_tracks_by_the_stored_pairing_not_by_position():
    pairing = {"match_quality": "reordered", "pairing": {(1, 1): (1, 2), (1, 2): (1, 1)}}

    result = compare_album(_album(["second song", "First Song"], ["First Song", "Second Song"], pairing=pairing))

    assert [(row["track_number"], row["current_value"], row["proposed_value"]) for row in result["rows"]] == [
        (1, "second song", "Second Song")]


def test_without_a_stored_pairing_tracks_pair_by_position_only_where_titles_agree():
    result = compare_album(_album(["carry on", "The Mirror"], ["Carry On", "Only for the Night"], pairing=None))

    assert [(row["track_number"], row["kind"]) for row in result["rows"]] == [(1, "case")]


# Classical albums (owner 2026-11-17, batch 2 case 7): "Composer first if Music Brainz shows
# composer first", with the same review rules as any album; no special composer handling.
DVORAK_CREDIT = [{"name": "Antonín Dvořák", "join_phrase": "; "}, {"name": "Inna Poroshina"}]


def _classical(local_artist):
    return {"title": "Piano Works", "artist_name": local_artist, "release_title": "Piano Works",
            "release_credit": "Antonín Dvořák; Inna Poroshina", "pairing": ORDER_EXACT,
            "media": [{"position": 1, "tracks": [{"position": 1, "title": "Humoresque",
                                                  "artist_credit": DVORAK_CREDIT}]}],
            "tracks": [{"disc_number": 1, "track_number": 1, "title": "Humoresque", "artist": local_artist}]}


@pytest.mark.parametrize("local_artist", ["Inna Poroshina", "Inna Poroshina; Antonín Dvořák"])
def test_a_composer_first_credit_is_proposed_as_musicbrainz_orders_it_and_waits_for_the_owner(local_artist):
    rows = compare_album(_classical(local_artist))["rows"]
    assert {(row["field"], row["proposed_value"], row["kind"], row["mode"]) for row in rows} == {
        ("album_artist", "Antonín Dvořák; Inna Poroshina", "album_artist_joined", "review"),
        ("artist", "Antonín Dvořák; Inna Poroshina", "track_artist_joined", "review"),
    }


def test_a_classical_album_already_credited_as_musicbrainz_does_has_no_correction():
    assert compare_album(_classical("Antonín Dvořák; Inna Poroshina"))["rows"] == []
