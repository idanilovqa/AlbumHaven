"""MusicBrainz series (Delivery 2, S6): one test per rule, each with its negative case,
replayed from answers recorded once from the local mirror
(``delivery-2-series-mirror.json``). The owner's example is the Colossus Projects series."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from urllib.parse import urlparse

from music_app.services.musicbrainz_client import MusicBrainzClient
from tests.py.musicbrainz_test_mirror import OK

_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                       / "delivery-2-series-mirror.json").read_text(encoding="utf-8"))
CASES = _FIXTURE["cases"]
COLOSSUS = "520f6fcd-251d-46cd-83a9-0bc725d42333"


def _replay_client():
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        assert key in _FIXTURE["responses"], f"unrecorded mirror request {key}"
        return _FIXTURE["responses"][key], OK

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


def test_a_release_group_part_of_a_series_names_it_with_its_number():
    group = _replay_client().lookup_release_group(CASES["release_group_in_series"])["release_group"]
    assert group["series"] == [{"mbid": COLOSSUS, "name": "Colossus Projects", "type": "Release group series",
                                "disambiguation": None, "number": "18", "ordering_key": 18}]


def test_a_release_group_in_no_series_has_none():
    group = _replay_client().lookup_release_group(CASES["release_group_without_series"])["release_group"]
    assert group["series"] == []


def test_a_release_part_of_a_release_series_names_it_without_an_invented_number():
    release = _replay_client().lookup_release_tracklist(CASES["release_in_series"])["release"]
    [series] = release["series"]
    assert (series["name"], series["type"], series["number"]) == ("COLEZO! TWIN", "Release series", None)


def test_a_release_in_no_series_has_none():
    release = _replay_client().lookup_release_tracklist(CASES["release_without_series"])["release"]
    assert release["series"] == []


def _with_relation(**changes):
    payload = json.loads(json.dumps(_FIXTURE["responses"][
        f"/release-group/{CASES['release_group_in_series']}?inc=genres+series-rels&fmt=json"]))
    payload["relations"][0].update(changes)

    def get_json(_url, _agent, **_kwargs):
        return payload, OK

    client = MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)
    return client.lookup_release_group(CASES["release_group_in_series"])["release_group"]["series"]


def test_only_a_forward_part_of_relation_to_a_series_counts():
    assert [part["mbid"] for part in _with_relation()] == [COLOSSUS]
    # The series' own view of the link, another relation type or another target is no series.
    assert _with_relation(direction="backward") == []
    assert _with_relation(type="named after") == []
    assert _with_relation(**{"target-type": "url"}) == []


# Series or Featured In (owner 2026-11-15): a series' size on MusicBrainz -------------------

def test_a_real_series_counts_its_release_groups():
    series = _replay_client().lookup_series(CASES["real_series"])["series"]
    assert (series["name"], series["type"], series["member_count"]) == (
        "Colossus Projects", "Release group series", 22)


def test_a_list_counts_every_album_it_names():
    series = _replay_client().lookup_series(CASES["list_series"])["series"]
    assert (series["name"], series["member_count"]) == ("Rolling Stone: The 100 Greatest Metal Albums of All Time", 100)


# The list-like name backstop in migration 0193 (owner 2026-11-15), read from the migration
# itself so there is one source; PostgreSQL's word bounds \\m and \\M are Python's \\b.

def _list_name_pattern():
    sql = (Path(__file__).resolve().parents[2] / "migrations" / "postgres"
           / "0193_create_musicbrainz_series.sql").read_text(encoding="utf-8")
    pattern = re.search(r"when name ~\* '(.+?)' then 'featured_in'", sql).group(1).replace("''", "'")
    return re.compile(pattern.replace("\\m", "\\b").replace("\\M", "\\b"), re.IGNORECASE)


@pytest.mark.parametrize("name", [
    "1001 Albums You Must Hear Before You Die", "Rolling Stone: 500 Greatest Albums", "Pitchfork: Best New Album",
    "Justin Stranzl: Best of 1999", "Dave Marsh: Top 40 Albums of 1964", "Essential Jazz", "Juno Award winners",
    "Rock and Roll Hall of Fame", "Billboard 200: 2022-02-12", "UK Albums Chart", "Official Charts: 1985",
    "The Wire: 2005 Rewind", "Year-End Albums 2019", "Year End Top Albums", "Album of the Year",
    "Readers' Poll 2010", "Readers\u2019 Poll", "Village Voice Critics", "Critic's Choice"])
def test_a_list_or_chart_name_is_featured_in(name):
    assert _list_name_pattern().search(name)


@pytest.mark.parametrize("name", [
    "Best of Bowie", "Colossus Projects", "Chartreuse Sessions", "The Rewinder Tapes", "Topographic Oceans",
    "The Bestiary Saga", "King Crimson Collectors' Club", "Billboards and Bricks", "Pixar soundtracks"])
def test_a_band_series_or_a_lookalike_word_is_not(name):
    assert not _list_name_pattern().search(name)
