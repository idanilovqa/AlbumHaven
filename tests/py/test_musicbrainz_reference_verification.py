"""Verifying what was entered in MusicBrainz Info, for one album (approved rows R4, R5, R6)."""
from __future__ import annotations

import pytest

from music_app.services.musicbrainz_reference_verification import verify_musicbrainz_reference

GROUP = "00000000-0000-4000-8000-00000000000a"
MERGED = "00000000-0000-4000-8000-00000000000b"
EDITIONS = [f"00000000-0000-4000-8000-0000000000{n:02d}" for n in range(1, 7)]
CREDIT = [{"name": "Band", "artist_mbid": "00000000-0000-4000-8000-0000000000ff",
           "artist_name": "Band", "join_phrase": ""}]
TITLES = ("Opening", "The Mirror", "Closing")


def _local(*titles):
    return [{"disc_number": 1, "track_number": number, "title": title, "duration_seconds": 100 * number}
            for number, title in enumerate(titles or TITLES, start=1)]


def _release(mbid, titles=TITLES, canonical=None):
    return {"classification": "complete", "release": {
        "id": mbid, "canonical_id": canonical or mbid, "title": "Album", "date": "2004-05-06",
        "release_group_id": GROUP, "artist_credit": CREDIT, "media": [{"position": 1, "tracks": [
            {"position": number, "title": title, "length": 100000 * number}
            for number, title in enumerate(titles, start=1)]}]}}


class _Client:
    def __init__(self, *, group=None, releases=None, editions=None):
        self.group = group or {"classification": "not_found"}
        self.releases = releases or {}
        self.editions = editions or {"classification": "complete", "releases": []}
        self.calls = []

    def lookup_release_group(self, mbid, *, artist_credit=False):
        self.calls.append(("group", mbid))
        assert artist_credit
        return self.group

    def release_group_editions(self, mbid):
        self.calls.append(("editions", mbid))
        return self.editions

    def lookup_release_tracklist(self, mbid):
        self.calls.append(("release", mbid))
        return self.releases.get(mbid, {"classification": "not_found"})


def _group(canonical=GROUP):
    return {"classification": "complete", "release_group": {
        "id": GROUP, "canonical_id": canonical, "title": "Album", "first_release_date": "2003",
        "artist_credit": CREDIT}}


def _editions(*counts):
    return {"classification": "complete", "releases": [
        {"id": mbid, "date": "2004", "track_count": count} for mbid, count in zip(EDITIONS, counts)]}


def test_a_release_pins_the_edition():
    client = _Client(releases={EDITIONS[0]: _release(EDITIONS[0], canonical=MERGED)})

    found = verify_musicbrainz_reference(client, f"https://musicbrainz.org/release/{EDITIONS[0]}", _local())

    assert found == {
        "status": "ok", "entity": "release", "title": "Album", "year": 2004, "artist_credit": CREDIT,
        "release_group_mbid": GROUP, "release_mbid": MERGED, "match_quality": "order_exact",
        "track_pairing": [], "tracklist": {"matches": True, "local": 3, "release": 3}}
    assert client.calls == [("release", EDITIONS[0])]


def test_a_different_tracklist_warns_and_is_still_verified():
    titles = ("One", "Two", "Three", "Four", "Five")
    client = _Client(releases={EDITIONS[0]: _release(EDITIONS[0], titles)})

    found = verify_musicbrainz_reference(client, f"musicbrainz.org/release/{EDITIONS[0]}", _local())

    assert found["status"] == "ok" and found["release_mbid"] == EDITIONS[0]
    assert found["tracklist"] == {"matches": False, "local": 3, "release": 5}
    assert (found["match_quality"], found["track_pairing"]) == ("ambiguous", [])


def test_a_release_group_pins_the_edition_with_the_local_order():
    client = _Client(group=_group(MERGED), editions=_editions(3, 3), releases={
        EDITIONS[0]: _release(EDITIONS[0], TITLES[::-1]), EDITIONS[1]: _release(EDITIONS[1])})

    found = verify_musicbrainz_reference(client, GROUP, _local())

    assert (found["entity"], found["release_group_mbid"], found["release_mbid"]) == (
        "release-group", MERGED, EDITIONS[1])
    assert (found["match_quality"], found["year"], found["artist_credit"]) == ("order_exact", 2003, CREDIT)
    assert found["tracklist"] == {"matches": True, "local": 3, "release": 3}
    assert client.calls[1] == ("editions", MERGED)


def test_without_a_certain_edition_none_is_pinned():
    client = _Client(group=_group(), editions=_editions(3, 9), releases={
        EDITIONS[0]: _release(EDITIONS[0], ("One", "Two", "Three"))})

    found = verify_musicbrainz_reference(client, GROUP, _local())

    assert found["status"] == "ok" and found["release_mbid"] is None and found["match_quality"] is None
    assert found["tracklist"] == {"matches": False, "local": 3, "release": 3}


def test_a_group_without_an_edition_of_that_length_reads_no_tracklist():
    client = _Client(group=_group(), editions=_editions(12, 9))

    found = verify_musicbrainz_reference(client, GROUP, _local())

    assert found["tracklist"] == {"matches": False, "local": 3, "release": 9}
    assert [name for name, _ in client.calls] == ["group", "editions"]


def test_a_group_with_no_editions_has_nothing_to_warn_about():
    found = verify_musicbrainz_reference(_Client(group=_group()), GROUP, _local())

    assert found["status"] == "ok" and found["tracklist"] is None


def test_at_most_three_tracklists_are_read():
    other = ("One", "Two", "Three")
    client = _Client(group=_group(), editions=_editions(*[3] * 6),
                     releases={mbid: _release(mbid, other) for mbid in EDITIONS})

    verify_musicbrainz_reference(client, GROUP, _local())

    assert [name for name, _ in client.calls].count("release") == 3


def test_a_bare_id_is_tried_as_a_group_then_as_a_release():
    client = _Client(releases={EDITIONS[0]: _release(EDITIONS[0])})

    assert verify_musicbrainz_reference(client, EDITIONS[0], _local())["entity"] == "release"
    assert client.calls == [("group", EDITIONS[0]), ("release", EDITIONS[0])]


def test_a_link_is_never_tried_as_the_other_kind():
    client = _Client(releases={GROUP: _release(GROUP)})

    assert verify_musicbrainz_reference(
        client, f"https://musicbrainz.org/release-group/{GROUP}", _local()) == {"status": "not_found"}
    assert client.calls == [("group", GROUP)]


@pytest.mark.parametrize("value,expected", [
    ("a name", {"status": "invalid"}),
    (f"https://musicbrainz.org/artist/{GROUP}", {"status": "wrong_entity", "entity": "artist"}),
])
def test_a_bad_reference_asks_nothing(value, expected):
    client = _Client()

    assert verify_musicbrainz_reference(client, value, _local()) == expected
    assert client.calls == []


def test_nothing_found_is_not_found():
    assert verify_musicbrainz_reference(_Client(), GROUP, _local()) == {"status": "not_found"}


@pytest.mark.parametrize("failure", ["rate_limited", "provider_unavailable", "invalid_response"])
@pytest.mark.parametrize("stage", ["group", "editions", "tracklist"])
def test_a_provider_failure_verifies_nothing(failure, stage):
    failed = {"classification": failure}
    client = _Client(group=failed if stage == "group" else _group(),
                     editions=failed if stage == "editions" else _editions(3),
                     releases={EDITIONS[0]: failed})

    assert verify_musicbrainz_reference(client, GROUP, _local()) == {"status": "unavailable"}


def test_editions_without_tracks_listed_are_nothing_to_compare_with():
    found = verify_musicbrainz_reference(_Client(group=_group(), editions=_editions(0, 0)), GROUP, _local())

    assert found["tracklist"] is None
