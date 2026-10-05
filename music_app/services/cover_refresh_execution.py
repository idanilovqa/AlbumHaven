from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from music_app.services.app_logging import flush_log_handlers, flush_log_handlers_debounced, log_app_event
from music_app.services.album_cover_candidate_publisher import AlbumCoverCandidatePublisher
from music_app.services.album_cover_candidate_snapshots_postgres import (
    AlbumCoverCandidateSnapshotRepository,
)
from music_app.services.cache import (
    persist_cover_selection_for_tracks_for_config,
    save_cache_to_disk_for_config,
)
from music_app.services.cover_workflow import (
    begin_external_cover_write_promotion,
    complete_local_image_promotion,
    cover_revision_for_path,
    record_external_cover_write,
    rollback_local_image_promotion,
    run_serialized_cover_selection,
)
from music_app.services.covers import find_cover_image, images_are_visually_similar
from music_app.services import cover_refresh_provider
from music_app.services.cover_provider_candidates import (
    CoverCandidate,
    cover_candidate_to_lookup_match,
)
from music_app.services.library import build_albums_from_file_cache
from music_app.services.library_roots import library_root_cache_identity
from music_app.services.scan_cache_persistence import select_scan_cache_adapter

StateGetter = Callable[[], dict[str, object]]

_SLOW_COVER_FETCH_LOG_THRESHOLD_MS = 8000
_LOGGER = logging.getLogger(__name__)

_COVER_SELECTION_FIELDS = (
    "cover_path", "cover_revision", "cover_selection_origin", "remote_cover_url",
    "remote_cover_thumbnail_url", "remote_cover_source", "remote_cover_source_label",
    "remote_cover_album_url", "remote_cover_width", "remote_cover_height",
)


def _cover_selection_values(entry: Mapping[str, object]) -> tuple[object, ...]:
    return tuple(entry.get(field) for field in _COVER_SELECTION_FIELDS)


def _recover_existing_cover_selection(
    *, config, job, cover_path, file_cache, get_state, library_state,
    cache_lock, scan_generation, cover_generation,
) -> tuple[bool, bool]:
    """Commit recovered artwork before publishing its cover fields to runtime."""
    folder = Path(job["folder"]).resolve()
    selected = cover_path.resolve()
    paths = {str(path) for path in job.get("track_paths") or []}
    entries = {path: file_cache[path] for path in paths if isinstance(file_cache.get(path), dict)}
    if str(job.get("cover_selection_origin") or "").strip().casefold() == "user":
        return False, False
    if any(str(entry.get("cover_selection_origin") or "").strip().casefold() == "user" for entry in entries.values()):
        return False, False
    if not paths or len(entries) != len(paths):
        return False, True
    if not selected.is_relative_to(folder) or not selected.is_file():
        return False, True
    if any(not Path(path).resolve().is_relative_to(folder) for path in paths):
        return False, True

    baseline = {path: _cover_selection_values(entry) for path, entry in entries.items()}
    expected_states = {
        (str(entry.get("cover_selection_origin") or "").strip().casefold(),
         str(entry.get("cover_revision") or ""))
        for entry in entries.values()
    }
    if len(expected_states) != 1:
        return False, True
    expected_origin, expected_revision = next(iter(expected_states))

    def state_is_current() -> bool:
        current = get_state()
        if current is not library_state:
            return False
        if cover_generation is not None and int(current.get("cover_generation") or 0) != cover_generation:
            return False
        if scan_generation is not None:
            if current.get("scan_in_progress") or int(current.get("scan_generation") or 0) != scan_generation:
                return False
        current_entries = current.get("file_cache") or {}
        return all(
            isinstance(current_entries.get(path), dict)
            and _cover_selection_values(current_entries[path]) == values
            for path, values in baseline.items()
        )

    def recover() -> tuple[bool, bool]:
        with cache_lock:
            if not state_is_current():
                return False, True
            revision = cover_revision_for_path(selected)
            if all(entry.get("cover_path") == str(selected) and entry.get("cover_revision") == revision for entry in entries.values()):
                return False, False

        def commit_current(commit_action):
            with cache_lock:
                paths_still_owned = (
                    Path(job["folder"]).resolve() == folder
                    and cover_path.resolve() == selected
                    and selected.resolve().is_relative_to(folder)
                    and all(Path(path).resolve().is_relative_to(folder) for path in paths)
                )
                if not state_is_current() or not paths_still_owned or not selected.is_file() or cover_revision_for_path(selected) != revision:
                    raise RuntimeError("Recovered cover selection changed before commit.")
                result = commit_action()
                selection = dict.fromkeys(_COVER_SELECTION_FIELDS)
                selection.update(cover_path=str(selected), cover_revision=revision, cover_selection_origin="automatic")
                current_entries = library_state["file_cache"]
                for path, entry in entries.items():
                    entry.update(selection)
                    current_entries[path].update(selection)
                return result

        result = persist_cover_selection_for_tracks_for_config(
            config, paths, selected, cover_revision=revision,
            cover_selection_origin="automatic", reject_if_user_controlled=True,
            expected_cover_state=(expected_origin or None, expected_revision or None),
            commit_guard=commit_current,
        )
        if result.get("blocked_by_user_selection") or result.get("blocked_by_expected_cover_state"):
            return False, True
        return True, False

    return run_serialized_cover_selection(folder, recover)


def _automatic_candidate_payload(candidate: object) -> dict[str, object]:
    if isinstance(candidate, Mapping):
        return dict(candidate)
    if isinstance(candidate, CoverCandidate):
        return cover_candidate_to_lookup_match(candidate, lookup_group="services")
    return {
        "source": getattr(candidate, "source", ""),
        "source_label": getattr(candidate, "source", ""),
        "url": getattr(candidate, "url", ""),
        "thumbnail_url": getattr(candidate, "url", ""),
        "width": getattr(candidate, "width", 0),
        "height": getattr(candidate, "height", 0),
        "score": getattr(candidate, "score", 0.0),
        "artist": getattr(candidate, "matched_artist", ""),
        "album": getattr(candidate, "matched_album", ""),
        "year": getattr(candidate, "matched_year", None),
    }


def _build_automatic_cover_write_guard(
    *,
    config: dict[str, object],
    folder: Path,
    track_paths: set[str],
) -> Callable[..., object]:
    def automatic_write_guard(
        write_action: Callable[[], object],
        *,
        cover_selection_origin: str,
    ) -> object:
        if str(cover_selection_origin or "").strip().casefold() != "automatic":
            raise ValueError("Automatic cover writes require automatic selection origin.")
        selected_cover_path = Path(
            getattr(write_action, "selected_cover_path", folder / "cover.jpg")
        )
        provisional_revision = str(
            getattr(write_action, "provisional_cover_revision", "") or ""
        ).strip()
        if not provisional_revision:
            raise RuntimeError("Automatic cover write is missing its provisional revision.")
        preserve_user_ownership = bool(
            getattr(write_action, "preserve_user_ownership", False)
        )
        expected_cover_revision = str(
            getattr(write_action, "expected_cover_revision", "") or ""
        ).strip()
        prepared_cover_bytes = getattr(write_action, "prepared_cover_bytes", None)
        if preserve_user_ownership and (
            not expected_cover_revision or not isinstance(prepared_cover_bytes, bytes)
        ):
            raise RuntimeError("Same-art automatic upgrade is missing its guarded baseline.")

        def persist_and_write() -> object:
            current_cover = folder / "cover.jpg"
            if preserve_user_ownership and (
                not current_cover.is_file()
                or cover_revision_for_path(current_cover) != expected_cover_revision
                or not images_are_visually_similar(current_cover, prepared_cover_bytes)
            ):
                return False
            written_holder: dict[str, Path] = {}

            def commit_after_write(commit_action: Callable[[], object]) -> object:
                promotion = begin_external_cover_write_promotion(
                    folder,
                    serialize_selection=False,
                )
                try:
                    written = write_action()
                    if not written:
                        raise RuntimeError("Automatic cover write returned no file.")
                    written_holder["path"] = Path(written)
                    record_external_cover_write(promotion)
                    result = commit_action()
                except Exception:
                    rollback_local_image_promotion(promotion)
                    raise
                complete_local_image_promotion(promotion)
                return result

            persistence_origin = "user" if preserve_user_ownership else "automatic"
            persistence_result = persist_cover_selection_for_tracks_for_config(
                config,
                track_paths,
                selected_cover_path,
                cover_revision=provisional_revision,
                cover_selection_origin=persistence_origin,
                reject_if_user_controlled=not preserve_user_ownership,
                expected_cover_selection_origin=(
                    "user" if preserve_user_ownership else None
                ),
                expected_cover_revision=(
                    expected_cover_revision if preserve_user_ownership else None
                ),
                commit_guard=commit_after_write,
            )
            if bool(
                persistence_result.get("blocked_by_user_selection")
                or persistence_result.get("blocked_by_expected_cover_state")
            ):
                return False
            written_path = written_holder.get("path")
            if written_path is None:
                raise RuntimeError("Automatic cover persistence committed without a file write.")

            exact_revision = cover_revision_for_path(written_path)
            if exact_revision != provisional_revision:
                persist_cover_selection_for_tracks_for_config(
                    config,
                    track_paths,
                    written_path,
                    cover_revision=exact_revision,
                    cover_selection_origin=persistence_origin,
                    reject_if_user_controlled=not preserve_user_ownership,
                    expected_cover_selection_origin=(
                        "user" if preserve_user_ownership else None
                    ),
                    expected_cover_revision=(
                        provisional_revision if preserve_user_ownership else None
                    ),
                )
            return written_path

        return run_serialized_cover_selection(folder, persist_and_write)

    return automatic_write_guard


def execute_cover_job(
    *,
    job: dict[str, object],
    image_extensions: set[str],
    user_agent: str,
    cover_cache,
    force_search: bool,
    allow_apple_web_fallback: bool,
    allow_apple_web_fallback_when_has_cover: bool,
    negative_cache_ttl_seconds: float | None,
    enabled_provider_groups: object = None,
    config: dict[str, object] | None = None,
    candidate_callback: Callable[..., object] | None = None,
    automatic_write_guard: Callable[..., object] | None = None,
) -> tuple[Path | None, bool, dict[str, object]]:
    folder = job["folder"]
    artist = str(job.get("artist") or "")
    album = str(job.get("album") or "")
    try:
        provider_kwargs = {
            "folder": folder,
            "artist": artist,
            "album": album,
            "edition": str(job.get("edition") or "").strip() or None,
            "year": int(job["year"]) if isinstance(job.get("year"), int) else None,
            "image_extensions": image_extensions,
            "cache": cover_cache,
            "user_agent": user_agent,
            "force_search": force_search,
            "allow_apple_web_fallback": allow_apple_web_fallback,
            "allow_apple_web_fallback_when_has_cover": allow_apple_web_fallback_when_has_cover,
            "negative_cache_ttl_seconds": negative_cache_ttl_seconds,
        }
        if "cover_selection_origin" in job:
            stored_origin = str(
                job.get("cover_selection_origin") or "automatic"
            ).strip().casefold()
            provider_kwargs["cover_selection_origin"] = (
                stored_origin if stored_origin in {"user", "automatic"} else "automatic"
            )
            provider_kwargs["reject_if_user_controlled"] = True
        effective_candidate_callback = candidate_callback or job.get("candidate_callback")
        if callable(effective_candidate_callback):
            provider_kwargs["candidate_callback"] = effective_candidate_callback
        effective_write_guard = automatic_write_guard
        if (
            effective_write_guard is None
            and config is not None
            and provider_kwargs.get("cover_selection_origin") in {"automatic", "user"}
        ):
            track_paths = {
                str(path or "").strip()
                for path in job.get("track_paths") or []
                if str(path or "").strip()
            }
            if track_paths:
                effective_write_guard = _build_automatic_cover_write_guard(
                    config=config,
                    folder=Path(folder),
                    track_paths=track_paths,
                )
        if effective_write_guard is not None:
            provider_kwargs["automatic_write_guard"] = effective_write_guard
        if enabled_provider_groups is not None:
            provider_kwargs["enabled_provider_groups"] = enabled_provider_groups
        return cover_refresh_provider.ensure_best_cover_for_folder(**provider_kwargs)
    except Exception as exc:
        _LOGGER.warning("Cover refresh failed for %s: %s", folder, exc)
        return (
            find_cover_image(folder, image_extensions),
            False,
            {
                "artist": artist,
                "album": album,
                "year": int(job["year"]) if isinstance(job.get("year"), int) else None,
                "folder": str(folder),
                "force_search": force_search,
                "reason": "exception_during_cover_fetch",
                "error": str(exc),
            },
        )


def run_cover_jobs(
    *,
    get_state: StateGetter,
    config,
    logger,
    cache_lock,
    jobs: list[dict[str, object]],
    file_cache: dict[str, dict[str, object]],
    separate_release_keys: set[str],
    image_extensions: set[str],
    user_agent: str,
    cover_cache,
    scan_generation: int | None = None,
    cover_generation: int | None = None,
    force_search: bool = False,
    allow_apple_web_fallback: bool = False,
    allow_apple_web_fallback_when_has_cover: bool = True,
    negative_cache_ttl_seconds: float | None = None,
    job_workers: int = 1,
) -> dict[str, object]:
    library_state = get_state()
    changed = False
    selection_conflict = False
    runtime_cover_updates: dict[str, tuple[tuple[object, ...], dict[str, object]]] = {}
    needs_snapshot = False
    failed = 0
    skipped = 0
    downloaded_count = 0
    downloaded_paths: list[str] = []
    job_results: list[dict[str, object]] = []
    miss_reasons = {
        "remote_search_returned_no_candidate",
        "remote_search_timed_out",
        "remote_search_failed",
        "candidate_download_failed",
        "candidate_decode_failed",
        "write_returned_no_file",
        "exception_during_cover_fetch",
    }

    def owns_progress() -> bool:
        current = get_state()
        return (
            current is library_state
            and (cover_generation is None or int(current.get("cover_generation") or 0) == cover_generation)
            and (scan_generation is None or int(current.get("scan_generation") or 0) == scan_generation)
        )
    candidate_publishers: dict[int, object] = {}
    candidate_callbacks: dict[int, Callable[..., object]] = {}

    for job in jobs:
        album_id = job.get("album_id")
        try:
            repository = AlbumCoverCandidateSnapshotRepository(config)
            if not isinstance(album_id, int) or album_id <= 0:
                album_id = repository.resolve_album_id_for_track_paths(
                    track_paths=[
                        str(track_path)
                        for track_path in (job.get("track_paths") or [])
                        if str(track_path).strip()
                    ]
                )
            if not isinstance(album_id, int) or album_id <= 0:
                continue
            publisher = AlbumCoverCandidatePublisher(
                repository,
                album_id=album_id,
                search_generation=str(uuid.uuid4()),
                search_kind="automatic",
            )
            publisher.begin_candidate_generation()
            candidate_publishers[id(job)] = publisher

            def publish_candidate(
                candidate: object,
                *,
                automatic_improvement: bool = False,
                _publisher=publisher,
                _album_id=album_id,
            ) -> None:
                try:
                    candidate_payload = _automatic_candidate_payload(candidate)
                    accepted = _publisher.publish_candidates([candidate_payload])
                    mark_improvement = getattr(
                        _publisher, "mark_automatic_improvement", None
                    )
                    candidate_id_for = getattr(_publisher, "candidate_id_for", None)
                    if accepted and automatic_improvement and callable(mark_improvement):
                        qualifying_candidate_id = (
                            candidate_id_for(candidate_payload)
                            if callable(candidate_id_for)
                            else None
                        )
                        mark_improvement(qualifying_candidate_id)
                except Exception as exc:
                    logger.warning(
                        "Automatic candidate snapshot publication failed album_id=%s error=%r",
                        _album_id,
                        exc,
                    )

            candidate_callbacks[id(job)] = publish_candidate
        except Exception as exc:
            logger.warning(
                "Automatic candidate snapshot publisher initialization failed album_id=%s error=%r",
                album_id,
                exc,
            )

    def settle_candidate_publisher(
        job: dict[str, object], detail: Mapping[str, object]
    ) -> None:
        publisher = candidate_publishers.get(id(job))
        if publisher is None:
            return
        reason = str(detail.get("reason") or "")
        terminal = (
            getattr(publisher, "fail", None)
            if reason in miss_reasons
            else getattr(publisher, "complete", None)
        )
        if not callable(terminal):
            return
        try:
            terminal()
        except Exception as exc:
            logger.warning(
                "Automatic candidate snapshot terminal update failed album_id=%s error=%r",
                job.get("album_id"),
                exc,
            )

    def apply_job_result(index: int, job: dict[str, object], cover_path: Path | None, downloaded: bool, detail: dict[str, object]) -> None:
        nonlocal changed, failed, skipped, downloaded_count, selection_conflict, needs_snapshot
        folder = job["folder"]
        artist = str(job.get("artist") or "")
        album = str(job.get("album") or "")
        cover_value = str(cover_path) if cover_path else None
        written_revision: str | None = None
        if cover_path:
            written_path = Path(str(detail.get("written_path") or cover_value or "").strip())
            if written_path.is_file() and written_path.resolve().is_relative_to(Path(folder).resolve()):
                written_revision = cover_revision_for_path(written_path)
                detail["cover_revision"] = written_revision
        has_cover = bool(cover_value)
        detail["downloaded"] = downloaded
        detail["has_cover"] = has_cover
        detail["cover_path"] = cover_value
        job_results.append(detail)

        logger.verbose(
            "Cover fetch processed artist=%r album=%r folder=%r downloaded=%s has_cover=%s",
            artist,
            album,
            str(folder),
            downloaded,
            has_cover,
        )

        reason = str(detail.get("reason") or "")
        if reason == "remote_provider_group_disabled":
            terminal_category = "skipped"
            skipped += 1
        elif downloaded:
            terminal_category = "downloaded"
            downloaded_count += 1
            with cache_lock:
                if owns_progress():
                    library_state["covers_downloaded"] = int(library_state.get("covers_downloaded") or 0) + 1
            written_path = str(detail.get("written_path") or cover_value or "").strip()
            if written_path:
                downloaded_paths.append(written_path)
        elif not has_cover:
            terminal_category = "failed"
            failed += 1
            if reason in miss_reasons and callable(getattr(logger, "log", None)):
                log_app_event(
                    config,
                    logger,
                    "Cover art update failed",
                    level="warning",
                    artist=artist,
                    album=album,
                    folder=str(folder),
                    status="missing_cover_art",
                    reason=str(detail.get("reason") or ""),
                    force_search=force_search,
                    elapsed_ms=detail.get("elapsed_ms"),
                    resolver_trace=detail.get("resolver_trace"),
                )
        else:
            terminal_category = "skipped"
            skipped += 1

        elapsed_ms = float(detail.get("elapsed_ms") or 0.0)
        if (
            elapsed_ms >= _SLOW_COVER_FETCH_LOG_THRESHOLD_MS
            and callable(getattr(logger, "log", None))
        ):
            log_app_event(
                config,
                logger,
                "Cover fetch slow",
                level="info",
                artist=artist,
                album=album,
                folder=str(folder),
                reason=str(detail.get("reason") or ""),
                downloaded=downloaded,
                has_cover=has_cover,
                force_search=force_search,
                elapsed_ms=elapsed_ms,
                resolver_trace=detail.get("resolver_trace"),
            )

        recovering_selection = bool(cover_path and not downloaded)
        if recovering_selection:
            recovered, conflict = _recover_existing_cover_selection(
                config=config, job=job, cover_path=Path(cover_path),
                file_cache=file_cache, get_state=get_state, library_state=library_state,
                cache_lock=cache_lock, scan_generation=scan_generation,
                cover_generation=cover_generation,
            )
            changed = changed or recovered
            selection_conflict = selection_conflict or conflict
            if conflict:
                detail["recovery_conflict"] = True
                detail["reason"] = "recovered_cover_selection_conflict"
                log_app_event(
                    config, logger if callable(getattr(logger, "log", None)) else _LOGGER,
                    "Existing cover metadata recovery skipped because selection could not be verified",
                    level="warning", reason="recovered_cover_selection_conflict",
                )

        for track_path in job.get("track_paths") or []:
            if recovering_selection:
                continue
            entry = file_cache.get(str(track_path))
            if not isinstance(entry, dict):
                continue
            if reason == "automatic_write_blocked_by_user_selection":
                continue
            if not downloaded and (
                str(job.get("cover_selection_origin") or "").strip().casefold() == "user"
                or str(entry.get("cover_selection_origin") or "").strip().casefold() == "user"
            ):
                # Finding a file beside an album is not a new user selection.
                # Only the guarded writer may publish a user-owned improvement.
                continue
            desired_selection_origin = (
                "user"
                if str(job.get("cover_selection_origin") or "").strip().casefold()
                == "user"
                else "automatic"
            )
            local_cover_changed = entry.get("cover_path") != cover_value or bool(
                written_revision and entry.get("cover_revision") != written_revision
            )
            if downloaded:
                local_cover_changed = local_cover_changed or any(
                    (
                        entry.get("cover_revision") != written_revision,
                        entry.get("cover_selection_origin") != desired_selection_origin,
                        entry.get("remote_cover_url") is not None,
                        entry.get("remote_cover_thumbnail_url") is not None,
                        entry.get("remote_cover_source") is not None,
                        entry.get("remote_cover_source_label") is not None,
                        entry.get("remote_cover_album_url") is not None,
                        entry.get("remote_cover_width") is not None,
                        entry.get("remote_cover_height") is not None,
                    )
                )
            if local_cover_changed:
                previous_selection = _cover_selection_values(entry)
                if not downloaded and not cover_path:
                    # Keep legacy clearing private until its snapshot commits.
                    entry = dict(entry)
                    needs_snapshot = True
                entry["cover_path"] = cover_value
                entry["remote_cover_url"] = None
                entry["remote_cover_thumbnail_url"] = None
                entry["remote_cover_source"] = None
                entry["remote_cover_source_label"] = None
                entry["remote_cover_album_url"] = None
                entry["remote_cover_width"] = None
                entry["remote_cover_height"] = None
                if written_revision:
                    entry["cover_revision"] = written_revision
                if downloaded:
                    entry["cover_selection_origin"] = desired_selection_origin
                runtime_cover_updates[str(track_path)] = (
                    previous_selection,
                    {field: entry.get(field) for field in _COVER_SELECTION_FIELDS},
                )
                changed = True

        log_app_event(
            config, logger if callable(getattr(logger, "log", None)) else _LOGGER,
            "Cover fetch outcome",
            level="info",
            album_id=job.get("album_id"),
            artist=artist,
            album=album,
            folder=str(folder),
            reason=str(detail.get("reason") or ""),
            terminal_category=terminal_category,
            downloaded=downloaded,
            has_cover=has_cover,
            force_search=force_search,
            elapsed_ms=elapsed_ms,
            resolver_trace=detail.get("resolver_trace") or [],
        )
        with cache_lock:
            if owns_progress():
                library_state["covers_current_folder"] = str(folder)
                library_state["covers_processed"] = int(library_state.get("covers_processed") or 0) + 1
        # Image selections are committed by the guarded writer per album. Keep
        # lookup outcomes durable too, without republishing the entire inventory.
        if index % 25 == 0:
            cover_cache.save()
        flush_log_handlers_debounced(logger, min_interval_seconds=2.0)

    effective_job_workers = max(1, min(int(job_workers or 1), len(jobs) or 1))
    if effective_job_workers > 1:
        for index, job in enumerate(jobs, start=1):
            logger.verbose(
                "Cover fetch queue item index=%s total=%s artist=%r album=%r year=%r folder=%r track_count=%s force_search=%s",
                index,
                len(jobs),
                str(job.get("artist") or ""),
                str(job.get("album") or ""),
                job.get("year"),
                str(job.get("folder") or ""),
                len(job.get("track_paths") or []),
                force_search,
            )
        with ThreadPoolExecutor(max_workers=effective_job_workers, thread_name_prefix="albumhaven-cover-job") as executor:
            future_map = {
                executor.submit(
                    execute_cover_job,
                    job=job,
                    image_extensions=image_extensions,
                    user_agent=user_agent,
                    cover_cache=cover_cache,
                    force_search=force_search,
                    allow_apple_web_fallback=allow_apple_web_fallback,
                    allow_apple_web_fallback_when_has_cover=allow_apple_web_fallback_when_has_cover,
                    negative_cache_ttl_seconds=negative_cache_ttl_seconds,
                    enabled_provider_groups=config.get("COVER_PROVIDER_GROUPS"),
                    config=config,
                    candidate_callback=candidate_callbacks.get(id(job)),
                ): (index, job)
                for index, job in enumerate(jobs, start=1)
            }
            completed = 0
            for future in as_completed(future_map):
                _index, job = future_map[future]
                with cache_lock:
                    if owns_progress():
                        library_state["covers_processed"] = completed
                cover_path, downloaded, detail = future.result()
                settle_candidate_publisher(job, detail)
                completed += 1
                apply_job_result(completed, job, cover_path, downloaded, detail)
    else:
        for index, job in enumerate(jobs, start=1):
            current_state = get_state()
            if scan_generation is not None and (
                current_state.get("scan_in_progress")
                or int(current_state.get("scan_generation") or 0) != scan_generation
            ):
                logger.warning(
                    "Cover fetch aborted before folder=%r artist=%r album=%r reason=%s scan_in_progress=%s current_generation=%s expected_generation=%s",
                    str(job.get("folder") or ""),
                    str(job.get("artist") or ""),
                    str(job.get("album") or ""),
                    "scan_generation_changed",
                    bool(current_state.get("scan_in_progress")),
                    int(current_state.get("scan_generation") or 0),
                    scan_generation,
                )
                changed = False
                break
            if cover_generation is not None and int(current_state.get("cover_generation") or 0) != cover_generation:
                logger.warning(
                    "Cover fetch aborted before folder=%r artist=%r album=%r reason=%s current_cover_generation=%s expected_cover_generation=%s",
                    str(job.get("folder") or ""),
                    str(job.get("artist") or ""),
                    str(job.get("album") or ""),
                    "cover_generation_changed",
                    int(current_state.get("cover_generation") or 0),
                    cover_generation,
                )
                changed = False
                break

            folder = job["folder"]
            artist = str(job.get("artist") or "")
            album = str(job.get("album") or "")
            logger.verbose(
                "Cover fetch queue item index=%s total=%s artist=%r album=%r year=%r folder=%r track_count=%s force_search=%s",
                index,
                len(jobs),
                artist,
                album,
                job.get("year"),
                str(folder),
                len(job.get("track_paths") or []),
                force_search,
            )
            with cache_lock:
                if owns_progress():
                    library_state["covers_current_folder"] = str(folder)
                    library_state["covers_processed"] = index - 1
            cover_path, downloaded, detail = execute_cover_job(
                job=job,
                image_extensions=image_extensions,
                user_agent=user_agent,
                cover_cache=cover_cache,
                force_search=force_search,
                allow_apple_web_fallback=allow_apple_web_fallback,
                allow_apple_web_fallback_when_has_cover=allow_apple_web_fallback_when_has_cover,
                negative_cache_ttl_seconds=negative_cache_ttl_seconds,
                enabled_provider_groups=config.get("COVER_PROVIDER_GROUPS"),
                config=config,
                candidate_callback=candidate_callbacks.get(id(job)),
            )
            settle_candidate_publisher(job, detail)
            apply_job_result(index, job, cover_path, downloaded, detail)

    cover_cache.save()
    flush_log_handlers(logger)

    if changed:
        snapshot = None
        snapshot_options = {}
        if needs_snapshot and not selection_conflict:
            adapter = select_scan_cache_adapter(config)
            snapshot_options = {
                "expected_cover_mutation_revision": adapter.load_cover_mutation_revision(),
                "expected_inventory_mutation_revision": adapter.load_inventory_mutation_revision(),
            }

        def publication_is_current() -> bool:
            current = get_state()
            return (
                current is library_state
                and (cover_generation is None or int(current.get("cover_generation") or 0) == cover_generation)
                and (scan_generation is None or (
                    not current.get("scan_in_progress")
                    and int(current.get("scan_generation") or 0) == scan_generation
                ))
            )

        with cache_lock:
            if publication_is_current():
                current_entries = library_state.get("file_cache") or {}
                accepted_updates = {}
                for path, (baseline, selection) in runtime_cover_updates.items():
                    entry = current_entries.get(path)
                    if not isinstance(entry, dict):
                        selection_conflict = True
                        continue
                    current_selection = _cover_selection_values(entry)
                    if current_selection not in (baseline, _cover_selection_values(selection)):
                        selection_conflict = True
                        continue
                    accepted_updates[path] = selection
                    if selection.get("cover_path") is not None:
                        entry.update(selection)
                if needs_snapshot and not selection_conflict:
                    baseline_entries = {path: dict(entry) for path, entry in current_entries.items()}
                    snapshot = {path: dict(entry) for path, entry in current_entries.items()}
                    for path, selection in accepted_updates.items():
                        snapshot[path].update(selection)
                library_state["albums"] = build_albums_from_file_cache(current_entries, separate_release_keys)

        if snapshot is not None:
            def commit_snapshot(commit_action):
                with cache_lock:
                    if not publication_is_current() or library_state.get("file_cache") != baseline_entries:
                        raise RuntimeError("Cover snapshot publication changed before commit.")
                    result = commit_action()
                    for path, selection in accepted_updates.items():
                        library_state["file_cache"][path].update(selection)
                    library_state["albums"] = build_albums_from_file_cache(
                        library_state["file_cache"], separate_release_keys,
                    )
                    return result

            # Preserve the legacy clearing path. Revision guards reject concurrent
            # DB changes; pre-existing DB/runtime divergence is not reconciled here.
            save_cache_to_disk_for_config(
                config, config["CACHE_PATH"], snapshot,
                library_root_cache_identity(config),
                float(library_state.get("last_scan") or time.time()),
                publication_commit_guard=commit_snapshot, **snapshot_options,
            )

    with cache_lock:
        if owns_progress():
            library_state["covers_current_folder"] = ""
            library_state["covers_in_progress"] = False
    return {
        "changed": changed,
        "processed": len(job_results),
        "downloaded": downloaded_count,
        "skipped": skipped,
        "failed": failed,
        "downloaded_paths": downloaded_paths,
        "job_results": job_results,
    }
