"""Native cover entrypoints through a recording transaction, without external IO."""
from pathlib import Path

import pytest

from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401
from tests.py.test_cover_mutation_boundary import boundary  # noqa: F401
from music_app.services import cover_mutation as mutation, cover_workflow


class RecordingCacheLock:
    def __init__(self, boundary):
        self.boundary = boundary
        self.held = False

    def __enter__(self):
        b = self.boundary
        assert b.connection.open and b.events[-1] == "revision"
        assert not self.held
        self.held = True
        b.events.append("cache-lock")

    def __exit__(self, *args):
        self.held = False
        self.boundary.events.append("cache-unlock")


def test_automatic_prepared_effect_commits_exact_revision_once_without_outer_cache_lock(boundary, monkeypatch):
    from types import SimpleNamespace
    from music_app.services import cover_refresh_execution as refresh
    b = boundary
    lock = RecordingCacheLock(b)
    monkeypatch.setattr(refresh, "run_cover_mutation_for_config", lambda config, **kwargs: b.adapter.run_cover_mutation(**kwargs))
    def promote(folder, raw, **kwargs):
        assert b.connection.open and not lock.held and raw == b"prepared"
        b.events.append("media")
        b.target.write_bytes(b"new cover")
        return SimpleNamespace(cover_path=b.target, promoted_cover_revision="exact-new")
    monkeypatch.setattr(refresh, "begin_prepared_remote_cover_promotion", promote)
    monkeypatch.setattr(refresh, "cover_revision_for_path", lambda path: "exact-new")
    monkeypatch.setattr(cover_workflow, "complete_local_image_promotion", lambda promotion: b.events.append("complete"))
    monkeypatch.setattr(cover_workflow, "rollback_local_image_promotion", lambda promotion: b.events.append("rollback"))
    def forbidden_writer():
        pytest.fail("Prepared automatic effect must not run the provider's combined writer")
    forbidden_writer.prepared_cover_bytes = b"prepared"
    published = []
    def publish_selection(selection):
        assert lock.held and b.connection.committed
        b.events.append("publish")
        published.append(selection)
    guard = refresh._build_automatic_cover_write_guard(
        config={}, folder=b.root, track_paths={str(b.root / "track.flac")},
        expected_album_id=72, cache_lock=lock, automatic_write_is_current=lambda: True,
        publish_selection=publish_selection)
    assert guard(forbidden_writer, cover_selection_origin="automatic") == b.target
    assert len(b.connections) == 1
    assert published[0]["cover_revision"] == "exact-new"
    assert published[0]["cover_path"] == str(b.target)
    assert b.events.index("commit") < b.events.index("publish") < b.events.index("cache-unlock")
    assert b.events.count("persist") == b.events.count("revision") == b.events.count("commit") == 1
    assert b.events.index("media") < b.events.index("persist") < b.events.index("cache-lock") < b.events.index("commit")


def test_recovery_enters_database_before_cache_lock_and_publishes_after_commit(boundary, monkeypatch):
    from types import SimpleNamespace
    from music_app.services import cover_refresh_execution as refresh
    b = boundary
    lock = RecordingCacheLock(b)
    path = str(b.root / "track.flac")
    cache = {path: {"album_id": 72, "cover_selection_origin": "automatic", "cover_revision": "old"}}
    state = {"file_cache": cache, "scan_generation": 2, "cover_generation": 4}
    b.connection.scope["metadata"] = {"cover_selection_origin": "automatic", "cover_revision": "old"}
    monkeypatch.setattr(refresh, "select_scan_cache_adapter", lambda config: SimpleNamespace(
        assert_legacy_cover_mutation_allowed=lambda **kwargs: {"album_id": 72}))
    def boundary_call(config, **kwargs):
        assert not lock.held
        return b.adapter.run_cover_mutation(**kwargs)
    monkeypatch.setattr(refresh, "run_cover_mutation_for_config", boundary_call)
    monkeypatch.setattr(refresh, "cover_revision_for_path", lambda path: "recovered-exact")
    assert refresh._recover_existing_cover_selection(
        config={}, job={"folder": b.root, "album_id": 72, "track_paths": [path]}, cover_path=b.target,
        file_cache=cache, get_state=lambda: state, library_state=state, cache_lock=lock,
        scan_generation=2, cover_generation=4,
    ) == (True, False)
    assert b.connection.committed and cache[path]["cover_revision"] == "recovered-exact"
    assert b.events.index("album") < b.events.index("folder-enter") < b.events.index("persist") < b.events.index("cache-lock")
    assert len(b.connections) == 1 and b.events.count("persist") == 1


@pytest.mark.parametrize("failure", ["uncertain", "provider-after-commit"])
def test_automatic_commit_outcomes_never_enter_legacy_fallback(boundary, monkeypatch, failure):
    from types import SimpleNamespace
    from music_app.services import cover_refresh_execution as refresh
    b = boundary
    if failure == "uncertain":
        b.connection.failure = "commit"
        b.connection.info.transaction_status = 4
    lock = RecordingCacheLock(b)
    monkeypatch.setattr(refresh, "select_scan_cache_adapter", lambda config: SimpleNamespace(
        assert_legacy_cover_mutation_allowed=lambda **kwargs: {"album_id": 72}))
    monkeypatch.setattr(refresh, "run_cover_mutation_for_config", lambda config, **kwargs: b.adapter.run_cover_mutation(**kwargs))
    def promote(folder, raw, **kwargs):
        assert b.connection.open and not lock.held
        b.target.write_bytes(b"new cover")
        return SimpleNamespace(cover_path=b.target, promoted_cover_revision="exact-new")
    monkeypatch.setattr(refresh, "begin_prepared_remote_cover_promotion", promote)
    monkeypatch.setattr(cover_workflow, "rollback_local_image_promotion", lambda promotion: pytest.fail("Uncertain commit rolled back media"))
    monkeypatch.setattr(cover_workflow, "complete_local_image_promotion", lambda promotion: b.events.append("complete"))
    monkeypatch.setattr(refresh, "find_cover_image", lambda *args, **kwargs: pytest.fail("Uncertain commit entered fallback"))
    def ensure(**kwargs):
        assert not b.connection.open
        def writer():
            pytest.fail("Provider writer bypassed transaction")
        writer.prepared_cover_bytes = b"prepared"
        kwargs["automatic_write_guard"](writer, cover_selection_origin="automatic")
        raise RuntimeError("provider post-processing failed after save")
    monkeypatch.setattr(refresh.cover_refresh_provider, "ensure_best_cover_for_folder", ensure)
    published = []
    def publish(selection):
        assert b.connection.committed and lock.held
        published.append(selection)
    result = refresh.execute_cover_job(
        job={"folder": b.root, "album_id": 72, "track_paths": [str(b.root / "track.flac")], "cover_selection_origin": "automatic"},
        image_extensions={".jpg"}, user_agent="IsolatedTests/1.0", cover_cache={},
        force_search=False, allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False, negative_cache_ttl_seconds=None,
        config={}, cache_lock=lock, automatic_write_is_current=lambda: True,
        automatic_cover_publisher=publish,
    )
    assert result[0:2] == (None, False)
    assert result[2]["selection_conflict"] is True
    if failure == "uncertain":
        assert result[2]["reason"] == "cover_selection_commit_uncertain"
        assert result[2]["persisted"] is None and not published
        assert "complete" not in b.events
    else:
        assert result[2]["reason"] == "cover_selection_finalization_failed"
        assert result[2]["persisted"] is True and len(published) == 1
        assert result[2]["committed_cover_selection"]["cover_revision"] == "exact-new"
        assert result[2]["runtime_selection_published"] is True
    assert b.target.read_bytes() == b"new cover" and b.events.count("commit") == 1


@pytest.mark.parametrize("queued_id", [71, None])
def test_automatic_job_cannot_retarget_after_queueing(boundary, monkeypatch, queued_id):
    from types import SimpleNamespace
    from music_app.services import cover_refresh_execution as refresh
    b = boundary
    monkeypatch.setattr(refresh, "select_scan_cache_adapter", lambda config: SimpleNamespace(
        assert_legacy_cover_mutation_allowed=lambda **kwargs: {"album_id": 72}))
    monkeypatch.setattr(refresh.cover_refresh_provider, "ensure_best_cover_for_folder",
                        lambda **kwargs: pytest.fail("Stale queued album identity reached provider"))
    monkeypatch.setattr(refresh, "find_cover_image",
                        lambda *args, **kwargs: pytest.fail("Stale queued album identity entered fallback"))
    result = refresh.execute_cover_job(
        job={"folder": b.root, "album_id": queued_id, "track_paths": [str(b.root / "track.flac")],
             "cover_selection_origin": "automatic"},
        image_extensions={".jpg"}, user_agent="IsolatedTests/1.0", cover_cache={},
        force_search=False, allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False, negative_cache_ttl_seconds=None,
        config={},
    )
    assert result[0:2] == (None, False)
    assert result[2]["selection_conflict"] is True
    assert b.connections == []
