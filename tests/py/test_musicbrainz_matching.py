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
    name_relation,
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


FULL = {"year", "track_count", "track_list", "durations"}


def _candidate(mbid, levels, *, name=True, credit=False, score=100, signals=(), canonical=None, sibling=False):
    return {"mbid": mbid, "score": score, "name_agrees": name, "credit_agrees": credit, "sibling": sibling,
            "canonical_name": canonical or mbid,
            "albums": [{"level": level, "signals": set(signals)} for level in levels]}


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
    (["strong", "agree", None], [None, None, "agree"]),                  # twice the score, one more album
    (["strong", "strong", None, None], [None, None, "strong", "strong"]),  # same-name bands, albums split
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
    result = decide([elsewhere], "Fleetwood")
    assert result["classification"] == "unconfirmed", "one album under an unrelated name is offered, not accepted"
    assert [candidate["mbid"] for candidate in result["candidates"]] == ["erik-mongrain"]


def test_an_album_two_candidates_agree_on_goes_to_the_stronger_evidence():
    # Etherna, Ibis, Odyssey: one band holds both albums, a namesake shares one title only.
    full = _candidate("full", ["strong", "strong"], signals=FULL)
    subset = _candidate("subset", [None, "agree"], signals={"year"})

    result = decide([subset, full], "Etherna")

    assert result["classification"] == "matched"
    assert result["selected"]["mbid"] == "full"


def test_equal_evidence_on_the_same_album_proves_neither_and_tracks_break_the_tie():
    tied = decide([_candidate("first", ["strong"], signals={"year", "track_count"}),
                   _candidate("second", ["strong"], signals={"year", "track_count"})], "Oasis")
    assert tied["classification"] == "ambiguous"

    broken = decide([_candidate("first", ["strong"], signals=FULL),
                     _candidate("second", ["strong"], signals={"year", "track_count"})], "Oasis")
    assert broken["classification"] == "matched"
    assert broken["selected"]["mbid"] == "first"


def test_albums_decide_another_name_on_two_strong_albums_or_one_confirmed_album_of_a_related_name():
    # PFM: two strong albums under "Premiata Forneria Marconi".
    two = decide([_candidate("pfm", ["strong", "strong"], name=False, canonical="Premiata Forneria Marconi")], "PFM")
    assert two["classification"] == "matched"

    # Eric Mongrain's one album, tracks confirmed, under "Erik Mongrain".
    spelling = decide([_candidate("erik", ["strong"], name=False, signals=FULL, canonical="Erik Mongrain")],
                      "Eric Mongrain")
    assert spelling["classification"] == "matched"

    unconfirmed_tracks = decide([_candidate("erik", ["strong"], name=False, signals={"year", "track_count"},
                                            canonical="Erik Mongrain")], "Eric Mongrain")
    assert unconfirmed_tracks["classification"] == "unconfirmed"


def test_alan_parsons_project_goes_to_the_artist_its_album_belongs_to():
    """Owner: albums decide which of The Alan Parsons Project and Alan Parsons a tag is."""
    solo = _candidate("alan-parsons", ["strong"], name=False, signals=FULL, canonical="Alan Parsons")
    project = _candidate("the-alan-parsons-project", [None], canonical="The Alan Parsons Project")

    result = decide([project, solo], "Alan Parsons Project")

    assert result["classification"] == "matched"
    assert result["selected"]["mbid"] == "alan-parsons"


def test_a_collaboration_is_never_given_to_one_of_its_artists():
    member = _candidate("menken", ["strong", "strong"], name=False, signals=FULL, canonical="Alan Menken")

    result = decide([member], "Alan Menken & Howard Ashman")

    assert result["classification"] == "unconfirmed"


def test_an_album_credited_to_several_artists_never_goes_to_one_of_them_under_another_name():
    # "John Petrucci & Jordan Rudess": MusicBrainz credits Petrucci and Rudess jointly.
    member = _candidate("petrucci", ["strong", "strong"], name=False, signals=FULL, canonical="John Petrucci")
    member["joint_credit"] = True
    assert decide([member], "Petrucci Rudess Duets")["classification"] == "unconfirmed"

    # Alan Menken and Howard Ashman agree equally on "The Little Mermaid": the album
    # counts for neither, yet both stay offered for confirmation, never "not found".
    menken, ashman = (_candidate(mbid, ["strong"], name=False, signals=FULL) for mbid in ("menken", "ashman"))
    menken["joint_credit"] = ashman["joint_credit"] = True
    joint = decide([menken, ashman], "Alan Menken & Howard Ashman")
    assert joint["classification"] == "unconfirmed"
    assert {candidate["mbid"] for candidate in joint["candidates"]} == {"menken", "ashman"}

    # AC/DC is one MusicBrainz artist: its separator never makes it a collaboration.
    band = _candidate("acdc", ["strong"], canonical="AC/DC")
    assert decide([band], "AC/DC")["classification"] == "matched"


def test_a_matched_sibling_needs_only_its_album_evidence():
    # "Devin Townsend Project" beside the matched "The Devin Townsend Project".
    sibling = _candidate("dtp", ["strong", "strong", "strong"], name=False, sibling=True, canonical="Devin Townsend")

    assert decide([sibling], "Devin Townsend Project")["classification"] == "matched"


def test_a_single_matched_sibling_is_accepted_when_no_album_points_elsewhere():
    # "Chick_Corea" beside the matched "Chick Corea", its albums not on MusicBrainz.
    sibling = _candidate("corea", [None], sibling=True, canonical="Chick Corea")
    assert decide([sibling], "Chick_Corea")["classification"] == "matched"

    elsewhere = _candidate("other", ["strong"], name=False, canonical="Somebody Else")
    result = decide([sibling, elsewhere], "Chick_Corea")
    assert (result.get("selected") or {}).get("mbid") != "corea", "an album pointing elsewhere outweighs the sibling"


def test_special_purpose_artists_are_never_a_match():
    various = _candidate("89ad4ac3-39f7-470e-963a-56509c546377", ["strong", "strong"], signals=FULL)

    assert decide([various], "Various")["classification"] == "not_found"


@pytest.mark.parametrize(("local", "candidate", "expected"), [
    ("Alan Parsons Project", "Alan Parsons", "contains"),
    ("Калугин Сергей", "Сергей Калугин", "spelling"),
    ("Aldo Taliapietra", "Aldo Tagliapietra", "spelling"),
    ("Alan Menken & Howard Ashman", "Alan Menken", "collaboration"),
    ("Наталья Маркова и группа Двуречье", "Наталья Маркова и Двуречье", "spelling"),
    ("Hiromi", "上原ひろみ", "different"),
    ("The Devin Townsend Project", "Devin Townsend Project", "same"),
])
def test_name_relation(local, candidate, expected):
    assert name_relation(local, {"canonical_name": candidate}) == expected


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


def test_only_trailing_edition_words_are_dropped_from_a_title():
    assert "once" in title_keys("Once Deluxe Edition")
    assert "abbey road" in title_keys("Abbey Road (Remastered 2009)")
    assert "forces" not in title_keys("Special Forces"), "a title that starts with an edition word keeps it"
    assert title_agreement("Special Forces", "Forces") is None


# Owner decision 2026-11-08: an album that certainly matches one MusicBrainz artist (title,
# track titles and track count agree) takes that artist, whatever the artist's other albums
# show; there is no majority or margin rule.
CERTAIN = {"year", "track_count", "track_list"}


def test_albums_that_certainly_match_two_artists_split_the_local_artist_per_album():
    # Amarok: four albums are the Polish band's, three the Spanish band's.
    poland = _candidate("poland", ["strong"] * 4 + [None] * 3, signals=CERTAIN)
    spain = _candidate("spain", [None] * 4 + ["strong"] * 3, signals=CERTAIN)

    result = decide([poland, spain], "Amarok")

    assert result["classification"] == "per_album"
    assert {index: owner["mbid"] for index, owner in result["certain"].items()} == {
        0: "poland", 1: "poland", 2: "poland", 3: "poland", 4: "spain", 5: "spain", 6: "spain"}


def test_certain_albums_of_one_artist_match_it_under_any_name_without_a_margin():
    # Jay-Z's "The Grey Album" is Danger Mouse's; one album is enough.
    danger_mouse = _candidate("danger-mouse", ["strong"], name=False, signals=CERTAIN, canonical="Danger Mouse")

    result = decide([danger_mouse], "Jay-Z")

    assert result["classification"] == "matched"
    assert result["selected"]["mbid"] == "danger-mouse"


def test_an_album_two_artists_certainly_match_and_weak_evidence_decide_nothing():
    first, second = (_candidate(mbid, ["strong"], signals=CERTAIN) for mbid in ("first", "second"))
    assert decide([first, second], "Oasis")["certain"] == {}

    # Track count and lengths without the track titles are not certain (Diatom, Hiroyuki Nanba).
    loose = _candidate("loose", ["strong"], name=False, signals={"track_count", "durations"}, canonical="Mike Nigro")
    assert decide([loose], "Diatom")["classification"] == "unconfirmed"


def test_a_collaboration_is_never_split_or_given_to_one_member_by_certain_albums():
    menken = _candidate("menken", ["strong"], name=False, signals=CERTAIN, canonical="Alan Menken")

    assert decide([menken], "Alan Menken & Glenn Slater")["classification"] == "unconfirmed"


# Owner review 4 (2026-11-09): titles under other forms, with the tracklist bar.
@pytest.mark.parametrize(("local", "remote", "expected"), [
    ("The Seim A New", "The Seim Anew", "exact"),                    # spacing only
    ("Jinsei Game (人生ゲイム)", "人生ゲイム", "exact"),                # the bracketed original
    ("22 strings", "22 Strings/Cordes", "exact"),                     # one side of a bilingual title
    ("Up to 30", "Up to Thirty", "exact"),                            # a number in words
    ("RTJ3", "Run the Jewels 3", "exact"),                            # the band's initials
    ("Toy Manitee", "Toy Matinee", "typo"),                           # two letters swapped
    ("Exodus: Slaves for Life", "Slaves for Life", "partial"),   # a subtitle is only part of a title
    ("Up to 30 + 3 + Infinity", "30+3+Infinity", "partial"),
    ("Tusk", "Tusks", None),
    ("Abbey Road", "Abbey Lane", None),
])
def test_owner_review_4_title_forms(local, remote, expected):
    names = ("Run the Jewels", "Amaseffer")
    assert title_agreement(local, remote, names) == expected


def test_a_typo_or_partial_title_counts_only_with_a_matching_tracklist():
    for title in ("typo", "partial"):
        assert album_level(title, {"year", "track_count"}) is None
        assert album_level(title, {"track_list", "track_count"}) == "strong"


def test_mojibake_tags_compare_with_their_repaired_text():
    assert name_keys("Korai Цrцm") & name_keys("Korai Öröm")
    assert name_keys("BjÃ¶rk") & name_keys("Björk")
    assert not name_keys("Кино") & name_keys("Kino Öröm")


def test_equal_track_counts_compare_lengths_track_by_track():
    # Diatom: a 7:40 first track against a 3:00 one is not a length match, whatever the total.
    local = {"tracks": [{"title": "A", "duration_seconds": 180}, {"title": "B", "duration_seconds": 460}]}
    remote = {"tracks": [{"title": "X", "length": 460000}, {"title": "Y", "length": 180000}]}
    assert "durations" not in album_signals(local, remote)


def test_differing_titles_and_lengths_are_never_strong():
    # Dramatic View: the year and the count agree, the fetched titles and lengths do not.
    local = {"year": 2015, "tracks": [{"title": "A", "duration_seconds": 100}, {"title": "B", "duration_seconds": 200}]}
    remote = {"first_release_date": "2015", "tracks": [{"title": "C", "length": 300000}, {"title": "D", "length": 50000}]}
    signals = album_signals(local, remote)
    assert signals == {"year", "track_count", "tracks_differ"}
    assert album_level("exact", signals) == "agree"


def test_missing_musicbrainz_lengths_are_unknown_not_a_mismatch():
    local = {"tracks": [{"title": "A", "duration_seconds": 100}, {"title": "B", "duration_seconds": 200}]}
    remote = {"tracks": [{"title": "A", "length": 0}, {"title": "B", "length": 0}]}
    assert album_signals(local, remote) == {"track_count", "track_list", "lengths_unknown"}


def test_a_shorter_musicbrainz_tracklist_inside_the_local_one_agrees():
    # Karma: MusicBrainz lists the cassette's 4 tracks; the local edition adds 3.
    local = {"tracks": [{"title": t, "duration_seconds": s} for t, s in
                        (("Intruder D'or", 237), ("Tigers In The Rain", 468), ("Small Fish", 291),
                         ("Nine Cats", 873), ("Five", 500), ("Six", 600), ("Seven", 700))]}
    remote = {"tracks": [{"title": t, "length": s * 1000} for t, s in
                         (("Intruder d’or", 237), ("Tigers in the Rain", 468), ("Small Fish", 291), ("Nine Cats", 873))]}
    assert {"track_list", "durations"} <= album_signals(local, remote)


def test_a_one_word_bracket_or_slash_part_is_never_a_title_of_its_own():
    assert title_agreement("Foo (Live)", "Live") is None
    assert title_agreement("Abbey Road (Remastered 2009)", "Remastered") is None
    assert title_agreement("Mysterious Realms / Heidebilder", "Heidebilder") is None
    assert title_agreement("22 strings", "22 Strings/Cordes") == "exact"
