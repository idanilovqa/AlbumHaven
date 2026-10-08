"""Gallery projection must preserve the established root semantic oracle."""
import copy
from concurrent.futures import Future
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from music_app.services import library_browse_postgres as browse


def membership(artist, key, *, year=2000):
    return dict(artist_name=artist, artist_id=artist, album_id=len(key),
                    album_key=key, album_title=key, album_release_year=year)


def test_gallery_extraction_preserves_073f75b_golden_order_and_cursor():
    # Literal results captured from the unchanged 073f75b selector, before extraction.
    rows = [membership("Alias", "shared"), membership("Canonical", "shared"),
            membership("Featured", "shared"), membership("# Artist", "punctuation"),
            membership("Éclair", "unicode"), membership("日本語", "japanese"),
            membership("Owner feat. Guest", "compound"), membership("Wrong live owner", "lost"),
            membership("2 Artist", "numeric")]
    missing = [dict(key="lost", album_artist="Before", name="Lost", year=1990)]
    aliases = {"Alias": "Canonical", "Owner feat. Guest": "Owner"}
    state = {"gallery_scope": "all", "visible_library_categories": ["hoard", "main_library"]}
    snapshot = browse._prepare_root_gallery_snapshot(rows, missing, aliases, state)
    assert [(row["artist_name"], row["album_key"]) for row in snapshot["ordered"]] == [
        ("# Artist", "punctuation"), ("2 Artist", "numeric"), ("Before", "lost"),
        ("Canonical", "shared"), ("Featured", "shared"), ("Owner", "compound"),
        ("Éclair", "unicode"), ("日本語", "japanese"),
    ]
    assert snapshot["sidebar"] == [
        {"artist": artist, "artist_display": artist, "count": 1}
        for artist in ["# Artist", "2 Artist", "Before", "Canonical", "Featured", "Owner", "Éclair", "日本語"]
    ]
    assert snapshot["album_count"] == 7
    assert snapshot["occurrence_count"] == 8
    page = browse._select_root_gallery_snapshot_page(snapshot, {"gallery_page_size": "2"})
    assert page[3] == {
        "next_cursor": "WzEsICI3Yzg5NTVjMzNlNzI3ZTJhODdiZTE1MmRlOTFkZWVmMDdkMDJiY2MzMGZhYzQxNWFmMzI3ZjFmMTlkMzAwYTg2IiwgMl0",
        "has_more": True, "revision": "7c8955c33e727e2a87be152de91deef07d02bcc30fac415af327f1f19d300a86", "page_size": 2,
    }
    continuation = browse._select_root_gallery_snapshot_page(snapshot, {
        "gallery_page_size": "2", "gallery_cursor": page[3]["next_cursor"]})
    assert [(row["artist_name"], row["album_key"]) for row in continuation[0]] == [("Before", "lost"), ("Canonical", "shared")]


def test_empty_gallery_preserves_073f75b_golden_cursor_revision():
    page, sidebar, count, metadata = browse._root_gallery_page_selection([], [], {}, {}, {"gallery_page_size": "2"})
    assert page == sidebar == []
    assert count == 0
    assert metadata == {"next_cursor": None, "has_more": False,
                        "revision": "d0d11bca0f82dc3bef1ba5eaa3cc6d144832fc5aa9b2081d516c76513b186bfa", "page_size": 2}


@pytest.mark.parametrize("categories", [[], ["main_library"], ["hoard", "new_arrivals"]])
def test_prepared_gallery_snapshot_preserves_complete_oracle_and_cursor(categories):
    rows = [membership("Alias", "shared"), membership("Canonical", "shared"),
            membership("Featured", "shared"), membership("# Artist", "first"),
            membership("Éclair", "last", year=1998)]
    missing = [dict(key="lost", album_artist="Before", name="Lost", year=1990)]
    aliases = {"Alias": "Canonical"}
    state = {"gallery_scope": "all", "visible_library_categories": categories}
    original = copy.deepcopy((rows, missing, aliases, state))
    prepared = browse._prepare_root_gallery_snapshot(rows, missing, aliases, state)
    cursor = None
    while True:
        params = {"gallery_page_size": "2"}
        if cursor:
            params["gallery_cursor"] = cursor
        expected = browse._root_gallery_page_selection(rows, missing, aliases, state, params)
        actual = browse._select_root_gallery_snapshot_page(prepared, params)
        assert actual == expected
        cursor = actual[3]["next_cursor"]
        if not cursor:
            break
    assert (rows, missing, aliases, state) == original


def test_prepared_snapshot_keeps_legacy_cursor_hash_for_presentation_changes():
    rows = [membership("Artist", str(i)) for i in range(3)]
    first = browse._root_gallery_page_selection(rows, [], {}, {}, {"gallery_page_size": "1"})
    prepared = browse._prepare_root_gallery_snapshot(rows, [], {}, {
        "gallery_display_mode": "rows", "gallery_scale_percent": 75})
    second = browse._select_root_gallery_snapshot_page(prepared, {
        "gallery_page_size": "1", "gallery_cursor": first[3]["next_cursor"]})
    assert second[3]["revision"] == first[3]["revision"]
    assert second[0][0]["album_key"] == "1"


def test_projection_scope_preserves_category_order_but_ignores_presentation():
    from music_app.services.gallery_projection_postgres import gallery_projection_scope_key
    first = {"gallery_scope": "all", "visible_library_categories": ["hoard", "main_library"]}
    changed = {**first, "gallery_display_mode": "rows", "gallery_scale_percent": 75}
    reversed_categories = {**first, "visible_library_categories": ["main_library", "hoard"]}
    assert gallery_projection_scope_key(first) == gallery_projection_scope_key(changed)
    assert gallery_projection_scope_key(first) != gallery_projection_scope_key(reversed_categories)


def test_projection_occurrences_exclude_mutable_missing_details_and_private_paths():
    from music_app.services.gallery_projection_postgres import projection_occurrences
    row = {**membership("Missing", "lost"), "artist_sort_name": "missing",
           "private_path": "private/source", "missing_album": {"key": "lost", "cover": "old"}}
    result = projection_occurrences({"ordered": [row]})
    assert result[0]["missing_album_key"] == "lost"
    assert "private_path" not in result[0]
    assert "missing_album" not in result[0]


def test_refresh_scheduled_during_publication_runs_once_afterward(monkeypatch):
    from music_app.services import cache, gallery_projection_postgres as projection
    submitted = []
    class Executor:
        def submit(self, action):
            future = Future()
            submitted.append((action, future))
            return future
    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", Executor())
    monkeypatch.setattr(projection, "_PENDING", {})
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-test"}
    calls = []
    def refresh(*args, **kwargs):
        calls.append("refresh")
        if len(calls) == 1:
            for _ in range(3):
                projection.schedule_gallery_projection_refresh(config)
    monkeypatch.setattr(projection, "ensure_gallery_projection_ready", refresh)
    projection.schedule_gallery_projection_refresh(config)
    submitted[0][1].set_result(submitted[0][0]())
    assert len(submitted) == 2
    submitted[1][1].set_result(submitted[1][0]())
    assert calls == ["refresh", "refresh"]
    assert projection._PENDING == {}


@pytest.mark.parametrize("generations, expected", [(range(100), [0, 99]), ([0, 2, 1], [0, 2])])
def test_snapshot_queue_keeps_only_latest_generation_per_scope(monkeypatch, generations, expected):
    from music_app.services import cache, gallery_projection_postgres as projection
    submitted, published = [], []
    class Executor:
        def submit(self, action):
            future = Future()
            submitted.append((action, future))
            return future
    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", Executor())
    monkeypatch.setattr(projection, "_PENDING", {})
    monkeypatch.setattr(projection, "publish_gallery_projection",
                        lambda config, context, *args, **kwargs: published.append(context["generation"]))
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-test"}
    for generation in generations:
        projection.queue_gallery_projection_snapshot(config, {"library_id": 1, "generation": generation}, {}, {})
    assert len(submitted) == len(projection._PENDING) == 1
    submitted[0][1].set_result(submitted[0][0]())
    assert len(submitted) == 2
    submitted[1][1].set_result(submitted[1][0]())
    assert published == expected
    assert not projection._PENDING


def test_invalid_page_size_does_not_consume_membership():
    def rows():
        raise AssertionError("membership must not be read")
        yield
    with pytest.raises(ValueError):
        browse._root_gallery_page_selection(rows(), [], {}, {}, {"gallery_page_size": "0"})


def test_readonly_projection_never_connects_or_queues(monkeypatch):
    from music_app.services import gallery_projection_postgres as projection
    def forbidden(*args, **kwargs):
        pytest.fail("read-only browse attempted a write or connection")
    monkeypatch.setattr(projection, "_PENDING", {})
    config = {"SHARED_LIBRARY_BROWSE_ONLY": True, "ALBUM_HAVEN_APP_DATABASE_URL": "owned-test"}
    assert projection.ensure_gallery_projection_ready(config, connect=forbidden) == {"built": 0}
    assert projection.publish_gallery_projection(config, {"library_id": 1}, {}, {}, connect=forbidden) is False
    assert projection.schedule_gallery_projection_refresh(config, connect=forbidden) is None
    assert not projection._PENDING


@pytest.mark.parametrize("failure", [None, RuntimeError, InterruptedError])
def test_startup_gallery_failure_falls_back_but_cancellation_propagates(monkeypatch, failure):
    from music_app.services import state, gallery_projection_postgres as projection
    app = SimpleNamespace(config={"ALBUM_HAVEN_APP_DATABASE_URL": "owned-test"}, library_state={}, logger=Mock())
    monkeypatch.setattr(state, "ensure_relation_projection_ready", lambda *args, **kwargs: {"ready": True})
    def ensure(*args, **kwargs):
        if failure:
            raise failure("owned test")
        return {"built": 2}
    monkeypatch.setattr(projection, "ensure_gallery_projection_ready", ensure)
    if failure is InterruptedError:
        with pytest.raises(InterruptedError):
            state.ensure_runtime_relation_projection_ready(app)
    else:
        assert state.ensure_runtime_relation_projection_ready(app)["ready"]
        assert app.logger.exception.called == (failure is RuntimeError)


def test_startup_without_database_does_not_attempt_gallery_preparation(monkeypatch):
    from music_app.services import state, gallery_projection_postgres as projection
    app = SimpleNamespace(config={}, library_state={}, logger=Mock())
    monkeypatch.setattr(state, "ensure_relation_projection_ready", lambda *args, **kwargs: {"ready": True})
    ensure = Mock()
    monkeypatch.setattr(projection, "ensure_gallery_projection_ready", ensure)
    assert state.ensure_runtime_relation_projection_ready(app)["ready"]
    ensure.assert_not_called()
    app.logger.exception.assert_not_called()


def test_old_schema_context_uses_accurate_fallback():
    from music_app.services import gallery_projection_postgres as projection
    calls = []
    class Connection:
        def execute(self, sql):
            calls.append(sql)
            assert "to_regclass" in sql
            return SimpleNamespace(fetchone=lambda: {"installed": False})
    assert projection.load_gallery_projection_page(Connection(), {}, {}) is None
    assert len(calls) == 1


def test_cancellation_after_capture_prevents_publication(monkeypatch):
    from music_app.services import gallery_projection_postgres as projection
    class Connection:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def execute(self, *args):
            return SimpleNamespace(fetchall=lambda: [])
    repository = SimpleNamespace(
        _connect_to_database=Connection,
        _load_relation_alias_maps=lambda **kwargs: {"alias_to_canonical": {}},
        _load_missing_album_rows=lambda **kwargs: [],
    )
    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", lambda *args, **kwargs: repository)
    monkeypatch.setattr(projection, "gallery_projection_context", lambda connection: {"library_id": 1})
    monkeypatch.setattr(projection, "_ready_header", lambda *args: None)
    published = Mock()
    monkeypatch.setattr(projection, "publish_gallery_projection", published)
    cancellation = iter((False, False, True))
    with pytest.raises(InterruptedError, match="publication cancelled"):
        projection.ensure_gallery_projection_ready({}, cancel_requested=lambda: next(cancellation))
    published.assert_not_called()


@pytest.mark.parametrize("fails", [False, True])
def test_full_scan_refresh_scheduled_only_after_successful_commit(monkeypatch, fails):
    from pathlib import Path
    from music_app.services import cache, gallery_projection_postgres as projection
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    order = []
    adapter = object.__new__(PostgresScanCacheAdapter)
    adapter._connect = Mock()
    def save(*args, **kwargs):
        order.append("commit")
        if fails:
            raise RuntimeError("publication rejected")
        return {"ready": True}
    monkeypatch.setattr(adapter, "save_snapshot", save)
    monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda config: adapter)
    monkeypatch.setattr(projection, "schedule_gallery_projection_refresh", lambda *args, **kwargs: order.append("refresh"))
    if fails:
        with pytest.raises(RuntimeError):
            cache.save_cache_to_disk_for_config({}, Path("unused"), {}, "root", 1)
        assert order == ["commit"]
    else:
        assert cache.save_cache_to_disk_for_config({}, Path("unused"), {}, "root", 1) == {"ready": True}
        assert order == ["commit", "refresh"]


@pytest.mark.parametrize("size", [8, 50])
@pytest.mark.parametrize("missing", [False, True])
def test_ready_page_bounds_hydration_and_bypasses_membership_work(monkeypatch, size, missing):
    from music_app.services import gallery_projection_postgres as projection
    from tests.py.test_library_browse_postgres import _browse_album_row, _EmptyAlbumRatingsService
    rows = [_browse_album_row(artist="Artist", album_id=i, album_key=f"album-{i}", title=f"Album {i}")
            for i in range(1, 102)]
    snapshot = browse._prepare_root_gallery_snapshot(rows, [], {}, browse._root_sidebar_view_state({}))
    if missing:
        for row in snapshot["ordered"]:
            row["missing_album_key"] = row["album_key"]
            row["album_id"] = None
    calls = []
    class Connection:
        def execute(self, sql, params=None):
            calls.append((sql, params))
            if "gallery_album_ids" in (params or {}):
                result = [row for row in rows if row["album_id"] in params["gallery_album_ids"]]
            elif sql == browse._relation_alias_maps_sql():
                result = [{"alias_to_canonical": {}, "canonical_to_aliases": {}}]
            else:
                assert sql.startswith("SET TRANSACTION")
                result = []
            return type("Cursor", (), {"fetchall": lambda self: result})()
        def rollback(self):
            calls.append(("rollback", None))
        def close(self):
            calls.append(("close", None))
    connection = Connection()
    repository = browse.PostgresLibraryBrowseRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-test"}, connect=lambda _: connection,
        album_ratings_service=_EmptyAlbumRatingsService())
    monkeypatch.setattr(projection, "gallery_projection_context", lambda connection: {"library_id": 1})
    monkeypatch.setattr(projection, "load_gallery_projection_page", lambda connection, state, params, **kwargs:
                        browse._select_root_gallery_snapshot_page(snapshot, params))
    def forbidden(*args, **kwargs):
        pytest.fail("ready page recomputed whole membership or alias readiness")
    monkeypatch.setattr(repository, "_load_relation_alias_maps", forbidden)
    monkeypatch.setattr(browse, "_prepare_root_gallery_snapshot", forbidden)
    missing_calls = []
    def load_missing(*, album_keys, connection):
        missing_calls.append(album_keys)
        return [{"key": key, "name": key, "album_artist": "Artist"} for key in album_keys]
    monkeypatch.setattr(repository, "_load_missing_album_rows", load_missing if missing else forbidden)
    if missing:
        monkeypatch.setattr(browse, "_missing_album_projection_payloads", lambda rows, **kwargs: rows)
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **kwargs: [])
    monkeypatch.setattr(repository._inventory_repository, "load_support_state", lambda **kwargs:
                        {"ignored_version_keys": [], "manual_version_links": {}})
    monkeypatch.setattr(browse, "_queue_display_cover_variants_for_groups", lambda *args: None)
    payload = repository.build_root_startup_preview_payload(query_params={"gallery_page_size": str(size)})
    assert payload["album_count"] == 101
    assert sum(len(group["albums"]) for group in payload["artist_groups"]) == size
    hydrated = [params["gallery_album_ids"] for _, params in calls if params and "gallery_album_ids" in params]
    if missing:
        assert not hydrated
        assert len(missing_calls) == 1 and len(missing_calls[0]) == size
    else:
        assert len(hydrated) == 1 and len(hydrated[0]) == size
    assert calls[-2:] == [("rollback", None), ("close", None)]
