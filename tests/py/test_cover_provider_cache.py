from __future__ import annotations

import json
import threading

import pytest

from music_app.services import cover_provider_cache
from music_app.services.cover_provider_cache import CoverSearchCache, import_cover_search_cache_file
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _dedicated_database_urls_or_skip, _drop_application_schemas


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    """Records every statement; answers `select payload` from `rows` and the import marker from `imported`."""

    def __init__(self, rows=None, *, imported=False, fail=False):
        self.rows, self.imported, self.fail, self.statements = dict(rows or {}), imported, fail, []

    def __call__(self, _url):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def execute(self, sql, params=()):
        if self.fail:
            raise RuntimeError("database unavailable")
        self.statements.append((" ".join(sql.split()), params))
        if "from library.cover_provider_cache_imports" in sql:
            return _Result((1,) if self.imported else None)
        if "from library.cover_provider_cache_entries where cache_key" in sql:
            payload = self.rows.get(params[0])
            return _Result(None if payload is None else {"payload": payload})
        return _Result(None)


def _jsonb_object(param) -> dict:
    return getattr(param, "obj", param)


def test_without_a_database_answers_stay_in_this_process_and_nothing_is_written(tmp_path):
    cache = CoverSearchCache()
    nested = {"inner": "original"}
    value = {"url": "https://images.example/cover.jpg", "nested": nested}

    cache.set("artist::album", value)
    value["url"] = "mutated"
    nested["inner"] = "mutated"
    first_hit = cache.get("artist::album")
    assert first_hit == {"url": "https://images.example/cover.jpg", "nested": {"inner": "mutated"}}
    first_hit["url"] = "changed"
    assert cache.get("artist::album") == {"url": "https://images.example/cover.jpg", "nested": {"inner": "mutated"}}
    cache.save()
    assert cache.get("artist::album") is not None
    assert CoverSearchCache().get("artist::album") is None
    assert list(tmp_path.iterdir()) == []


def test_a_lookup_reads_one_row_by_its_key_and_never_the_whole_cache():
    connection = _Connection({"artist::album": {"missing": True}})
    cache = CoverSearchCache("postgresql://cache", connect=connection)

    assert cache.get("artist::album") == {"missing": True}
    assert cache.get("other::album") is None

    assert connection.statements == [
        ("select payload from library.cover_provider_cache_entries where cache_key = %s", ("artist::album",)),
        ("select payload from library.cover_provider_cache_entries where cache_key = %s", ("other::album",)),
    ]


def test_construction_reads_nothing():
    connection = _Connection()

    CoverSearchCache("postgresql://cache", connect=connection)

    assert connection.statements == []


def test_save_upserts_only_the_staged_keys_once_and_a_clean_save_writes_nothing():
    connection = _Connection({"stored::album": {"missing": True}})
    cache = CoverSearchCache("postgresql://cache", connect=connection)
    cache.set("artist::album", {"url": "https://images.example/cover.jpg"})
    assert cache.get("artist::album") == {"url": "https://images.example/cover.jpg"}
    assert connection.statements == []

    cache.save()
    cache.save()

    assert len(connection.statements) == 1
    sql, params = connection.statements[0]
    assert sql.startswith("insert into library.cover_provider_cache_entries")
    assert "on conflict (cache_key) do update" in sql
    assert _jsonb_object(params[0]) == {"artist::album": {"url": "https://images.example/cover.jpg"}}


def test_a_browse_only_app_reads_answers_but_never_writes_them():
    connection = _Connection({"stored::album": {"missing": True}})
    cache = CoverSearchCache("postgresql://cache", connect=connection, writable=False)

    cache.set("artist::album", {"url": "https://images.example/cover.jpg"})
    cache.save()

    assert cache.get("artist::album") == {"url": "https://images.example/cover.jpg"}
    assert cache.get("stored::album") == {"missing": True}
    assert [sql for sql, _ in connection.statements] == [
        "select payload from library.cover_provider_cache_entries where cache_key = %s",
    ]


def test_the_process_cache_follows_the_app_database_and_writer_role(monkeypatch):
    monkeypatch.setattr(cover_provider_cache, "_PROCESS_CACHES", {})
    monkeypatch.setattr(cover_provider_cache, "_SHARED_CACHE_CONFIG", {})

    cover_provider_cache.configure_shared_cover_search_cache(
        {"ALBUM_HAVEN_APP_DATABASE_URL": " postgresql://app ", "SHARED_LIBRARY_BROWSE_ONLY": True},
    )
    browse_only = cover_provider_cache._shared_cover_search_cache()
    assert (browse_only.database_url, browse_only.writable) == ("postgresql://app", False)

    writer_config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"}
    cover_provider_cache.configure_shared_cover_search_cache(writer_config)
    writer = cover_provider_cache._shared_cover_search_cache()
    assert writer.writable is True
    # Provider helpers and cover batches share one cache per database and writer role.
    assert writer is cover_provider_cache.cover_search_cache_for(writer_config)
    assert writer is not browse_only


def test_answers_that_are_never_written_stay_bounded(monkeypatch):
    monkeypatch.setattr(cover_provider_cache, "_STAGED_ENTRY_LIMIT", 2)
    cache = CoverSearchCache(writable=False)
    for key in ("first", "second", "third"):
        cache.set(key, {"missing": True})
    cache.set("second", {"missing": False})

    assert cache.get("first") is None
    assert cache.get("third") == {"missing": True}
    assert cache.get("second") == {"missing": False}


def test_a_failed_write_keeps_the_staged_answer_for_the_next_save(caplog):
    connection = _Connection(fail=True)
    cache = CoverSearchCache("postgresql://cache", connect=connection)
    cache.set("artist::album", {"missing": True})

    with caplog.at_level("WARNING"):
        cache.save()

    assert "Cover provider cache write failed" in caplog.text
    assert cache.get("artist::album") == {"missing": True}
    connection.fail = False
    cache.save()
    assert _jsonb_object(connection.statements[-1][1][0]) == {"artist::album": {"missing": True}}
    cache.save()
    assert len(connection.statements) == 1


def test_a_failed_lookup_is_a_miss_and_is_logged(caplog):
    cache = CoverSearchCache("postgresql://cache", connect=_Connection(fail=True))

    with caplog.at_level("WARNING"):
        assert cache.get("artist::album") is None

    assert "Cover provider cache read failed" in caplog.text


def _old_cache_file(tmp_path, count):
    path = tmp_path / "cover_search_cache.json"
    queries = {f"artist-{index}::album": {"missing": True} for index in range(count)}
    queries["malformed::album"] = ["not", "an", "object"]
    path.write_text(json.dumps({"queries": queries}), encoding="utf-8")
    return path


def test_the_import_runs_once_in_batches_and_leaves_the_old_file_in_place(tmp_path, caplog):
    path = _old_cache_file(tmp_path, 1_201)
    connection = _Connection()
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://cache", "COVER_CACHE_PATH": path}

    with caplog.at_level("INFO"):
        result = import_cover_search_cache_file(config, connect=connection)

    assert result == {"status": "imported", "total": 1_201}
    inserts = [params for sql, params in connection.statements if "on conflict (cache_key) do nothing" in sql]
    assert [len(_jsonb_object(params[0])) for params in inserts] == [500, 500, 201]
    assert connection.statements[-1][1] == ("cover_search_cache_json", 1_201)
    assert "Cover provider cache import progress imported=1000 of 1201" in caplog.text
    assert path.is_file()


def test_a_finished_import_reads_only_its_marker_and_never_the_file(tmp_path, monkeypatch):
    path = _old_cache_file(tmp_path, 3)
    connection = _Connection(imported=True)
    monkeypatch.setattr(type(path), "read_text", lambda *_a, **_k: pytest.fail("the old file was read"))

    result = import_cover_search_cache_file(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://cache", "COVER_CACHE_PATH": path}, connect=connection,
    )

    assert result == {"status": "done"}
    assert len(connection.statements) == 1


def test_a_stopped_import_records_nothing_finished_so_the_next_startup_resumes(tmp_path):
    path = _old_cache_file(tmp_path, 1_200)
    connection = _Connection()
    stop = threading.Event()
    stop.set()

    result = import_cover_search_cache_file(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://cache", "COVER_CACHE_PATH": path},
        connect=connection, stop_requested=stop,
    )

    assert result == {"status": "stopped", "imported": 0, "total": 1_200}
    assert not any("cover_provider_cache_imports (source" in sql for sql, _ in connection.statements)


def test_a_browse_only_sandbox_skips_the_import(tmp_path):
    connection = _Connection()

    result = import_cover_search_cache_file(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://cache", "COVER_CACHE_PATH": _old_cache_file(tmp_path, 2),
         "SHARED_LIBRARY_BROWSE_ONLY": True},
        connect=connection,
    )

    assert result == {"status": "skipped"}
    assert connection.statements == []


def test_without_an_old_file_the_import_records_zero_entries(tmp_path):
    connection = _Connection()

    result = import_cover_search_cache_file(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://cache", "COVER_CACHE_PATH": tmp_path / "absent.json"},
        connect=connection,
    )

    assert result == {"status": "imported", "total": 0}
    assert connection.statements[-1][1] == ("cover_search_cache_json", 0)


@pytest.fixture
def cover_cache_database(monkeypatch):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        yield runtime_url
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


def _connect(url):
    return isolatedPostgres._connect(url)


def test_postgres_rows_are_read_by_primary_key_and_upserted_per_key(cover_cache_database, tmp_path):
    url = cover_cache_database
    writer = CoverSearchCache(url, connect=_connect)
    writer.set("artist::album", {"missing": True})
    writer.set("musicbrainz-release::artist::album", {"updated_at": 1.0, "releases": [{"id": "release-1"}]})
    writer.save()
    writer.set("artist::album", {"url": "https://images.example/cover.jpg"})
    writer.save()

    restarted = CoverSearchCache(url, connect=_connect)
    assert restarted.get("artist::album") == {"url": "https://images.example/cover.jpg"}
    assert restarted.get("musicbrainz-release::artist::album") == {"updated_at": 1.0, "releases": [{"id": "release-1"}]}
    assert restarted.get("absent::album") is None
    with _connect(url) as connection:
        indexes = [row["indexdef"] for row in connection.execute(
            "select indexdef from pg_indexes where schemaname = 'library' and tablename = 'cover_provider_cache_entries'"
        ).fetchall()]
    assert any(definition.startswith("CREATE UNIQUE INDEX") and definition.endswith("(cache_key)")
               for definition in indexes), indexes

    path = tmp_path / "cover_search_cache.json"
    path.write_text(json.dumps({"queries": {
        "artist::album": {"missing": True},
        "imported::album": {"missing": True},
    }}), encoding="utf-8")
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": url, "COVER_CACHE_PATH": path}
    assert import_cover_search_cache_file(config, connect=_connect) == {"status": "imported", "total": 2}
    assert import_cover_search_cache_file(config, connect=_connect) == {"status": "done"}
    # Rows already in Postgres win over the old file.
    assert restarted.get("artist::album") == {"url": "https://images.example/cover.jpg"}
    assert restarted.get("imported::album") == {"missing": True}


def test_cover_query_key_preserves_automatic_refresh_normalization():
    assert (
        cover_provider_cache.cover_query_key("Beyonce & Jay-Z", "Lemonade!", "Deluxe Edition", 2016)
        == "beyonce and jay z::lemonade exclamation mark::deluxe edition::2016"
    )
    assert cover_provider_cache.cover_query_key(" Artist ", " Album ", None, None) == "artist::album::::"


def test_musicbrainz_release_disk_cache_namespace_filters_and_skips_empty(monkeypatch):
    cache = CoverSearchCache()
    monkeypatch.setattr(cover_provider_cache, "_shared_cover_search_cache", lambda: cache)
    monkeypatch.setattr(cover_provider_cache.time, "time", lambda: 1234.0)

    cover_provider_cache._set_musicbrainz_release_disk_cache("artist::album", ["malformed"])

    assert cache.get("musicbrainz-release::artist::album") is None

    cover_provider_cache._set_musicbrainz_release_disk_cache(
        "artist::album",
        [
            {"id": "release-1", "title": "Album"},
            "malformed",
            {"id": "release-2", "title": "Deluxe"},
        ],
    )

    assert cache.get("artist::album") is None
    assert cache.get("musicbrainz-release::artist::album") == {
        "updated_at": 1234.0,
        "releases": [
            {"id": "release-1", "title": "Album"},
            {"id": "release-2", "title": "Deluxe"},
        ],
    }
    assert cover_provider_cache._get_musicbrainz_release_disk_cache("artist::album") == [
        {"id": "release-1", "title": "Album"},
        {"id": "release-2", "title": "Deluxe"},
    ]


def test_caa_results_disk_cache_namespace_filters_ttl_and_skips_empty(monkeypatch):
    cache = CoverSearchCache()
    now = 2_000.0
    monkeypatch.setattr(cover_provider_cache, "_shared_cover_search_cache", lambda: cache)
    monkeypatch.setattr(cover_provider_cache.time, "time", lambda: now)

    cover_provider_cache._set_caa_results_disk_cache("release-1", ["malformed"])

    assert cache.get("caa-results::release-1") is None

    cover_provider_cache._set_caa_results_disk_cache(
        "release-1",
        [
            {"image": "https://images.example/front.jpg"},
            "malformed",
            {"image": "https://images.example/back.jpg"},
        ],
    )

    assert cache.get("release-1") is None
    assert cache.get("caa-results::release-1") == {
        "updated_at": now,
        "ttl_seconds": cover_provider_cache._CAA_RESULTS_CACHE_TTL_SECONDS,
        "candidates": [
            {"image": "https://images.example/front.jpg"},
            {"image": "https://images.example/back.jpg"},
        ],
    }
    assert cover_provider_cache._get_caa_results_disk_cache("release-1") == [
        {"image": "https://images.example/front.jpg"},
        {"image": "https://images.example/back.jpg"},
    ]

    cache.set(
        "caa-results::expired",
        {
            "updated_at": now - cover_provider_cache._CAA_RESULTS_CACHE_TTL_SECONDS - 1,
            "candidates": [{"image": "https://images.example/old.jpg"}],
        },
    )
    cache.set(
        "caa-results::malformed",
        {
            "updated_at": now,
            "candidates": {"image": "https://images.example/not-a-list.jpg"},
        },
    )
    cache.set(
        "caa-results::stored-ttl-is-ignored",
        {
            "updated_at": now - 1,
            "ttl_seconds": 0,
            "candidates": [{"image": "https://images.example/fresh.jpg"}],
        },
    )

    assert cover_provider_cache._get_caa_results_disk_cache("expired") is None
    assert cover_provider_cache._get_caa_results_disk_cache("malformed") is None
    assert cover_provider_cache._get_caa_results_disk_cache("stored-ttl-is-ignored") == [
        {"image": "https://images.example/fresh.jpg"},
    ]
