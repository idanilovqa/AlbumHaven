"""Native cover entrypoints through a recording transaction, without external IO."""
from pathlib import Path

import pytest

from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401
from tests.py.test_cover_mutation_boundary import boundary  # noqa: F401
from music_app.services import cover_mutation as mutation, cover_workflow


@pytest.mark.parametrize("display_only", [False, True])
@pytest.mark.parametrize("outcome", ["success", "uncertain", "runtime-failure"])
def test_remote_worker_prepares_before_database_and_persists_once(boundary, monkeypatch, display_only, outcome):
    from types import SimpleNamespace
    from music_app.services import cover_lookup_runtime as runtime
    from music_app.services.cover_provider_candidates import SelectedRemoteImage
    b = boundary
    if outcome == "uncertain":
        b.connection.failure = "commit"
        b.connection.info.transaction_status = 4
    updates = []
    errors = []
    import traceback
    logger = SimpleNamespace(exception=lambda *args, **kwargs: errors.append(traceback.format_exc()))
    monkeypatch.setattr(runtime, "_validated_remote_selection_album_root", lambda *args: b.root)
    monkeypatch.setattr(runtime, "_runtime_phase_metrics_for_task", lambda *args: ({}, {}))
    monkeypatch.setattr(runtime, "_publish_save_runtime_phase_metrics", lambda *args, **kwargs: None)
    monkeypatch.setattr(runtime, "request_cover_lookup_task_stop", lambda *args: None)
    monkeypatch.setattr(runtime, "update_cover_lookup_task", lambda *args, **kwargs: updates.append(kwargs))
    monkeypatch.setattr(runtime, "select_scan_cache_adapter", lambda config: SimpleNamespace(
        assert_legacy_cover_mutation_allowed=lambda **kwargs: {"album_id": 72}))
    monkeypatch.setattr(runtime, "run_cover_mutation_for_config", lambda config, **kwargs: b.adapter.run_cover_mutation(**kwargs))
    def download(*, folder, write_cover_func, **kwargs):
        assert not b.connection.open
        b.events.append("fetch")
        return write_cover_func(folder, b"raw image"), {}
    def prepare(raw):
        assert raw == b"raw image" and not b.connection.open
        b.events.append("decode")
        return b"prepared image"
    def promote(folder, prepared, **kwargs):
        assert prepared == b"prepared image" and b.connection.open
        b.events.append("media")
        b.target.write_bytes(b"new cover")
        return SimpleNamespace(cover_path=b.target, promoted_cover_revision="exact-new")
    monkeypatch.setattr(runtime, "download_remote_cover_to_folder", download)
    monkeypatch.setattr(runtime, "prepare_remote_cover_bytes_for_authoritative_write", prepare)
    monkeypatch.setattr(runtime, "begin_prepared_remote_cover_promotion", promote)
    def decoded(prepared):
        assert not b.connection.open
        return SimpleNamespace(close=lambda: None), 600, 601
    monkeypatch.setattr(runtime, "decode_image_bytes", decoded)
    def problematic(*args, **kwargs):
        assert not b.connection.open
        return None
    monkeypatch.setattr(runtime, "build_problematic_album_detail_payload", problematic)
    monkeypatch.setattr(cover_workflow, "complete_local_image_promotion", lambda promotion: b.events.append("complete"))
    monkeypatch.setattr(cover_workflow, "rollback_local_image_promotion", lambda promotion: b.events.append("rollback"))
    def runtime_guard(state, action):
        assert b.connection.open and b.events[-1] == "revision"
        b.events.append("runtime-lock")
        return action()
    monkeypatch.setattr(runtime, "run_authoritative_cover_commit_for_state", runtime_guard)
    def publish(*args, **kwargs):
        assert b.connection.committed
        b.events.append("publish")
        if outcome == "runtime-failure":
            raise RuntimeError("runtime publication failed")
        return [], None
    monkeypatch.setattr(runtime, "_apply_cover_selection_for_tracks", publish)
    runtime._run_cover_lookup_save_remote_task(
        "owned-recording-task", {}, logger, {}, "IsolatedTests/1.0", b.root,
        {str(b.root / "track.flac")}, "candidate",
        SelectedRemoteImage(url="https://example.invalid/image.jpg", display_only=display_only),
        apply_cover_selection_for_tracks=lambda **kwargs: None,
    )
    if outcome != "success":
        assert updates[-1]["status"] == "failed", errors
        from music_app.services.cover_lookup_tasks import serialize_cover_lookup_task_payload
        serialized = serialize_cover_lookup_task_payload(updates[-1])
        assert serialized["persisted"] is updates[-1]["persisted"]
        assert serialized["finalization_failed"] is updates[-1]["finalization_failed"]
        assert "rollback" not in b.events
        assert b.events.count("commit") == 1 and b.events.count("persist") == 1
        if outcome == "uncertain":
            assert "confirm" in updates[-1]["message"].lower() or "check" in updates[-1]["message"].lower()
            assert updates[-1]["persisted"] is None
            assert updates[-1]["result_kind"] == "save-confirmation-uncertain"
        else:
            assert updates[-1]["message"] == "Failed to save selected cover art."
            assert updates[-1]["persisted"] is True
            assert updates[-1]["finalization_failed"] is True
        if not display_only:
            assert b.target.read_bytes() == b"new cover"
        return
    assert updates[-1]["status"] == "completed", errors
    assert len(b.connections) == 1 and b.events.count("persist") == 1
    assert b.events.count("revision") == 1 and b.events.count("commit") == 1
    if display_only:
        assert "fetch" not in b.events and "decode" not in b.events and "media" not in b.events
    else:
        assert b.events.index("fetch") < b.events.index("decode") < b.events.index("enter")
        assert b.events.index("album") < b.events.index("media") < b.events.index("persist")
    assert b.events.index("persist") < b.events.index("runtime-lock") < b.events.index("commit") < b.events.index("publish")


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


@pytest.mark.parametrize("operation,race", [
    ("local", None), ("paste", None), ("active-delete", None), ("inactive-delete", None),
    ("local", "alias"), ("active-delete", "alias"),
    ("local", "prepared-bytes"), ("active-delete", "prepared-bytes"),
])
def test_native_routes_use_fresh_database_scope_and_shared_boundary(boundary, monkeypatch, operation, race):
    import asyncio
    import json
    from types import SimpleNamespace
    from starlette.requests import Request
    from music_app.routes import api_wave_d_asgi_routes as routes
    b = boundary
    path = str(b.root / "track.flac")
    album = {"album_id": 72, "key": "child", "album": "Fixture", "artist": "Fixture"}
    state = {"file_cache": {path: {"album_id": 72, "cover_path": str(b.source)}}}
    payload = {"album": album, "source_path": str(b.target if "delete" in operation else b.source),
               "data_url": "isolated-paste"}
    if race == "alias":
        alias = b.root / "chosen.jpg"
        alias.symlink_to(Path(payload["source_path"]))
        payload["source_path"] = str(alias)
        def retarget():
            alias.unlink()
            alias.symlink_to(b.source if "delete" in operation else b.target)
        b.connection.source_wait = retarget
    async def json_payload(request):
        return payload
    async def context(*args, **kwargs):
        return album, SimpleNamespace(album_root=b.root, track_paths={path})
    async def none(*args, **kwargs):
        return None
    async def gallery(*args, **kwargs):
        return {}
    monkeypatch.setattr(routes, "_json_payload", json_payload)
    monkeypatch.setattr(routes, "_resolve_album_payload_context", context)
    monkeypatch.setattr(routes, "history_scope_for_request", none)
    monkeypatch.setattr(routes, "_legacy_cover_mutation_preflight", none)
    monkeypatch.setattr(routes, "_serialize_cover_gallery_from_asgi", gallery)
    monkeypatch.setattr(routes, "_app_config", lambda request: {"IMAGE_EXTENSIONS": {".jpg"}})
    monkeypatch.setattr(routes, "_app_logger", lambda request: SimpleNamespace(exception=lambda *args: None))
    monkeypatch.setattr(routes, "_library_state", lambda request: state)
    monkeypatch.setattr(routes, "resolve_authoritative_album_track_paths", lambda *args, **kwargs: {path})
    monkeypatch.setattr(routes, "validate_local_cover_source", lambda config, root, source, **kwargs: Path(source).resolve())
    monkeypatch.setattr(routes, "_log_local_cover_persistence_event", lambda *args, **kwargs: None)
    monkeypatch.setattr(routes, "mark_cover_lookup_notifications_action_taken_for_track_paths", lambda *args, **kwargs: [])
    monkeypatch.setattr(routes.state_service, "take_cover_selection_interrupted_scan_mode_for_state", lambda *args: None)
    def run_mutation(config, **kwargs):
        if race == "prepared-bytes":
            b.source.write_bytes(b"replacement source bytes")
        return b.adapter.run_cover_mutation(**kwargs)
    monkeypatch.setattr(routes, "run_cover_mutation_for_config", run_mutation)
    def dimension(path):
        assert not b.connection.open
        b.events.append("decode")
        return 600, 601
    monkeypatch.setattr(routes, "image_dimensions", dimension)
    def prepare(data_url):
        assert data_url == "isolated-paste" and not b.connection.open
        b.events.append("decode")
        return b"prepared"
    monkeypatch.setattr(routes, "prepare_pasted_cover_bytes", prepare)
    def promote(*args, **kwargs):
        assert b.connection.open
        b.events.append("media")
        b.target.write_bytes(b"new cover")
        return SimpleNamespace(cover_path=b.target, promoted_cover_revision="exact-new")
    monkeypatch.setattr(routes, "begin_local_image_promotion", promote)
    monkeypatch.setattr(routes, "begin_prepared_remote_cover_promotion", promote)
    monkeypatch.setattr(routes, "cover_promotion_effect", lambda promotion, **kwargs: mutation.CoverMutationEffect(
        selection={"selected_cover_path": b.target, "cover_revision": "exact-new", **kwargs}, value=b.target))
    def candidates(*args, **kwargs):
        assert not b.connection.open
        kwargs["image_dimensions"](b.source)
        return [b.source]
    monkeypatch.setattr(routes, "ranked_local_cover_candidates", candidates)
    if operation == "inactive-delete":
        b.connection.scope["cover_path"] = str(b.source)
    def delete(*, source_path, active_cover_path, prepared_candidates, prepared_dimensions, prepared_revisions):
        assert b.connection.open
        assert active_cover_path == (b.source if operation == "inactive-delete" else b.target)
        b.events.append("media")
        source_path.unlink()
        return mutation.CoverMutationEffect(
            selection=None if operation == "inactive-delete" else {"selected_cover_path": b.source, "cover_revision": "fallback-exact"},
            value=b.source)
    monkeypatch.setattr(routes, "delete_local_cover_effect",
                        cover_workflow.delete_local_cover_effect if race == "prepared-bytes" else delete)
    def guard(state, action):
        assert b.connection.open
        b.events.append("runtime-lock")
        return action()
    monkeypatch.setattr(routes.state_service, "run_authoritative_cover_commit_for_state", guard)
    def publish(*args, **kwargs):
        assert b.connection.committed
        b.events.append("publish")
        return [], None
    monkeypatch.setattr(routes, "apply_cover_path_for_tracks", publish)
    handler = {"local": routes.utilities_cover_lookup_local_select,
               "paste": routes.utilities_cover_lookup_pasted_image_save,
               "active-delete": routes.utilities_cover_lookup_local_delete,
               "inactive-delete": routes.utilities_cover_lookup_local_delete}[operation]
    response = asyncio.run(handler(Request({"type": "http", "method": "POST", "path": "/", "headers": []})))
    if race:
        assert response.status_code == 409, response.body
        assert "media" not in b.events and "persist" not in b.events and "commit" not in b.events
        assert b.target.read_bytes() == b"old cover"
        return
    assert response.status_code == 200, response.body
    assert json.loads(response.body)["ok"] is True
    assert len(b.connections) == 1 and b.events.count("commit") == 1
    assert b.events.index("decode") < b.events.index("enter") < b.events.index("album") < b.events.index("media")
    assert b.events.count("persist") == (0 if operation == "inactive-delete" else 1)
    assert b.events.count("revision") == 1


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
