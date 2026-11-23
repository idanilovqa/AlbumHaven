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
    if "category" not in params:
        # 6.5 (option 1): a common scope is built by startup, scans, the watcher and tag saves, never a request.
        assert queued == [], "a request never schedules a common scope"
        return
    # A custom scope has no other owner: its first build is queued for that scope alone.
    assert len(queued) == 1
    assert queued[0][0] is config
    assert queued[0][1]["view_state"] == browse._root_sidebar_view_state(params)


def test_stale_gallery_serves_immediately_and_leaves_its_refresh_to_the_owners(monkeypatch):
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
    assert payload["gallery_page"]["projection_stale"] is True, "the last published page, with the stale note"
    # 6.5 (option 1): a stale published scope is refreshed by its owners (scan, watcher, tag save).
    assert queued == []
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


# 6.5 (option 1, #65): opening the gallery never starts a whole-scope rebuild. Common scopes are built by
# startup and refreshed by scans, the watcher and tag saves; a request serves the last published page (with
# the stale note) or the existing Pending state.

class _SnapshotConnection:
    def execute(self, sql, _params=None):
        rows = []
        if sql == browse._relation_alias_maps_sql():
            rows = [{"alias_to_canonical": {}, "canonical_to_aliases": {}}]
        else:
            assert sql.startswith("SET TRANSACTION"), sql
        return SimpleNamespace(fetchone=lambda: rows[0] if rows else None, fetchall=lambda: list(rows))

    def rollback(self):
        pass

    def close(self):
        pass


def _pending_repository(monkeypatch, config, *, generation=2):
    context = {"library_id": 1, "generation": generation}
    repository = browse.PostgresLibraryBrowseRepository(
        config, connect=lambda _: _SnapshotConnection(), album_ratings_service=_EmptyAlbumRatingsService())
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: context)
    monkeypatch.setattr(gallery, "load_gallery_projection_page", lambda *_a, **_k: None)
    monkeypatch.setattr(gallery, "load_gallery_projection_sidebar", lambda *_a, **_k: None)
    return repository, context


def test_requests_after_a_failed_common_refresh_schedule_and_publish_nothing(monkeypatch):
    """(a) N requests after a failed common refresh schedule nothing; (b) retried requests publish nothing new."""
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-failed-common-refresh"}
    repository, _context = _pending_repository(monkeypatch, config)
    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh",
                        lambda *_a, **_k: pytest.fail("a request scheduled a common scope refresh"))
    monkeypatch.setattr(gallery, "publish_gallery_projection",
                        lambda *_a, **_k: pytest.fail("a request published a common scope"))
    monkeypatch.setattr(gallery, "queue_gallery_projection_snapshot",
                        lambda *_a, **_k: pytest.fail("a request published a live-computed scope"))
    for _request in range(5):
        for params in ({"gallery_page_size": "8"}, {"gallery_page_size": "50", "gallery_scope": "new_arrivals"}):
            with pytest.raises(browse.GalleryProjectionPending):
                repository.build_root_startup_preview_payload(query_params=params)
        with pytest.raises(browse.GalleryProjectionPending):
            repository.build_projected_root_sidebar_payload()


def test_the_next_source_change_recovers_a_common_scope_once(monkeypatch):
    """(c) After a failed refresh, the next committed watcher change schedules exactly one refresh."""
    from music_app.services import state as state_service

    scheduled = []
    monkeypatch.setattr(state_service, "schedule_gallery_projection_refresh", lambda config: scheduled.append(config))
    monkeypatch.setattr(state_service, "refresh_postgres_utility_projections_after_edit", lambda *_a, **_k: None)
    monkeypatch.setattr(state_service, "library_browse_postgres_is_effective", lambda _config: False)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-recovering-common-scope"}
    state_service.invalidate_targeted_library_projections(
        {}, config, revision=7, affected_album_keys=("artist::album",), track_paths=("/music/a.flac",),
    )
    assert scheduled == [config]


class _RunningExecutor:
    """Runs each submitted action at once, as the write executor's thread would, into a completed future."""

    def __init__(self):
        self.submitted = 0

    def submit(self, action):
        from concurrent.futures import Future

        self.submitted += 1
        future = Future()
        try:
            future.set_result(action())
        except Exception as error:
            future.set_exception(error)
        return future


def test_a_failed_custom_first_build_is_not_queued_again_at_the_same_generation(monkeypatch):
    """(d) A paged request queues a never-built custom scope's first build once; after it fails, more requests
    at the same source generation queue nothing, including one that arrives the moment the build's
    single-flight slot is released; a source change allows one more."""
    from music_app.services import cache

    executor = _RunningExecutor()
    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", executor)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-custom-first-build"}
    repository, context = _pending_repository(monkeypatch, config)
    params = {"gallery_page_size": "8", "category": "hoard"}
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready",
                        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("custom scope build failed")))

    def request():
        with pytest.raises(browse.GalleryProjectionPending):
            repository.build_root_startup_preview_payload(query_params=params)

    import threading

    gap = {"armed": True, "released": False}

    class ReleasingPending(dict):
        """Notes the moment the failed build's single-flight slot is popped."""

        def pop(self, key, *default):
            value = super().pop(key, *default)
            if gap["armed"]:
                gap["armed"], gap["released"] = False, True
            return value

    class GapLock:
        """A request lands right after that slot's lock is released, before any later completion callback."""

        def __init__(self):
            self._lock = threading.Lock()

        def __enter__(self):
            self._lock.acquire()
            return self

        def __exit__(self, *_exc):
            self._lock.release()
            if gap["released"]:
                gap["released"] = False
                request()
            return False

    monkeypatch.setattr(gallery, "_PENDING", ReleasingPending())
    monkeypatch.setattr(gallery, "_PENDING_LOCK", GapLock())
    request()
    assert executor.submitted == 1, "the failure is recorded before the slot is released"
    for _request in range(5):
        request()
    assert executor.submitted == 1, "a failed first build is not queued again at the same generation"
    context["generation"] = 3
    request()
    assert executor.submitted == 2, "a source change allows one more first build"


def test_concurrent_custom_first_builds_submit_one_action_and_no_trailing_rebuild(monkeypatch):
    """Two requests for the same never-built custom scope at once queue exactly one build, and nothing runs
    after it."""
    import threading
    from concurrent.futures import Future
    from music_app.services import cache

    submitted = []

    class Executor:
        def submit(self, action):
            future = Future()
            submitted.append(future)
            return future

    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", Executor())
    monkeypatch.setattr(gallery, "_PENDING", {})
    barrier = threading.Barrier(2, timeout=5)
    schedule = gallery.schedule_gallery_projection_refresh

    def together(*args, **kwargs):
        barrier.wait()  # both requests have passed any check before either queues
        return schedule(*args, **kwargs)

    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh", together)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-concurrent-first-build"}
    state = browse._root_sidebar_view_state({"category": "hoard"})
    threads = [threading.Thread(target=gallery.queue_gallery_scope_first_build,
                                kwargs={"config": config, "view_state": state, "generation": 2})
               for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert len(submitted) == 1
    submitted[0].set_result({"built": 1})
    assert len(submitted) == 1, "no trailing second build after the first one"


def test_a_custom_first_build_never_falls_into_a_whole_library_rebuild(monkeypatch):
    """With incremental membership, a first build whose relations need a full gallery rebuild leaves that to
    its owner: no ensure_gallery_projection_ready, and nothing recorded as failed at this generation."""
    from music_app.services import cache, scoped_relation_projection

    monkeypatch.setattr(cache, "_CACHE_WRITE_EXECUTOR", _RunningExecutor())
    monkeypatch.setattr(gallery, "_PENDING", {})
    monkeypatch.setattr(scoped_relation_projection, "ensure_pending_relation_projection_ready",
                        lambda *_a, **_k: {"initialized": True, "gallery_rebuild_required": True})
    monkeypatch.setattr(gallery, "ensure_gallery_projection_ready",
                        lambda *_a, **_k: pytest.fail("a first build ran the whole-library gallery rebuild"))
    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready",
                        lambda *_a, **_k: pytest.fail("a first build ran a gallery build"))
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-first-build-rebuild-required"}
    state = browse._root_sidebar_view_state({"category": "hoard"})
    gallery.queue_gallery_scope_first_build(config, view_state=state, generation=2, incremental_membership=True)
    key = (config["ALBUM_HAVEN_APP_DATABASE_URL"], gallery.gallery_projection_scope_key(state))
    assert key not in gallery._FAILED_FIRST_BUILDS, "the owner's rebuild moves the generation; no failure here"


def test_a_request_with_a_published_common_scope_never_publishes_a_live_snapshot(monkeypatch):
    """main's live-compute publication (library_browse_postgres.py, queue_gallery_projection_snapshot) is never
    taken once a common scope is published."""
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-published-common-scope"}
    repository, _context = _pending_repository(monkeypatch, config)

    def published(_connection, _state, _params, **_kwargs):
        metadata = browse._root_gallery_page_metadata("published-revision", 0, 8, 0, 0)
        return [], [], 0, metadata

    monkeypatch.setattr(gallery, "load_gallery_projection_page", published)
    monkeypatch.setattr(gallery, "schedule_gallery_projection_refresh",
                        lambda *_a, **_k: pytest.fail("a published scope scheduled a refresh"))
    monkeypatch.setattr(gallery, "queue_gallery_projection_snapshot",
                        lambda *_a, **_k: pytest.fail("a published scope took the live-compute branch"))
    monkeypatch.setattr(repository._inventory_repository, "load_support_state",
                        lambda **_: {"ignored_version_keys": [], "manual_version_links": {}})
    monkeypatch.setattr(repository, "_load_non_album_entries", lambda **_: [])
    payload = repository.build_root_startup_preview_payload(query_params={"gallery_page_size": "8"})
    assert "projection_stale" not in payload["gallery_page"]
