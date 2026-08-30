from __future__ import annotations

from music_app.services import cover_refresh_jobs


class _LoggerStub:
    def __init__(self) -> None:
        self.verbose_calls: list[tuple[str, tuple[object, ...]]] = []

    def verbose(self, message: str, *args: object) -> None:
        self.verbose_calls.append((message, args))


def test_select_background_cover_refresh_jobs_includes_missing_and_user_owned_covers():
    logger = _LoggerStub()
    calls = []
    cover_cache = object()

    jobs = cover_refresh_jobs.select_background_cover_refresh_jobs(
        file_cache={"track-1": {}, "track-2": {}, "track-3": {}},
        user_owned_track_paths={"track-2"},
        cover_cache=cover_cache,
        build_cover_jobs=lambda current_file_cache, **kwargs: calls.append(
            (current_file_cache, kwargs)
        ) or [
            {"folder": "missing", "needs_cover_fetch": True, "cover_selection_origin": None},
            {
                "folder": "user",
                "track_paths": ["track-2"],
                "needs_cover_fetch": False,
                "cover_selection_origin": None,
            },
            {"folder": "automatic", "needs_cover_fetch": False, "cover_selection_origin": "automatic"},
            {"folder": "unowned", "needs_cover_fetch": False, "cover_selection_origin": None},
        ],
        logger=logger,
        scan_generation=12,
    )

    assert jobs == [
        {"folder": "missing", "needs_cover_fetch": True, "cover_selection_origin": None},
        {
            "folder": "user",
            "track_paths": ["track-2"],
            "needs_cover_fetch": False,
            "cover_selection_origin": "user",
        },
    ]
    assert calls == [(
        {"track-1": {}, "track-2": {}, "track-3": {}},
        {"cover_cache": cover_cache},
    )]


def test_select_manual_track_cover_refresh_jobs_filters_requested_paths():
    logger = _LoggerStub()
    file_cache = {"track-1": {}, "track-2": {}}

    jobs = cover_refresh_jobs.select_manual_track_cover_refresh_jobs(
        file_cache=file_cache,
        track_paths={"track-2"},
        cover_cache=object(),
        build_cover_jobs=lambda current_file_cache, **kwargs: [
            {"artist": "Artist A", "album": "Album A", "folder": "A", "track_paths": ["track-1"]},
            {"artist": "Artist B", "album": "Album B", "folder": "B", "track_paths": ["track-2"]},
        ],
        logger=logger,
    )

    assert jobs == [{"artist": "Artist B", "album": "Album B", "folder": "B", "track_paths": ["track-2"]}]
    assert len(logger.verbose_calls) == 2
    assert logger.verbose_calls[0][0].startswith("Cover refresh manual single skipped")
    assert logger.verbose_calls[1][0].startswith("Cover refresh manual single queued")


def test_log_cover_refresh_completion_uses_manual_single_fields():
    logged = []

    cover_refresh_jobs.log_cover_refresh_completion(
        config={"TESTING": True},
        logger=object(),
        log_app_event=lambda config, logger, message, **kwargs: logged.append((message, kwargs)),
        jobs=[{"folder": "A"}],
        result={
            "processed": 1,
            "downloaded": 1,
            "skipped": 0,
            "failed": 0,
            "downloaded_paths": ["cover.jpg"],
            "job_results": [
                {
                    "artist": "Artist B",
                    "album": "Album B",
                    "year": 2002,
                    "reason": "downloaded_remote_cover",
                    "source": "cover_art_archive",
                }
            ],
        },
        mode="manual-single",
        force_search=True,
    )

    assert logged == [
        (
            "Manual cover fetch completed",
            {
                "level": "info",
                "history": True,
                "album_count": 1,
                "processed": 1,
                "downloaded": 1,
                "skipped": 0,
                "failed": 0,
                "not_touched": 0,
                "not_found": 0,
                "downloaded_paths": ["cover.jpg"],
                "files": ["cover.jpg"],
                "mode": "manual-single",
                "force_search": True,
                "artist": "Artist B",
                "album": "Album B",
                "year": 2002,
                "reason": "downloaded_remote_cover",
                "source": "cover_art_archive",
            },
        )
    ]


def test_log_cover_refresh_completion_uses_background_defaults():
    logged = []

    cover_refresh_jobs.log_cover_refresh_completion(
        config={"TESTING": True},
        logger=object(),
        log_app_event=lambda config, logger, message, **kwargs: logged.append((message, kwargs)),
        jobs=[],
        result={"processed": 0, "downloaded": 0, "skipped": 0, "failed": 0, "downloaded_paths": []},
        mode="background",
    )

    assert logged == [
        (
            "Cover art update completed",
            {
                "level": "info",
                "history": True,
                "album_count": 0,
                "processed": 0,
                "downloaded": 0,
                "skipped": 0,
                "failed": 0,
                "not_touched": 0,
                "not_found": 0,
                "downloaded_paths": [],
                "files": [],
                "mode": "background",
            },
        )
    ]
