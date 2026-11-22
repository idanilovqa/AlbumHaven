"""What MusicBrainz Info accepts in its two inputs (approved S8a, S8c, S8e; rows R4 and R6)."""
from __future__ import annotations

import pytest

from music_app.services.musicbrainz_identity_references import (
    read_discogs_reference,
    read_musicbrainz_reference,
)

MBID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"


@pytest.mark.parametrize("value,entity", [
    (f"https://musicbrainz.org/release-group/{MBID}", "release-group"),
    (f"https://musicbrainz.org/release/{MBID}", "release"),
    (f"https://musicbrainz.org/release/{MBID}/", "release"),
    (f"https://musicbrainz.org/release/{MBID}/discids", "release"),
    (f"  https://musicbrainz.org/release/{MBID}?tab=details#top  ", "release"),
    (f"http://musicbrainz.org/release-group/{MBID}", "release-group"),
    (f"musicbrainz.org/release-group/{MBID}", "release-group"),
    (f"https://beta.musicbrainz.org/release/{MBID.upper()}", "release"),
    (MBID, None),
    (MBID.upper(), None),
])
def test_both_kinds_and_a_bare_id_are_read(value, entity):
    assert read_musicbrainz_reference(value) == {"status": "ok", "entity": entity, "mbid": MBID}


@pytest.mark.parametrize("entity", ["artist", "recording", "work", "label", "series"])
def test_another_kind_of_page_is_named(entity):
    assert read_musicbrainz_reference(f"https://musicbrainz.org/{entity}/{MBID}") == {
        "status": "wrong_entity", "entity": entity}


@pytest.mark.parametrize("value", [
    None, 12, "", "  ", "an-album-title", MBID[:-1], "00000000-0000-0000-0000-000000000000",
    f"https://musicbrainz.org/release/{MBID}x", f"https://musicbrainz.org/{MBID}",
    f"https://example.com/release/{MBID}", f"https://musicbrainz.org.example.com/release/{MBID}",
    f"https://example.com@evil.test/release/{MBID}", f"javascript://musicbrainz.org/release/{MBID}",
    f"{MBID} {MBID}", "https://musicbrainz.org/release/" + "a" * 5000,
])
def test_anything_else_is_invalid(value):
    assert read_musicbrainz_reference(value) == {"status": "invalid"}


@pytest.mark.parametrize("value", [
    "123456", "r123456", "[r123456]", " https://www.discogs.com/release/123456 ",
    "https://www.discogs.com/release/123456-Some-Band-Some-Album",
    "https://www.discogs.com/ru/release/123456-Пример", "discogs.com/release/123456?ev=rr",
])
def test_a_discogs_release_is_read(value):
    assert read_discogs_reference(value) == {"status": "ok", "release_id": 123456}


@pytest.mark.parametrize("value,entity", [
    ("https://www.discogs.com/artist/654321", "artist"),
    ("https://www.discogs.com/master/123-Name", "master"),
    ("https://www.discogs.com/ru/label/55", "label"),
])
def test_another_discogs_page_is_named(value, entity):
    assert read_discogs_reference(value) == {"status": "wrong_entity", "entity": entity}


@pytest.mark.parametrize("value", [
    None, "", "0", "-4", "123456x", "a name", "1" * 13, "https://example.com/release/123456",
    "https://discogs.com.evil.test/release/123456",
])
def test_anything_else_is_no_discogs_release(value):
    assert read_discogs_reference(value) == {"status": "invalid"}
