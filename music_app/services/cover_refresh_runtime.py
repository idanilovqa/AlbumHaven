from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from music_app.services.cover_provider_cache import CoverSearchCache

StateGetter = Callable[[], dict[str, object]]
ExecutorSubmitter = Callable[..., object]
BuildCoverJobs = Callable[..., list[dict[str, object]]]
FileCacheSnapshotGetter = Callable[[], dict[str, dict[str, object]]]
RefreshRunner = Callable[[], None]
RefreshRunnerWithForceSearch = Callable[..., dict[str, object]]
BackgroundRefreshStarter = Callable[..., None]
CoverRefreshJobSelector = Callable[..., list[dict[str, object]]]
CoverRefreshExecutor = Callable[..., dict[str, object]]
CoverRefreshLogger = Callable[..., None]


@dataclass(frozen=True)
class CoverRefreshContext:
    library_state: dict[str, object]
    file_cache: dict[str, dict[str, object]]
    separate_release_keys: set[str]
    cover_cache: CoverSearchCache
    image_extensions: set[str]
    user_agent: str
    scan_generation: int
    cover_generation: int


def _reset_cover_refresh_progress(library_state: dict[str, object], *, in_progress: bool) -> None:
    library_state["covers_in_progress"] = in_progress
    library_state["covers_processed"] = 0
    library_state["covers_total"] = 0
    library_state["covers_downloaded"] = 0
    library_state["covers_current_folder"] = ""


def _handle_cover_refresh_failure(library_state: dict[str, object], exc: Exception) -> None:
    library_state["last_error"] = str(exc)
    _reset_cover_refresh_progress(library_state, in_progress=False)


def _empty_cover_refresh_result(*, include_job_results: bool = False) -> dict[str, object]:
    result: dict[str, object] = {
        "changed": False,
        "processed": 0,
        "downloaded": 0,
        "failed": 0,
    }
    if include_job_results:
        result["job_results"] = []
    return result


def _start_cover_refresh_progress(
    library_state: dict[str, object],
    *,
    queued_count: int,
    current_folder: str = "",
) -> None:
    library_state["covers_in_progress"] = True
    library_state["covers_processed"] = 0
    library_state["covers_total"] = queued_count
    library_state["covers_downloaded"] = 0
    library_state["covers_current_folder"] = current_folder


def build_cover_refresh_context(
    *,
    get_state: StateGetter,
    config,
    bump_cover_generation: bool = False,
) -> CoverRefreshContext:
    library_state = get_state()
    if bump_cover_generation:
        library_state["cover_generation"] = int(library_state.get("cover_generation") or 0) + 1
    return CoverRefreshContext(
        library_state=library_state,
        file_cache=dict(library_state.get("file_cache") or {}),
        separate_release_keys=set(library_state.get("separate_release_keys") or set()),
        cover_cache=CoverSearchCache(config["COVER_CACHE_PATH"]),
        image_extensions=config["IMAGE_EXTENSIONS"],
        user_agent=str(config["MUSICBRAINZ_USER_AGENT"]),
        scan_generation=int(library_state.get("scan_generation") or 0),
        cover_generation=int(library_state.get("cover_generation") or 0),
    )


def _user_owned_track_paths(albums: list[object]) -> set[str]:
    track_paths: set[str] = set()
    for album in albums:
        origin = (
            album.get("cover_selection_origin")
            if isinstance(album, dict)
            else getattr(album, "cover_selection_origin", None)
        )
        if str(origin or "").strip().casefold() != "user":
            continue
        tracks = album.get("tracks", []) if isinstance(album, dict) else getattr(album, "tracks", [])
        for track in tracks or []:
            path = track.get("path") if isinstance(track, dict) else getattr(track, "path", None)
            if path is not None and str(path).strip():
                track_paths.add(str(path))
    return track_paths


def execute_cover_refresh_request(
    *,
    context: CoverRefreshContext,
    cache_lock,
    jobs: list[dict[str, object]],
    run_cover_jobs: CoverRefreshExecutor,
    log_cover_refresh_completion: CoverRefreshLogger,
    config,
    logger,
    log_app_event,
    mode: str,
    force_search: bool = False,
    allow_apple_web_fallback: bool,
    allow_apple_web_fallback_when_has_cover: bool,
    negative_cache_ttl_seconds: float | None = None,
    job_workers: int = 1,
    include_job_results_when_empty: bool = False,
    empty_log_result: dict[str, object] | None = None,
) -> dict[str, object]:
    _start_cover_refresh_progress(context.library_state, queued_count=len(jobs))
    if not jobs:
        log_cover_refresh_completion(
            config=config,
            logger=logger,
            log_app_event=log_app_event,
            jobs=jobs,
            result=empty_log_result or {
                "processed": 0,
                "downloaded": 0,
                "skipped": 0,
                "failed": 0,
                "downloaded_paths": [],
            },
            mode=mode,
            force_search=force_search,
        )
        context.library_state["covers_in_progress"] = False
        return _empty_cover_refresh_result(include_job_results=include_job_results_when_empty)

    result = run_cover_jobs(
        get_state=lambda: context.library_state,
        config=config,
        logger=logger,
        cache_lock=cache_lock,
        jobs=jobs,
        file_cache=context.file_cache,
        separate_release_keys=context.separate_release_keys,
        image_extensions=context.image_extensions,
        user_agent=context.user_agent,
        cover_cache=context.cover_cache,
        scan_generation=context.scan_generation if mode == "background" else None,
        cover_generation=context.cover_generation if mode != "background" else None,
        force_search=force_search,
        allow_apple_web_fallback=allow_apple_web_fallback,
        allow_apple_web_fallback_when_has_cover=allow_apple_web_fallback_when_has_cover,
        negative_cache_ttl_seconds=negative_cache_ttl_seconds,
        job_workers=job_workers,
    )
    log_cover_refresh_completion(
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        jobs=jobs,
        result=result,
        mode=mode,
        force_search=force_search,
    )
    return result


def run_background_cover_refresh_worker(
    *,
    get_state: StateGetter,
    refresh_cover_artwork: RefreshRunner,
) -> None:
    try:
        refresh_cover_artwork()
    except Exception as exc:
        _handle_cover_refresh_failure(get_state(), exc)


def run_manual_cover_refresh_worker(
    *,
    force_search: bool,
    get_state: StateGetter,
    refresh_unsuccessful_cover_artwork: RefreshRunnerWithForceSearch,
) -> None:
    try:
        refresh_unsuccessful_cover_artwork(force_search=force_search)
    except Exception as exc:
        _handle_cover_refresh_failure(get_state(), exc)


def build_cover_jobs_for_snapshot(
    *,
    get_file_cache_snapshot: FileCacheSnapshotGetter,
    logger,
    **kwargs,
) -> list[dict[str, object]]:
    from music_app.services.cover_refresh_planning import build_cover_refresh_jobs

    return build_cover_refresh_jobs(
        get_file_cache_snapshot(),
        logger=logger,
        **kwargs,
    )


def build_background_cover_refresh_runner(
    *,
    get_state: StateGetter,
    refresh_cover_artwork: RefreshRunner,
) -> Callable[[], None]:
    def _runner() -> None:
        run_background_cover_refresh_worker(
            get_state=get_state,
            refresh_cover_artwork=refresh_cover_artwork,
        )

    return _runner


def build_manual_cover_refresh_runner(
    *,
    get_state: StateGetter,
    refresh_unsuccessful_cover_artwork: RefreshRunnerWithForceSearch,
) -> Callable[[bool], None]:
    def _runner(force_search: bool) -> None:
        run_manual_cover_refresh_worker(
            force_search=force_search,
            get_state=get_state,
            refresh_unsuccessful_cover_artwork=refresh_unsuccessful_cover_artwork,
        )

    return _runner


def start_background_cover_refresh(
    *,
    get_state: StateGetter,
    submit_cover_job: ExecutorSubmitter,
    refresh_cover_artwork_worker: Callable[[], None],
    app=None,
) -> None:
    library_state = get_state()
    if library_state.get("covers_in_progress"):
        return
    library_state["cover_generation"] = int(library_state.get("cover_generation") or 0) + 1
    _reset_cover_refresh_progress(library_state, in_progress=True)
    try:
        submit_cover_job(refresh_cover_artwork_worker)
    except Exception:
        _reset_cover_refresh_progress(library_state, in_progress=False)
        raise


def start_background_cover_refresh_request(
    *,
    get_state: StateGetter,
    submit_cover_job: ExecutorSubmitter,
    refresh_cover_artwork: RefreshRunner,
    app=None,
) -> None:
    start_background_cover_refresh(
        get_state=get_state,
        submit_cover_job=submit_cover_job,
        refresh_cover_artwork_worker=build_background_cover_refresh_runner(
            get_state=get_state,
            refresh_cover_artwork=refresh_cover_artwork,
        ),
        app=app,
    )


def start_manual_cover_refresh(
    *,
    config,
    logger,
    get_state: StateGetter,
    start_background_refresh: BackgroundRefreshStarter,
    build_cover_jobs: BuildCoverJobs,
    submit_cover_job: ExecutorSubmitter,
    refresh_manual_cover_artwork_worker: Callable[[bool], None],
    force_search: bool = False,
    app=None,
) -> dict[str, object]:
    library_state = get_state()
    if library_state.get("covers_in_progress"):
        return {"started": False, "already_running": True, "queued_after_indexing": False}
    needs_indexing = (
        bool(library_state.get("scan_in_progress"))
        or not bool(library_state.get("file_cache"))
        or not bool(library_state.get("albums"))
    )
    if needs_indexing:
        library_state["pending_cover_refresh_after_scan"] = True
        library_state["pending_cover_refresh_force_search"] = bool(force_search)
        if not library_state.get("scan_in_progress"):
            start_background_refresh(force=True, scan_mode="background")
        return {
            "started": True,
            "already_running": False,
            "queued_after_indexing": True,
            "queued_count": 0,
            "current_folder": "",
        }
    cover_cache = CoverSearchCache(config["COVER_CACHE_PATH"])
    jobs = build_cover_jobs(require_missing_cover=True, cover_cache=cover_cache)
    library_state["cover_generation"] = int(library_state.get("cover_generation") or 0) + 1
    library_state["covers_processed"] = 0
    library_state["covers_total"] = len(jobs)
    library_state["covers_downloaded"] = 0
    first_folder = str((jobs[0] or {}).get("folder") or "").strip() if jobs else ""
    library_state["covers_current_folder"] = first_folder
    library_state["covers_in_progress"] = True
    if not jobs:
        library_state["covers_in_progress"] = False
        library_state["covers_current_folder"] = ""
        return {
            "started": True,
            "already_running": False,
            "queued_after_indexing": False,
            "queued_count": 0,
            "current_folder": "",
        }
    try:
        submit_cover_job(
            refresh_manual_cover_artwork_worker,
            bool(force_search),
        )
    except Exception:
        _reset_cover_refresh_progress(library_state, in_progress=False)
        raise
    return {
        "started": True,
        "already_running": False,
        "queued_after_indexing": False,
        "queued_count": len(jobs),
        "current_folder": first_folder,
    }


def start_manual_cover_refresh_request(
    *,
    config,
    logger,
    get_state: StateGetter,
    start_background_refresh: BackgroundRefreshStarter,
    get_file_cache_snapshot: FileCacheSnapshotGetter,
    submit_cover_job: ExecutorSubmitter,
    refresh_unsuccessful_cover_artwork: RefreshRunnerWithForceSearch,
    force_search: bool = False,
    app=None,
) -> dict[str, object]:
    return start_manual_cover_refresh(
        config=config,
        logger=logger,
        get_state=get_state,
        start_background_refresh=start_background_refresh,
        build_cover_jobs=lambda **kwargs: build_cover_jobs_for_snapshot(
            get_file_cache_snapshot=get_file_cache_snapshot,
            logger=logger,
            **kwargs,
        ),
        submit_cover_job=submit_cover_job,
        refresh_manual_cover_artwork_worker=build_manual_cover_refresh_runner(
            get_state=get_state,
            refresh_unsuccessful_cover_artwork=refresh_unsuccessful_cover_artwork,
        ),
        force_search=force_search,
        app=app,
    )


def cancel_cover_refresh(get_state: StateGetter) -> bool:
    library_state = get_state()
    if not library_state.get("covers_in_progress"):
        return False
    library_state["cover_generation"] = int(library_state.get("cover_generation") or 0) + 1
    library_state["covers_in_progress"] = False
    library_state["covers_current_folder"] = ""
    return True


def cancel_cover_refresh_status(*, get_state: StateGetter) -> dict[str, object]:
    cancelled = cancel_cover_refresh(get_state)
    library_state = get_state()
    return {
        "cancelled": bool(cancelled),
        "covers_in_progress": bool(library_state.get("covers_in_progress")),
    }


def refresh_cover_artwork_request(
    *,
    get_state: StateGetter,
    cache_lock,
    config,
    logger,
    log_app_event,
    select_background_cover_refresh_jobs: CoverRefreshJobSelector,
    build_cover_jobs: BuildCoverJobs,
    run_cover_jobs: CoverRefreshExecutor,
    log_cover_refresh_completion: CoverRefreshLogger,
    bulk_negative_cache_ttl_seconds: float,
    job_workers: int,
) -> None:
    context = build_cover_refresh_context(get_state=get_state, config=config)
    jobs = select_background_cover_refresh_jobs(
        file_cache=context.file_cache,
        user_owned_track_paths=_user_owned_track_paths(
            list(context.library_state.get("albums") or [])
        ),
        cover_cache=context.cover_cache,
        build_cover_jobs=lambda current_file_cache, **kwargs: build_cover_jobs(
            current_file_cache,
            logger=logger,
            **kwargs,
        ),
        logger=logger,
        scan_generation=context.scan_generation,
    )
    execute_cover_refresh_request(
        context=context,
        cache_lock=cache_lock,
        jobs=jobs,
        run_cover_jobs=run_cover_jobs,
        log_cover_refresh_completion=log_cover_refresh_completion,
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        mode="background",
        allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=bulk_negative_cache_ttl_seconds,
        job_workers=job_workers,
    )


def refresh_cover_artwork_for_track_paths_request(
    *,
    get_state: StateGetter,
    cache_lock,
    config,
    logger,
    log_app_event,
    track_paths: set[str],
    force_search: bool,
    select_manual_track_cover_refresh_jobs: CoverRefreshJobSelector,
    build_cover_jobs: BuildCoverJobs,
    run_cover_jobs: CoverRefreshExecutor,
    log_cover_refresh_completion: CoverRefreshLogger,
) -> dict[str, object]:
    context = build_cover_refresh_context(
        get_state=get_state,
        config=config,
        bump_cover_generation=True,
    )
    jobs = select_manual_track_cover_refresh_jobs(
        file_cache=context.file_cache,
        track_paths=track_paths,
        cover_cache=context.cover_cache,
        build_cover_jobs=lambda current_file_cache, **kwargs: build_cover_jobs(
            current_file_cache,
            logger=logger,
            **kwargs,
        ),
        logger=logger,
    )
    if not jobs:
        logger.warning(
            "Cover refresh manual single produced no jobs requested_track_count=%s sample_paths=%s",
            len(track_paths),
            sorted(track_paths)[:10],
        )
    return execute_cover_refresh_request(
        context=context,
        cache_lock=cache_lock,
        jobs=jobs,
        run_cover_jobs=run_cover_jobs,
        log_cover_refresh_completion=log_cover_refresh_completion,
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        mode="manual-single",
        force_search=force_search,
        allow_apple_web_fallback=True,
        allow_apple_web_fallback_when_has_cover=True,
        include_job_results_when_empty=True,
        empty_log_result={
            "processed": 0,
            "downloaded": 0,
            "skipped": 0,
            "failed": 0,
            "downloaded_paths": [],
            "job_results": [{"reason": "no_jobs_found"}],
        },
    )


def refresh_unsuccessful_cover_artwork_request(
    *,
    get_state: StateGetter,
    cache_lock,
    config,
    logger,
    log_app_event,
    force_search: bool,
    select_manual_bulk_cover_refresh_jobs: CoverRefreshJobSelector,
    build_cover_jobs: BuildCoverJobs,
    run_cover_jobs: CoverRefreshExecutor,
    log_cover_refresh_completion: CoverRefreshLogger,
    bulk_negative_cache_ttl_seconds: float,
    job_workers: int,
) -> dict[str, object]:
    context = build_cover_refresh_context(
        get_state=get_state,
        config=config,
        bump_cover_generation=True,
    )
    jobs = select_manual_bulk_cover_refresh_jobs(
        file_cache=context.file_cache,
        cover_cache=context.cover_cache,
        build_cover_jobs=lambda current_file_cache, **kwargs: build_cover_jobs(
            current_file_cache,
            logger=logger,
            **kwargs,
        ),
        logger=logger,
        force_search=force_search,
    )
    return execute_cover_refresh_request(
        context=context,
        cache_lock=cache_lock,
        jobs=jobs,
        run_cover_jobs=run_cover_jobs,
        log_cover_refresh_completion=log_cover_refresh_completion,
        config=config,
        logger=logger,
        log_app_event=log_app_event,
        mode="manual-bulk",
        force_search=force_search,
        allow_apple_web_fallback=True,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=bulk_negative_cache_ttl_seconds,
        job_workers=job_workers,
        include_job_results_when_empty=True,
    )
