"""Search recall for album artists whose names differ from MusicBrainz only in
punctuation or spacing. Search responses mirror what the local mirror returned
for these names during the Delivery 1 backfill."""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest

from music_app.services.musicbrainz_client import MusicBrainzClient, name_match_key
from music_app.services.musicbrainz_enrichment import resolve_artist
from tests.py.musicbrainz_test_mirror import OK, release_groups_payload, release_paths
from tests.py.musicbrainz_test_mirror import albums as local_albums

OCEANS = "00000000-0000-4000-8000-000000000101"
ME_AND_OCEANS = "00000000-0000-4000-8000-000000000102"
ABIGAIL = "00000000-0000-4000-8000-000000000103"
ALEX_G = "00000000-0000-4000-8000-000000000104"
WILLIAMS = "00000000-0000-4000-8000-000000000105"
WAKEMAN = "00000000-0000-4000-8000-000000000106"
ABWH = "00000000-0000-4000-8000-000000000107"
MENKEN = "00000000-0000-4000-8000-000000000108"
AZ = "00000000-0000-4000-8000-000000000109"
ARK_ONE = "00000000-0000-4000-8000-000000000110"
ARK_TWO = "00000000-0000-4000-8000-000000000111"

ARTISTS = {
    OCEANS: {"id": OCEANS, "name": "…and Oceans", "sort-name": "And Oceans",
             "aliases": [{"name": "... And Oceans", "sort-name": "... And Oceans"}]},
    ME_AND_OCEANS: {"id": ME_AND_OCEANS, "name": "Me and Oceans",
                    "aliases": [{"name": "Me & Oceans"}]},
    ABIGAIL: {"id": ABIGAIL, "name": "Abigail’s Ghost", "sort-name": "Abigail’s Ghost"},
    ALEX_G: {"id": ALEX_G, "name": "Alex G", "sort-name": "G, Alex",
             "aliases": [{"name": "Sandy"}, {"name": "(Sandy) Alex G"}]},
    WILLIAMS: {"id": WILLIAMS, "name": "A.A. Williams", "sort-name": "Williams, A.A.",
               "aliases": [{"name": "A. A. Williams"}]},
    WAKEMAN: {"id": WAKEMAN, "name": "Rick Wakeman", "sort-name": "Wakeman, Rick"},
    ABWH: {"id": ABWH, "name": "Anderson Bruford Wakeman Howe",
           "aliases": [{"name": "ABWH"}]},
    MENKEN: {"id": MENKEN, "name": "Alan Menken", "sort-name": "Menken, Alan"},
    AZ: {"id": AZ, "name": "AZ", "sort-name": "AZ"},
    ARK_ONE: {"id": ARK_ONE, "name": "Ark", "disambiguation": "Norwegian band"},
    ARK_TWO: {"id": ARK_TWO, "name": "Ark", "disambiguation": "Swedish band"},
}
RELEASE_GROUPS = {
    OCEANS: ["The Dynamic Gallery of Thoughts", "A.M.G.O.D."],
    ABIGAIL: ["Selling Insincerity"],
    ALEX_G: ["Trick", "DSU"],
    WILLIAMS: ["Forever Blue"],
}
# Phrase (artist:"...") and plain queries return different results on the mirror.
PHRASE = {
    "...And Oceans": [OCEANS, ME_AND_OCEANS],
    "Abigail's Ghost": [ABIGAIL],
    "(Sandy) Alex G": [],
    "A.A.Williams": [],
    "Anderson/Wakeman": [],
    "Alan Menken & Howard Ashman": [],
    "A & Z": [],
    "Ark": [ARK_ONE, ARK_TWO],
}
PLAIN = {
    r"\(Sandy\) Alex G": [ALEX_G],
    "A.A.Williams": [WILLIAMS],
    r"Anderson\/Wakeman": [WAKEMAN, ABWH],
    "Alan Menken & Howard Ashman": [MENKEN],
    "A & Z": [AZ],
}


def _client():
    calls: list[str] = []

    def get_json(url, _user_agent, **_kwargs):
        calls.append(url)
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        if parsed.path.endswith("/artist/"):
            text = query["query"][0]
            if text.startswith('artist:"') and text.endswith('"'):
                found = PHRASE.get(text[len('artist:"'):-1], [])
            else:
                found = PLAIN.get(text, [])
            artists = [{**ARTISTS[mbid], "score": 100} for mbid in found]
            return {"count": len(artists), "artists": artists}, OK
        if parsed.path.endswith("/release-group"):
            artist = query["artist"][0]
            return release_groups_payload(artist, RELEASE_GROUPS.get(artist, [])), OK
        answered = release_paths(url)
        if answered is not None:
            return answered
        return ARTISTS[parsed.path.rsplit("/", 1)[-1]], OK

    return MusicBrainzClient(base_url="https://mirror.test/ws/2/", user_agent="Test", get_json=get_json), calls


def _resolve(name, *album_titles):
    client, calls = _client()
    outcome = resolve_artist(
        {"local_artist_id": 7, "local_name": name, "albums": local_albums(*album_titles)},
        client=client,
    )
    return outcome, calls


@pytest.mark.parametrize(
    ("name", "albums", "expected"),
    [
        ("...And Oceans", ["The Dynamic Gallery of Thoughts"], OCEANS),
        ("Abigail's Ghost", ["Selling Insincerity"], ABIGAIL),
        ("(Sandy) Alex G", ["Trick"], ALEX_G),
        ("A.A.Williams", ["Forever Blue"], WILLIAMS),
    ],
)
def test_punctuation_and_spacing_variants_match_with_album_agreement(name, albums, expected):
    outcome, _calls = _resolve(name, *albums)

    assert outcome["classification"] == "found"
    assert outcome["artist"]["mbid"] == expected


def test_plain_fallback_runs_only_when_the_phrase_search_has_no_name_match():
    _outcome, calls = _resolve("...And Oceans", "The Dynamic Gallery of Thoughts")
    assert len([url for url in calls if "/artist/?" in url]) == 1

    _outcome, calls = _resolve("(Sandy) Alex G", "Trick")
    searches = [parse_qs(urlparse(url).query)["query"][0] for url in calls if "/artist/?" in url]
    assert searches == ['artist:"(Sandy) Alex G"', r"\(Sandy\) Alex G"]


@pytest.mark.parametrize("name", ["Anderson/Wakeman", "Alan Menken & Howard Ashman"])
def test_collaboration_credits_stay_not_found(name):
    outcome, calls = _resolve(name, "Anything")

    assert outcome["classification"] == "not_found"
    assert outcome["evidence_summary"] == "No MusicBrainz artist has this name or one of your albums."
    assert not [url for url in calls if "/release-group" in url], "members are never looked up"


def test_a_separator_variant_is_only_a_candidate_until_the_albums_agree():
    # "A & Z" and "A-Z" are one name to compare ("A-Z" is the owner's band), so
    # the rapper "AZ" is retrieved too; without album evidence it is never accepted.
    outcome, _calls = _resolve("A & Z", "Anything")

    assert outcome["classification"] == "unconfirmed"
    assert [candidate["artist_mbid"] for candidate in outcome["candidates"]] == [AZ]


def test_a_single_name_match_without_album_agreement_is_unconfirmed_not_matched():
    outcome, _calls = _resolve("A.A.Williams", "An Album MusicBrainz Does Not List")

    assert outcome["classification"] == "unconfirmed"
    assert [candidate["artist_mbid"] for candidate in outcome["candidates"]] == [WILLIAMS]
    assert outcome["candidates"][0]["evidence_summary"] == "0 of 1 album agree"


def test_several_name_matches_without_album_agreement_stay_multiple_matches():
    outcome, _calls = _resolve("Ark", "Unlisted Album")

    assert outcome["classification"] == "ambiguous"
    assert {candidate["artist_mbid"] for candidate in outcome["candidates"]} == {ARK_ONE, ARK_TWO}


@pytest.mark.parametrize(
    ("left", "right", "same"),
    [
        ("...And Oceans", "…and Oceans", True),
        ("Abigail's Ghost", "Abigail’s Ghost", True),
        ("A.A.Williams", "A.A. Williams", True),
        ("Me & Oceans", "Me and Oceans", True),
        ("A & Z", "AZ", False),
        ("Anderson/Wakeman", "Rick Wakeman", False),
        ("!!!", "!!!", True),
        ("!!!", "???", False),
    ],
)
def test_name_match_key_ignores_only_case_punctuation_and_spacing(left, right, same):
    assert (name_match_key(left) == name_match_key(right)) is same
