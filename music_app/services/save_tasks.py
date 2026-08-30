from __future__ import annotations

"""Phase 3 owner for shared save-task lifecycle state.

Repair and tag-edit flows can keep their request parsing elsewhere, but the
registry, async execution handoff, and finalization bookkeeping live here.
"""

import asyncio
from collections.abc import Callable
from concurrent.futures import Future
from datetime import datetime, timezone
import os
from pathlib import Path
from threading import Event, Lock
from time import perf_counter
import uuid

from music_app.services.cache import (
    _AUTHORITATIVE_COVER_FIELDS,
    _rebase_non_cover_cache_entry_changes,
    save_cache_to_disk_for_config,
)
from music_app.services.library_roots import library_root_cache_identity
from music_app.services.metadata import normalize_exception_value
from music_app.services.runtime_shutdown import create_daemon_executor


JsonDict = dict[str, object]
StateProvider = Callable[[], dict[str, object]]
AppEventLogger = Callable[..., None]
AlbumStateRebuilder = Callable[[dict[str, object], dict[str, JsonDict], dict[str, JsonDict], set[str], set[str]], None]
RelationViewBuilder = Callable[[list[object], dict[str, object]], dict[str, object]]
CacheSaveScheduler = Callable[
    ...,
    Future[dict[str, object] | None] | None,
]
StateMutationGuard = Callable[[Callable[[], object]], object]
LogHistoryAppender = Callable[[dict[str, object], dict[str, object]], None]
AlbumFinder = Callable[[set[str]], list[JsonDict]]
ProblematicAlbumFinder = Callable[[set[str]], JsonDict | None]
StructuralTagEditPersister = Callable[..., dict[str, object]]
StructuralTagEditCompensator = Callable[..., None]
ScopedPersistenceFailureRecorder = Callable[[bool, object], object]


_SAVE_TASK_EXECUTOR = create_daemon_executor(max_workers=2, thread_name_prefix="albumhaven-save-task")
_STRUCTURAL_TAG_EDIT_EXECUTOR = create_daemon_executor(
    max_workers=4,
    thread_name_prefix="albumhaven-structural-tag-edit",
)
_SAVE_TASKS: dict[str, JsonDict] = {}
_SAVE_TASKS_LOCK = Lock()
_MISSING_STRUCTURAL_FIELD = object()


class StructuralTagEditReservation:
    def __init__(
        self,
        manager: "StructuralTagEditReservationManager",
        resource_keys: frozenset[str],
    ) -> None:
        self._manager = manager
        self._resource_keys = resource_keys
        self._release_lock = Lock()
        self._released = False

    def release(self) -> None:
        with self._release_lock:
            if self._released:
                return
            self._released = True
        self._manager.release(self._resource_keys)


class _StructuralTagEditReservationWaiter:
    def __init__(
        self,
        ticket: int,
        resource_keys: frozenset[str],
        signal_grant: Callable[[], None],
    ) -> None:
        self.ticket = ticket
        self.resource_keys = resource_keys
        self.signal_grant = signal_grant
        self.granted = False


class StructuralTagEditReservationManager:
    """Fair reservations for overlapping album identities and track paths."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._next_ticket = 0
        self._waiting: list[_StructuralTagEditReservationWaiter] = []
        self._active_resources: set[str] = set()

    @staticmethod
    def _normalize_resource_keys(
        resource_keys: set[str] | frozenset[str],
    ) -> frozenset[str]:
        normalized_keys = frozenset(
            str(key or "").strip()
            for key in resource_keys
            if str(key or "").strip()
        )
        if not normalized_keys:
            raise ValueError(
                "Structural tag edits require at least one reservation resource."
            )
        return normalized_keys

    @staticmethod
    def _signal_grants(
        waiters: list[_StructuralTagEditReservationWaiter],
    ) -> None:
        for waiter in waiters:
            waiter.signal_grant()

    def _grant_available_locked(
        self,
    ) -> list[_StructuralTagEditReservationWaiter]:
        granted: list[_StructuralTagEditReservationWaiter] = []
        for waiter in list(self._waiting):
            if self._active_resources & waiter.resource_keys:
                continue
            if any(
                earlier.ticket < waiter.ticket
                and bool(earlier.resource_keys & waiter.resource_keys)
                for earlier in self._waiting
            ):
                continue
            self._waiting.remove(waiter)
            self._active_resources.update(waiter.resource_keys)
            waiter.granted = True
            granted.append(waiter)
        return granted

    def _register(
        self,
        resource_keys: set[str] | frozenset[str],
        signal_grant: Callable[[], None],
    ) -> _StructuralTagEditReservationWaiter:
        normalized_keys = self._normalize_resource_keys(resource_keys)
        with self._lock:
            ticket = self._next_ticket
            self._next_ticket += 1
            waiter = _StructuralTagEditReservationWaiter(
                ticket,
                normalized_keys,
                signal_grant,
            )
            self._waiting.append(waiter)
            granted = self._grant_available_locked()
        self._signal_grants(granted)
        return waiter

    def _cancel_waiter(
        self,
        waiter: _StructuralTagEditReservationWaiter,
    ) -> None:
        with self._lock:
            if waiter in self._waiting:
                self._waiting.remove(waiter)
            elif waiter.granted:
                waiter.granted = False
                self._active_resources.difference_update(waiter.resource_keys)
            granted = self._grant_available_locked()
        self._signal_grants(granted)

    def acquire(
        self,
        resource_keys: set[str] | frozenset[str],
    ) -> StructuralTagEditReservation:
        granted = Event()
        waiter = self._register(resource_keys, granted.set)
        try:
            granted.wait()
        except BaseException:
            self._cancel_waiter(waiter)
            raise
        return StructuralTagEditReservation(self, waiter.resource_keys)

    async def acquire_async(
        self,
        resource_keys: set[str] | frozenset[str],
    ) -> StructuralTagEditReservation:
        loop = asyncio.get_running_loop()
        granted = loop.create_future()

        def complete_grant() -> None:
            if not granted.done():
                granted.set_result(None)

        waiter = self._register(
            resource_keys,
            lambda: loop.call_soon_threadsafe(complete_grant),
        )
        try:
            await granted
        except BaseException:
            self._cancel_waiter(waiter)
            raise
        return StructuralTagEditReservation(self, waiter.resource_keys)

    def release(self, resource_keys: frozenset[str]) -> None:
        with self._lock:
            self._active_resources.difference_update(resource_keys)
            granted = self._grant_available_locked()
        self._signal_grants(granted)


_STRUCTURAL_TAG_EDIT_RESERVATIONS = StructuralTagEditReservationManager()


def structural_tag_edit_resource_keys(
    source_album_identity: object,
    track_paths: set[str],
    destination_album_identities: set[str] | None = None,
) -> set[str]:
    keys: set[str] = set()
    album_identities = {
        str(source_album_identity or "").strip().casefold(),
        *{
            str(identity or "").strip().casefold()
            for identity in (destination_album_identities or set())
        },
    }
    keys.update(
        f"album:{identity}"
        for identity in album_identities
        if identity
    )
    for raw_path in track_paths:
        path = str(raw_path or "").strip()
        if not path:
            continue
        keys.add(
            f"path:{os.path.normcase(str(Path(path).resolve(strict=False)))}"
        )
    return keys


def acquire_structural_tag_edit_reservation(
    resource_keys: set[str],
) -> StructuralTagEditReservation:
    return _STRUCTURAL_TAG_EDIT_RESERVATIONS.acquire(resource_keys)


async def acquire_structural_tag_edit_reservation_async(
    resource_keys: set[str],
) -> StructuralTagEditReservation:
    return await _STRUCTURAL_TAG_EDIT_RESERVATIONS.acquire_async(resource_keys)


def _rebase_committed_structural_entry_changes(
    *,
    baseline_file_cache: dict[str, JsonDict],
    changed_entries: dict[str, JsonDict],
    latest_file_cache: dict[str, JsonDict],
) -> dict[str, JsonDict]:
    """Apply committed structural intent while preserving latest unrelated state."""
    rebased_file_cache = dict(latest_file_cache)
    for path, requested_entry in changed_entries.items():
        baseline_entry = baseline_file_cache.get(path)
        latest_entry = latest_file_cache.get(path)
        if not isinstance(baseline_entry, dict):
            raise RuntimeError(
                "Structural runtime refresh is missing the request baseline "
                f"for {path!r}."
            )
        if not isinstance(latest_entry, dict):
            raise RuntimeError(
                "Structural runtime refresh cannot resolve the committed path "
                f"{path!r}."
            )
        rebased_entry = dict(latest_entry)
        for key in set(baseline_entry) | set(requested_entry):
            if key in _AUTHORITATIVE_COVER_FIELDS:
                continue
            baseline_value = baseline_entry.get(key, _MISSING_STRUCTURAL_FIELD)
            requested_value = requested_entry.get(
                key,
                _MISSING_STRUCTURAL_FIELD,
            )
            if requested_value == baseline_value:
                continue
            if requested_value is _MISSING_STRUCTURAL_FIELD:
                rebased_entry.pop(key, None)
            else:
                rebased_entry[key] = requested_value
        rebased_file_cache[path] = rebased_entry
    return rebased_file_cache


def _normalize_empty_exception_rebase_entries(
    file_cache: dict[str, JsonDict],
    *,
    paths: set[str] | None = None,
) -> dict[str, JsonDict]:
    normalized_file_cache = dict(file_cache)
    normalized_paths = set(file_cache) if paths is None else paths
    for path in normalized_paths:
        entry = file_cache.get(path)
        if not isinstance(entry, dict):
            continue
        normalized_entry = dict(entry)
        if (
            "exception_type" in normalized_entry
            and not normalize_exception_value(normalized_entry["exception_type"])
        ):
            normalized_entry["exception_type"] = ""
        normalized_file_cache[path] = normalized_entry
    return normalized_file_cache


def save_task_result(task_id: str) -> JsonDict:
    with _SAVE_TASKS_LOCK:
        return dict(_SAVE_TASKS.get(task_id, {}))


def update_save_task(task_id: str, **changes) -> None:
    with _SAVE_TASKS_LOCK:
        task = _SAVE_TASKS.setdefault(task_id, {"id": task_id, "status": "pending"})
        task.update(changes)


def create_save_task(kind: str) -> str:
    task_id = uuid.uuid4().hex
    update_save_task(task_id, kind=kind, status="pending", created_at=datetime.now(timezone.utc).isoformat())
    return task_id


def _build_save_failure_log_entry(
    log_entry: JsonDict,
    error: object,
    changed_paths: set[str],
) -> JsonDict:
    files = sorted(
        {
            str(path or "")
            for path in [*(log_entry.get("files") or []), *changed_paths]
            if str(path or "")
        }
    )
    return {
        **log_entry,
        "id": uuid.uuid4().hex,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "Tag edit failed",
        "file_count": len(files),
        "files": files,
        "error": str(error),
    }


def _fail_save_task(
    task_id: str,
    *,
    config: dict[str, object],
    logger: object,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    log_entry: JsonDict,
    changed_paths: set[str],
    error: object,
) -> None:
    failure_entry = _build_save_failure_log_entry(log_entry, error, changed_paths)
    try:
        append_log_history(config, failure_entry)
    except Exception:
        pass
    try:
        log_app_event(
            config,
            logger,
            "Tag edit failed",
            level="error",
            **{
                key: value
                for key, value in failure_entry.items()
                if key not in {"id", "timestamp", "action"}
            },
        )
    except Exception:
        pass
    update_save_task(
        task_id,
        status="failed",
        completed_at=datetime.now(timezone.utc).isoformat(),
        error=str(error),
        log_entry=failure_entry,
    )


def _post_commit_value(
    warnings: list[str],
    stage: str,
    callback: Callable[[], object],
    default: object,
) -> object:
    try:
        return callback()
    except Exception as exc:
        warnings.append(
            f"{stage} failed after persistence committed: {exc}"
        )
        return default


def _committed_values_from_cache_changes(
    *,
    previous_file_cache: dict[str, JsonDict],
    updated_file_cache: dict[str, JsonDict],
    changed_paths: set[str],
    changed_field_names: set[str],
) -> dict[str, JsonDict]:
    committed: dict[str, JsonDict] = {}
    for path in sorted(changed_paths):
        previous_entry = previous_file_cache.get(path)
        updated_entry = updated_file_cache.get(path)
        if not isinstance(updated_entry, dict):
            continue
        previous_entry = previous_entry if isinstance(previous_entry, dict) else {}
        fields = {
            field: updated_entry.get(field, "")
            for field in changed_field_names
            if updated_entry.get(field, "") != previous_entry.get(field, "")
        }
        if fields:
            committed[path] = fields
    return committed


def _finalize_save_task(
    task_id: str,
    *,
    config: dict[str, object],
    logger: object,
    get_state: StateProvider,
    rebuild_affected_albums_in_state: AlbumStateRebuilder,
    build_relation_views: RelationViewBuilder,
    schedule_cache_updates_save: CacheSaveScheduler,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    find_albums_by_track_paths: AlbumFinder,
    find_problematic_album_by_track_paths: ProblematicAlbumFinder,
    updated_file_cache: dict[str, JsonDict],
    previous_file_cache: dict[str, JsonDict],
    changed_paths: set[str],
    requested_track_paths: set[str],
    separate_release_keys: set[str],
    changed_field_names: set[str],
    structural_edit_fields: set[str],
    log_entry: JsonDict,
    scoped_postgres_exception_only: bool = False,
    run_state_mutation: StateMutationGuard | None = None,
    compensate_save_task: StructuralTagEditCompensator | None = None,
    before_persistence_commit: Callable[[object], object] | None = None,
    complete_scoped_persistence: Callable[[], object] | None = None,
    record_scoped_persistence_failure: ScopedPersistenceFailureRecorder | None = None,
) -> None:
    finalize_started = perf_counter()
    persistence_started = finalize_started
    changed_entries = {
        path: dict(updated_file_cache[path])
        for path in changed_paths
        if isinstance(updated_file_cache.get(path), dict)
    }
    operation_baseline = {
        path: dict(previous_file_cache[path])
        for path in changed_paths
        if isinstance(previous_file_cache.get(path), dict)
    }
    committed_relation_state: dict[str, object] | None = None
    durable_boundary_crossed = False
    try:
        if scoped_postgres_exception_only:
            if complete_scoped_persistence is not None:
                complete_scoped_persistence()
            durable_boundary_crossed = True
        else:
            preflight_state = get_state()
            preflight_file_cache = dict(
                preflight_state.get("file_cache", {}) or {}
            )
            for path, baseline_entry in operation_baseline.items():
                preflight_file_cache.setdefault(path, dict(baseline_entry))
            _rebase_non_cover_cache_entry_changes(
                baseline_file_cache=operation_baseline,
                changed_entries=changed_entries,
                latest_file_cache=preflight_file_cache,
            )
            persistence_options = (
                {"before_commit": before_persistence_commit}
                if before_persistence_commit is not None
                else {}
            )
            persistence_future = schedule_cache_updates_save(
                config["CACHE_PATH"],
                changed_entries,
                operation_baseline,
                **persistence_options,
            )
            if persistence_future is not None:
                durable_result = persistence_future.result()
                durable_boundary_crossed = True
                if isinstance(durable_result, dict):
                    committed_relation_state = durable_result
            elif before_persistence_commit is not None:
                raise RuntimeError(
                    "Tag edit persistence returned no durable completion task."
                )
    except Exception as exc:
        compensation_succeeded = True
        try:
            if compensate_save_task is not None:
                compensate_save_task(
                    changed_paths=set(changed_paths),
                    previous_file_entries=previous_file_cache,
                    updated_file_entries=updated_file_cache,
                    changed_field_names=set(changed_field_names),
                )
        except Exception as compensation_exc:
            compensation_succeeded = False
            exc = compensation_exc
        if record_scoped_persistence_failure is not None:
            try:
                record_scoped_persistence_failure(compensation_succeeded, exc)
            except Exception as journal_exc:
                logger.exception(
                    "Could not record tag edit compensation outcome: %s",
                    journal_exc,
                )
        _fail_save_task(
            task_id,
            config=config,
            logger=logger,
            append_log_history=append_log_history,
            log_app_event=log_app_event,
            log_entry=log_entry,
            changed_paths=set(changed_paths),
            error=exc,
        )
        return
    persistence_ms = (perf_counter() - persistence_started) * 1000.0

    warnings: list[str] = []

    def record_runtime_failure(stage: str, exc: Exception) -> None:
        if not durable_boundary_crossed:
            raise exc
        warnings.append(f"{stage} failed after persistence committed: {exc}")

    def refresh_runtime_state() -> None:
        st = get_state()
        live_file_cache = dict(st.get("file_cache", {}) or {})
        for path, baseline_entry in operation_baseline.items():
            live_file_cache.setdefault(path, dict(baseline_entry))
        rebase_baseline = operation_baseline
        rebase_changes = changed_entries
        rebase_latest = live_file_cache
        if scoped_postgres_exception_only:
            rebase_baseline = _normalize_empty_exception_rebase_entries(
                operation_baseline
            )
            rebase_changes = _normalize_empty_exception_rebase_entries(
                changed_entries
            )
            rebase_latest = _normalize_empty_exception_rebase_entries(
                live_file_cache,
                paths=set(changed_entries),
            )
        current_file_cache = _rebase_non_cover_cache_entry_changes(
            baseline_file_cache=rebase_baseline,
            changed_entries=rebase_changes,
            latest_file_cache=rebase_latest,
        )
        st["file_cache"] = current_file_cache
        if not scoped_postgres_exception_only:
            try:
                rebuild_affected_albums_in_state(
                    st,
                    previous_file_cache,
                    current_file_cache,
                    changed_paths or requested_track_paths,
                    separate_release_keys,
                )
            except Exception as exc:
                record_runtime_failure("Album state rebuild", exc)
        relation_projection_edit_fields = structural_edit_fields | {"artist"}
        if (
            changed_field_names & relation_projection_edit_fields
            and not scoped_postgres_exception_only
        ):
            try:
                if isinstance(committed_relation_state, dict) and isinstance(
                    committed_relation_state.get("relation_views"),
                    dict,
                ):
                    st["relation_views"] = dict(
                        committed_relation_state["relation_views"]
                    )
                    st["relations_last_built"] = float(
                        committed_relation_state.get("relations_last_built") or 0.0
                    )
                else:
                    raise RuntimeError(
                        "Postgres persistence returned no canonical relation projection state."
                    )
            except Exception as exc:
                record_runtime_failure("Relation state refresh", exc)

        from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
        from music_app.services.utility_rules import invalidate_utility_rules_payload_cache

        for stage, callback in (
            (
                "Problematic album invalidation",
                lambda: invalidate_problematic_albums_payload_cache(st),
            ),
            (
                "Utility rule invalidation",
                lambda: invalidate_utility_rules_payload_cache(st),
            ),
        ):
            try:
                callback()
            except Exception as exc:
                record_runtime_failure(stage, exc)

    state_guard = run_state_mutation or (lambda action: action())
    try:
        state_guard(refresh_runtime_state)
    except Exception as exc:
        if durable_boundary_crossed:
            warnings.append(
                f"Runtime state refresh failed after persistence committed: {exc}"
            )
        else:
            update_save_task(
                task_id,
                status="failed",
                completed_at=datetime.now(timezone.utc).isoformat(),
                error=str(exc),
            )
            return
    _post_commit_value(
        warnings,
        "History update",
        lambda: append_log_history(config, log_entry),
        None,
    )
    _post_commit_value(
        warnings,
        "Application event log",
        lambda: log_app_event(
            config,
            logger,
            str(log_entry.get("action") or "Library save completed"),
            level="info",
            **{
                key: value
                for key, value in log_entry.items()
                if key not in {"id", "timestamp", "action"}
            },
        ),
        None,
    )
    updated_albums = _post_commit_value(
        warnings,
        "Album refresh",
        lambda: find_albums_by_track_paths(requested_track_paths),
        [],
    )
    updated_problematic_album = _post_commit_value(
        warnings,
        "Problematic album refresh",
        lambda: find_problematic_album_by_track_paths(requested_track_paths),
        None,
    )
    completion = {
        "status": "completed",
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "updated_albums": updated_albums,
        "updated_problematic_album": updated_problematic_album,
        "requires_view_refresh": bool(
            changed_field_names & structural_edit_fields
        )
        or bool(warnings),
        "log_entry": log_entry,
        "committed_values": _committed_values_from_cache_changes(
            previous_file_cache=previous_file_cache,
            updated_file_cache=updated_file_cache,
            changed_paths=changed_paths,
            changed_field_names=changed_field_names,
        ),
        "timings": {
            "postgres_ms": round(persistence_ms, 3),
            "finalization_ms": round(
                (perf_counter() - finalize_started) * 1000.0,
                3,
            ),
        },
    }
    if warnings:
        completion["warnings"] = warnings
    update_save_task(task_id, **completion)


def finalize_save_task(
    task_id: str,
    *args,
    structural_tag_edit_reservation: object | None = None,
    **kwargs,
) -> None:
    try:
        _finalize_save_task(task_id, *args, **kwargs)
    finally:
        release = getattr(structural_tag_edit_reservation, "release", None)
        if callable(release):
            release()


def finalize_structural_tag_edit_save_task(
    task_id: str,
    *,
    config: dict[str, object],
    logger: object,
    get_state: StateProvider,
    rebuild_affected_albums_in_state: AlbumStateRebuilder,
    persist_structural_tag_edit: StructuralTagEditPersister,
    compensate_structural_tag_edit: StructuralTagEditCompensator | None = None,
    append_log_history: LogHistoryAppender,
    log_app_event: AppEventLogger,
    find_albums_by_track_paths: AlbumFinder,
    find_problematic_album_by_track_paths: ProblematicAlbumFinder,
    updated_file_cache: dict[str, JsonDict],
    previous_file_cache: dict[str, JsonDict],
    changed_paths: set[str],
    requested_track_paths: set[str],
    separate_release_keys: set[str],
    changed_field_names: set[str],
    structural_edit_fields: set[str],
    log_entry: JsonDict,
    relation_projection_edit_fields: set[str] | None = None,
    run_state_mutation: StateMutationGuard | None = None,
    structural_tag_edit_reservation: object | None = None,
    before_persistence_commit: Callable[[object], object] | None = None,
    record_scoped_persistence_failure: ScopedPersistenceFailureRecorder | None = None,
) -> None:
    finalize_started = perf_counter()
    try:
        try:
            persistence_started = perf_counter()
            persistence_options = (
                {"before_commit": before_persistence_commit}
                if before_persistence_commit is not None
                else {}
            )
            persistence_result = persist_structural_tag_edit(
                changed_paths=set(changed_paths),
                previous_file_entries=previous_file_cache,
                updated_file_entries=updated_file_cache,
                changed_field_names=set(changed_field_names),
                **persistence_options,
            )
            persistence_ms = (perf_counter() - persistence_started) * 1000.0
        except Exception as exc:
            compensation_succeeded = True
            try:
                if compensate_structural_tag_edit is not None:
                    compensate_structural_tag_edit(
                        changed_paths=set(changed_paths),
                        previous_file_entries=previous_file_cache,
                        updated_file_entries=updated_file_cache,
                        changed_field_names=set(changed_field_names),
                    )
            except Exception as compensation_exc:
                compensation_succeeded = False
                exc = compensation_exc
            if record_scoped_persistence_failure is not None:
                try:
                    record_scoped_persistence_failure(compensation_succeeded, exc)
                except Exception as journal_exc:
                    logger.exception(
                        "Could not record structural tag edit compensation outcome: %s",
                        journal_exc,
                    )
            _fail_save_task(
                task_id,
                config=config,
                logger=logger,
                append_log_history=append_log_history,
                log_app_event=log_app_event,
                log_entry=log_entry,
                changed_paths=set(changed_paths),
                error=exc,
            )
            return

        warnings: list[str] = []
        committed_separate_release_key = str(
            persistence_result.get("separate_release_key") or ""
        ).strip()
        committed_relation_views = persistence_result.get("relation_views")
        committed_relations_last_built = float(
            persistence_result.get("relations_last_built") or 0.0
        )

        def refresh_runtime_state() -> None:
            st = get_state()
            current_separate_release_keys = set(separate_release_keys)
            if committed_separate_release_key:
                current_separate_release_keys.add(
                    committed_separate_release_key
                )
            st["separate_release_keys"] = current_separate_release_keys
            current_file_cache = dict(st.get("file_cache", {}) or {})
            operation_baseline = {
                path: dict(previous_file_cache[path])
                for path in changed_paths
                if isinstance(previous_file_cache.get(path), dict)
            }
            changed_entries = {
                path: dict(updated_file_cache[path])
                for path in changed_paths
                if isinstance(updated_file_cache.get(path), dict)
            }
            for path, baseline_entry in operation_baseline.items():
                current_file_cache.setdefault(path, dict(baseline_entry))
            current_file_cache = _rebase_committed_structural_entry_changes(
                baseline_file_cache=operation_baseline,
                changed_entries=changed_entries,
                latest_file_cache=current_file_cache,
            )
            st["file_cache"] = current_file_cache
            required_relation_fields = (
                structural_edit_fields | {"artist"}
                if relation_projection_edit_fields is None
                else relation_projection_edit_fields
            )
            if changed_field_names & required_relation_fields:
                if not isinstance(committed_relation_views, dict):
                    warnings.append(
                        "Relation state refresh failed after persistence committed: "
                        "Postgres persistence returned no canonical relation projection state."
                    )
                else:
                    st["relation_views"] = dict(committed_relation_views)
                    st["relations_last_built"] = committed_relations_last_built
            try:
                rebuild_affected_albums_in_state(
                    st,
                    previous_file_cache,
                    current_file_cache,
                    changed_paths or requested_track_paths,
                    current_separate_release_keys,
                )
            except Exception as exc:
                warnings.append(
                    f"Album state rebuild failed after persistence committed: {exc}"
                )
            from music_app.services.problematic_albums import invalidate_problematic_albums_payload_cache
            from music_app.services.utility_rules import invalidate_utility_rules_payload_cache

            for stage, callback in (
                (
                    "Problematic album invalidation",
                    lambda: invalidate_problematic_albums_payload_cache(st),
                ),
                (
                    "Utility rule invalidation",
                    lambda: invalidate_utility_rules_payload_cache(st),
                ),
            ):
                try:
                    callback()
                except Exception as exc:
                    warnings.append(
                        f"{stage} failed after persistence committed: {exc}"
                    )

        state_guard = run_state_mutation or (lambda action: action())
        _post_commit_value(
            warnings,
            "Runtime state refresh",
            lambda: state_guard(refresh_runtime_state),
            None,
        )
        try:
            updated_albums = find_albums_by_track_paths(requested_track_paths)
        except Exception as exc:
            _fail_save_task(
                task_id,
                config=config,
                logger=logger,
                append_log_history=append_log_history,
                log_app_event=log_app_event,
                log_entry=log_entry,
                changed_paths=set(changed_paths),
                error=exc,
            )
            return
        _post_commit_value(
            warnings,
            "History update",
            lambda: append_log_history(config, log_entry),
            None,
        )
        _post_commit_value(
            warnings,
            "Application event log",
            lambda: log_app_event(
                config,
                logger,
                str(log_entry.get("action") or "Library save completed"),
                level="info",
                **{
                    key: value
                    for key, value in log_entry.items()
                    if key not in {"id", "timestamp", "action"}
                },
            ),
            None,
        )
        updated_problematic_album = _post_commit_value(
            warnings,
            "Problematic album refresh",
            lambda: find_problematic_album_by_track_paths(requested_track_paths),
            None,
        )
        completion = {
            "status": "completed",
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "updated_albums": updated_albums,
            "updated_problematic_album": updated_problematic_album,
            "requires_view_refresh": bool(
                changed_field_names & structural_edit_fields
            )
            or bool(warnings),
            "log_entry": log_entry,
            "committed_values": _committed_values_from_cache_changes(
                previous_file_cache=previous_file_cache,
                updated_file_cache=updated_file_cache,
                changed_paths=changed_paths,
                changed_field_names=changed_field_names,
            ),
            "timings": {
                "postgres_ms": round(persistence_ms, 3),
                "finalization_ms": round(
                    (perf_counter() - finalize_started) * 1000.0,
                    3,
                ),
            },
        }
        if warnings:
            completion["warnings"] = warnings
        update_save_task(task_id, **completion)
    finally:
        release = getattr(structural_tag_edit_reservation, "release", None)
        if callable(release):
            release()


def queue_finalize_save_task(*, wait_for_completion: bool = False, **kwargs) -> None:
    if wait_for_completion:
        finalize_save_task(**kwargs)
        return
    try:
        _SAVE_TASK_EXECUTOR.submit(finalize_save_task, **kwargs)
    except Exception:
        release = getattr(
            kwargs.get("structural_tag_edit_reservation"),
            "release",
            None,
        )
        if callable(release):
            release()
        raise


def queue_finalize_structural_tag_edit_save_task(
    *,
    wait_for_completion: bool = False,
    **kwargs,
) -> None:
    if wait_for_completion:
        finalize_structural_tag_edit_save_task(**kwargs)
        return
    try:
        _STRUCTURAL_TAG_EDIT_EXECUTOR.submit(
            finalize_structural_tag_edit_save_task,
            **kwargs,
        )
    except Exception:
        release = getattr(
            kwargs.get("structural_tag_edit_reservation"),
            "release",
            None,
        )
        if callable(release):
            release()
        raise
