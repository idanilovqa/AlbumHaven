from __future__ import annotations

import pytest
import threading

from music_app.services import cover_refresh_runtime


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
    }

    cover_refresh_runtime.refresh_cover_artwork_request(
        get_state=lambda: library_state,
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
    assert executed[0]["cover_generation"] is None
    assert executed[0]["config"] is runtime_config
    assert executed[0]["logger"] is logger
    assert executed[0]["negative_cache_ttl_seconds"] == 321.0
    assert executed[0]["job_workers"] == 4
    assert library_state["covers_in_progress"] is False
    assert len(logged) == 1
    assert logged[0]["mode"] == "background"


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
