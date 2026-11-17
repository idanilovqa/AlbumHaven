"""Latin forms of track titles (MusicBrainz Delivery 2, S7; owner 2026-11-17, 1A and 1E), one
test per rule with its negative case. MusicBrainz answers are replayed from responses recorded
once from the local mirror (``delivery-2-transliteration-mirror.json``): 天門's "秒速5センチメートル",
which links an English transliteration and an English translation. The fallback libraries are
stood in for, so the tests never need them installed."""
from __future__ import annotations

import json
import sys
import types
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services import track_transliteration as module
from music_app.services.musicbrainz_client import MusicBrainzClient, latin_transliteration_id
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.track_transliteration import (
    apply_track_transliterations,
    fallback_transliteration,
    needs_transliteration,
    track_transliterations,
    transliteration_media,
)
from tests.py.musicbrainz_test_mirror import OK

_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "musicbrainz"
                       / "delivery-2-transliteration-mirror.json").read_text(encoding="utf-8"))
CASES = _FIXTURE["cases"]
JAPANESE_TITLES = ["桜花抄", "想い出は遠くの日々", "焦燥", "雪の駅", "Kiss", "カナエの気持ち", "夢", "空と海の詩",
                   "届かない気持ち", "End Theme", "One more time, One more chance (piano version)"]
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)


def _replay_client(asked=None):
    def get_json(url, _agent, **_kwargs):
        parsed = urlparse(url)
        key = parsed.path.replace("/ws/2", "") + "?" + parsed.query
        if asked is not None:
            asked.append(key)
        assert key in _FIXTURE["responses"], f"unrecorded mirror request {key}"
        return _FIXTURE["responses"][key], OK

    return MusicBrainzClient(base_url="http://127.0.0.1:5050/ws/2", user_agent="Test", get_json=get_json)


@pytest.fixture
def no_fallbacks(monkeypatch):
    """Neither cutlet nor pypinyin is installed."""
    monkeypatch.setitem(sys.modules, "cutlet", None)
    monkeypatch.setitem(sys.modules, "pypinyin", None)
    module._cutlet.cache_clear()
    yield
    module._cutlet.cache_clear()


@pytest.fixture
def fallbacks(monkeypatch):
    """Stand-ins answering as cutlet 0.5.2 and pypinyin 0.55.0 do for these titles."""
    romaji = {"桜花抄": "Ouka shou", "焦燥": "Shousou", "天門": "Tenmon", "Hello 世界": "Hello sekai",
              "カナエの気持ち": "Kanae no kimochi", "夢": "Yume"}
    pinyin = {"天门": ["tiān", "mén"], "你好 Love": ["nǐ", "hǎo", " Love"], "你好，世界": ["nǐ", "hǎo", "，", "shì", "jiè"]}
    monkeypatch.setitem(sys.modules, "cutlet", types.SimpleNamespace(
        Cutlet=lambda: types.SimpleNamespace(romaji=lambda text: romaji[text])))
    monkeypatch.setitem(sys.modules, "pypinyin", types.SimpleNamespace(
        Style=types.SimpleNamespace(TONE="tone"), lazy_pinyin=lambda text, style: pinyin[text]))
    module._cutlet.cache_clear()
    yield
    module._cutlet.cache_clear()


def _tracks(titles, disc=1):
    return [{"disc_number": disc, "track_number": number, "title": title} for number, title in enumerate(titles, 1)]


# Script detection: Unicode blocks --------------------------------------------------------

@pytest.mark.parametrize("title", ["桜花抄", "カナエの気持ち", "사랑", "Αγάπη", "حب", "Hello 世界", "ｶﾅｴ"])
def test_a_title_with_letters_beyond_latin_and_cyrillic_needs_a_latin_form(title):
    assert needs_transliteration(title)


@pytest.mark.parametrize("title", ["Kiss", "Café Ægir Œuvre", "Кино", "Їжак і Ґава", "1999!", "", "♪ — ★", "ＡＢＣ"])
def test_latin_cyrillic_digits_and_punctuation_need_none(title):
    assert not needs_transliteration(title)


# MusicBrainz: the transl-tracklisting pseudo-release -------------------------------------

def test_the_linked_transliteration_is_chosen_and_the_translation_beside_it_is_not():
    found = _replay_client().lookup_release_transliteration(CASES["release_with_transliteration"])
    # "English transliteration", not "5 Centimeters Per Second" ("English translation").
    assert found == {"classification": "complete", "transliteration_mbid": CASES["transliteration"]}


def test_a_release_linking_no_transliteration_has_none():
    found = _replay_client().lookup_release_transliteration(CASES["release_without_transliteration"])
    assert found == {"classification": "complete", "transliteration_mbid": None}


def _relation(mbid, *, script="Latn", language="jpn", note="", direction="forward", kind="transl-tracklisting"):
    return {"type": kind, "direction": direction, "target-type": "release",
            "release": {"id": mbid, "disambiguation": note,
                        "text-representation": {"script": script, "language": language}}}


def test_only_a_forward_latin_transliteration_in_the_releases_language_counts():
    first, second = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"

    def chosen(*relations):
        return latin_transliteration_id({"text-representation": {"script": "Jpan", "language": "jpn"},
                                         "relations": list(relations)})

    assert chosen(_relation(second), _relation(first)) == first
    assert chosen(_relation(first), _relation(second, note="Romaji transliteration")) == second
    assert chosen(_relation(first, script="Kana")) is None
    assert chosen(_relation(first, language="eng")) is None
    assert chosen(_relation(first, note="English translation")) is None
    assert chosen(_relation(first, direction="backward")) is None
    assert chosen(_relation(first, kind="remaster")) is None


def test_the_pseudo_releases_tracklist_is_stored_by_medium_and_position():
    release = _replay_client().lookup_release_tracklist(CASES["transliteration"])["release"]
    [medium] = transliteration_media(release)
    assert medium["position"] == 1
    assert [track["title"] for track in medium["tracks"][:3]] == ["Oukashou", "Omoide wa Tooku no Hibi", "Shousou"]
    assert [track["position"] for track in medium["tracks"]] == list(range(1, 12))


# Pairing with the local tracks -----------------------------------------------------------

def _stored(quality="order_exact", pairing=None, disc_position=None):
    release = _replay_client().lookup_release_tracklist(CASES["transliteration"])["release"]
    return {"match_quality": quality, "pairing": pairing or {}, "disc_position": disc_position,
            "media": transliteration_media(release)}


def test_musicbrainz_forms_pair_by_position_when_the_order_is_exact(no_fallbacks):
    shown = track_transliterations(_tracks(JAPANESE_TITLES), stored=_stored())
    # Latin titles ("Kiss", "End Theme", "One more time…") show nothing.
    assert shown == {(1, 1): "Oukashou", (1, 2): "Omoide wa Tooku no Hibi", (1, 3): "Shousou", (1, 4): "Yuki no Eki",
                     (1, 6): "Kanae no Kimochi", (1, 7): "Yume", (1, 8): "Sora to Umi no Shi",
                     (1, 9): "Todoke Kanai Kimochi"}


def test_a_reordered_album_pairs_through_the_stored_pairing_and_an_ambiguous_one_not_at_all(no_fallbacks):
    tracks = _tracks(["焦燥", "桜花抄"])
    reordered = _stored("reordered", {(1, 1): (1, 3), (1, 2): (1, 1)})
    assert track_transliterations(tracks, stored=reordered) == {(1, 1): "Shousou", (1, 2): "Oukashou"}
    assert track_transliterations(tracks, stored=_stored("ambiguous")) == {}
    assert track_transliterations(tracks, stored={**_stored(), "match_quality": None}) == {}


def test_one_disc_of_a_larger_release_starts_at_its_disc_position(no_fallbacks):
    stored = _stored(disc_position=2)
    stored["media"] = [{"position": 1, "tracks": [{"position": 1, "title": "Wrong"}]}, *(
        {**medium, "position": 2} for medium in stored["media"])]
    assert track_transliterations(_tracks(["桜花抄"]), stored=stored) == {(1, 1): "Oukashou"}


# MusicBrainz first, then the optional fallbacks ------------------------------------------

def test_musicbrainz_wins_over_cutlet(fallbacks):
    shown = track_transliterations(_tracks(["桜花抄", "想い出は遠くの日々", "焦燥"]), stored=_stored())
    assert shown == {(1, 1): "Oukashou", (1, 2): "Omoide wa Tooku no Hibi", (1, 3): "Shousou"}
    # cutlet alone would say "Ouka shou".
    assert track_transliterations(_tracks(["桜花抄"]), album_title="秒速5センチメートル")[(1, 1)] == "Ouka shou"


def test_without_musicbrainz_japanese_falls_back_to_cutlet_when_installed(fallbacks):
    shown = track_transliterations(_tracks(["桜花抄", "Hello 世界", "Kiss", "カナエの気持ち"]))
    assert shown == {(1, 1): "Ouka shou", (1, 2): "Hello sekai", (1, 4): "Kanae no kimochi"}


def test_without_musicbrainz_or_the_fallbacks_nothing_is_shown(no_fallbacks):
    assert track_transliterations(_tracks(["桜花抄", "Hello 世界", "天门"])) == {}


def test_ideographs_are_japanese_on_an_album_with_kana_and_chinese_otherwise(fallbacks):
    assert track_transliterations(_tracks(["天門", "カナエの気持ち"]))[(1, 1)] == "Tenmon"
    assert track_transliterations(_tracks(["天門"]), album_title="秒速5センチメートル") == {(1, 1): "Tenmon"}
    assert fallback_transliteration("天门", japanese=False) == "Tiān mén"
    assert fallback_transliteration("你好 Love", japanese=False) == "Nǐ hǎo Love"
    assert fallback_transliteration("你好，世界", japanese=False) == "Nǐ hǎo， shì jiè"


def test_the_installed_libraries_give_the_approved_mockups_forms():
    """The real cutlet and pypinyin pinned in requirements.txt (the mockup's 1A forms)."""
    pytest.importorskip("cutlet")
    pytest.importorskip("pypinyin")
    module._cutlet.cache_clear()
    assert track_transliterations(_tracks(["桜花抄", "想い出は遠くの日々", "Kiss", "カナエの気持ち", "Кино", "사랑"])) == {
        (1, 1): "Ouka shou", (1, 2): "Omoide wa tooku no hibi", (1, 4): "Kanae no kimochi"}
    assert fallback_transliteration("天门", japanese=False) == "Tiān mén"


def test_other_scripts_show_only_musicbrainz_and_cyrillic_never_shows_anything(fallbacks):
    assert track_transliterations(_tracks(["사랑", "Αγάπη"])) == {}
    korean = {"match_quality": "order_exact", "pairing": {},
              "media": [{"position": 1, "tracks": [{"position": 1, "title": "Sarang"}, {"position": 2, "title": "Kino"}]}]}
    # Even a stored Latin form never shows beside a Cyrillic title (1E).
    assert track_transliterations(_tracks(["사랑", "Кино"]), stored=korean) == {(1, 1): "Sarang"}


def test_an_answer_still_not_in_latin_script_is_never_shown(fallbacks, monkeypatch):
    unchanged = {"match_quality": "order_exact", "pairing": {}, "media": [{"position": 1, "tracks": [
        {"position": 1, "title": "Hello 世界"}]}]}
    # MusicBrainz's copy of the original title gives way to the fallback (a Japanese album).
    assert track_transliterations(_tracks(["Hello 世界"]), stored=unchanged, album_title="カナエ") == {
        (1, 1): "Hello sekai"}
    monkeypatch.setitem(sys.modules, "cutlet", types.SimpleNamespace(
        Cutlet=lambda: types.SimpleNamespace(romaji=lambda text: "桜花 shou")))
    module._cutlet.cache_clear()
    assert fallback_transliteration("桜花抄", japanese=True) is None
    assert track_transliterations(_tracks(["Hello 世界"]), stored=unchanged, album_title="カナエ") == {}


# Album details payload --------------------------------------------------------------------

class _Connection:
    def __init__(self, row):
        self.row, self.queries = row, 0

    def execute(self, _sql, _params):
        self.queries += 1
        return types.SimpleNamespace(fetchone=lambda: self.row)


def test_album_details_rows_carry_the_latin_form_only_where_one_is_shown(no_fallbacks):
    stored = _stored()
    connection = _Connection({"release_mbid": CASES["release_with_transliteration"], "match_quality": "order_exact",
                              "track_pairing": [], "track_order_differs": False, "disc_position": None,
                              "media": json.dumps(stored["media"])})
    album = {"name": "秒速5センチメートル", "track_rows": _tracks(JAPANESE_TITLES[:5])}
    apply_track_transliterations(connection, album, album_id=7)
    assert [row.get("title_transliteration") for row in album["track_rows"]] == [
        "Oukashou", "Omoide wa Tooku no Hibi", "Shousou", "Yuki no Eki", None]
    # Tags stay the tags.
    assert [row["title"] for row in album["track_rows"]] == JAPANESE_TITLES[:5]


def test_an_album_of_latin_and_cyrillic_titles_asks_the_database_nothing(no_fallbacks):
    connection = _Connection(None)
    album = {"track_rows": _tracks(["Kiss", "Кино"])}
    apply_track_transliterations(connection, album, album_id=7)
    assert connection.queries == 0 and all("title_transliteration" not in row for row in album["track_rows"])


# The album release lane: asked once per release ------------------------------------------

class _Repository:
    def __init__(self, due):
        self.due, self.stored = due, []

    def claim_due_job(self, **_kwargs):
        return None

    def enqueue(self, **_kwargs):
        return 0

    def claim_transliteration(self, *, now):
        return self.due

    def store_transliteration(self, **kwargs):
        self.stored.append(kwargs)


def _lane(due, client=None):
    repository, asked = _Repository(due), []
    result = MusicBrainzAlbumReleaseProcessor(repository=repository, client=client or _replay_client(asked),
                                              now=lambda: NOW).process_next(worker_id="w")
    return result, repository.stored, asked


def test_a_due_release_asks_its_link_then_its_transliteration_once_and_stores_it():
    result, stored, asked = _lane({"release_mbid": CASES["release_with_transliteration"], "titles": JAPANESE_TITLES})
    assert result == {"processed": True, "state": "succeeded"}
    assert asked == [f"/release/{CASES['release_with_transliteration']}?inc=release-rels&fmt=json",
                     f"/release/{CASES['transliteration']}?inc=recordings+artist-credits+release-groups+series-rels"
                     "&fmt=json"]
    [row] = stored
    assert (row["release_mbid"], row["transliteration_mbid"]) == (CASES["release_with_transliteration"],
                                                                  CASES["transliteration"])
    assert row["media"][0]["tracks"][0] == {"position": 1, "title": "Oukashou"}


def test_a_release_linking_none_is_stored_as_none_after_one_ask():
    _result, stored, asked = _lane({"release_mbid": CASES["release_without_transliteration"], "titles": ["桜花抄"]})
    assert len(asked) == 1
    assert (stored[0]["transliteration_mbid"], stored[0]["media"]) == (None, [])


def test_a_release_whose_titles_need_no_latin_form_is_stored_without_asking():
    _result, stored, asked = _lane({"release_mbid": CASES["release_without_transliteration"],
                                    "titles": ["Kiss", "Кино", "Song’s — Remix"]})
    assert asked == [] and stored[0]["transliteration_mbid"] is None


def test_a_failed_ask_stores_nothing_and_ends_the_pass():
    class Down:
        asked = 0

        def lookup_release_transliteration(self, _mbid):
            Down.asked += 1
            return {"classification": "provider_unavailable"}

    result, stored, _asked = _lane({"release_mbid": CASES["release_with_transliteration"], "titles": ["桜花抄"]},
                                   client=Down())
    assert (result, stored, Down.asked) == ({"processed": False, "state": "idle"}, [], 1)


def test_nothing_due_is_idle():
    assert _lane(None)[0] == {"processed": False, "state": "idle"}
