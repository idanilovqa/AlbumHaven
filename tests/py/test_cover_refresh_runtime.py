from __future__ import annotations

import inspect
import logging
from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor

import pytest
import threading

from music_app.services import cover_refresh_execution, cover_refresh_runtime


def test_automatic_cover_writer_uses_shared_mutation_coordinator():
    source = inspect.getsource(cover_refresh_execution._build_automatic_cover_write_guard)

    assert "execute_cover_mutation_for_config(" in source
    assert "run_serialized_cover_selection(" not in source
    for callback in (
        "prepare=",
        "write_artifact=",
        "recover_selection=",
        "publish_committed=",
    ):
        assert callback in source


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
@pytest.mark.parametrize("scoped", [True, False], ids=["trusted-roots", "legacy-scope"])
def test_claimed_runtime_uses_private_root_snapshot_without_settings_read_or_path_resolution(
    monkeypatch, tmp_path, mode, scoped,
):
    from pathlib import Path
    from music_app.services import library_roots, state

    root = tmp_path / "currently-offline-root"
    existing_snapshot = (tmp_path / "legacy-root",)
    config = {"_library_root_paths_snapshot": existing_snapshot}
    scope = SimpleNamespace(file_cache={}, progress_total=0, mode=mode, force_search=False)
    if scoped:
        scope.library_root_paths = (str(root),)
    seen = []

    def reject_settings(*_args, **_values):
        pytest.fail("claimed root snapshot must not query unscoped root settings")

    def reject_resolve(*_args, **_values):
        pytest.fail("claim root conversion must not resolve or probe filesystem paths")

    def inspect_config(execution_config):
        seen.append(execution_config)
        assert execution_config is not config
        assert library_roots.configured_library_root_paths_snapshot(execution_config) == (
            (root,) if scoped else existing_snapshot
        )
        return {"processed": 0, "downloaded": 0, "failed": 0}

    monkeypatch.setattr(library_roots, "load_library_root_settings", reject_settings)
    monkeypatch.setattr(Path, "resolve", reject_resolve)
    monkeypatch.setattr(state, "refresh_unsuccessful_cover_artwork_for_state",
                        lambda _state, execution_config, *_args, **_values: inspect_config(execution_config))
    monkeypatch.setattr(state, "refresh_cover_artwork_request",
                        lambda **values: inspect_config(values["config"]))
    cover_refresh_runtime.run_claimed_cover_refresh(
        scope=scope, config=config, logger=SimpleNamespace(),
        should_cancel=lambda: False, progress=lambda **_values: True,
    )
    assert len(seen) == 1
    assert config == {"_library_root_paths_snapshot": existing_snapshot}


@pytest.mark.parametrize("mode", ["manual", "post_scan"])
def test_claimed_runtime_scopes_fresh_checks_preparation_and_completion(monkeypatch, mode):
    from music_app.services import scan_cache_persistence, state

    current = {"invalid": False}
    checks, stages = [], []

    class Connection:
        def __init__(self):
            self.in_transaction = False
            self.commits = 0
            self.closed = False

        def commit(self):
            self.in_transaction = False
            self.commits += 1

        def rollback(self):
            self.in_transaction = False

        def close(self):
            self.closed = True

    connection = Connection()
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://claimed-runtime-scope"}
    monkeypatch.setattr(scan_cache_persistence, "PostgresScanCacheAdapter",
                        lambda _config: SimpleNamespace(_connect_to_database=lambda: connection))

    def read_current_authority():
        assert scan_cache_persistence._SHARED_CONNECTION.get() is not None
        with scan_cache_persistence.scan_cache_transaction(config["ALBUM_HAVEN_APP_DATABASE_URL"]) as sql:
            assert sql is connection
            assert sql.in_transaction is False
            sql.in_transaction = True
            checks.append(current["invalid"])
            return not current["invalid"]

    def should_cancel():
        return not read_current_authority()

    def progress(**_values):
        return read_current_authority()

    def engine(library_state):
        assert scan_cache_persistence._SHARED_CONNECTION.get() is not None
        stages.append("preparation")
        assert read_current_authority()
        # The provider runs after the read's transaction committed.
        assert connection.in_transaction is False
        stages.append("provider")
        current["invalid"] = True
        generation = library_state["cover_generation"]
        library_state["covers_processed"] = 1
        assert library_state["cover_generation"] > generation
        stages.append("completion")
        library_state["covers_current_folder"] = ""
        assert should_cancel()
        assert connection.in_transaction is False
        return {"processed": 1, "downloaded": 0, "failed": 0}

    monkeypatch.setattr(state, "refresh_unsuccessful_cover_artwork_for_state",
                        lambda library_state, *_args, **_values: engine(library_state))
    monkeypatch.setattr(state, "refresh_cover_artwork_request",
                        lambda **values: engine(values["get_state"]()))
    result = cover_refresh_runtime.run_claimed_cover_refresh(
        scope=SimpleNamespace(file_cache={}, progress_total=1, mode=mode, force_search=False),
        config=config, logger=SimpleNamespace(), should_cancel=should_cancel, progress=progress,
    )
    assert result["processed"] == 1
    assert stages == ["preparation", "provider", "completion"]
    assert checks[0] is False
    assert checks[-1] is True
    assert connection.commits == len(checks)
    assert connection.closed is True


def test_claimed_cover_pass_uses_fresh_loader_instead_of_bootstrap_adapter(monkeypatch):
    selection = {19: {"selected_cover_path": "A.jpg", "cover_selection_origin": "automatic"}}
    calls = []

    def load(album_ids):
        calls.append(album_ids)
        return selection

    monkeypatch.setattr(
        cover_refresh_runtime, "select_scan_cache_adapter",
        lambda _config: pytest.fail("durable worker must not read bootstrap inventory"),
    )
    cache = {"track": {"album_id": 19, "selected_cover_path": "stale.jpg"}}
    config = {"CLAIMED_COVER_SELECTION_LOADER": load}
    first = cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, config)
    selection[19] = {
        "selected_cover_path": "C.jpg", "cover_selection_origin": "user",
        "cover_selection_provenance": "explicit", "cover_revision": "C-revision",
    }
    second = cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, config)
    assert first["track"]["selected_cover_path"] == "A.jpg"
    assert second["track"]["selected_cover_path"] == "C.jpg"
    assert second["track"]["selected_cover_origin"] == "user"
    assert second["track"]["selected_cover_provenance"] == "explicit"
    assert second["track"]["selected_cover_revision"] == "C-revision"
    assert cache["track"]["selected_cover_path"] == "stale.jpg"
    assert calls == [{19}, {19}]


@pytest.mark.parametrize("mode", ["recovered", "downloaded"])
def test_claimed_automatic_mutation_forwards_validated_library_id(monkeypatch, tmp_path, mode):
    from music_app.services.cover_mutation_coordinator import CoverMutationOutcome, CoverMutationStatus

    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"retained artwork")
    track = str(tmp_path / "01.flac")
    entries = {track: {"album_id": 19, "cover_path": None}}
    state = {"file_cache": entries}
    config = {"CLAIMED_COVER_LIBRARY_ID": 37, "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://worker"}
    calls = []

    def execute(_config, **kwargs):
        calls.append(kwargs)
        return CoverMutationOutcome(status=CoverMutationStatus.CANCELED)

    monkeypatch.setattr(cover_refresh_execution, "execute_cover_mutation_for_config", execute)
    monkeypatch.setattr(
        cover_refresh_execution, "PostgresCoverMutationRepository",
        lambda **_kwargs: SimpleNamespace(load_baseline=lambda **_values: None),
    )
    if mode == "recovered":
        cover_refresh_execution._recover_existing_cover_selection(
            config=config, job={"folder": tmp_path, "track_paths": [track]},
            cover_path=cover, file_cache=entries, get_state=lambda: state,
            library_state=state, cache_lock=threading.Lock(),
            scan_generation=None, cover_generation=None,
        )
    else:
        def write():
            pytest.fail("canceled coordinator must not write an artifact")

        write.provisional_cover_revision = "provisional-revision"
        guard = cover_refresh_execution._build_automatic_cover_write_guard(
            config=config, folder=tmp_path, track_paths={track},
        )
        assert guard(write, cover_selection_origin="automatic") is False
    assert len(calls) == 1
    assert calls[0]["library_id"] == 37


def test_cover_pass_snapshot_refreshes_selection_once_without_runtime_alias(monkeypatch):
    from types import SimpleNamespace

    current = {12: {"selected_cover_path": "parent/selected.jpg", "cover_selection_origin": "user"}}
    calls = []
    def load(album_ids):
        calls.append(album_ids)
        return current
    monkeypatch.setattr(cover_refresh_runtime, "select_scan_cache_adapter", lambda _config: SimpleNamespace(load_cover_selections=load))
    cache = {"disc1/a": {"album_id": 12, "cover_path": None, "cover_selection_origin": "automatic"}, "disc2/b": {"album_id": 12, "cover_path": "physical.jpg"}}
    first = cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, {})
    assert calls == [{12}]
    assert first["disc1/a"]["selected_cover_path"] == "parent/selected.jpg"
    assert first["disc1/a"]["selected_cover_origin"] == "user"
    assert first["disc1/a"]["cover_selection_origin"] == "automatic"
    assert first["disc2/b"]["cover_path"] == "physical.jpg"
    assert "selected_cover_path" not in cache["disc1/a"]
    current[12] = {"selected_cover_path": "changed.jpg", "cover_selection_origin": "user"}
    second = cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, {})
    assert second["disc2/b"]["selected_cover_path"] == "changed.jpg"
    assert len(calls) == 2
    cache["foreign"] = {"album_id": 99, "selected_cover_path": "stale.jpg"}
    missing = cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, {})
    assert missing["foreign"]["selected_cover_path"] is None
    current[99] = {"selected_cover_path": None, "cover_selection_origin": None}
    assert cover_refresh_runtime.cover_pass_file_cache_snapshot(cache, {})["foreign"]["selected_cover_path"] is None


class LoggerStub:
    def __init__(self) -> None:
        self.messages: list[tuple[str, tuple[object, ...]]] = []

    def warning(self, message: str, *args: object) -> None:
        self.messages.append((message, args))


@pytest.fixture
def runtime_config(tmp_path):
    return {
        "COVER_CACHE_PATH": str(tmp_path / "cover-search-cache.json"),
        "IMAGE_EXTENSIONS": {".jpg", ".jpeg", ".png", ".webp"},
        "MUSICBRAINZ_USER_AGENT": "album-haven-tests/cover-refresh-runtime",
    }


@pytest.fixture
def logger():
    return LoggerStub()


@pytest.mark.parametrize("failure_phase", ["preparation", "submission"])
def test_manual_admission_exceptions_report_failed_not_cancelled(runtime_config, logger, failure_phase):
    state = {"albums": [{"key": "album"}], "file_cache": {"track": {"album": "Album"}}}

    def fail(*args, **kwargs):
        raise RuntimeError("admission failed")

    with pytest.raises(RuntimeError, match="admission failed"):
        cover_refresh_runtime.start_manual_cover_refresh(
            config=runtime_config, logger=logger, cache_lock=threading.Lock(),
            get_state=lambda: state, start_background_refresh=lambda **kwargs: None,
            build_cover_jobs=fail if failure_phase == "preparation" else lambda **kwargs: [{"folder": "Artist/Album"}],
            submit_cover_job=fail, refresh_manual_cover_artwork_worker=lambda *args: None,
        )
    assert state["covers_in_progress"] is False
    assert state["covers_outcome"] == "failed"


def test_background_submission_exception_reports_failed_not_cancelled():
    state = {}

    def fail(*args):
        raise RuntimeError("submission failed")

    with pytest.raises(RuntimeError, match="submission failed"):
        cover_refresh_runtime.start_background_cover_refresh(
            get_state=lambda: state, submit_cover_job=fail,
            refresh_cover_artwork_worker=lambda: None,
        )
    assert state["covers_in_progress"] is False
    assert state["covers_outcome"] == "failed"


def test_start_manual_cover_refresh_queues_after_indexing(runtime_config, logger):
    background_calls = []
    library_state = {"scan_in_progress": True}

    result = cover_refresh_runtime.start_manual_cover_refresh(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: background_calls.append(kwargs),
        build_cover_jobs=lambda **kwargs: [],
        submit_cover_job=lambda *args: None,
        refresh_manual_cover_artwork_worker=lambda force_search: None,
        force_search=True,
    )

    assert result == {
        "started": True,
        "already_running": False,
        "queued_after_indexing": True,
        "queued_count": 0,
        "current_folder": "",
    }
    assert background_calls == []
    assert library_state["pending_cover_refresh_after_scan"] is True
    assert library_state["pending_cover_refresh_force_search"] is True


def test_start_manual_cover_refresh_starts_background_scan_when_index_missing(runtime_config, logger):
    background_calls = []
    library_state = {}

    result = cover_refresh_runtime.start_manual_cover_refresh(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: background_calls.append(kwargs),
        build_cover_jobs=lambda **kwargs: [],
        submit_cover_job=lambda *args: None,
        refresh_manual_cover_artwork_worker=lambda force_search: None,
        force_search=False,
    )

    assert result["queued_after_indexing"] is True
    assert background_calls == [{"force": True, "scan_mode": "background"}]


def test_start_manual_cover_refresh_uses_persisted_snapshot_without_full_scan(
    runtime_config, logger,
):
    background_calls = []
    submitted = []
    library_state = {}
    snapshot = {"track-1": {"album": "Album"}}

    result = cover_refresh_runtime.start_manual_cover_refresh(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: background_calls.append(kwargs),
        build_cover_jobs=lambda **kwargs: [{"folder": "Artist/Album"}],
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_manual_cover_artwork_worker=lambda force_search, prepared: None,
        get_file_cache_snapshot=lambda: snapshot,
        force_search=True,
    )

    assert background_calls == []
    assert result["queued_after_indexing"] is False
    assert result["queued_count"] == 1
    assert len(submitted) == 1
    assert library_state["file_cache"] == snapshot
    assert library_state["file_cache"] is submitted[0][2][0].file_cache


def test_start_manual_cover_refresh_can_defer_snapshot_preparation(
    runtime_config, logger,
):
    submitted = []
    library_state = {}
    snapshot = {"track-1": {"album": "Album"}}

    result = cover_refresh_runtime.start_manual_cover_refresh(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: pytest.fail("unexpected scan"),
        build_cover_jobs=lambda **kwargs: [{"folder": "Artist/Album"}],
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_manual_cover_artwork_worker=lambda force_search, prepared: None,
        get_file_cache_snapshot=lambda: snapshot,
        force_search=True,
        defer_preparation=True,
    )

    assert result == {
        "started": True,
        "already_running": False,
        "queued_after_indexing": False,
        "queued_count": 0,
        "current_folder": "",
    }
    assert library_state["covers_in_progress"] is True
    assert len(submitted) == 1

    prepare, *prepare_args = submitted.pop()
    prepare(*prepare_args)

    assert library_state["file_cache"] == snapshot
    assert library_state["covers_total"] == 1
    assert len(submitted) == 1


def test_start_manual_cover_refresh_returns_direct_status_snapshot(runtime_config, logger):
    submitted = []
    invoked = []
    library_state = {
        "albums": [{"key": "album-1"}],
        "file_cache": {"track-1": {"album": "Album"}},
    }

    result = cover_refresh_runtime.start_manual_cover_refresh(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: None,
        build_cover_jobs=lambda **kwargs: [{"folder": "Artist/Album"}],
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_manual_cover_artwork_worker=lambda force_search, prepared: invoked.append((force_search, prepared)),
        force_search=True,
    )

    assert result == {
        "started": True,
        "already_running": False,
        "queued_after_indexing": False,
        "queued_count": 1,
        "current_folder": "Artist/Album",
    }
    assert len(submitted) == 1
    assert submitted[0][1] is True
    assert library_state["covers_in_progress"] is True
    assert library_state["covers_current_folder"] == "Artist/Album"
    callback, *args = submitted[0]
    callback(*args)
    assert invoked[0][0] is True
    assert invoked[0][1][0].library_state is library_state
    assert invoked[0][1][1] == [{"folder": "Artist/Album"}]


def test_start_manual_cover_refresh_request_builds_jobs_from_snapshot(runtime_config, logger, monkeypatch):
    background_calls = []
    submitted = []
    built = []
    library_state = {
        "albums": [{"key": "album-1"}],
        "file_cache": {"track-1": {"album": "Album"}},
    }

    monkeypatch.setattr(
        cover_refresh_runtime,
        "build_cover_jobs_for_snapshot",
        lambda **kwargs: built.append(kwargs) or [{"folder": "Artist/Album"}],
    )

    result = cover_refresh_runtime.start_manual_cover_refresh_request(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: background_calls.append(kwargs),
        get_file_cache_snapshot=lambda: {"track-1": {"album": "Album"}},
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_unsuccessful_cover_artwork=lambda **kwargs: None,
        force_search=True,
    )

    assert result == {
        "started": True,
        "already_running": False,
        "queued_after_indexing": False,
        "queued_count": 1,
        "current_folder": "Artist/Album",
    }
    assert background_calls == []
    assert len(submitted) == 1
    assert submitted[0][1] is True
    assert built == [{
        "get_file_cache_snapshot": built[0]["get_file_cache_snapshot"],
        "logger": built[0]["logger"],
        "require_missing_cover": True,
        "cover_cache": built[0]["cover_cache"],
    }]
    assert built[0]["logger"] is logger
    assert callable(built[0]["get_file_cache_snapshot"])


def test_start_manual_cover_refresh_request_queues_with_explicit_dependencies_outside_context(
    runtime_config, logger, monkeypatch
):
    submitted = []
    built = []
    library_state = {
        "albums": [{"key": "album-1"}],
        "file_cache": {"track-1": {"album": "Album"}},
        "cover_generation": 0,
    }

    monkeypatch.setattr(
        cover_refresh_runtime,
        "build_cover_jobs_for_snapshot",
        lambda **kwargs: built.append(kwargs) or [{"folder": "Artist/Album"}],
    )

    result = cover_refresh_runtime.start_manual_cover_refresh_request(
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: None,
        get_file_cache_snapshot=lambda: {"track-1": {"album": "Album"}},
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_unsuccessful_cover_artwork=lambda **kwargs: None,
        force_search=True,
    )

    assert result == {
        "started": True,
        "already_running": False,
        "queued_after_indexing": False,
        "queued_count": 1,
        "current_folder": "Artist/Album",
    }
    assert len(submitted) == 1
    assert callable(submitted[0][0])
    assert submitted[0][1] is True
    assert built[0]["logger"] is logger
    assert built[0]["cover_cache"].cache_path == runtime_config["COVER_CACHE_PATH"]
    assert library_state["cover_generation"] == 1
    assert library_state["covers_in_progress"] is True


def test_start_background_cover_refresh_request_builds_runner():
    submitted = []
    library_state = {"covers_in_progress": False}

    cover_refresh_runtime.start_background_cover_refresh_request(
        get_state=lambda: library_state,
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_cover_artwork=lambda: None,
    )

    assert len(submitted) == 1
    assert callable(submitted[0][0])


def test_start_background_cover_refresh_request_queues_with_explicit_app_outside_context():
    submitted = []
    library_state = {"covers_in_progress": False, "cover_generation": 0}

    cover_refresh_runtime.start_background_cover_refresh_request(
        get_state=lambda: library_state,
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_cover_artwork=lambda: None,
    )

    assert len(submitted) == 1
    assert callable(submitted[0][0])
    assert library_state["cover_generation"] == 1


def test_start_background_cover_refresh_request_publishes_busy_state_before_worker_runs():
    submitted = []
    library_state = {
        "covers_in_progress": False,
        "covers_processed": 4,
        "covers_total": 5,
        "covers_downloaded": 2,
        "covers_current_folder": "Previous/Album",
    }

    cover_refresh_runtime.start_background_cover_refresh_request(
        get_state=lambda: library_state,
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_cover_artwork=lambda: None,
    )

    assert len(submitted) == 1
    assert library_state["covers_in_progress"] is True
    assert library_state["covers_processed"] == 0
    assert library_state["covers_total"] == 0
    assert library_state["covers_downloaded"] == 0
    assert library_state["covers_current_folder"] == ""


def test_cancel_cover_refresh_status_returns_service_snapshot():
    library_state = {
        "covers_in_progress": True,
        "covers_current_folder": "Artist/Album",
    }

    payload = cover_refresh_runtime.cancel_cover_refresh_status(get_state=lambda: library_state)

    assert payload == {
        "cancelled": True,
        "covers_in_progress": False,
    }
    assert library_state["covers_current_folder"] == ""


def test_run_background_cover_refresh_worker_runs_supplied_callback():
    library_state = {"covers_in_progress": True}
    calls = []

    cover_refresh_runtime.run_background_cover_refresh_worker(
        get_state=lambda: library_state,
        refresh_cover_artwork=lambda: calls.append("refreshed"),
    )

    assert calls == ["refreshed"]


def test_run_manual_cover_refresh_worker_preserves_completed_progress_on_failure():
    library_state = {
        "covers_in_progress": True,
        "covers_processed": 5,
        "covers_total": 7,
        "covers_downloaded": 3,
        "covers_current_folder": "Artist/Album",
    }

    with pytest.raises(RuntimeError, match="boom"):
        cover_refresh_runtime.run_manual_cover_refresh_worker(
            force_search=False,
            get_state=lambda: library_state,
            refresh_unsuccessful_cover_artwork=lambda **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
        )

    assert library_state["last_error"] == "boom"
    assert library_state["covers_in_progress"] is False
    assert library_state["covers_processed"] == 5
    assert library_state["covers_total"] == 7
    assert library_state["covers_downloaded"] == 3
    assert library_state["covers_outcome"] == "failed"
    assert library_state["covers_current_folder"] == ""


@pytest.fixture(params=["background", "manual", "prepared"])
def cover_worker_runner(request):
    state = {
        "covers_in_progress": True, "cover_generation": 3, "scan_generation": 4,
        "covers_processed": 5, "covers_completed": 4, "covers_total": 7,
        "covers_downloaded": 3, "covers_current_folder": "Artist/Album",
        "covers_outcome": "running", "covers_finished_monotonic": None,
    }
    current = [state]
    prepared = None
    if request.param == "prepared":
        prepared = (cover_refresh_runtime.CoverRefreshContext(
            library_state=state, file_cache={}, separate_release_keys=set(),
            cover_cache=None, image_extensions={".jpg"}, user_agent="AlbumHavenTests/1.0",
            scan_generation=4, cover_generation=3,
        ), [{"folder": "Artist/Album"}])

    def submit(executor, callback):
        if request.param == "background":
            runner = cover_refresh_runtime.build_background_cover_refresh_runner(
                get_state=lambda: current[0], refresh_cover_artwork=callback,
            )
            return executor.submit(runner)
        runner = cover_refresh_runtime.build_manual_cover_refresh_runner(
            get_state=lambda: current[0], refresh_unsuccessful_cover_artwork=callback,
            cache_lock=threading.Lock(),
        )
        return executor.submit(runner, True, prepared)

    return state, current, prepared, submit, request.param


@pytest.mark.parametrize("transition", ["unchanged", "replacement", "cover_generation", "scan_generation"])
def test_cover_worker_future_preserves_failure_and_owned_progress(cover_worker_runner, transition):
    state, current, _prepared, submit, _mode = cover_worker_runner
    failure = RuntimeError("provider outcome persistence acknowledgement lost")
    expected = {}

    def fail(**_kwargs):
        if transition == "replacement":
            current[0] = dict(state)
        elif transition != "unchanged":
            current[0][transition] += 1
        if transition != "unchanged":
            current[0].update(
                covers_completed=11, covers_processed=12, covers_total=20,
                covers_downloaded=9, covers_current_folder="Newer/Album",
                covers_outcome="running", last_error="newer diagnostic",
            )
        expected.update(current[0])
        raise failure

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = submit(executor, fail)
        with pytest.raises(RuntimeError, match="provider outcome persistence acknowledgement lost") as caught:
            future.result(timeout=5)

    assert caught.value is failure
    assert future.exception() is failure
    if transition == "unchanged":
        finished = current[0]["covers_finished_monotonic"]
        assert isinstance(finished, (int, float))
        expected.update(
            last_error=str(failure), covers_in_progress=False,
            covers_outcome="failed", covers_current_folder="",
            covers_finished_monotonic=finished,
        )
    assert current[0] == expected, "a stale worker must not alter any newer progress field"


def test_cover_worker_future_preserves_success_contract(cover_worker_runner):
    state, current, prepared, submit, mode = cover_worker_runner
    baseline = dict(state)
    calls = []

    def complete(**kwargs):
        calls.append(kwargs)
        return {"processed": 1}

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = submit(executor, complete)
        assert future.result(timeout=5) is None

    expected_kwargs = {} if mode == "background" else {"force_search": True}
    if prepared is not None:
        expected_kwargs["prepared"] = prepared
    assert calls == [expected_kwargs]
    assert current[0] == baseline


@pytest.mark.parametrize("entrypoint", ["worker", "request"])
def test_background_worker_lock_covers_capture_and_failure_not_callback(entrypoint):
    cache_lock = threading.Lock()
    reads = []
    writes = []

    class ObservedState(dict):
        def get(self, key, default=None):
            if key in {"cover_generation", "scan_generation"}:
                reads.append(cache_lock.locked())
            return super().get(key, default)

        def __setitem__(self, key, value):
            if key in {"last_error", "covers_outcome", "covers_finished_monotonic"}:
                writes.append(cache_lock.locked())
            return super().__setitem__(key, value)

    state = ObservedState(cover_generation=3, scan_generation=4, covers_in_progress=False)
    failure = RuntimeError("guarded background failure")

    def fail():
        assert cache_lock.acquire(blocking=False), "callback must execute outside cache_lock"
        cache_lock.release()
        raise failure

    if entrypoint == "worker":
        def runner():
            cover_refresh_runtime.run_background_cover_refresh_worker(
                get_state=lambda: state, refresh_cover_artwork=fail, cache_lock=cache_lock,
            )
    else:
        submitted = []
        cover_refresh_runtime.start_background_cover_refresh_request(
            get_state=lambda: state, refresh_cover_artwork=fail, cache_lock=cache_lock,
            submit_cover_job=lambda callback: submitted.append(callback),
        )
        assert len(submitted) == 1
        runner = submitted[0]
    reads.clear()
    writes.clear()
    with ThreadPoolExecutor(max_workers=1) as executor:
        with pytest.raises(RuntimeError, match="guarded background failure") as caught:
            executor.submit(runner).result(timeout=5)
    assert caught.value is failure
    assert reads == [True, True, True, True], "capture and ownership recheck must hold cache_lock"
    assert writes and all(writes), "failure status updates must share the ownership-check lock"
    assert not cache_lock.locked()


def test_background_worker_lock_is_forwarded_by_normal_state_wiring(monkeypatch, runtime_config, logger):
    from music_app.services import state as state_module

    observed = []
    monkeypatch.setattr(
        state_module, "refresh_library_state",
        lambda _state, **kwargs: kwargs["start_background_cover_refresh"](),
    )
    monkeypatch.setattr(
        state_module, "start_background_cover_refresh_request",
        lambda **kwargs: observed.append(kwargs.get("cache_lock")),
    )
    state_module.refresh_library_for_state({}, runtime_config, logger)
    assert observed == [state_module._CACHE_LOCK]


def test_refresh_cover_artwork_request_runs_background_jobs_with_runtime_context(runtime_config, logger):
    selected = []
    executed = []
    logged = []
    library_state = {
        "file_cache": {"track-1": {"album": "Album"}},
        "albums": [{
            "cover_selection_origin": "user",
            "tracks": [{"path": "track-1"}],
        }],
        "separate_release_keys": {"release-1"},
        "scan_generation": 12,
        "cover_generation": 7,
    }

    get_state = lambda: library_state
    result = cover_refresh_runtime.refresh_cover_artwork_request(
        get_state=get_state,
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        log_app_event=lambda *args, **kwargs: None,
        select_background_cover_refresh_jobs=lambda **kwargs: selected.append(kwargs) or [{"folder": "Artist/Album"}],
        build_cover_jobs=lambda current_file_cache, **kwargs: [
            {"folder": "Artist/Album", "track_paths": list(current_file_cache)}
        ],
        run_cover_jobs=lambda **kwargs: (
            library_state.__setitem__("covers_in_progress", False),
            executed.append(kwargs),
            {
                "changed": False,
                "processed": 1,
                "downloaded": 0,
                "skipped": 1,
                "failed": 0,
                "downloaded_paths": [],
                "job_results": [],
            },
        )[2],
        log_cover_refresh_completion=lambda **kwargs: logged.append(kwargs),
        bulk_negative_cache_ttl_seconds=321.0,
        job_workers=4,
    )

    assert len(selected) == 1
    assert selected[0]["scan_generation"] == 12
    assert selected[0]["user_owned_track_paths"] == {"track-1"}
    assert len(executed) == 1
    assert executed[0]["scan_generation"] == 12
    assert executed[0]["cover_generation"] == 7
    assert executed[0]["config"] is runtime_config
    assert executed[0]["logger"] is logger
    assert executed[0]["negative_cache_ttl_seconds"] == 321.0
    assert executed[0]["job_workers"] == 4
    assert executed[0]["get_state"] is get_state
    assert result["processed"] == 1
    assert library_state["covers_in_progress"] is False
    assert len(logged) == 1
    assert logged[0]["mode"] == "background"
    assert result == {
        "changed": False,
        "processed": 1,
        "downloaded": 0,
        "skipped": 1,
        "failed": 0,
        "downloaded_paths": [],
        "job_results": [],
    }


@pytest.fixture
def claimed_existing_cover(tmp_path, monkeypatch):
    from music_app.services import cache as cache_service
    from music_app.services import cover_mutation_coordinator
    from music_app.services.cover_mutation_coordinator import (
        CoverMutationBaseline,
        CoverMutationIdentity,
    )

    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover = folder / "cover.jpg"
    cover.write_bytes(b"existing-cover-bytes")
    track = str(folder / "01.flac")
    entries = {track: {
        "album_id": 19,
        "cover_path": None,
        "cover_revision": "previous-revision",
        "cover_selection_origin": "automatic",
    }}
    state = {
        "file_cache": {track: dict(entries[track])},
        "scan_generation": 7,
        "scan_in_progress": False,
        "cover_generation": 11,
    }
    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://claimed-recovery"}
    identity = CoverMutationIdentity(library_id=1, local_album_id=19)
    authority = {
        "cover_mutation_revision": 0,
        "selected_cover_path": None,
        "selected_cover_revision": "previous-revision",
    }

    class FakeCoverMutationRepository:
        def __init__(self, *, database_url, connect_to_database):
            assert database_url == config["ALBUM_HAVEN_APP_DATABASE_URL"]
            assert connect_to_database is cover_refresh_execution.scan_cache_transaction

        def resolve_identity(self, *, library_id, track_paths):
            assert library_id == identity.library_id
            assert set(track_paths) == {track}
            return identity

        def load_baseline(self, *, identity):
            return CoverMutationBaseline(
                inventory_revision=0,
                cover_mutation_revision=authority["cover_mutation_revision"],
                selected_cover_revision=authority["selected_cover_revision"],
                selected_cover_path=authority["selected_cover_path"],
            )

        def recover_ambiguous(self, *, request):
            raise AssertionError(f"Unexpected generic recovery: {request!r}")

    monkeypatch.setattr(
        cover_refresh_execution,
        "PostgresCoverMutationRepository",
        FakeCoverMutationRepository,
    )
    monkeypatch.setattr(
        cache_service,
        "PostgresCoverMutationRepository",
        FakeCoverMutationRepository,
    )
    monkeypatch.setattr(
        cache_service,
        "_select_runtime_scan_cache_adapter",
        lambda _config: SimpleNamespace(
            load_inventory_publication=lambda: {"library_id": identity.library_id}
        ),
    )
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **options: options["acquire_local_lock"](),
    )
    monkeypatch.setattr(
        cover_refresh_execution, "persist_cover_selection_in_shared_transaction",
        lambda *_args, **_kwargs: pytest.fail("claimed recovery must not use generic persistence"),
    )
    return SimpleNamespace(
        track=track,
        cover=cover,
        entries=entries,
        state=state,
        config=config,
        authority=authority,
        kwargs={
            "config": config,
            "job": {"folder": folder, "track_paths": [track]},
            "cover_path": cover,
            "file_cache": entries,
            "get_state": lambda: state,
            "library_state": state,
            "cache_lock": threading.Lock(),
            "scan_generation": 7,
            "cover_generation": 11,
        },
    )


@pytest.mark.parametrize(
    ("origin", "revision"), [("automatic", "previous-revision"), (None, None)],
)
def test_existing_cover_recovery_uses_claimed_persister_with_exact_fence(
    claimed_existing_cover, origin, revision,
):
    case = claimed_existing_cover
    for entries in (case.entries, case.state["file_cache"]):
        entries[case.track].update(cover_selection_origin=origin, cover_revision=revision)
    calls, commits = [], []
    selected_revision = cover_refresh_execution.cover_revision_for_path(case.cover)
    case.kwargs["expected_inventory_mutation_revision"] = 23

    def persist(track_paths, selected_cover_path, **options):
        calls.append((track_paths, selected_cover_path))
        assert options.keys() == {
            "cover_revision",
            "cover_selection_origin",
            "expected_library_id",
            "expected_album_id",
            "expected_inventory_revision",
            "expected_cover_mutation_revision",
            "expected_inventory_mutation_revision",
            "local_cover_width",
            "local_cover_height",
            "reject_if_user_controlled",
            "reject_if_explicit_selection",
            "expected_cover_state",
            "expected_cover_selection_origin",
            "expected_cover_revision",
            "commit_guard",
        }
        assert options["cover_revision"] == selected_revision
        assert options["cover_selection_origin"] == "automatic"
        assert options["expected_library_id"] == 1
        assert options["expected_album_id"] == 19
        assert options["expected_inventory_revision"] == 0
        assert options["expected_cover_mutation_revision"] == 0
        assert options["expected_inventory_mutation_revision"] == 23
        assert options["reject_if_user_controlled"] is True
        assert options["expected_cover_state"] == (origin, revision)
        assert case.entries[case.track]["cover_path"] is None
        assert case.state["file_cache"][case.track]["cover_path"] is None
        def commit():
            case.authority.update(
                cover_mutation_revision=1,
                selected_cover_path=str(case.cover.resolve()),
                selected_cover_revision=selected_revision,
            )
            commits.append("committed")

        options["commit_guard"](commit)
        return {"album_rows_updated": 1, "track_file_rows_updated": 1}

    case.config["CLAIMED_COVER_SELECTION_PERSISTER"] = persist

    assert cover_refresh_execution._recover_existing_cover_selection(**case.kwargs) == (True, False)
    assert calls == [({case.track}, case.cover.resolve())]
    assert commits == ["committed"]
    for entries in (case.entries, case.state["file_cache"]):
        assert entries[case.track]["cover_path"] == str(case.cover.resolve())
        assert entries[case.track]["cover_revision"] == selected_revision
        assert entries[case.track]["cover_selection_origin"] == "automatic"


@pytest.mark.parametrize(
    "rejection",
    ["blocked_by_user_selection", "blocked_by_expected_cover_state", "claim_cancelled", "generation_changed"],
)
def test_existing_cover_recovery_claim_rejection_does_not_publish_runtime(
    claimed_existing_cover, rejection,
):
    case = claimed_existing_cover
    baseline = dict(case.entries[case.track])
    calls, commits = [], []

    def persist(track_paths, selected_cover_path, **options):
        calls.append((track_paths, selected_cover_path))
        assert options["expected_cover_state"] == ("automatic", "previous-revision")
        assert options["reject_if_user_controlled"] is True
        if rejection == "claim_cancelled":
            raise RuntimeError("cover refresh claim no longer active")
        if rejection == "generation_changed":
            case.state["cover_generation"] += 1
            options["commit_guard"](lambda: commits.append("committed"))
            pytest.fail("stale generation must not commit")
        return {rejection: True}

    case.config["CLAIMED_COVER_SELECTION_PERSISTER"] = persist

    if rejection in {"claim_cancelled", "generation_changed"}:
        with pytest.raises(RuntimeError, match="claim no longer active|changed before commit"):
            cover_refresh_execution._recover_existing_cover_selection(**case.kwargs)
    else:
        assert cover_refresh_execution._recover_existing_cover_selection(**case.kwargs) == (False, True)
    assert calls == [({case.track}, case.cover.resolve())]
    assert commits == []
    assert case.entries[case.track] == baseline
    assert case.state["file_cache"][case.track] == baseline


def test_claimed_cover_refresh_runs_nonempty_plan_with_safe_logger_plumbing(
    runtime_config, monkeypatch
):
    from music_app.jobs.safe_logging import DurablePipelineLogger
    from music_app.services import app_logging, state as state_service

    executions = []
    monkeypatch.setattr(
        state_service,
        "select_background_cover_refresh_jobs",
        lambda **_kwargs: [{"folder": "opaque-folder", "track_paths": []}],
    )
    monkeypatch.setattr(
        state_service,
        "run_cover_jobs",
        lambda **kwargs: (
            kwargs["logger"].verbose("private candidate %s", "private-url"),
            app_logging.flush_log_handlers_debounced(
                kwargs["logger"], min_interval_seconds=0.1
            ),
            executions.append(kwargs),
            {
                "changed": False,
                "processed": 1,
                "downloaded": 0,
                "skipped": 1,
                "failed": 0,
                "downloaded_paths": [],
                "job_results": [],
            },
        )[-1],
    )
    monkeypatch.setattr(
        state_service, "log_cover_refresh_completion", lambda **_kwargs: None
    )
    logger = DurablePipelineLogger(
        logging.getLogger("test.cover.claimed.nonempty"), domain="cover"
    )

    result = cover_refresh_runtime.run_claimed_cover_refresh(
        scope=SimpleNamespace(
            file_cache={},
            progress_total=1,
            mode="post_scan",
            force_search=False,
        ),
        config=runtime_config,
        logger=logger,
        should_cancel=lambda: False,
        progress=lambda **_kwargs: True,
    )

    assert result["processed"] == 1
    assert len(executions) == 1
    assert executions[0]["logger"] is logger


def test_refresh_cover_artwork_for_track_paths_request_logs_no_jobs_found(runtime_config, logger):
    logged = []
    library_state = {"cover_generation": 4}

    result = cover_refresh_runtime.refresh_cover_artwork_for_track_paths_request(
        get_state=lambda: library_state,
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        log_app_event=lambda *args, **kwargs: None,
        track_paths={"track-1"},
        force_search=True,
        select_manual_track_cover_refresh_jobs=lambda **kwargs: [],
        build_cover_jobs=lambda current_file_cache, **kwargs: [],
        run_cover_jobs=lambda **kwargs: {"unexpected": True},
        log_cover_refresh_completion=lambda **kwargs: logged.append(kwargs),
    )

    assert result == {
        "changed": False,
        "processed": 0,
        "downloaded": 0,
        "failed": 0,
        "job_results": [],
    }
    assert library_state["cover_generation"] == 5
    assert library_state["covers_in_progress"] is False
    assert len(logged) == 1
    assert logged[0]["mode"] == "manual-single"
    assert logged[0]["force_search"] is True
    assert logged[0]["result"]["job_results"] == [{"reason": "no_jobs_found"}]
    assert logger.messages == [
        (
            "Cover refresh manual single produced no jobs requested_track_count=%s sample_paths=%s",
            (1, ["track-1"]),
        )
    ]


def test_refresh_unsuccessful_cover_artwork_request_uses_bumped_cover_generation(runtime_config, logger):
    selected = []
    executed = []
    logged = []
    library_state = {
        "file_cache": {"track-1": {"album": "Album"}},
        "cover_generation": 7,
    }

    result = cover_refresh_runtime.refresh_unsuccessful_cover_artwork_request(
        get_state=lambda: library_state,
        cache_lock=threading.Lock(),
        config=runtime_config,
        logger=logger,
        log_app_event=lambda *args, **kwargs: None,
        force_search=False,
        select_manual_bulk_cover_refresh_jobs=lambda **kwargs: selected.append(kwargs) or [{"folder": "Artist/Album"}],
        build_cover_jobs=lambda current_file_cache, **kwargs: [
            {"folder": "Artist/Album", "track_paths": list(current_file_cache)}
        ],
        run_cover_jobs=lambda **kwargs: (
            library_state.__setitem__("covers_in_progress", False),
            executed.append(kwargs),
            {
                "changed": True,
                "processed": 1,
                "downloaded": 1,
                "skipped": 0,
                "failed": 0,
                "downloaded_paths": ["cover.jpg"],
                "job_results": [],
            },
        )[2],
        log_cover_refresh_completion=lambda **kwargs: logged.append(kwargs),
        bulk_negative_cache_ttl_seconds=654.0,
        job_workers=2,
    )

    assert result["changed"] is True
    assert len(selected) == 1
    assert len(executed) == 1
    assert executed[0]["cover_generation"] == 8
    assert executed[0]["config"] is runtime_config
    assert executed[0]["logger"] is logger
    assert executed[0]["negative_cache_ttl_seconds"] == 654.0
    assert executed[0]["job_workers"] == 2
    assert len(logged) == 1
    assert logged[0]["mode"] == "manual-bulk"


@pytest.mark.parametrize("failure_stage", ["planning", "submission"])
@pytest.mark.parametrize("newer_request", [False, True])
def test_manual_preparation_failure_cleans_only_owned_request(runtime_config, logger, failure_stage, newer_request):
    state = {"albums": [{"key": "album"}], "file_cache": {"track": {"album": "Album"}}, "cover_generation": 2}
    lock = threading.Lock()
    newer = {"cover_generation": 4, "covers_in_progress": True, "covers_current_folder": "Newer/Album", "covers_processed": 17, "covers_total": 99, "covers_downloaded": 8}
    def fail():
        assert not lock.locked(), "Planning and executor submission must not hold runtime lock"
        if newer_request:
            with lock:
                state.update(newer)
        raise RuntimeError("isolated preparation failure")
    def plan(**_kwargs):
        if failure_stage == "planning":
            fail()
        return [{"folder": "Artist/Album"}]
    def submit(*_args):
        if failure_stage == "submission":
            fail()
        pytest.fail("Failed planning must not submit")
    with pytest.raises(RuntimeError, match="isolated preparation failure"):
        cover_refresh_runtime.start_manual_cover_refresh(
            config=runtime_config, logger=logger, get_state=lambda: state, cache_lock=lock,
            start_background_refresh=lambda **kw: pytest.fail("Unexpected scan"),
            build_cover_jobs=plan, submit_cover_job=submit,
            refresh_manual_cover_artwork_worker=lambda force_search, prepared: None,
        )
    if newer_request:
        assert {key: state[key] for key in newer} == newer
    else:
        assert state["cover_generation"] == 3
        assert state["covers_in_progress"] is False
        assert state["covers_current_folder"] == ""
        assert state["covers_total"] == (1 if failure_stage == "submission" else 0)
        assert state["covers_processed"] == state["covers_downloaded"] == 0
        assert state["covers_outcome"] == "failed"


def test_empty_prepared_manual_refresh_finishes_without_provider_execution(runtime_config, logger):
    state = {"cover_generation": 2, "scan_generation": 4, "covers_in_progress": True}
    context = cover_refresh_runtime.build_cover_refresh_context(get_state=lambda: state, config=runtime_config)
    logged = []
    result = cover_refresh_runtime.execute_cover_refresh_request(
        context=context, cache_lock=threading.Lock(), jobs=[],
        run_cover_jobs=lambda **kw: pytest.fail("Empty prepared job list must not run providers"),
        log_cover_refresh_completion=lambda **kw: logged.append(kw),
        config=runtime_config, logger=logger, log_app_event=lambda *args, **kw: None,
        mode="manual-bulk", force_search=True, allow_apple_web_fallback=True,
        allow_apple_web_fallback_when_has_cover=False, include_job_results_when_empty=True,
        prepared_get_state=lambda: state,
    )
    assert result == {"changed": False, "processed": 0, "downloaded": 0, "failed": 0, "job_results": []}
    assert state["cover_generation"] == 2
    assert state["covers_in_progress"] is False
    assert len(logged) == 1
    assert logged[0]["jobs"] == []


def test_manual_preparation_reservation_rechecks_competing_start(runtime_config, logger):

    submitted, results, errors = [], [], []
    lock = threading.Lock()
    observed_idle = threading.Event()
    competitor_done = threading.Event()

    class InterleavedState(dict):
        armed = True

        def get(self, key, default=None):
            value = super().get(key, default)
            if key == "covers_in_progress" and self.armed:
                self.armed = False
                observed_idle.set()
                # Without the shared lock, let the competing request reserve
                # between this idle observation and this caller's reservation.
                if not lock.locked():
                    assert competitor_done.wait(5), "Competing request did not finish"
            return value

    state = InterleavedState(albums=[{"key": "album"}], file_cache={"track": {"album": "Album"}}, cover_generation=2)

    def start():
        return cover_refresh_runtime.start_manual_cover_refresh(
            config=runtime_config, logger=logger, get_state=lambda: state,
            start_background_refresh=lambda **kw: pytest.fail("Unexpected scan"),
            build_cover_jobs=lambda **kw: [{"folder": "Artist/Album"}],
            submit_cover_job=lambda *args: submitted.append(args),
            refresh_manual_cover_artwork_worker=lambda force_search, prepared: None,
            cache_lock=lock,
        )

    def compete():
        try:
            assert observed_idle.wait(5), "First request never observed idle"
            results.append(start())
        except BaseException as exc:
            errors.append(exc)
        finally:
            competitor_done.set()

    thread = threading.Thread(target=compete)
    thread.start()
    try:
        results.append(start())
    finally:
        thread.join(5)
    assert not thread.is_alive()
    assert errors == []
    assert sum(bool(item["started"]) for item in results) == 1
    assert len(submitted) == 1
    assert state["cover_generation"] == 3


@pytest.mark.parametrize("invalidate", ["cancel", "newer"])
def test_prepared_manual_start_preserves_change_after_validation(runtime_config, logger, monkeypatch, invalidate):
    state = {"albums": [{"key": "album"}], "file_cache": {"track": {"album": "Album"}}, "scan_generation": 4, "cover_generation": 2, "covers_in_progress": True}
    context = cover_refresh_runtime.build_cover_refresh_context(get_state=lambda: state, config=runtime_config)
    jobs = [{"folder": "Artist/Album", "track_paths": ["track"]}]
    lock = threading.Lock()
    original_execute = cover_refresh_runtime.execute_cover_refresh_request
    expected = {}
    executions = []

    def interleave(**kwargs):
        with lock:
            cover_refresh_runtime.cancel_cover_refresh_status(get_state=lambda: state)
            if invalidate == "newer":
                state.update(cover_generation=state["cover_generation"] + 1, covers_in_progress=True, covers_total=99, covers_processed=17, covers_downloaded=8, covers_current_folder="Newer/Album")
            expected.update(state)
        return original_execute(**kwargs)

    monkeypatch.setattr(cover_refresh_runtime, "execute_cover_refresh_request", interleave)
    result = cover_refresh_runtime.refresh_unsuccessful_cover_artwork_request(
        get_state=lambda: state, cache_lock=lock, config=runtime_config, logger=logger,
        log_app_event=lambda *args, **kw: None, force_search=True,
        select_manual_bulk_cover_refresh_jobs=lambda **kw: pytest.fail("Must reuse prepared jobs"),
        build_cover_jobs=lambda *args, **kw: pytest.fail("Must reuse prepared jobs"),
        run_cover_jobs=lambda **kw: executions.append(kw) or {"changed": False, "processed": 1},
        log_cover_refresh_completion=lambda **kw: None,
        bulk_negative_cache_ttl_seconds=321, job_workers=2, prepared=(context, jobs),
    )
    assert executions == []
    assert state == expected
    assert result["processed"] == 0


@pytest.mark.parametrize("invalidate", [None, "cancel", "scan", "newer"])
def test_manual_submission_reuses_preparation_and_rejects_stale_work(runtime_config, logger, monkeypatch, invalidate):
    state = {"albums": [{"key": "album"}], "file_cache": {"track": {"album": "Album"}}, "scan_generation": 4, "cover_generation": 2}
    snapshot = {"track": {"album": "Snapshot", "cover_selection_origin": "user"}}
    jobs = [{"folder": "Artist/Album", "track_paths": ["track"], "cover_selection_origin": "user"}]
    planned, submitted, executed, snapshots = [], [], [], []
    def plan_snapshot(**kwargs):
        planned.append(kwargs["cover_cache"])
        assert kwargs["get_file_cache_snapshot"]() == snapshot
        return jobs
    monkeypatch.setattr(cover_refresh_runtime, "build_cover_jobs_for_snapshot", plan_snapshot)
    def execute(**kwargs):
        executed.append(kwargs)
        return {"changed": False, "processed": 1, "downloaded": 0, "failed": 0, "job_results": []}
    def refresh(**kwargs):
        return cover_refresh_runtime.refresh_unsuccessful_cover_artwork_request(
            get_state=lambda: state, cache_lock=threading.Lock(), config=runtime_config, logger=logger,
            log_app_event=lambda *args, **kw: None,
            select_manual_bulk_cover_refresh_jobs=lambda **kw: planned.append(kw["cover_cache"]) or jobs,
            build_cover_jobs=lambda *args, **kw: jobs, run_cover_jobs=execute,
            log_cover_refresh_completion=lambda **kw: None,
            bulk_negative_cache_ttl_seconds=321, job_workers=2, **kwargs,
        )
    result = cover_refresh_runtime.start_manual_cover_refresh_request(
        cache_lock=threading.Lock(), config=runtime_config, logger=logger, get_state=lambda: state,
        start_background_refresh=lambda **kwargs: pytest.fail("unexpected scan"),
        get_file_cache_snapshot=lambda: snapshots.append(True) or snapshot,
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_unsuccessful_cover_artwork=refresh, force_search=True,
    )
    assert result["queued_count"] == 1
    assert result["current_folder"] == jobs[0]["folder"]
    reserved_generation = state["cover_generation"]
    if invalidate == "cancel":
        cover_refresh_runtime.cancel_cover_refresh_status(get_state=lambda: state)
    elif invalidate == "scan":
        state["scan_generation"] += 1
    elif invalidate == "newer":
        state.update(cover_generation=reserved_generation + 1, covers_total=99, covers_processed=17, covers_current_folder="Newer/Album")
    expected_generation = state["cover_generation"]
    callback, *args = submitted[0]
    callback(*args)
    assert len(planned) == 1
    assert len(snapshots) == 1
    assert state["cover_generation"] == expected_generation
    if invalidate:
        assert executed == []
        if invalidate == "newer":
            assert state["covers_in_progress"] is True
            assert state["covers_total"] == 99
            assert state["covers_processed"] == 17
            assert state["covers_current_folder"] == "Newer/Album"
        else:
            assert state["covers_in_progress"] is False
    else:
        assert len(executed) == 1
        assert executed[0]["jobs"] is jobs
        assert executed[0]["file_cache"] == snapshot
        assert executed[0]["cover_cache"] is planned[0]
        assert executed[0]["force_search"] is True
        assert executed[0]["job_workers"] == 2
