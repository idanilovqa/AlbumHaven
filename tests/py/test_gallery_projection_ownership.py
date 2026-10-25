"""Ownership and publication ordering for background gallery preparation."""
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from threading import Event

import pytest

from music_app.services import gallery_projection_postgres as gallery
from music_app.services import library_browse_postgres as browse


def test_concurrent_gallery_preparations_share_one_source_read(monkeypatch):
    entered, waiting, release = (Event() for _ in range(3))
    reads = []

    class Repository:
        def __init__(self, *_args, **_kwargs):
            pass

        def _load_relation_alias_maps(self):
            reads.append(True)
            entered.set()
            assert release.wait(3)
            return {}

        @contextmanager
        def _connect_to_database(self):
            yield type("Connection", (), {"execute": lambda *_: None})()

    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(gallery, "gallery_projection_context", lambda _: None)
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-concurrent-gallery"}

    class ObservedFuture(Future):
        def result(self, *args, **kwargs):
            waiting.set()
            return super().result(*args, **kwargs)

    monkeypatch.setattr(gallery, "Future", ObservedFuture)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(gallery.ensure_gallery_projection_ready, config)
        try:
            assert entered.wait(2)
            second = pool.submit(gallery.ensure_gallery_projection_ready, config)
            assert waiting.wait(2)
        finally:
            release.set()
        assert first.result(timeout=2) == second.result(timeout=2) == {"built": 0}
    assert reads == [True]


def test_gallery_preparation_checks_cancellation_before_source_reads(monkeypatch):
    cancelled = Event()
    cancelled.set()
    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository",
                        lambda *_a, **_k: pytest.fail("cancelled preparation read sources"))
    with pytest.raises(InterruptedError):
        gallery.ensure_gallery_projection_ready(
            {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-cancelled-gallery"}, cancel_requested=cancelled)


@pytest.mark.parametrize("publish_default", [False, True])
def test_gallery_publishes_default_before_preparing_second_scope(monkeypatch, publish_default):
    events = []

    class Connection:
        def execute(self, sql, params=None):
            if params is not None:
                events.append("membership")
            return type("Cursor", (), {"fetchall": lambda _: []})()

    class Repository:
        def __init__(self, *_args, **_kwargs):
            pass

        def _load_relation_alias_maps(self, **_kwargs):
            return {"alias_to_canonical": {}, "canonical_to_aliases": {}}

        def _load_missing_album_rows(self, **_kwargs):
            return []

        @contextmanager
        def _connect_to_database(self):
            events.append("snapshot-open")
            yield Connection()
            events.append("snapshot-closed")

    prepare = browse._prepare_root_gallery_snapshot

    def prepare_scope(rows, missing, aliases, state):
        scope = state["gallery_scope"]
        if scope == "new_arrivals":
            assert "publish-all" in events
        events.append("prepare-" + scope)
        return prepare(rows, missing, aliases, state)

    def publish(_config, context, state, snapshot, **_kwargs):
        assert context == {"library_id": 1, "generation": 3 if state["gallery_scope"] == "all" else 4}
        assert events[-1] == "snapshot-closed"
        events.append("publish-" + state["gallery_scope"])
        return publish_default if state["gallery_scope"] == "all" else True

    monkeypatch.setattr(browse, "PostgresLibraryBrowseRepository", Repository)
    monkeypatch.setattr(browse, "_prepare_root_gallery_snapshot", prepare_scope)
    generations = iter([3, 4])
    monkeypatch.setattr(gallery, "gallery_projection_context",
                        lambda _: {"library_id": 1, "generation": next(generations)})
    monkeypatch.setattr(gallery, "_ready_header", lambda *_: None)
    monkeypatch.setattr(gallery, "publish_gallery_projection", publish)
    assert gallery.ensure_gallery_projection_ready(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-publish-order"}) == {"built": 1 + int(publish_default)}
    assert events.index("publish-all") < events.index("prepare-new_arrivals")
    assert events[-1] == "publish-new_arrivals"


def test_cancelling_waiter_does_not_cancel_preparation_owner(monkeypatch):
    entered, release, waiting, cancelled = (Event() for _ in range(4))
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-gallery-waiter"}
    calls = []

    def prepare(*_args, **_kwargs):
        calls.append(True)
        entered.set()
        assert release.wait(3)
        return {"built": 2}

    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready", prepare)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(gallery.ensure_gallery_projection_ready, config)
        try:
            assert entered.wait(2)
            shared = gallery._PREPARATIONS[config["ALBUM_HAVEN_APP_DATABASE_URL"]]
            original_result = shared.result

            def wait_for_result(*args, **kwargs):
                waiting.set()
                return original_result(*args, **kwargs)

            monkeypatch.setattr(shared, "result", wait_for_result)
            waiter = pool.submit(gallery.ensure_gallery_projection_ready, config, cancel_requested=cancelled)
            assert waiting.wait(2)
            cancelled.set()
            with pytest.raises(InterruptedError):
                waiter.result(timeout=2)
            assert not owner.done()
        finally:
            release.set()
        assert owner.result(timeout=2) == {"built": 2}
    assert calls == [True]
    assert config["ALBUM_HAVEN_APP_DATABASE_URL"] not in gallery._PREPARATIONS


def test_failed_gallery_owner_releases_preparation_for_retry(monkeypatch):
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-gallery-retry"}
    calls = []

    def prepare(*_args, **_kwargs):
        calls.append(True)
        if len(calls) == 1:
            raise RuntimeError("owned publication failure")
        return {"built": 2}

    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready", prepare)
    with pytest.raises(RuntimeError, match="owned publication failure"):
        gallery.ensure_gallery_projection_ready(config)
    assert config["ALBUM_HAVEN_APP_DATABASE_URL"] not in gallery._PREPARATIONS
    assert gallery.ensure_gallery_projection_ready(config) == {"built": 2}
    assert calls == [True, True]


def test_gallery_preparation_does_not_block_another_database(monkeypatch):
    entered, release = Event(), Event()
    first = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-gallery-first"}
    second = {"ALBUM_HAVEN_APP_DATABASE_URL": "owned-gallery-second"}

    def prepare(config, **_kwargs):
        if config is first:
            entered.set()
            assert release.wait(3)
        return {"built": 1}

    monkeypatch.setattr(gallery, "_ensure_gallery_projection_ready", prepare)
    with ThreadPoolExecutor(max_workers=2) as pool:
        owner = pool.submit(gallery.ensure_gallery_projection_ready, first)
        try:
            assert entered.wait(2)
            assert pool.submit(gallery.ensure_gallery_projection_ready, second).result(timeout=2) == {"built": 1}
            assert not owner.done()
        finally:
            release.set()
        assert owner.result(timeout=2) == {"built": 1}
