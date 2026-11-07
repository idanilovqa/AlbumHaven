"""Artist identity on album evidence: name keys only retrieve candidates."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from music_app.services.musicbrainz_evidence import (
    album_level,
    album_signals,
    candidate_name_keys,
    decide,
    name_keys,
    title_agreement,
    title_keys,
)
from music_app.services.musicbrainz_matching import native_name

CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz" / "artist-search-cases.json")
    .read_text(encoding="utf-8")
)
TRACKS = [{"title": "Opening", "duration_seconds": 200}, {"title": "Closing", "duration_seconds": 300}]
REMOTE_TRACKS = [{"title": "Opening", "length": 200000}, {"title": "Closing", "length": 300000}]


def _evidence(local_name, local_titles, candidate):
    """A candidate scored like the resolver does, with matching years and tracks."""
    albums = []
    for title in local_titles:
        agreement = next((title_agreement(title, remote, (local_name,))
                          for remote in candidate.get("release_titles") or []
                          if title_agreement(title, remote, (local_name,))), None)
        local = {"title": title, "year": 2000, "tracks": TRACKS}
        signals = album_signals(local, {"first_release_date": "2000", "tracks": REMOTE_TRACKS}) if agreement else set()
        albums.append({"title": agreement, "signals": signals, "level": album_level(agreement, signals)})
    return {**candidate, "albums": albums,
            "name_agrees": bool(candidate_name_keys(candidate) & name_keys(local_name)), "credit_agrees": False}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["case"])
def test_approved_artist_matching_matrix(case):
    local = case["local_evidence"]
    titles = [credit["title"] for credit in local.get("release_credits") or []]

    result = decide([_evidence(local["name"], titles, candidate) for candidate in case["candidates"]])

    assert result["classification"] == case["expected_classification"]
    assert (result.get("selected") or {}).get("mbid") == case.get("expected_mbid")


def _candidate(mbid, levels, *, name=True, credit=False, score=100):
    return {"mbid": mbid, "score": score, "name_agrees": name, "credit_agrees": credit,
            "albums": [{"level": level, "signals": set()} for level in levels]}


def test_a_strong_single_album_wins_when_the_runner_up_has_no_agreeing_album():
    # Dragonfly and Walrus: one local album; other same-name bands share at most its title.
    result = decide([_candidate("spanish", ["strong"]), _candidate("swiss", ["title"]), _candidate("us", [None])])

    assert result["classification"] == "matched"
    assert result["selected"]["mbid"] == "spanish"


def test_a_runner_up_with_agreeing_albums_loses_only_to_twice_the_score_and_two_more_albums():
    # Alice Cooper: the singer agrees on 20 albums, the 1964-74 band on 7.
    singer = _candidate("singer", ["strong"] * 3 + ["agree"] * 17)
    band = _candidate("band", ["strong"] * 2 + ["agree"] * 5)

    result = decide([band, singer])

    assert result["classification"] == "matched"
    assert result["selected"]["mbid"] == "singer"


@pytest.mark.parametrize(("winner", "runner"), [
    (["strong", "agree"], ["agree"]),                                # twice the score, one more album
    (["strong", "strong", "agree"], ["strong", "agree", "agree"]),   # neither twice nor two more
])
def test_an_undecided_margin_stays_multiple_matches(winner, runner):
    result = decide([_candidate("first", winner), _candidate("second", runner)])

    assert result["classification"] == "ambiguous"
    assert {candidate["mbid"] for candidate in result["candidates"]} == {"first", "second"}


def test_the_winner_needs_a_strong_album():
    result = decide([_candidate("only", ["agree", "agree"])])

    assert result["classification"] == "unconfirmed"


@pytest.mark.parametrize("levels", [[], ["title"], [None, None]], ids=["no-albums", "title-only", "other-albums"])
def test_no_candidate_is_accepted_without_album_agreement(levels):
    result = decide([_candidate("named", levels)])

    assert result["classification"] == "unconfirmed"
    assert "selected" not in result


def test_name_only_candidates_stay_multiple_matches():
    result = decide([_candidate("one", []), _candidate("two", [])])

    assert result["classification"] == "ambiguous"


def test_a_release_credited_under_the_local_name_needs_its_credit_and_tracks():
    # 3 Crows: no artist has the name; the release is credited "3 Crows" on Chris Buck.
    credited = _candidate("chris-buck", ["strong"], name=False, credit=True)
    assert decide([credited])["classification"] == "matched"

    elsewhere = _candidate("erik-mongrain", ["strong"], name=False, credit=False)
    result = decide([elsewhere])
    assert result["classification"] == "unconfirmed", "albums alone never accept another name"
    assert [candidate["mbid"] for candidate in result["candidates"]] == ["erik-mongrain"]


@pytest.mark.parametrize(("local", "remote", "expected"), [
    ("O3 A Trillogy - Part 1", "O₃: A Trilogy, Part 1", "fuzzy"),
    ("O3 a Trilogy Part 2", "O₃: A Trilogy, Part 2", "exact"),
    ("[REDACTED]", "[REDACTED]", "exact"),
    ("Génesis", "Genesis", "exact"),
    ("Agamemnon Part I & II", "Part I & II", "exact"),
    ("Mothermania", "Mothermania: The Best of The Mothers", "exact"),
    ("Abbey Road (Remastered 2009)", "Abbey Road", "exact"),
    ("Morso", "Μόρσο", "exact"),
    ("Tusk", "Tusks", None),
    ("Kingdom of the Night", "Kingdom of the Knight", "fuzzy"),
])
def test_album_titles_agree_across_spelling_scripts_and_band_name_prefixes(local, remote, expected):
    assert title_agreement(local, remote, ("Agamemnon",)) == expected


def test_a_near_title_needs_a_second_signal_and_a_bare_title_is_never_strong():
    assert album_level("fuzzy", set()) is None
    assert album_level("fuzzy", {"year"}) == "agree"
    assert album_level("exact", set()) == "title"
    assert album_level("exact", {"year"}) == "agree"
    assert album_level("exact", {"year", "durations"}) == "strong"
    assert "redacted" in title_keys("[REDACTED]")


def test_album_signals_compare_year_track_count_titles_and_durations():
    local = {"year": 2019, "tracks": [{"title": "It's A Murder", "duration_seconds": 200},
                                      {"title": "Raven's Way", "duration_seconds": 322}]}
    remote = {"first_release_date": "2019-03-01",
              "tracks": [{"title": "It's a Murder", "length": 201500}, {"title": "Raven's Way", "length": 324000}]}

    assert album_signals(local, remote) == {"year", "track_count", "track_list", "durations"}
    assert album_signals(local, {"first_release_date": "2015", "tracks": []}) == set()


@pytest.mark.parametrize(("local", "remote"), [
    ("The Blue Öyster Cult", "Blue Öyster Cult"),
    ("A Helmet Of Gnats", "Helmet of Gnats"),
    ("The Dial.", "Dial"),
    ("Punky Bruster", "Punky Brüster"),
    ("Zabranjeno Pusenje", "Zabranjeno pušenje"),
    ("Cønstantine", "Constantine"),
    ("ЯRuGa", "YARuGA"),
    ("A & Z", "A-Z"),
    ("10cc / 10cc", "10cc"),
    ("Dimitris Mystakidis", "Mystakidis, Dimitris"),
    ("Mothers of Invention", "Mothers of Invention, The"),
])
def test_name_keys_fold_articles_accents_scripts_separators_and_sort_names(local, remote):
    assert name_keys(local) & name_keys(remote)


@pytest.mark.parametrize(("local", "remote"), [
    ("Anderson/Wakeman", "Rick Wakeman"),
    ("Blind Guardian", "Blind Guardians"),
    ("Eric Mongrain", "Erik Mongrain"),
    ("Birgir", "Birgir Steinn Stefansson"),
])
def test_name_keys_never_join_different_names(local, remote):
    assert not name_keys(local) & name_keys(remote)


def test_native_script_name_requires_matching_locale_evidence():
    candidate = {
        "canonical_name": "Kipelov",
        "aliases": [{"name": "Кипелов", "locale": "ru", "primary": True},
                    {"name": "Кіпєлов", "locale": "uk", "primary": True}],
    }
    local = {"name": "Kipelov", "locale": "ru", "release_credits": [{"title": "Реки времён", "credited_artist": "Кипелов"}]}

    assert native_name(local, candidate) == "Кипелов"
    assert native_name({**local, "locale": None}, candidate) is None
    assert native_name(local, {"canonical_name": "Kipelov", "aliases": []}) is None
