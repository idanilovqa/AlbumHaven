from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from math import isfinite
from threading import Lock
from time import perf_counter


_EDIT_TAG_PHASES = frozenset({
    "reservation_wait",
    "intent_prepare",
    "media_writes",
    "files_verified_checkpoint",
    "postgres_commit",
    "runtime_reconciliation",
    "history_publication",
    "event_publication",
    "canonical_album_lookup",
    "problematic_album_lookup",
    "response_construction",
})
_POOL_EVENTS = frozenset({"acquired", "released", "timeout"})
_POOL_WORKLOADS = frozenset({"browse", "default"})
_COUNT_LIMIT = 1_000_000


def _bounded_nonnegative_float(value: object) -> float | None:
    try:
        normalized = float(value)
    except (TypeError, ValueError):
        return None
    if not isfinite(normalized):
        return None
    return max(normalized, 0.0)


def _bounded_nonnegative_int(value: object) -> int | None:
    normalized = _bounded_nonnegative_float(value)
    if normalized is None:
        return None
    return min(int(normalized), _COUNT_LIMIT)


class EditTagTimingRecorder:
    def __init__(
        self,
        operation_id: str,
        *,
        clock: Callable[[], float] = perf_counter,
    ) -> None:
        self._operation_id = str(operation_id or "")
        self._clock = clock
        self._lock = Lock()
        self._phase_timings_ms: dict[str, float] = {}
        self._pool_lease_timings_ms: dict[str, dict[str, float]] = {}
        self._pool_lease_counts: dict[str, dict[str, int]] = {}
        self._pool_available_observed_workloads: set[str] = set()

    @contextmanager
    def measure(self, phase: str) -> Iterator[None]:
        started_at = self._clock()
        try:
            yield
        finally:
            self.record(phase, (self._clock() - started_at) * 1000)

    def record(self, phase: str, elapsed_ms: float) -> None:
        normalized_phase = str(phase or "").strip()
        if normalized_phase not in _EDIT_TAG_PHASES:
            raise ValueError(f"Unsupported Edit Tags timing phase: {normalized_phase}")
        normalized_elapsed = _bounded_nonnegative_float(elapsed_ms)
        if normalized_elapsed is None:
            raise ValueError("Edit Tags timing must be finite.")
        with self._lock:
            self._phase_timings_ms[normalized_phase] = (
                self._phase_timings_ms.get(normalized_phase, 0.0)
                + normalized_elapsed
            )

    def observe_pool_lease(
        self,
        event: str,
        payload: Mapping[str, object],
    ) -> None:
        normalized_event = str(event or "").strip()
        if normalized_event not in _POOL_EVENTS:
            return
        workload = str(payload.get("workload") or "").strip()
        if workload not in _POOL_WORKLOADS:
            workload = "other"

        with self._lock:
            timings = self._pool_lease_timings_ms.setdefault(
                workload,
                {"held_ms": 0.0, "wait_ms": 0.0},
            )
            for key in ("held_ms", "wait_ms"):
                value = _bounded_nonnegative_float(payload.get(key))
                if value is not None:
                    timings[key] += value

            counts = self._pool_lease_counts.setdefault(
                workload,
                {
                    "acquired": 0,
                    "pool_available_min": 0,
                    "pool_size_max": 0,
                    "released": 0,
                    "requests_waiting_max": 0,
                    "timeout": 0,
                },
            )
            counts[normalized_event] = min(
                counts[normalized_event] + 1,
                _COUNT_LIMIT,
            )
            pool_size = _bounded_nonnegative_int(payload.get("pool_size"))
            if pool_size is not None:
                counts["pool_size_max"] = max(counts["pool_size_max"], pool_size)
            pool_available = _bounded_nonnegative_int(payload.get("pool_available"))
            if pool_available is not None:
                if workload in self._pool_available_observed_workloads:
                    counts["pool_available_min"] = min(
                        counts["pool_available_min"], pool_available
                    )
                else:
                    counts["pool_available_min"] = pool_available
                    self._pool_available_observed_workloads.add(workload)
            requests_waiting = _bounded_nonnegative_int(payload.get("requests_waiting"))
            if requests_waiting is not None:
                counts["requests_waiting_max"] = max(
                    counts["requests_waiting_max"],
                    requests_waiting,
                )

    def snapshot(self) -> dict[str, object]:
        with self._lock:
            return {
                "operation_id": self._operation_id,
                "phase_timings_ms": {
                    phase: round(elapsed_ms, 2)
                    for phase, elapsed_ms in self._phase_timings_ms.items()
                },
                "pool_lease_timings_ms": {
                    workload: {
                        key: round(value, 2)
                        for key, value in timings.items()
                    }
                    for workload, timings in self._pool_lease_timings_ms.items()
                },
                "pool_lease_counts": {
                    workload: dict(counts)
                    for workload, counts in self._pool_lease_counts.items()
                },
            }
