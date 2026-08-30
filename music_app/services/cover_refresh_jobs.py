from __future__ import annotations

from collections.abc import Callable

CoverJob = dict[str, object]
BuildCoverJobs = Callable[..., list[CoverJob]]
CoverRefreshResult = dict[str, object]
CoverRefreshLogger = Callable[..., None]


def select_background_cover_refresh_jobs(
    *,
    file_cache: dict[str, dict[str, object]],
    user_owned_track_paths: set[str] | None = None,
    cover_cache,
    build_cover_jobs: BuildCoverJobs,
    logger,
    scan_generation: int,
) -> list[CoverJob]:
    planned_jobs = build_cover_jobs(file_cache, cover_cache=cover_cache)
    owned_paths = {str(path) for path in (user_owned_track_paths or set())}
    jobs: list[CoverJob] = []
    for job in planned_jobs:
        belongs_to_user_owned_album = any(
            str(path) in owned_paths
            for path in (job.get("track_paths") or [])
        )
        if belongs_to_user_owned_album:
            job["cover_selection_origin"] = "user"
        if bool(job.get("needs_cover_fetch")) or belongs_to_user_owned_album or (
            str(job.get("cover_selection_origin") or "").strip().casefold() == "user"
        ):
            jobs.append(job)
    logger.verbose(
        "Cover refresh background job selection queued=%s user_owned=%s scan_generation=%s file_cache_entries=%s",
        len(jobs),
        sum(
            1
            for job in jobs
            if str(job.get("cover_selection_origin") or "").strip().casefold() == "user"
        ),
        scan_generation,
        len(file_cache),
    )
    return jobs


def select_manual_bulk_cover_refresh_jobs(
    *,
    file_cache: dict[str, dict[str, object]],
    cover_cache,
    build_cover_jobs: BuildCoverJobs,
    logger,
    force_search: bool,
) -> list[CoverJob]:
    jobs = build_cover_jobs(file_cache, require_missing_cover=True, cover_cache=cover_cache)
    logger.verbose(
        "Cover refresh manual bulk job selection queued=%s file_cache_entries=%s force_search=%s",
        len(jobs),
        len(file_cache),
        force_search,
    )
    return jobs


def select_manual_track_cover_refresh_jobs(
    *,
    file_cache: dict[str, dict[str, object]],
    track_paths: set[str],
    cover_cache,
    build_cover_jobs: BuildCoverJobs,
    logger,
) -> list[CoverJob]:
    all_jobs = build_cover_jobs(file_cache, cover_cache=cover_cache)
    jobs: list[CoverJob] = []
    for job in all_jobs:
        matched = any(str(path) in track_paths for path in (job.get("track_paths") or []))
        if matched:
            jobs.append(job)
            logger.verbose(
                "Cover refresh manual single queued artist=%r album=%r folder=%r matched_track_count=%s requested_track_count=%s",
                str(job.get("artist") or ""),
                str(job.get("album") or ""),
                str(job.get("folder") or ""),
                len(job.get("track_paths") or []),
                len(track_paths),
            )
        else:
            logger.verbose(
                "Cover refresh manual single skipped artist=%r album=%r folder=%r reason=%s",
                str(job.get("artist") or ""),
                str(job.get("album") or ""),
                str(job.get("folder") or ""),
                "track_paths_not_requested",
            )
    return jobs


def log_cover_refresh_completion(
    *,
    config,
    logger,
    log_app_event: CoverRefreshLogger,
    jobs: list[CoverJob],
    result: CoverRefreshResult,
    mode: str,
    force_search: bool = False,
) -> None:
    first_result = next((item for item in (result.get("job_results") or []) if isinstance(item, dict)), {})
    event_kwargs: dict[str, object] = {
        "level": "info",
        "history": True,
        "album_count": len(jobs),
        "processed": result.get("processed", 0),
        "downloaded": result.get("downloaded", 0),
        "skipped": result.get("skipped", 0),
        "failed": result.get("failed", 0),
        "not_touched": result.get("skipped", 0),
        "not_found": result.get("failed", 0),
        "downloaded_paths": result.get("downloaded_paths", []),
        "files": result.get("downloaded_paths", []),
        "mode": mode,
    }
    if mode != "background":
        event_kwargs["force_search"] = force_search
    if mode == "manual-single":
        event_kwargs["artist"] = str(first_result.get("artist") or "")
        event_kwargs["album"] = str(first_result.get("album") or "")
        event_kwargs["year"] = first_result.get("year")
        event_kwargs["reason"] = str(first_result.get("reason") or "")
        event_kwargs["source"] = str(first_result.get("source") or "")
        message = "Manual cover fetch completed"
    else:
        message = "Cover art update completed"
    log_app_event(config, logger, message, **event_kwargs)
