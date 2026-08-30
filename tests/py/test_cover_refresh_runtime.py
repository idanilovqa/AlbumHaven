from __future__ import annotations

import pytest

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


def test_start_manual_cover_refresh_queues_after_indexing(runtime_config, logger):
    background_calls = []
    library_state = {"scan_in_progress": True}

    result = cover_refresh_runtime.start_manual_cover_refresh(
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
    library_state = {
        "albums": [{"key": "album-1"}],
        "file_cache": {"track-1": {"album": "Album"}},
    }

    result = cover_refresh_runtime.start_manual_cover_refresh(
        config=runtime_config,
        logger=logger,
        get_state=lambda: library_state,
        start_background_refresh=lambda **kwargs: None,
        build_cover_jobs=lambda **kwargs: [{"folder": "Artist/Album"}],
        submit_cover_job=lambda *args: submitted.append(args),
        refresh_manual_cover_artwork_worker=lambda force_search: None,
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


def test_run_manual_cover_refresh_worker_resets_status_on_failure():
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
    assert library_state["covers_processed"] == 0
    assert library_state["covers_total"] == 0
    assert library_state["covers_downloaded"] == 0
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
        cache_lock=object(),
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
        cache_lock=object(),
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
        cache_lock=object(),
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
