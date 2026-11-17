"""Latin album titles (MusicBrainz Delivery 2, S7, 0256; owner-approved b3-1d3), rule by rule
with each negative case. No database: the stored rows' Postgres behaviour is in
test_track_transliteration_postgres.py.
"""
from __future__ import annotations

import sys
import types
from datetime import datetime, timezone
from pathlib import Path

import pytest

from music_app.services import track_transliteration as module
from music_app.services.musicbrainz_release_identity import MusicBrainzAlbumReleaseProcessor
from music_app.services.track_transliteration import album_title_transliteration, refresh_album_latin_titles
from tests.py.test_track_transliteration import CASES, _replay_client

REPO = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def fallbacks(monkeypatch):
    """Stand-ins answering as cutlet 0.5.2 and pypinyin 0.55.0 do for these titles."""
    romaji = {"センチメートル": "Senchimeetoru", "天門": "Tenmon", "ジャイアニズム叱": "Jaianizumu ?"}
    pinyin = {"天門": ["tiān", "mén"], "天门": ["tiān", "mén"]}
    monkeypatch.setitem(sys.modules, "cutlet", types.SimpleNamespace(
        Cutlet=lambda: types.SimpleNamespace(romaji=lambda text: romaji[text])))
    monkeypatch.setitem(sys.modules, "pypinyin", types.SimpleNamespace(
        Style=types.SimpleNamespace(TONE="tone"), lazy_pinyin=lambda text, style: pinyin[text]))
    module._cutlet.cache_clear()
    yield
    module._cutlet.cache_clear()


# The language rule, as for tracks -------------------------------------------------------------

def test_an_album_title_with_kana_is_romaji_whatever_the_language(fallbacks):
    assert album_title_transliteration("センチメートル") == "Senchimeetoru"
    assert album_title_transliteration("センチメートル", stored={"language": "zho"}) == "Senchimeetoru"


def test_ideographs_are_romaji_only_for_a_japanese_release_and_pinyin_otherwise(fallbacks):
    assert album_title_transliteration("天門", stored={"language": "jpn"}) == "Tenmon"
    for other in ({"language": "zho"}, {"language": ""}, None):
        assert album_title_transliteration("天門", stored=other) == "Tiān mén"


def test_only_the_japanese_runs_are_read_and_a_run_cutlet_cannot_read_gives_none(fallbacks):
    assert album_title_transliteration("Tenmon Best (天門)", stored={"language": "jpn"}) == "Tenmon Best (tenmon)"
    assert album_title_transliteration("Gianizm (ジャイアニズム叱)", stored={"language": "jpn"}) is None


@pytest.mark.parametrize("title", ["Hoshi no Koe", "Кино", "Album 2", "", None])
def test_latin_and_cyrillic_album_titles_get_no_latin_form(fallbacks, title):
    assert album_title_transliteration(title, stored={"language": "jpn"}) is None


def test_other_scripts_get_none_without_a_musicbrainz_form(fallbacks):
    assert album_title_transliteration("사랑", stored={"language": "kor"}) is None


# The refresh: one row per due album, compared as stored values -------------------------------

class _Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.rows[0] if self.rows else None


class _Connection:
    """Answers the due-albums read with ``due`` and the stored answer with ``language``."""

    def __init__(self, due, language=None):
        self.due, self.language, self.writes = due, language, []

    def execute(self, sql, params):
        if "local_album_latin_titles latin on latin.album_id" in sql:
            return _Result(self.due)
        if "musicbrainz_release_transliterations transliteration" in sql:
            return _Result([] if self.language is None else [{
                "release_mbid": "r", "match_quality": "order_exact", "track_pairing": [], "track_order_differs": False,
                "disc_position": None, "media": [], "language": self.language}])
        self.writes.append((" ".join(sql.split()), params))
        return _Result([])


def _due(title, album_id=1):
    return {"album_id": album_id, "library_id": 9, "album_key": f"k{album_id}", "title": title, "source_updated_at": NOW}


def test_a_due_album_stores_its_latin_title_and_folded_search_key(fallbacks):
    connection = _Connection([_due("天門")], language="zho")
    assert refresh_album_latin_titles(connection, library_ids=[9], limit=25) == ["k1"]
    [(sql, params)] = connection.writes
    assert sql.startswith("insert into library.local_album_latin_titles") and "on conflict (album_id) do update" in sql
    assert params == {"album_id": 1, "library_id": 9, "title": "天門", "latin": "Tiān mén", "key": "tianmen",
                      "source": NOW}


def test_the_stored_language_decides_the_reading(fallbacks):
    connection = _Connection([_due("天門")], language="jpn")
    refresh_album_latin_titles(connection, library_ids=[9], limit=25)
    assert (connection.writes[0][1]["latin"], connection.writes[0][1]["key"]) == ("Tenmon", "tenmon")


def test_an_album_title_with_no_known_form_keeps_a_null_row(fallbacks):
    connection = _Connection([_due("사랑")])
    refresh_album_latin_titles(connection, library_ids=[9], limit=25)
    assert (connection.writes[0][1]["latin"], connection.writes[0][1]["key"]) == (None, None)


def test_a_title_changed_to_latin_drops_its_row(fallbacks):
    connection = _Connection([_due("Heaven Gate")])
    assert refresh_album_latin_titles(connection, library_ids=[9], limit=25) == ["k1"]
    assert connection.writes == [("delete from library.local_album_latin_titles where album_id = %(album_id)s",
                                  {"album_id": 1})]


def test_nothing_due_writes_nothing(fallbacks):
    connection = _Connection([])
    assert refresh_album_latin_titles(connection, library_ids=[9], limit=25) == [] and connection.writes == []


def test_a_row_is_due_when_its_title_or_source_changed_compared_as_stored_values_never_clocks():
    sql = " ".join(module._DUE_LATIN_ALBUM_TITLES_SQL.split())
    assert "latin.source_title is distinct from albums.title" in sql
    assert ("latin.source_updated_at is distinct from greatest(decision.updated_at, transliteration.updated_at)"
            in sql)
    assert "now()" not in sql.lower() and "current_timestamp" not in sql.lower()
    # The same coarse script test as the tracks' due check (0255), shared with the Python side.
    assert "albums.title ~ %(beyond_latin)s" in sql
    assert "tracks.title ~ %(beyond_latin)s" in " ".join(module._DUE_LATIN_ALBUMS_SQL.split())


def test_a_symbol_title_keeps_a_null_row_so_it_is_not_due_again(fallbacks):
    """"★" passes the coarse test but needs no form: without a row it would be due on every
    pass, ahead of real albums, and drop its cached searches each time."""
    connection = _Connection([_due("Best ★ Hits")])
    assert refresh_album_latin_titles(connection, library_ids=[9], limit=25) == ["k1"]
    [(sql, params)] = connection.writes
    assert sql.startswith("insert into library.local_album_latin_titles")
    assert (params["title"], params["latin"], params["key"]) == ("Best ★ Hits", None, None)
    assert module._BEYOND_LATIN_RE.search("Best ★ Hits")


def test_a_symbol_track_title_keeps_a_null_row_and_a_latin_one_none(fallbacks):
    """The same rule for tracks (0255): "Intro ♪" keeps a null row; "Outro" keeps none."""
    class Tracks(_Connection):
        def execute(self, sql, params):
            if "local_track_latin_titles latin on latin.track_id" in sql:
                assert params["beyond_latin"] == module._BEYOND_LATIN
                return _Result(self.due)
            if sql.startswith("select id, disc_number, track_number, title from library.local_tracks"):
                return _Result([{"id": 11, "disc_number": 1, "track_number": 1, "title": "Intro ♪"},
                                {"id": 12, "disc_number": 1, "track_number": 2, "title": "Outro"}])
            return super().execute(sql, params)

    connection = Tracks([{"album_id": 1, "library_id": 9, "album_key": "k1", "source_updated_at": NOW}])
    assert module.refresh_latin_titles(connection, library_ids=[9], limit=25) == ["k1"]
    delete, insert = connection.writes
    assert delete[1] == {"track_ids": [11, 12], "kept": [11]}
    assert insert[0].startswith("insert into library.local_track_latin_titles")
    assert (insert[1]["track_id"], insert[1]["latin"], insert[1]["key"]) == (11, None, None)


def test_the_coarse_test_passes_over_latin_and_cyrillic_titles():
    for title in ("Heaven Gate", "Привет — Hi", "Café “Noir”"):
        assert not module._BEYOND_LATIN_RE.search(title), title
    for title in ("天門", "Intro ♪", "사랑"):
        assert module._BEYOND_LATIN_RE.search(title), title


def test_the_repository_refreshes_tracks_and_albums_and_counts_each_album_once(monkeypatch):
    from contextlib import contextmanager

    from music_app.services import musicbrainz_corrections_postgres, musicbrainz_release_identity_postgres
    from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository

    class Connection:
        def execute(self, _sql, _params=None):
            return _Result([{"library_id": 9}])

    @contextmanager
    def connect(_url):
        yield Connection()

    monkeypatch.setattr(musicbrainz_release_identity_postgres, "_transaction", lambda _connection: connect(None))
    monkeypatch.setattr(module, "refresh_latin_titles", lambda _connection, **_kwargs: ["a", "b"])
    monkeypatch.setattr(module, "refresh_album_latin_titles", lambda _connection, **_kwargs: ["b", "c"])
    notified = []
    monkeypatch.setattr(musicbrainz_corrections_postgres, "notify_searchable_values_changed",
                        lambda _url, keys: notified.append(sorted(keys)))
    repository = MusicBrainzReleaseIdentityPostgresRepository({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://x"},
                                                              connect=connect)
    assert repository.refresh_latin_titles() == 3
    assert notified == [["a", "b", "c"]], "search and gallery caches of every changed album are dropped"


# The language: an album title alone asks MusicBrainz for its release -------------------------

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

    def refresh_latin_titles(self):
        return 0


def _lane(due):
    repository, asked = _Repository(due), []
    MusicBrainzAlbumReleaseProcessor(repository=repository, client=_replay_client(asked),
                                     now=lambda: NOW).process_next(worker_id="w")
    return repository.stored, asked


def test_a_release_whose_album_title_alone_needs_a_latin_form_is_asked_for_its_language():
    stored, asked = _lane({"release_mbid": CASES["release_without_transliteration"], "titles": ["Kiss"],
                           "album_titles": ["センチメートル"]})
    assert len(asked) == 1 and stored[0]["language"] == "jpn"


def test_a_release_with_latin_track_and_album_titles_is_still_stored_without_asking():
    stored, asked = _lane({"release_mbid": CASES["release_without_transliteration"], "titles": ["Kiss"],
                           "album_titles": ["Кино"]})
    assert asked == [] and (stored[0]["transliteration_mbid"], stored[0]["language"]) == (None, "")


def test_the_claim_considers_album_titles_and_returns_them_beside_the_track_titles():
    import inspect

    from music_app.services.musicbrainz_release_identity_postgres import MusicBrainzReleaseIdentityPostgresRepository

    source = " ".join(inspect.getsource(MusicBrainzReleaseIdentityPostgresRepository.claim_transliteration).split())
    assert "and (albums.title ~ '" in source and "or exists (select 1 from library.local_tracks tracks" in source
    assert "as album_titles" in source
    # A release whose stored language is missing (answered before 0255) is still asked again.
    assert "transliteration.language is null" in source


# Search and the gallery payload --------------------------------------------------------------

def test_search_finds_an_album_by_its_folded_latin_title_through_its_own_arm():
    from music_app.services.library_browse_postgres import _search_preview_sql

    sql = " ".join(_search_preview_sql().split())
    assert ("latin_title_album_matches as materialized ( select library.local_album_latin_titles.library_id,"
            " library.local_album_latin_titles.album_id from library.local_album_latin_titles"
            " where library.local_album_latin_titles.search_key is not null"
            " and library.local_album_latin_titles.search_key like %(query_latin_like)s )") in sql
    assert "union select library_id, album_id from latin_title_album_matches union" in sql
    # Negative: the album arm never matches a raw query, only the folded key.
    arm = sql[sql.index("latin_title_album_matches as materialized"):sql.index("file_name_matches as")]
    assert "query_like" not in arm.replace("query_latin_like", "")


class _PayloadConnection:
    def __init__(self, rows):
        self.rows, self.queries = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params):
        self.queries.append((sql, params))
        return _Result(self.rows)


def test_cards_get_the_stored_latin_title_never_beside_a_corrected_title():
    from music_app.services.musicbrainz_correction_display import project_correction_display

    connection = _PayloadConnection([
        {"album_key": "a", "corrected_title": None, "corrected_album_artist": None, "title_latin": "Tenmon"},
        {"album_key": "b", "corrected_title": "Corrected", "corrected_album_artist": None, "title_latin": "Tiān mén"},
        {"album_key": "d", "corrected_title": "天門", "corrected_album_artist": None, "title_latin": "Tiān mén"}])
    payload = {"groups": [{"albums": [{"key": "a", "name": "天門", "album_artist": "X"},
                                      {"key": "b", "name": "天门", "album_artist": "X"},
                                      {"key": "c", "name": "Plain", "album_artist": "X"},
                                      {"key": "d", "name": "天門", "album_artist": "X"}]}]}
    project_correction_display({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://x"}, payload,
                               connect=lambda _url: connection)
    a, b, c, d = payload["groups"][0]["albums"]
    assert a["title_latin"] == "Tenmon" and "display_title" not in a
    assert b["display_title"] == "Corrected" and "title_latin" not in b
    assert set(c) == {"key", "name", "album_artist"}, "an album with no Latin title carries no extra bytes"
    assert d["title_latin"] == "Tiān mén", "a corrected title equal to the tag still shows the tag's Latin form"
    [(sql, _params)] = connection.queries
    sql = " ".join(sql.split())
    assert ("left join library.local_album_latin_titles latin on latin.album_id = albums.id"
            " and latin.source_title = albums.title and latin.latin is not null") in sql, "only a current form"


# The migration -------------------------------------------------------------------------------

def test_0256_mirrors_0255s_latin_table_keyed_by_album():
    sql = (REPO / "migrations" / "postgres" / "0256_add_album_latin_titles.sql").read_text(encoding="utf-8")
    assert sql.splitlines()[0] == "-- depends on: 0255_add_track_latin_titles_and_release_language.sql"
    flat = " ".join(sql.split())
    assert ("create table if not exists library.local_album_latin_titles ( album_id bigint primary key"
            " references library.local_albums(id) on delete cascade, library_id bigint not null,") in flat
    for check in ("source_title text not null", "latin text check (char_length(latin) between 1 and 2048)",
                  "search_key text check (search_key ~ '^[a-z0-9]+$')", "source_updated_at timestamptz",
                  "check ((latin is null) = (search_key is null))"):
        assert check in flat
    assert ("create index if not exists local_album_latin_titles_search_key_trgm_idx on library.local_album_latin_titles"
            " using gin (search_key %I.gin_trgm_ops) where search_key is not null") in flat
    assert "revoke all on table library.local_album_latin_titles from public" in flat
    assert "grant select on table library.local_album_latin_titles to album_haven_readonly" in flat
    for role in ("album_haven_app", "album_haven_migrator"):
        assert f"grant select, insert, update, delete on table library.local_album_latin_titles to {role}" in flat
    # Additive only.
    assert not any(word in flat.lower() for word in ("drop ", "alter table", "update library", "delete from"))
