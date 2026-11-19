"""A series' general information comes only from Wikipedia (MusicBrainz Delivery 2, S6; owner
2026-11-17), rule by rule with each negative case. Every answer is replayed from
``delivery-2-series-wikipedia.json``; no test reaches the network."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services import musicbrainz_series_wikipedia as wikipedia
from music_app.services.musicbrainz_client import MusicBrainzClient
from music_app.services.musicbrainz_enrichment_worker import MusicBrainzEnrichmentChain
from music_app.services.musicbrainz_series_wikipedia import (
    NOT_FOUND,
    REFRESH_AFTER,
    SeriesWikipediaProcessor,
    failure_rest,
    plain_extract,
)
from music_app.services.musicbrainz_series_wikipedia_postgres import SeriesWikipediaPostgresRepository
from tests.py.musicbrainz_test_mirror import OK
from version import RELEASE_VERSION

_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                       / "delivery-2-series-wikipedia.json").read_text(encoding="utf-8"))
CASES = _FIXTURE["cases"]
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)


def _musicbrainz():
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        if key not in _FIXTURE["musicbrainz"]:
            return None, {"status": "http_error", "http_status": 404}
        return _FIXTURE["musicbrainz"][key], OK

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


class Wikimedia:
    """Recorded Wikimedia answers; ``down`` answers nothing, as an outage."""

    def __init__(self, *, down=False):
        self.asked, self.down = [], down

    def __call__(self, url):
        self.asked.append(url)
        if self.down:
            return None
        return _FIXTURE["wikimedia"].get(url, NOT_FOUND)


def _lookup(case, wikimedia=None):
    wikimedia = wikimedia or Wikimedia()
    processor = SeriesWikipediaProcessor(repository=None, musicbrainz=_musicbrainz(), get_json=wikimedia)
    return processor.lookup(CASES[case]), wikimedia


# Finding the article ---------------------------------------------------------------------

def test_a_direct_wikipedia_link_wins_english_first_and_wikidata_is_not_asked():
    found, wikimedia = _lookup("direct_wikipedia")
    assert found == {"language": "en", "title": "Grammy Award for Best Rock Album",
                     "url": "https://en.wikipedia.org/wiki/Grammy_Award_for_Best_Rock_Album",
                     "extract": "The Grammy Award for Best Rock Album is an award presented at the Grammy Awards to "
                                "recording artists for quality albums in the rock music genre."}
    assert wikimedia.asked == [
        "https://en.wikipedia.org/api/rest_v1/page/summary/Grammy_Award_for_Best_Rock_Album"]


def test_a_wikidata_link_leads_to_the_english_article():
    found, wikimedia = _lookup("wikidata_enwiki")
    assert (found["language"], found["title"]) == ("en", "1001 Albums You Must Hear Before You Die")
    assert found["url"] == "https://en.wikipedia.org/wiki/1001_Albums_You_Must_Hear_Before_You_Die"
    # Plain text on one line.
    assert found["extract"].startswith("1001 Albums You Must Hear Before You Die is a musical reference book first "
                                       "published in 2005, with reviews")
    assert [urlparse(url).hostname for url in wikimedia.asked] == ["www.wikidata.org", "en.wikipedia.org"]


def test_without_an_english_article_another_wikipedia_is_used_never_wikiquote():
    found, _wikimedia = _lookup("wikidata_without_enwiki")
    # frwiki before itwiki; frwikiquote is not a Wikipedia.
    assert (found["language"], found["title"]) == ("fr", "Les 100 meilleurs albums de rock français")
    assert found["url"] == "https://fr.wikipedia.org/wiki/Les_100_meilleurs_albums_de_rock_fran%C3%A7ais"


@pytest.mark.parametrize("case", ["no_link", "ended_link_only"])
def test_no_current_wikipedia_or_wikidata_link_means_nothing_and_wikimedia_is_never_asked(case):
    found, wikimedia = _lookup(case)
    assert found is False
    assert wikimedia.asked == []


def test_a_disambiguation_page_is_no_information():
    found, _wikimedia = _lookup("disambiguation")
    assert found is False


def test_a_missing_article_or_wikidata_item_is_no_information():
    processor = SeriesWikipediaProcessor(repository=None, musicbrainz=_musicbrainz(), get_json=lambda _url: NOT_FOUND)
    assert processor.lookup(CASES["direct_wikipedia"]) is False
    assert processor.lookup(CASES["wikidata_enwiki"]) is False


def test_an_unknown_series_on_musicbrainz_is_no_information():
    wikimedia = Wikimedia()
    processor = SeriesWikipediaProcessor(repository=None, musicbrainz=_musicbrainz(), get_json=wikimedia)
    assert processor.lookup("00000000-0000-4000-8000-0000000002ff") is False
    assert wikimedia.asked == []


def test_a_provider_that_does_not_answer_is_a_failure_not_no_information():
    found, _wikimedia = _lookup("wikidata_enwiki", Wikimedia(down=True))
    assert found is None

    class Unavailable:
        def lookup_series_links(self, _mbid):
            return {"classification": "provider_unavailable"}

    assert SeriesWikipediaProcessor(repository=None, musicbrainz=Unavailable(),
                                    get_json=Wikimedia()).lookup(CASES["direct_wikipedia"]) is None


def test_the_extract_is_capped_at_a_word_and_never_exceeds_the_stored_limit():
    text = plain_extract(" ".join(["word"] * 1000))
    assert len(text) <= wikipedia.EXTRACT_LIMIT and text.endswith("word…")
    assert plain_extract("  one\n two  ") == "one two"


# Rate and identity --------------------------------------------------------------------------

def test_the_user_agent_is_exactly_the_owner_approved_identifier():
    assert wikipedia.USER_AGENT == f"AlbumHaven/{RELEASE_VERSION} (+https://github.com/idanilovqa/AlbumHaven)"
    assert re.fullmatch(r"AlbumHaven/\d+\.\d+\.\d+ \(\+https://github\.com/idanilovqa/AlbumHaven\)",
                        wikipedia.USER_AGENT)
    assert "@" not in wikipedia.USER_AGENT


def test_wikimedia_requests_carry_the_user_agent_and_are_spaced_a_second_apart(monkeypatch):
    sent, clock, slept = [], [100.0], []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def read(self):
            return b'{"type": "standard"}'

    def urlopen(request, timeout):
        sent.append((request.full_url, request.get_header("User-agent"), clock[0]))
        return Response()

    monkeypatch.setattr(wikipedia.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(wikipedia.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(wikipedia.time, "sleep", lambda seconds: (slept.append(seconds), clock.__setitem__(0, clock[0] + seconds)))
    monkeypatch.setattr(wikipedia, "_LAST_REQUEST", [0.0])
    url = "https://en.wikipedia.org/api/rest_v1/page/summary/X"
    assert wikipedia.wikimedia_get_json(url) == {"type": "standard"}
    assert wikipedia.wikimedia_get_json(url) == {"type": "standard"}
    assert [agent for _url, agent, _at in sent] == [wikipedia.USER_AGENT] * 2
    assert sent[1][2] - sent[0][2] >= 1.0
    assert slept == [pytest.approx(1.0)]


@pytest.mark.parametrize("url", ["http://en.wikipedia.org/wiki/X", "https://example.org/wiki/X",
                                 "https://en.wikipedia.org.example.org/api"])
def test_only_wikipedia_and_wikidata_are_ever_asked(url, monkeypatch):
    monkeypatch.setattr(wikipedia.urllib.request, "urlopen", lambda *_args, **_kwargs: pytest.fail("network"))
    with pytest.raises(ValueError):
        wikipedia.wikimedia_get_json(url)


# Due, refresh and failure rest ------------------------------------------------------------------

@pytest.mark.parametrize("failures,rest", [(1, 1), (2, 2), (3, 4), (5, 16), (6, 30), (12, 30)])
def test_a_failure_rests_a_day_then_twice_as_long_each_time_at_most_a_month(failures, rest):
    assert failure_rest(failures) == timedelta(days=rest)


def test_a_found_introduction_is_refreshed_after_about_ninety_days():
    assert REFRESH_AFTER == timedelta(days=90)


class Repository:
    def __init__(self, due):
        self.due, self.stored, self.asked = list(due), [], []

    def due_series(self, *, limit, now, refresh_after):
        self.asked.append((limit, now, refresh_after))
        return self.due[:limit]

    def store(self, *, mbid, found, observed_at):
        self.stored.append((mbid, found if found in (None, False) else found["title"]))


def test_a_pass_looks_up_a_few_due_series_and_stores_each_answer():
    repository = Repository([CASES["direct_wikipedia"], CASES["no_link"], CASES["wikidata_enwiki"],
                             CASES["wikidata_without_enwiki"]])
    processor = SeriesWikipediaProcessor(repository=repository, musicbrainz=_musicbrainz(), get_json=Wikimedia(),
                                         now=lambda: NOW)
    assert processor.process_next(worker_id="w") == {"processed": True, "state": "succeeded",
                                                     "job_kind": "musicbrainz_series_wikipedia"}
    assert repository.asked == [(3, NOW, REFRESH_AFTER)]
    assert repository.stored == [(CASES["direct_wikipedia"], "Grammy Award for Best Rock Album"),
                                 (CASES["no_link"], False),
                                 (CASES["wikidata_enwiki"], "1001 Albums You Must Hear Before You Die")]


def test_a_failure_is_stored_and_the_rest_of_the_pass_waits():
    repository = Repository([CASES["wikidata_enwiki"], CASES["direct_wikipedia"]])
    processor = SeriesWikipediaProcessor(repository=repository, musicbrainz=_musicbrainz(),
                                         get_json=Wikimedia(down=True), now=lambda: NOW)
    assert processor.process_next(worker_id="w")["state"] == "retry_wait"
    assert repository.stored == [(CASES["wikidata_enwiki"], None)]


def test_nothing_due_is_idle_and_asks_no_one():
    wikimedia = Wikimedia()
    processor = SeriesWikipediaProcessor(repository=Repository([]), musicbrainz=None, get_json=wikimedia,
                                         now=lambda: NOW)
    assert processor.process_next(worker_id="w") == {"processed": False, "state": "idle"}
    assert wikimedia.asked == []


def test_the_enrichment_chain_runs_the_series_step_only_when_nothing_else_is_due():
    calls = []

    class Step:
        def __init__(self, name, processed):
            self.name, self.processed = name, processed

        def process_next(self, *, worker_id):
            calls.append(self.name)
            return {"processed": self.processed}

    chain = MusicBrainzEnrichmentChain(Step("artists", False), Step("albums", False), Step("fallback", False),
                                       series_processor=Step("series", True))
    assert chain.process_next(worker_id="w") == {"processed": True}
    assert calls == ["artists", "albums", "fallback", "series"]
    calls.clear()
    busy = MusicBrainzEnrichmentChain(Step("artists", False), Step("albums", True),
                                      series_processor=Step("series", True))
    busy.process_next(worker_id="w")
    assert calls == ["artists", "albums"]


# Storage (no database: the statements each answer sends) ----------------------------------------

class _Connection:
    def __init__(self, failures=0):
        self.calls, self.failures = [], failures

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def execute(self, sql, params):
        self.calls.append((" ".join(sql.split()), params))
        return self

    def fetchone(self):
        return {"wikipedia_failure_count": self.failures}


def _repository(connection):
    return SeriesWikipediaPostgresRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated"},
                                             connect=lambda _url: connection)


def test_a_found_article_is_stored_and_the_series_is_answered():
    connection = _Connection()
    _repository(connection).store(mbid=CASES["direct_wikipedia"], observed_at=NOW, found={
        "language": "en", "title": "T", "url": "https://en.wikipedia.org/wiki/T", "extract": "Text."})
    (insert, params), (update, _) = connection.calls
    assert insert.startswith("insert into integration.musicbrainz_series_wikipedia")
    assert (params["language"], params["title"], params["extract"]) == ("en", "T", "Text.")
    assert "wikipedia_checked_at = %(observed_at)s, wikipedia_failure_count = 0, wikipedia_next_attempt_at = null" in update


def test_no_article_removes_any_stored_one():
    connection = _Connection()
    _repository(connection).store(mbid=CASES["no_link"], observed_at=NOW, found=False)
    (delete, _), (update, _) = connection.calls
    assert delete.startswith("delete from integration.musicbrainz_series_wikipedia")
    assert "wikipedia_checked_at = %(observed_at)s" in update


def test_a_failure_keeps_the_stored_article_and_rests_by_its_count():
    connection = _Connection(failures=2)
    _repository(connection).store(mbid=CASES["wikidata_enwiki"], observed_at=NOW, found=None)
    (select, _), (update, params) = connection.calls
    assert "for update" in select
    assert "wikipedia_checked_at" not in update and "musicbrainz_series_wikipedia" not in update
    assert (params["failures"], params["next_attempt_at"]) == (3, NOW + timedelta(days=4))


def test_only_series_of_the_library_that_are_due_are_chosen():
    connection = _Connection()
    connection.fetchall = lambda: [{"mbid": CASES["no_link"]}]
    assert _repository(connection).due_series(limit=3, now=NOW, refresh_after=REFRESH_AFTER) == [CASES["no_link"]]
    [(sql, params)] = connection.calls
    assert "library.local_album_musicbrainz_series" in sql and "active_library" in sql
    assert "series.wikipedia_checked_at < %(now)s - %(refresh_after)s" in sql
    assert "series.wikipedia_next_attempt_at <= %(now)s" in sql
    assert params == {"limit": 3, "now": NOW, "refresh_after": REFRESH_AFTER}
