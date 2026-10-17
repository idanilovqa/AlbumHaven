"""Asset versions must be cheap when unchanged without losing live invalidation."""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

import pytest


class Signal:
    def __init__(self):
        self.dirty = False
        self.closed = 0
        self.fail = False

    def changed(self):
        if self.fail:
            raise OSError("notification unavailable")
        dirty, self.dirty = self.dirty, False
        return dirty

    def close(self):
        self.closed += 1


def test_unchanged_requests_reuse_digest_and_changes_recompute(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    signal, calls = Signal(), []
    cache = RuntimeAssetVersionCache(lambda _root: signal)

    def build():
        calls.append(True)
        return str(len(calls))

    assert cache.get(tmp_path, build) == "1"
    assert cache.get(tmp_path, build) == "1"
    signal.dirty = True
    assert cache.get(tmp_path, build) == "2"
    assert calls == [True, True]
    cache.close()
    cache.close()
    assert signal.closed == 1


@pytest.mark.parametrize("failure", ["unsupported", "creation", "poll"])
def test_unreliable_notification_never_reuses_a_digest(tmp_path, failure):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    signal, calls = Signal(), []

    def factory(_root):
        if failure == "creation":
            raise OSError("unsupported filesystem")
        return None if failure == "unsupported" else signal

    cache = RuntimeAssetVersionCache(factory)

    def build():
        calls.append(True)
        return str(len(calls))

    assert cache.get(tmp_path, build) == "1"
    signal.fail = True
    assert cache.get(tmp_path, build) == "2"
    assert cache.get(tmp_path, build) == "3"
    cache.close()


def test_missing_or_failed_build_is_not_cached(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    signal = Signal()
    cache = RuntimeAssetVersionCache(lambda _root: signal)
    assert cache.get(tmp_path, lambda: "missing") == "missing"
    assert cache.get(tmp_path, lambda: "valid") == "valid"
    signal.dirty = True
    with pytest.raises(RuntimeError):
        cache.get(tmp_path, lambda: (_ for _ in ()).throw(RuntimeError("failed build")))
    assert cache.get(tmp_path, lambda: "recovered") == "recovered"
    cache.close()


def test_change_during_build_and_switching_roots_invalidate(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    signals = []

    def factory(_root):
        signal = Signal()
        signals.append(signal)
        return signal

    cache = RuntimeAssetVersionCache(factory)

    def changing_build():
        signals[-1].dirty = True
        return "before-change"

    assert cache.get(tmp_path, changing_build) == "before-change"
    assert cache.get(tmp_path, lambda: "after-change") == "after-change"
    assert cache.get(tmp_path / "other", lambda: "other-root") == "other-root"
    assert signals[0].closed == 1
    cache.close()
    assert signals[1].closed == 1


def test_concurrent_requests_share_the_same_hash_build(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    entered, release, waiting = Event(), Event(), Event()
    calls, attempts = [], []
    cache = RuntimeAssetVersionCache(lambda _root: Signal())

    class ObservedLock:
        def __init__(self):
            self.lock = Lock()

        def __enter__(self):
            attempts.append(True)
            if len(attempts) == 2:
                waiting.set()
            self.lock.acquire()

        def __exit__(self, *_args):
            self.lock.release()

    cache._lock = ObservedLock()

    def build():
        calls.append(True)
        entered.set()
        assert release.wait(3)
        return "one"

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(cache.get, tmp_path, build)
        assert entered.wait(2)
        second = pool.submit(cache.get, tmp_path, build)
        try:
            assert waiting.wait(2)
        finally:
            release.set()
        assert first.result(timeout=2) == second.result(timeout=2) == "one"
    assert calls == [True]
    cache.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows native change-notification contract")
def test_native_signal_detects_same_timestamp_edits_and_directory_changes(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    asset = tmp_path / "asset.js"
    asset.write_bytes(b"version1")
    original = asset.stat()
    builds = []

    def build():
        builds.append(True)
        return "|".join(p.name + ":" + p.read_text() for p in sorted(tmp_path.rglob("*.js")))

    cache = RuntimeAssetVersionCache()
    try:
        first = cache.get(tmp_path, build)
        assert cache.get(tmp_path, build) == first
        assert len(builds) == 1
        asset.write_bytes(b"version2")
        os.utime(asset, ns=(original.st_atime_ns, original.st_mtime_ns))
        assert cache.get(tmp_path, build) != first
        nested = tmp_path / "nested"
        nested.mkdir()
        added = nested / "added.js"
        added.write_text("added")
        assert "added.js:added" in cache.get(tmp_path, build)
        renamed = nested / "renamed.js"
        added.rename(renamed)
        assert "renamed.js:added" in cache.get(tmp_path, build)
        renamed.unlink()
        assert "added" not in cache.get(tmp_path, build)
    finally:
        cache.close()


@pytest.mark.skipif(os.name != "nt", reason="Windows native change-notification contract")
def test_replacing_the_watched_root_never_reuses_the_old_digest(tmp_path):
    from music_app.services.runtime_asset_versions import RuntimeAssetVersionCache
    root = tmp_path / "static"
    root.mkdir()
    (root / "app.js").write_text("old")
    cache = RuntimeAssetVersionCache()
    try:
        assert cache.get(root, lambda: (root / "app.js").read_text()) == "old"
        root.rename(tmp_path / "old-static")
        root.mkdir()
        (root / "app.js").write_text("new")
        assert cache.get(root, lambda: (root / "app.js").read_text()) == "new"
    finally:
        cache.close()
