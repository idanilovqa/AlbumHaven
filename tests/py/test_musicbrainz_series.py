"""MusicBrainz series (Delivery 2, S6): one test per rule, each with its negative case,
replayed from answers recorded once from the local mirror
(``delivery-2-series-mirror.json``). The owner's example is the Colossus Projects series."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from urllib.parse import urlparse

from music_app.services.musicbrainz_client import SERIES_SIZE_CUTOFF, MusicBrainzClient
from music_app.services.musicbrainz_http import count_until
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

def _streaming_client(body_for, *, chunk_size=4096):
    """A client whose series count streams ``body_for(url)`` (an iterable of chunks) through
    the real bounded counter; ``read`` records how many bytes the count consumed."""
    read = {"bytes": 0, "requests": 0}

    def count_matches(url, _agent, *, pattern, stop_at):
        read["requests"] += 1

        def chunks():
            for chunk in body_for(url, chunk_size):
                read["bytes"] += len(chunk)
                yield chunk
        count, stopped = count_until(chunks(), pattern, stop_at)
        return count, {"status": "network", "http_status": 200, "stopped_early": stopped}

    client = MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", count_matches=count_matches)
    return client, read


def _recorded_body(url, chunk_size):
    parsed = urlparse(url)
    body = json.dumps(_FIXTURE["responses"][parsed.path.replace("/ws/2", "") + "?" + parsed.query]).encode()
    return [body[index:index + chunk_size] for index in range(0, len(body), chunk_size)]


def test_a_real_series_counts_its_release_groups():
    client, read = _streaming_client(_recorded_body)
    assert client.lookup_series(CASES["real_series"])["series"] == {"id": CASES["real_series"], "member_count": 22}
    assert read["requests"] == 1


def test_a_list_is_counted_only_up_to_the_featured_in_cutoff():
    client, read = _streaming_client(_recorded_body)
    assert client.lookup_series(CASES["list_series"])["series"]["member_count"] == SERIES_SIZE_CUTOFF
    whole = sum(len(chunk) for chunk in _recorded_body(
        f"http://127.0.0.1:5050/ws/2/series/{CASES['list_series']}?inc=release-group-rels+release-rels&fmt=json",
        4096))
    assert read["bytes"] < whole


def _huge_series_body(_url, chunk_size, *, members=5000):
    """A list of thousands of release groups, generated as it is read (the largest real
    lists are 30 MB)."""
    relation = (b'{"type":"part of","target-type":"release_group","direction":"backward",'
                b'"release_group":{"id":"00000000-0000-4000-8000-000000000000","title":"Album"}},')
    body = iter([b'{"id":"51dd33c1-a154-46f4-ad84-c2743f97ed52","type":"Release group series","relations":[']
                + [relation] * members + [b"]}"])
    pending = b""
    for part in body:
        pending += part
        while len(pending) >= chunk_size:
            yield pending[:chunk_size]
            pending = pending[chunk_size:]
    if pending:
        yield pending


def test_a_series_of_thousands_is_read_only_to_the_cutoff_and_is_featured_in():
    client, read = _streaming_client(_huge_series_body, chunk_size=1024)
    assert client.lookup_series("51dd33c1-a154-46f4-ad84-c2743f97ed52")["series"]["member_count"] == 50
    # About 51 relations' worth was read, not 5,000 (one chunk past the cutoff at most).
    assert read["bytes"] <= 160 * 51 + 1024
    assert read["requests"] == 1


def test_a_member_split_across_two_chunks_counts_once_and_other_relations_do_not_count():
    body = (b'[{"target-type":"release_group"},{"target-type" : "release"},'
            b'{"target-type":"series"},{"target-type":"url"},{"target-type":"release_group"}]')
    pattern = re.compile(rb'"target-type"\s*:\s*"release(?:_group)?"')
    for size in (1, 7, 13, len(body)):
        assert count_until((body[i:i + size] for i in range(0, len(body), size)), pattern, 50) == (3, False)
    assert count_until([body], pattern, 2) == (2, True)


class _Response:
    """A streamed HTTP body: ``fail_after`` chunks, then a reset connection."""

    def __init__(self, chunks, fail_after=None):
        self.chunks, self.fail_after, self.reads, self.closed = list(chunks), fail_after, 0, False

    def read(self, _size):
        if self.fail_after is not None and self.reads >= self.fail_after:
            raise ConnectionResetError("reset by peer")
        self.reads += 1
        return self.chunks.pop(0) if self.chunks else b""

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.closed = True


def test_the_transport_closes_the_stream_at_the_cutoff_and_a_reset_is_a_connection_error(monkeypatch):
    from music_app.services import musicbrainz_http

    member = b'{"target-type":"release_group"},'
    pattern = re.compile(rb'"target-type"\s*:\s*"release(?:_group)?"')
    response = _Response([member * 10] * 1000)
    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", lambda *_args, **_kwargs: response)
    count, transport = musicbrainz_http.count_json_matches("http://127.0.0.1:5050/ws/2/series/x", "Test",
                                                           pattern=pattern, stop_at=50)
    assert (count, transport["stopped_early"], response.reads, response.closed) == (50, True, 5, True)

    broken = _Response([member] * 3, fail_after=2)
    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", lambda *_args, **_kwargs: broken)
    assert musicbrainz_http.count_json_matches("http://127.0.0.1:5050/ws/2/series/x", "Test",
                                               pattern=pattern, stop_at=50) == (None, {"status": "connection_error"})


def test_the_count_stops_exactly_where_migration_0193_makes_a_series_featured_in():
    sql = (Path(__file__).resolve().parents[2] / "migrations" / "postgres"
           / "0193_create_musicbrainz_series.sql").read_text(encoding="utf-8")
    assert f"when member_count >= {SERIES_SIZE_CUTOFF} then 'featured_in'" in sql


def test_a_failed_count_is_a_provider_failure_not_a_size():
    def count_matches(_url, _agent, **_kwargs):
        return None, {"status": "timeout"}

    client = MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", count_matches=count_matches)
    found = client.lookup_series(COLOSSUS)
    assert found["classification"] != "complete" and "series" not in found


# One series count serves every album of it; a failed count rests (owner 2026-11-16) -------

class _SeriesRepository:
    def __init__(self, due):
        self.due, self.stored = list(due), []

    def unsized_series(self, *, limit, now):
        return self.due[:limit]

    def store_series_size(self, *, mbid, member_count, observed_at):
        self.stored.append((mbid, member_count))


class _CountingClient:
    def __init__(self, answers):
        self.answers, self.asked = answers, []

    def lookup_series(self, mbid):
        self.asked.append(mbid)
        return self.answers[mbid]


def test_one_series_count_serves_every_album_and_a_failure_rests_the_rest():
    from datetime import datetime, timezone

    from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor

    # However many albums share these series, the repository names each due series once.
    repository = _SeriesRepository(["a", "b", "c"])
    client = _CountingClient({"a": {"classification": "complete", "series": {"member_count": 22}},
                              "b": {"classification": "provider_unavailable"},
                              "c": {"classification": "complete", "series": {"member_count": 50}}})
    processor = MusicBrainzAlbumReleaseProcessor(repository=repository, client=client)
    processor._size_new_series(datetime(2026, 11, 16, tzinfo=timezone.utc))
    assert client.asked == ["a", "b"]
    # The failure is stored (it rests a day) and stops this pass: the mirror is not pressed.
    assert repository.stored == [("a", 22), ("b", None)]


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
    "Readers' Poll 2010", "Readers\u2019 Poll", "Village Voice Critics", "Critic's Choice",
    "plattentests.de \u2013 Album des Jahres 2025", "Musikexpress: Alben des Jahres", "Gala de l'ADISQ: Album de l'année",
    "Album de l\u2019ann\u00e9e", "Criminal Records Jameson: Top Ten Albums of 2009", "Z-Trip's Top Nine 80s Records",
    "Top 10 of the decade", "Q Magazine: 20 Loudest Albums of All Time", "Westword: The Ten Worst Concept Albums",
    "Stereogum Readers\u2019 10 Favorite Albums of 2018", "Angry Robot: 10 Favourite 80s Albums",
    "TheNeedleDrop: Honorable Mentions of 2023", "Honourable Mention", "Albums \u201cdisques d\u2019or\u201d",
    "Albums \u201cdisques de platine\u201d", "disques d'diamant", "RIAA certifications", "Platinum certified albums",
    "Music Canada Certified Double Diamond Albums", "certified Gold", "Gold Albums of Sweden", "Gold Vinyl",
    "Clear Vinyl", "Pink Vinyl", "Purple Translucent Vinyl", "Red Opaque Vinyl", "Splatter vinyl series"])
def test_a_list_or_chart_name_is_featured_in(name):
    assert _list_name_pattern().search(name)


@pytest.mark.parametrize("name", [
    "Best of Bowie", "Colossus Projects", "Chartreuse Sessions", "The Rewinder Tapes", "Topographic Oceans",
    "Over the Top Saga", "The Bestiary Saga", "King Crimson Collectors' Club", "Billboards and Bricks",
    "Pixar soundtracks", "Gold \u2013 The Albums", "Spandau Ballet: Gold", "Golden Earring Remasters",
    "Spider-Man 2", "PostWax Year 1", "The 7 Samurai Trilogy", "Tuonen Tyt\u00e4r II", "Album Series",
    "Vinyl Classics", "Red Hot Chili Peppers Archive"])
def test_a_band_series_or_a_lookalike_word_is_not(name):
    assert not _list_name_pattern().search(name)
