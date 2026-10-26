"""Gallery requests defer unavailable persisted views without scanning inventory."""
from types import SimpleNamespace

import pytest

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import library_browse_postgres as browse
from tests.py.test_library_browse_postgres import _EmptyAlbumRatingsService


@pytest.mark.parametrize("params", [{"gallery_page_size": "8"}, {"gallery_page_size": "50", "category": "hoard"}])
def test_pending_gallery_queues_exact_scope_without_membership_work(monkeypatch, params):
    calls, queued = [], []

    class Connection:
        def execute(self, sql, _params=None):
            assert sql.startswith("SET TRANSACTION")
            calls.append("snapshot")

        def rollback(self):
            calls.append("rollback")

        def close(self):
            calls.append("close")

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-gallery-pending"}
    repository = browse.PostgresLibraryBrowseRepository(
        config, connect=lambda _: Connection(), album_ratings_service=_EmptyAlbumRatingsService())
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: {"library_id": 1, "generation": 2})
    monkeypatch.setattr(gallery, "load_gallery_projection_page", lambda *_a, **_k: None)
    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh",
                        lambda current, **kwargs: queued.append((current, kwargs)))
    monkeypatch.setattr(repository, "_load_relation_alias_maps",
                        lambda **_: pytest.fail("pending request expanded aliases"))
    monkeypatch.setattr(repository._inventory_repository, "load_support_state",
                        lambda **_: pytest.fail("pending request read support inventory"))
    with pytest.raises(browse.GalleryProjectionPending):
        repository.build_root_startup_preview_payload(query_params=params)
    assert calls == ["snapshot", "rollback", "close"]
    assert len(queued) == 1
    assert queued[0][0] is config
    assert queued[0][1]["view_state"] == browse._root_sidebar_view_state(params)


def test_stale_gallery_serves_immediately_and_refreshes_in_background(monkeypatch):
    calls, queued = [], []
    params = {"gallery_page_size": "8"}

    class Cursor:
        def __init__(self, rows=None):
            self.rows = list(rows or [])

        def fetchone(self):
            return self.rows[0] if self.rows else None

        def fetchall(self):
            return list(self.rows)

    class Connection:
        def execute(self, sql, _params=None):
            calls.append(sql)
            if sql.startswith("SET TRANSACTION"):
                return Cursor()
            if sql == browse._relation_alias_maps_sql():
                return Cursor([{"alias_to_canonical": {}, "canonical_to_aliases": {}}])
            raise AssertionError(sql)

        def rollback(self):
            calls.append("rollback")

        def close(self):
            calls.append("close")

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-stale-gallery"}
    repository = browse.PostgresLibraryBrowseRepository(
        config,
        connect=lambda _: Connection(),
        album_ratings_service=_EmptyAlbumRatingsService(),
    )
    monkeypatch.setattr(
        gallery,
        "gallery_projection_context",
        lambda _: {"library_id": 1, "generation": 3},
    )

    def load_stale(_connection, _state, _params, **kwargs):
        assert kwargs["allow_stale"] is True
        metadata = browse._root_gallery_page_metadata(
            "stale-revision", 0, 8, 0, 0,
        )
        metadata.update(
            projection_stale=True,
            source_generation=2,
        )
        return [], [], 0, metadata

    monkeypatch.setattr(gallery, "load_gallery_projection_page", load_stale)
    monkeypatch.setattr(
        gallery,
        "schedule_gallery_projection_refresh",
        lambda current, **kwargs: queued.append((current, kwargs)),
    )
    monkeypatch.setattr(
        repository._inventory_repository,
        "load_support_state",
        lambda **_: {
            "ignored_version_keys": [],
            "manual_version_links": {},
        },
    )
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_: [])

    payload = repository.build_root_startup_preview_payload(query_params=params)

    assert payload["album_count"] == 0
    assert payload["gallery_page"]["projection_stale"] is True
    assert len(queued) == 1
    assert queued[0][0] is config
    assert queued[0][1]["view_state"] == browse._root_sidebar_view_state(params)
    assert browse._root_gallery_membership_sql() not in calls


def test_custom_gallery_scope_is_prepared_without_common_scope_work(monkeypatch):
    from contextlib import contextmanager

    scopes = []
    state = browse._root_sidebar_view_state({"category": "hoard"})

    class Connection:
        def execute(self, _sql, _params=None):
            return SimpleNamespace(fetchall=lambda: [])

    class Repository:
        def __init__(self, *_a, **_k):
            pass

        def _load_relation_alias_maps(self, **_kwargs):
            return {"alias_to_canonical": {}, "canonical_to_aliases": {}}

        def _load_missing_album_rows(self, **_kwargs):
            return []

        @contextmanager
        def _connect_to_database(self):
            yield Connection()

    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: {"library_id": 1, "generation": 2})
    monkeypatch.setattr(gallery, "_ready_header", lambda *_: None)
    monkeypatch.setattr(gallery, "publish_gallery_projection",
                        lambda _config, _context, current, _snapshot, **_kwargs: scopes.append(current) or True)
    assert gallery.ensure_gallery_projection_ready(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-custom-gallery"}, view_state=state) == {"built": 1}
    assert scopes == [state]


@pytest.mark.parametrize("custom", [False, True])
def test_scope_refresh_coalesces_and_releases_failed_owner(monkeypatch, custom):
    from concurrent.futures import Future
    from music_app.services import cache

    submitted = []
    prepared = []

    class Executor:
        def submit(self, action):
            future = Future()
            submitted.append((action, future))
            return future

    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", Executor())
    monkeypatch.setattr(gallery, "_PENDING", {})
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready",
                        lambda _config, **kwargs: prepared.append(kwargs) or {"built": 1})
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-scoped-refresh"}
    state = browse._root_sidebar_view_state({"category": "hoard"} if custom else {})
    expected = {**state, "visible_library_categories": list(state["visible_library_categories"])}
    first = gallery.schedule_gallery_projection_refresh(config, view_state=state)
    assert gallery.schedule_gallery_projection_refresh(config, view_state=state) is None
    assert len(submitted) == 1
    first.set_exception(RuntimeError("owned recovery failure"))
    assert len(submitted) == 1
    assert not gallery._PENDING

    retry = gallery.schedule_gallery_projection_refresh(config, view_state=state)
    state["visible_library_categories"].append("changed-after-queue")
    action, future = submitted[1]
    assert retry is future
    future.set_result(action())
    assert prepared == [{"connect": None, **({"view_state": expected} if custom else {})}]
    assert not gallery._PENDING
