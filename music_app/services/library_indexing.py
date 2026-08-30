from __future__ import annotations

import os
import re
import time
from collections import deque
from collections.abc import Callable, Iterator
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path

from music_app.services.exception_overrides import apply_exception_override
from music_app.services.covers import image_dimensions
from music_app.services.cover_workflow import cover_revision_for_path
from music_app.services.library_hydration import find_cover_for_track_folder
from music_app.services.library import build_albums_from_file_cache
from music_app.services.library_roots import library_category_slug, root_definition_for_path
from music_app.services.metadata import (
    file_metadata_schema_is_current,
    read_metadata_for_file,
)


_REMOTE_COVER_KEYS = (
    "remote_cover_url",
    "remote_cover_thumbnail_url",
    "remote_cover_source",
    "remote_cover_source_label",
    "remote_cover_album_url",
    "remote_cover_width",
    "remote_cover_height",
)

_DISC_FOLDER_PATTERN = re.compile(r"^(?:cd|disc|disk)\s*[-_. ]*\d+\s*$", re.IGNORECASE)
_SCAN_PROGRESS_FILE_WEIGHT = 0.7
_SCAN_PROGRESS_BYTE_WEIGHT = 0.3
_SCAN_ESTIMATE_MIN_ELAPSED_SECONDS = 3.0
_SCAN_ESTIMATE_MIN_FILES = 12
_SCAN_ESTIMATE_EMA_BLEND = 0.28
_SCAN_FIRST_PARTIAL_ALBUM_PUBLISH_FILES = 250
_SCAN_PARTIAL_ALBUM_PUBLISH_INTERVAL_FILES = 1000
_SCAN_METADATA_READ_WORKERS = 4
_SCAN_METADATA_PREFETCH_ITEMS = 8
_SCAN_COOPERATIVE_YIELD_INTERVAL_FILES = 5
_SCAN_COOPERATIVE_YIELD_SECONDS = 0.001
_SCAN_COVER_MISSING = object()
_SCAN_FILE_ERROR_PATH_LIMIT = 1024
_SCAN_FILE_ERROR_MESSAGE_LIMIT = 1000


def _cooperative_scan_yield(processed: int) -> None:
    if (
        processed > 0
        and processed % _SCAN_COOPERATIVE_YIELD_INTERVAL_FILES == 0
    ):
        time.sleep(_SCAN_COOPERATIVE_YIELD_SECONDS)


def _record_scan_file_error(
    record_file_error: Callable[..., None] | None,
    action: str,
    *,
    path: object,
    error: BaseException,
) -> None:
    if record_file_error is None:
        return
    try:
        record_file_error(
            action,
            path=str(path or '')[:_SCAN_FILE_ERROR_PATH_LIMIT],
            error=str(error)[:_SCAN_FILE_ERROR_MESSAGE_LIMIT],
            error_type=type(error).__name__,
        )
    except Exception:
        # Diagnostics must never interrupt library discovery or indexing.
        return


def _resolve_folder_cover_path(
    *,
    folder: Path,
    existing_cover_value: object,
    image_extensions: set[str],
    folder_cover_cache: dict[str, object],
) -> str | None:
    folder_key = str(folder)
    cached_cover_value = folder_cover_cache.get(folder_key, _SCAN_COVER_MISSING)
    if cached_cover_value is not _SCAN_COVER_MISSING:
        return str(cached_cover_value) if cached_cover_value else None

    cover_value = str(existing_cover_value or "").strip()
    if cover_value:
        cover_path = Path(cover_value)
        if cover_path.exists():
            folder_cover_cache[folder_key] = cover_value
            return cover_value

    cover = find_cover_for_track_folder(folder, image_extensions)
    resolved_cover = str(cover) if cover else None
    folder_cover_cache[folder_key] = resolved_cover
    return resolved_cover


def _apply_cached_local_cover_metadata(
    entry: dict[str, object],
    *,
    cover_metadata_cache: dict[
        str,
        tuple[int | None, int | None, str | None, int | None, int | None],
    ],
    record_file_error: Callable[..., None] | None = None,
) -> None:
    cover_value = str(entry.get("cover_path") or "").strip()
    if not cover_value:
        entry["local_cover_width"] = None
        entry["local_cover_height"] = None
        entry["cover_revision"] = None
        entry["cover_validation_path"] = None
        entry["cover_validation_mtime_ns"] = None
        entry["cover_validation_size"] = None
        return

    if cover_value not in cover_metadata_cache:
        cover_path = Path(cover_value)
        try:
            if not cover_path.is_file():
                raise FileNotFoundError(cover_path)
            cover_stat = cover_path.stat()
        except OSError as error:
            _record_scan_file_error(
                record_file_error,
                "Library cover file inspection failed",
                path=cover_path,
                error=error,
            )
            cached_metadata = (None, None, None, None, None)
        else:
            cover_mtime_ns = int(cover_stat.st_mtime_ns)
            cover_size = int(cover_stat.st_size)
            cached_revision = str(entry.get("cover_revision") or "").strip()
            validation_matches = (
                cached_revision
                and str(entry.get("cover_validation_path") or "").strip() == cover_value
                and entry.get("cover_validation_mtime_ns") == cover_mtime_ns
                and entry.get("cover_validation_size") == cover_size
            )
            if validation_matches:
                try:
                    width = int(entry.get("local_cover_width") or 0) or None
                except (TypeError, ValueError):
                    width = None
                try:
                    height = int(entry.get("local_cover_height") or 0) or None
                except (TypeError, ValueError):
                    height = None
                cached_metadata = (
                    width,
                    height,
                    cached_revision,
                    cover_mtime_ns,
                    cover_size,
                )
            else:
                try:
                    width, height = image_dimensions(cover_path, raise_errors=True)
                except Exception as error:
                    _record_scan_file_error(
                        record_file_error,
                        "Library cover image decode failed",
                        path=cover_path,
                        error=error,
                    )
                    cached_metadata = (
                        None,
                        None,
                        None,
                        cover_mtime_ns,
                        cover_size,
                    )
                else:
                    try:
                        revision = cover_revision_for_path(cover_path)
                    except OSError as error:
                        _record_scan_file_error(
                            record_file_error,
                            "Library cover file inspection failed",
                            path=cover_path,
                            error=error,
                        )
                        cached_metadata = (
                            None,
                            None,
                            None,
                            cover_mtime_ns,
                            cover_size,
                        )
                    else:
                        cached_metadata = (
                            int(width or 0) or None,
                            int(height or 0) or None,
                            revision,
                            cover_mtime_ns,
                            cover_size,
                        )
        cover_metadata_cache[cover_value] = cached_metadata

    (
        entry["local_cover_width"],
        entry["local_cover_height"],
        entry["cover_revision"],
        entry["cover_validation_mtime_ns"],
        entry["cover_validation_size"],
    ) = cover_metadata_cache[cover_value]
    entry["cover_validation_path"] = (
        cover_value
        if entry["cover_validation_mtime_ns"] is not None
        else None
    )


class ScanCancelled(RuntimeError):
    pass


def _ordered_scan_metadata_entries(
    library_state: dict[str, object],
    all_file_stats: list[tuple[Path, os.stat_result]],
    previous: dict[str, dict[str, object]],
    *,
    expected_scan_generation: int | None,
    record_file_error: Callable[..., None] | None = None,
) -> Iterator[
    tuple[Path, os.stat_result, dict[str, object] | None, dict[str, object], bool]
]:
    """Read metadata concurrently while publishing scan results in discovery order."""

    executor = ThreadPoolExecutor(
        max_workers=_SCAN_METADATA_READ_WORKERS,
        thread_name_prefix="albumhaven-scan-metadata",
    )
    pending: deque[
        tuple[
            Path,
            os.stat_result,
            dict[str, object] | None,
            dict[str, object] | None,
            Future[dict[str, object]] | None,
        ]
    ] = deque()
    next_item_index = 0

    def ensure_scan_is_current() -> None:
        if expected_scan_generation is None:
            return
        current_generation = int(library_state.get("scan_generation") or 0)
        if (
            current_generation != expected_scan_generation
            or not library_state.get("scan_in_progress")
        ):
            raise ScanCancelled("Library indexing cancelled")

    def fill_prefetch_window() -> None:
        nonlocal next_item_index
        ensure_scan_is_current()
        while (
            len(pending) < _SCAN_METADATA_PREFETCH_ITEMS
            and next_item_index < len(all_file_stats)
        ):
            path, stat = all_file_stats[next_item_index]
            next_item_index += 1
            path_str = str(path)
            cached = previous.get(path_str)
            existing = dict(cached) if isinstance(cached, dict) else None
            if (
                existing is not None
                and existing.get("mtime") == stat.st_mtime
                and existing.get("size") == stat.st_size
                and file_metadata_schema_is_current(existing)
            ):
                pending.append((path, stat, existing, dict(existing), None))
            else:
                pending.append(
                    (
                        path,
                        stat,
                        existing,
                        None,
                        executor.submit(read_metadata_for_file, path),
                    )
                )

    completed_normally = False
    try:
        fill_prefetch_window()
        while pending:
            ensure_scan_is_current()
            path, stat, existing, cached_entry, metadata_future = pending.popleft()
            if cached_entry is not None:
                entry = dict(cached_entry)
            else:
                try:
                    entry = dict(metadata_future.result())
                except Exception as error:
                    _record_scan_file_error(
                        record_file_error,
                        "Library metadata read failed",
                        path=path,
                        error=error,
                    )
                    raise
            yield path, stat, existing, entry, metadata_future is not None
            fill_prefetch_window()
        completed_normally = True
    finally:
        if not completed_normally:
            for _path, _stat, _existing, _entry, future in pending:
                if future is not None:
                    future.cancel()
        executor.shutdown(
            wait=True,
            cancel_futures=not completed_normally,
        )


def _iter_scandir_entries(
    root: Path,
    *,
    record_file_error: Callable[..., None] | None = None,
):
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as iterator:
                entries = sorted(list(iterator), key=lambda entry: entry.name.casefold())
        except OSError as error:
            _record_scan_file_error(
                record_file_error,
                "Library directory read failed",
                path=current,
                error=error,
            )
            continue
        child_dirs: list[Path] = []
        for entry in entries:
            try:
                if entry.is_dir(follow_symlinks=False):
                    child_dirs.append(Path(entry.path))
                else:
                    yield entry
            except OSError as error:
                _record_scan_file_error(
                    record_file_error,
                    "Library directory entry inspection failed",
                    path=getattr(entry, "path", current),
                    error=error,
                )
                continue
        stack.extend(reversed(child_dirs))


def _discover_music_files_with_stats(
    library_state: dict[str, object],
    *,
    roots: list[Path],
    supported_extensions: set[str],
    expected_scan_generation: int | None,
    record_file_error: Callable[..., None] | None = None,
) -> tuple[list[tuple[Path, os.stat_result]], int, int]:
    discovered_files: list[tuple[Path, os.stat_result]] = []
    discovered_album_folders: set[Path] = set()
    total_bytes = 0

    library_state["scan_phase"] = "discovering"
    library_state["scan_processed"] = 0
    library_state["scan_total"] = 0
    library_state["scan_current_path"] = ""
    library_state["scan_bytes_processed"] = 0
    library_state["scan_total_bytes"] = 0
    library_state["scan_album_folders_processed"] = 0
    library_state["scan_album_folders_total"] = 0

    for root in roots:
        for entry in _iter_scandir_entries(
            root,
            record_file_error=record_file_error,
        ):
            if expected_scan_generation is not None:
                current_generation = int(library_state.get("scan_generation") or 0)
                scan_still_active = bool(library_state.get("scan_in_progress"))
                if current_generation != expected_scan_generation or not scan_still_active:
                    raise ScanCancelled("Library indexing cancelled")
            path = Path(entry.path)
            if path.suffix.lower() not in supported_extensions:
                continue
            try:
                stat = entry.stat(follow_symlinks=False)
            except OSError as error:
                _record_scan_file_error(
                    record_file_error,
                    "Library candidate file stat failed",
                    path=path,
                    error=error,
                )
                continue
            discovered_files.append((path, stat))
            total_bytes += int(stat.st_size or 0)
            discovered_album_folders.add(_album_folder_for_track_path(path))
            library_state["scan_total"] = len(discovered_files)
            library_state["scan_current_path"] = str(path)
            library_state["scan_total_bytes"] = total_bytes
            library_state["scan_album_folders_total"] = len(discovered_album_folders)

    return discovered_files, len(discovered_album_folders), total_bytes


def _album_folder_for_track_path(path: Path) -> Path:
    parent = path.parent
    if parent.parent != parent and _DISC_FOLDER_PATTERN.match(parent.name.strip()):
        return parent.parent
    return parent


def _clamp_fraction(value: float) -> float:
    return min(1.0, max(0.0, float(value or 0.0)))


def _combined_scan_progress_fraction(
    *,
    processed: int,
    total: int,
    bytes_processed: int,
    total_bytes: int,
) -> float:
    file_fraction = _clamp_fraction((processed / total) if total > 0 else 1.0)
    if total_bytes > 0:
        byte_fraction = _clamp_fraction(bytes_processed / total_bytes)
    else:
        byte_fraction = file_fraction
    return _clamp_fraction(
        (_SCAN_PROGRESS_FILE_WEIGHT * file_fraction)
        + (_SCAN_PROGRESS_BYTE_WEIGHT * byte_fraction)
    )


def _estimate_scan_remaining_seconds(
    *,
    elapsed_seconds: float,
    processed: int,
    total: int,
    bytes_processed: int,
    total_bytes: int,
    samples: list[tuple[float, int, int, float]],
    previous_eta_seconds: float,
) -> float:
    if total <= 0 or processed >= total:
        return 0.0
    if elapsed_seconds < _SCAN_ESTIMATE_MIN_ELAPSED_SECONDS or processed < min(total, _SCAN_ESTIMATE_MIN_FILES):
        return 0.0
    if len(samples) < 2:
        return 0.0

    baseline_time, _, _, baseline_progress = samples[0]
    current_time, _, _, current_progress = samples[-1]
    progress_delta = max(0.0, current_progress - baseline_progress)
    elapsed_delta = max(0.0, current_time - baseline_time)
    if progress_delta <= 0.0 or elapsed_delta <= 0.0:
        return 0.0

    throughput = progress_delta / elapsed_delta
    remaining_progress = max(
        0.0,
        1.0 - _combined_scan_progress_fraction(
            processed=processed,
            total=total,
            bytes_processed=bytes_processed,
            total_bytes=total_bytes,
        ),
    )
    if throughput <= 0.0 or remaining_progress <= 0.0:
        return 0.0

    raw_eta = remaining_progress / throughput
    previous_eta = max(0.0, float(previous_eta_seconds or 0.0))
    if previous_eta <= 0.0:
        return raw_eta
    return (previous_eta * (1.0 - _SCAN_ESTIMATE_EMA_BLEND)) + (raw_eta * _SCAN_ESTIMATE_EMA_BLEND)


def _record_scan_progress_metrics(
    library_state: dict[str, object],
    *,
    now: float,
    processed: int,
    total: int,
    bytes_processed: int,
    total_bytes: int,
    album_folders_processed: int,
) -> None:
    started_at = float(library_state.get("scan_started_at") or now)
    elapsed_seconds = max(0.0, now - started_at)
    library_state["scan_elapsed_seconds"] = elapsed_seconds
    library_state["scan_bytes_processed"] = int(bytes_processed)
    library_state["scan_album_folders_processed"] = int(album_folders_processed)

    raw_samples = library_state.get("scan_progress_samples")
    samples = list(raw_samples) if isinstance(raw_samples, list) else []
    last_sample = samples[-1] if samples else None
    if (
        not last_sample
        or processed >= total
        or (now - float(last_sample[0] or 0.0) >= 0.75)
        or (processed - int(last_sample[1] or 0) >= 25)
    ):
        progress_fraction = _combined_scan_progress_fraction(
            processed=processed,
            total=total,
            bytes_processed=bytes_processed,
            total_bytes=total_bytes,
        )
        samples.append((now, processed, bytes_processed, progress_fraction))
        if len(samples) > 18:
            samples = samples[-18:]
        library_state["scan_progress_samples"] = samples

    sample_rate = 0.0
    if len(samples) >= 2:
        baseline_time = float(samples[0][0] or now)
        baseline_processed = int(samples[0][1] or 0)
        sample_elapsed = max(0.0, now - baseline_time)
        sample_delta = max(0, processed - baseline_processed)
        if sample_elapsed > 0.0 and sample_delta > 0:
            sample_rate = sample_delta / sample_elapsed
    if sample_rate <= 0.0 and elapsed_seconds > 0.0 and processed > 0:
        sample_rate = processed / elapsed_seconds

    library_state["scan_files_per_second"] = sample_rate
    library_state["scan_estimated_remaining_seconds"] = _estimate_scan_remaining_seconds(
        elapsed_seconds=elapsed_seconds,
        processed=processed,
        total=total,
        bytes_processed=bytes_processed,
        total_bytes=total_bytes,
        samples=samples,
        previous_eta_seconds=float(library_state.get("scan_estimated_remaining_seconds") or 0.0),
    )


def _publish_partial_scan_albums(
    library_state: dict[str, object],
    updated_file_cache: dict[str, dict[str, object]],
    *,
    published_file_cache: dict[str, dict[str, object]] | None = None,
) -> None:
    separate_release_keys = set(library_state.get("separate_release_keys") or set())
    effective_file_cache = published_file_cache if isinstance(published_file_cache, dict) else updated_file_cache
    library_state["file_cache"] = dict(effective_file_cache)
    library_state["albums"] = build_albums_from_file_cache(effective_file_cache, separate_release_keys)


def _should_publish_partial_scan(*, processed: int, total: int) -> bool:
    processed_count = max(0, int(processed or 0))
    total_count = max(0, int(total or 0))
    if processed_count <= 0 or processed_count >= total_count:
        return False
    if processed_count == _SCAN_FIRST_PARTIAL_ALBUM_PUBLISH_FILES:
        return True
    if processed_count < _SCAN_FIRST_PARTIAL_ALBUM_PUBLISH_FILES:
        return False
    return (
        processed_count - _SCAN_FIRST_PARTIAL_ALBUM_PUBLISH_FILES
    ) % _SCAN_PARTIAL_ALBUM_PUBLISH_INTERVAL_FILES == 0


def scan_library_file_cache(
    library_state: dict[str, object],
    *,
    roots: list[Path],
    supported_extensions: set[str],
    image_extensions: set[str],
    exception_overrides: dict[str, object],
    use_existing_cache: bool = True,
    expected_scan_generation: int | None = None,
    root_definitions: list[dict[str, object]] | None = None,
    publication_state: dict[str, object] | None = None,
    publish_partial_snapshot: Callable[[], None] | None = None,
    record_file_error: Callable[..., None] | None = None,
) -> tuple[dict[str, dict[str, object]], float]:
    publication_target = publication_state if publication_state is not None else library_state
    all_file_stats, album_folders_total, total_bytes = _discover_music_files_with_stats(
        library_state,
        roots=roots,
        supported_extensions=supported_extensions,
        expected_scan_generation=expected_scan_generation,
        record_file_error=record_file_error,
    )
    updated_file_cache: dict[str, dict[str, object]] = {}

    library_state["scan_phase"] = "indexing"
    library_state["scan_total"] = len(all_file_stats)
    library_state["scan_processed"] = 0
    library_state["scan_current_path"] = ""
    library_state["scan_elapsed_seconds"] = 0.0
    library_state["scan_estimated_remaining_seconds"] = 0.0
    library_state["scan_files_per_second"] = 0.0
    library_state["scan_bytes_processed"] = 0
    library_state["scan_total_bytes"] = total_bytes
    library_state["scan_album_folders_processed"] = 0
    library_state["scan_album_folders_total"] = album_folders_total
    library_state["scan_progress_samples"] = []

    existing_published_cache = dict(publication_target.get("file_cache") or {})
    previous = existing_published_cache if use_existing_cache else {}
    publish_partial_album_snapshots = not (
        existing_published_cache
        and publication_target.get("albums")
    )
    seen_album_folders: set[Path] = set()
    folder_cover_cache: dict[str, object] = {}
    folder_root_definition_cache: dict[str, dict[str, object] | None] = {}
    cover_metadata_cache: dict[
        str,
        tuple[int | None, int | None, str | None, int | None, int | None],
    ] = {}
    bytes_processed = 0
    started_at = float(library_state.get("scan_started_at") or 0.0)
    if not started_at:
        started_at = time.time()
        library_state["scan_started_at"] = started_at
    library_state["scan_progress_samples"] = [(
        started_at,
        0,
        0,
        _combined_scan_progress_fraction(
            processed=0,
            total=len(all_file_stats),
            bytes_processed=0,
            total_bytes=total_bytes,
        ),
    )]
    configured_root_definitions = list(root_definitions or [])

    ordered_metadata_entries = _ordered_scan_metadata_entries(
        library_state,
        all_file_stats,
        previous,
        expected_scan_generation=expected_scan_generation,
        record_file_error=record_file_error,
    )
    for index, (path, stat, existing, entry, metadata_was_read) in enumerate(
        ordered_metadata_entries,
        start=1,
    ):
        path_str = str(path)
        track_folder = path.parent
        library_state["scan_current_path"] = path_str
        seen_album_folders.add(_album_folder_for_track_path(path))
        persisted_entry = (
            existing_published_cache.get(path_str)
            if isinstance(existing_published_cache, dict)
            else None
        )

        if metadata_was_read and isinstance(existing, dict):
            for key in _REMOTE_COVER_KEYS:
                if key not in entry or entry.get(key) in (None, ""):
                    entry[key] = existing.get(key)
        if (
            isinstance(persisted_entry, dict)
            and type(persisted_entry.get("is_compilation")) is bool
        ):
            entry["is_compilation"] = persisted_entry["is_compilation"]
        track_folder_key = str(track_folder)
        if track_folder_key not in folder_root_definition_cache:
            folder_root_definition_cache[track_folder_key] = root_definition_for_path(
                configured_root_definitions,
                path,
            )
        matched_root = folder_root_definition_cache[track_folder_key]
        if isinstance(matched_root, dict):
            entry["library_root_id"] = str(matched_root.get("id") or "").strip() or None
            entry["library_root_category"] = library_category_slug(matched_root.get("category"))
        apply_exception_override(entry, exception_overrides)
        entry["cover_path"] = _resolve_folder_cover_path(
            folder=track_folder,
            existing_cover_value=entry.get("cover_path"),
            image_extensions=image_extensions,
            folder_cover_cache=folder_cover_cache,
        )
        _apply_cached_local_cover_metadata(
            entry,
            cover_metadata_cache=cover_metadata_cache,
            record_file_error=record_file_error,
        )

        updated_file_cache[path_str] = entry
        library_state["scan_processed"] = index
        bytes_processed += int(stat.st_size or 0)
        _record_scan_progress_metrics(
            library_state,
            now=time.time(),
            processed=index,
            total=len(all_file_stats),
            bytes_processed=bytes_processed,
            total_bytes=total_bytes,
            album_folders_processed=len(seen_album_folders),
        )
        _cooperative_scan_yield(index)

        if (
            publish_partial_album_snapshots
            and _should_publish_partial_scan(processed=index, total=len(all_file_stats))
        ):
            partial_published_cache = dict(existing_published_cache)
            partial_published_cache.update(updated_file_cache)
            _publish_partial_scan_albums(
                publication_target,
                updated_file_cache,
                published_file_cache=partial_published_cache,
            )
            if publish_partial_snapshot is not None:
                publish_partial_snapshot()

    last_scan = time.time()
    library_state["scan_current_path"] = ""
    library_state["scan_elapsed_seconds"] = max(0.0, last_scan - started_at)
    library_state["scan_estimated_remaining_seconds"] = 0.0
    library_state["scan_bytes_processed"] = total_bytes
    library_state["scan_album_folders_processed"] = album_folders_total
    _publish_partial_scan_albums(publication_target, updated_file_cache)
    return updated_file_cache, last_scan
