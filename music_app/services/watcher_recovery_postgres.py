from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import math
from pathlib import Path
from threading import Lock
import time
from typing import Any, Callable, Iterable, Literal, Mapping, Protocol
from uuid import UUID

from music_app.services.library_event_coordinator import CoordinatorProblem
from music_app.services.library_watch import LibraryEvent, LibraryEventKind
from music_app.services.library_watch_health import LibraryWatchHealthProblem


_FAILURE_REASONS = frozenset(
    {
        "root_unavailable",
        "overflow",
        "stable_write_unavailable",
        "reconciliation_failed",
        "cross_root_uncertain",
    }
)


@dataclass(frozen=True, slots=True)
class WatcherRootRecord:
    database_id: int
    logical_id: str
    path: Path


@dataclass(frozen=True, slots=True)
class WatcherParticipantFence:
    logical_root_id: str
    accepted_sequence_lower: int
    accepted_sequence_upper: int
    dirty_generation: int


@dataclass(frozen=True, slots=True)
class AcceptedWatcherGeneration:
    generation_id: int
    participants: tuple[WatcherParticipantFence, ...]
    coalesced: bool = False
    needs_dispatch: bool = True


@dataclass(frozen=True, slots=True)
class MarkedDirtyWatcherGeneration:
    generation_id: int
    participants: tuple[WatcherParticipantFence, ...]
    incident_id: str
    warning_token: str


@dataclass(frozen=True, slots=True)
class ClaimedWatcherGeneration:
    generation_id: int
    intent_id: int
    library_id: int
    participants: tuple[WatcherParticipantFence, ...]
    generation_kind: str
    barrier_ids: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class WatcherRollbackResult:
    retained_generation_ids: tuple[int, ...]
    affected_root_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class WatcherMetrics:
    ready: int
    running: int
    coalesced: int
    dirty: int
    barrier_waiting: int
    lag_1_9: int
    lag_10_99: int
    lag_100_plus: int
    coalesced_events: int
    catch_ups: int
    oldest_ready_seconds: float
    oldest_repair_seconds: float


class WatcherSessionReplacedError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class WatcherDirtyWriteOutcome:
    state: Literal["committed", "rolled_back", "indeterminate"]
    committed_root_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.state not in {"committed", "rolled_back", "indeterminate"}:
            raise ValueError("watcher dirty write outcome state is invalid")
        if self.state != "committed" and self.committed_root_ids:
            raise ValueError("only a committed outcome may contain committed root IDs")


class WatcherDirtyWriteAttempt(Protocol):
    @property
    def is_terminal(self) -> bool: ...

    @property
    def outcome(self) -> WatcherDirtyWriteOutcome | None: ...

    def execute(self) -> WatcherDirtyWriteOutcome: ...

    def cancel(self) -> None: ...


def _relative_path(path: Path, root: Path) -> str:
    try:
        relative = path.resolve(strict=False).relative_to(root.resolve(strict=False))
    except (OSError, ValueError):
        raise ValueError("path must be root-relative") from None
    value = relative.as_posix()
    if value in {"", "."} or any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError("path must be a non-root root-relative value")
    return value


def _event_payload(
    event: LibraryEvent,
    roots: Mapping[str, WatcherRootRecord],
) -> dict[str, object]:
    source = roots.get(event.root_id)
    if source is None:
        raise ValueError("watcher source root is unknown")
    payload: dict[str, object] = {
        "kind": event.kind.value,
        "source_root_id": event.root_id,
        "source_path": _relative_path(event.path, source.path),
        "is_directory": bool(event.is_directory),
    }
    if event.kind is LibraryEventKind.MOVED:
        destination = roots.get(str(event.destination_root_id or ""))
        if destination is None or event.destination is None:
            raise ValueError("watcher destination root is unknown")
        payload.update(
            destination_root_id=destination.logical_id,
            destination_path=_relative_path(event.destination, destination.path),
        )
    return payload


def _participant_fences(rows: Iterable[Mapping[str, object]]) -> tuple[WatcherParticipantFence, ...]:
    fences: list[WatcherParticipantFence] = []
    seen: set[str] = set()
    for row in rows:
        logical_id = str(row.get("logical_root_id") or "").strip()
        lower = int(row.get("accepted_sequence_lower") or 0)
        upper = int(row.get("accepted_sequence_upper") or 0)
        dirty = int(row.get("dirty_generation") or 0)
        if not logical_id or logical_id in seen:
            raise ValueError("watcher participant scope is ambiguous")
        if lower < 1 or upper < lower or dirty < 0:
            raise ValueError("watcher participant fence is inverted")
        seen.add(logical_id)
        fences.append(WatcherParticipantFence(logical_id, lower, upper, dirty))
    return tuple(sorted(fences, key=lambda item: item.logical_root_id))


def _positive_id(value: object, name: str) -> int:
    parsed = int(value or 0)
    if parsed < 1:
        raise ValueError(f"{name} must be positive")
    return parsed


def _aware_utc(value: datetime, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(timezone.utc)


def _timestamp_text(value: object) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("watcher timestamp must be timezone-aware")
        return value.astimezone(timezone.utc).isoformat()
    return str(value or "").strip()


def _default_connect(database_url: str, **kwargs: Any) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row, **kwargs)


def _runtime_session_identity(library_id: int, session_token: UUID) -> tuple[int, UUID]:
    if not isinstance(library_id, int) or isinstance(library_id, bool) or library_id < 1:
        raise ValueError("library_id must be positive")
    if not isinstance(session_token, UUID):
        raise ValueError("session_token must be a UUID")
    return library_id, session_token


def _root_id_tuple(logical_root_ids: tuple[str, ...], *, unique: bool) -> tuple[str, ...]:
    if not isinstance(logical_root_ids, tuple) or len(logical_root_ids) > 256:
        raise ValueError("logical_root_ids must be a bounded tuple")
    if any(not isinstance(value, str) or not value.strip() for value in logical_root_ids):
        raise ValueError("logical_root_ids contains an invalid value")
    if unique and len(set(logical_root_ids)) != len(logical_root_ids):
        raise ValueError("logical_root_ids must be unique")
    return logical_root_ids


def _ordered_sql_root_ids(logical_root_ids: tuple[str, ...]) -> list[str]:
    if len(set(logical_root_ids)) == len(logical_root_ids):
        return sorted(logical_root_ids)
    return list(logical_root_ids)


def _runtime_session_error(exc: BaseException, *, begin: bool = False) -> BaseException:
    sqlstate = getattr(exc, "sqlstate", None)
    if sqlstate == "22023":
        return ValueError("watcher runtime session arguments are invalid")
    if sqlstate == "55000" and not begin:
        return WatcherSessionReplacedError("watcher runtime session was replaced")
    if begin:
        return RuntimeError("watcher runtime session could not begin")
    return RuntimeError("watcher runtime session operation failed")


class _PostgresWatcherDirtyWriteAttempt:
    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[..., Any],
        library_id: int,
        logical_root_ids: tuple[str, ...],
        observed_at: datetime,
        operation_deadline: float,
    ) -> None:
        self._database_url = database_url
        self._connect_to_database = connect_to_database
        self._library_id = library_id
        self._logical_root_ids = logical_root_ids
        self._observed_at = observed_at
        self._operation_deadline = operation_deadline
        self._lock = Lock()
        self._cancelled = False
        self._cancel_sent = False
        self._connection: Any | None = None
        self._executing = False
        self._outcome: WatcherDirtyWriteOutcome | None = None

    @property
    def is_terminal(self) -> bool:
        with self._lock:
            return self._outcome is not None

    @property
    def outcome(self) -> WatcherDirtyWriteOutcome | None:
        with self._lock:
            return self._outcome

    def _publish(self, outcome: WatcherDirtyWriteOutcome) -> WatcherDirtyWriteOutcome:
        with self._lock:
            if self._outcome is None:
                self._outcome = outcome
            return self._outcome

    @staticmethod
    def _close(connection: Any) -> None:
        try:
            connection.close()
        except Exception:
            pass

    @staticmethod
    def _rollback(connection: Any) -> bool:
        try:
            connection.rollback()
        except Exception:
            return False
        return True

    def execute(self) -> WatcherDirtyWriteOutcome:
        with self._lock:
            if self._outcome is not None:
                return self._outcome
            if self._executing:
                raise RuntimeError("watcher dirty write attempt is already executing")
            self._executing = True
            if self._cancelled:
                return self._publish_locked(WatcherDirtyWriteOutcome("rolled_back"))

        remaining = self._operation_deadline - time.monotonic()
        if remaining < 1.0:
            return self._publish(WatcherDirtyWriteOutcome("rolled_back"))

        connection = None
        commit_started = False
        try:
            connection = self._connect_to_database(
                self._database_url,
                connect_timeout=max(1, int(remaining)),
            )
            with self._lock:
                self._connection = connection
                cancelled = self._cancelled
            if cancelled:
                rolled_back = self._rollback(connection)
                self._close(connection)
                return self._publish(
                    WatcherDirtyWriteOutcome("rolled_back" if rolled_back else "indeterminate")
                )

            remaining_ms = int((self._operation_deadline - time.monotonic()) * 1000)
            if remaining_ms < 1:
                raise TimeoutError
            timeout = f"{remaining_ms}ms"
            connection.execute(
                "select pg_catalog.set_config('statement_timeout', %s, true)",
                (timeout,),
            )
            connection.execute(
                "select pg_catalog.set_config('lock_timeout', %s, true)",
                (timeout,),
            )
            connection.execute(
                "select * from library.mark_watcher_roots_dirty(%s, %s, %s, %s)",
                (
                    self._library_id,
                    list(self._logical_root_ids),
                    "overflow",
                    self._observed_at,
                ),
            ).fetchall()
            with self._lock:
                cancelled = self._cancelled
            if cancelled:
                rolled_back = self._rollback(connection)
                self._close(connection)
                return self._publish(
                    WatcherDirtyWriteOutcome(
                        "rolled_back" if rolled_back else "indeterminate"
                    )
                )
            commit_started = True
            connection.commit()
            with self._lock:
                cancelled = self._cancelled
            self._close(connection)
            return self._publish(
                WatcherDirtyWriteOutcome(
                    "indeterminate" if cancelled else "committed",
                    () if cancelled else self._logical_root_ids,
                )
            )
        except Exception:
            rolled_back = not commit_started and (
                connection is None or self._rollback(connection)
            )
            if connection is not None:
                self._close(connection)
            return self._publish(
                WatcherDirtyWriteOutcome("rolled_back" if rolled_back else "indeterminate")
            )
        finally:
            with self._lock:
                self._connection = None

    def _publish_locked(self, outcome: WatcherDirtyWriteOutcome) -> WatcherDirtyWriteOutcome:
        if self._outcome is None:
            self._outcome = outcome
        return self._outcome

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True
            connection = self._connection
            if connection is None or self._cancel_sent:
                return
            self._cancel_sent = True
        remaining = self._operation_deadline - time.monotonic()
        if remaining <= 0:
            self._close(connection)
            return
        cancel_timeout = min(max(0.001, remaining / 2), remaining * 0.9)
        try:
            connection.cancel_safe(timeout=cancel_timeout)
        except Exception:
            pass
        finally:
            self._close(connection)


class PostgresWatcherRecoveryRepository:
    def __init__(
        self,
        *,
        database_url: str,
        connect_to_database: Callable[[str], Any] = _default_connect,
    ) -> None:
        self._database_url = str(database_url)
        self._connect_to_database = connect_to_database

    def _connect(self) -> Any:
        return self._connect_to_database(self._database_url)

    def begin_runtime_session(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
        started_at: datetime,
    ) -> tuple[str, ...]:
        library_id, session_token = _runtime_session_identity(library_id, session_token)
        logical_root_ids = _root_id_tuple(logical_root_ids, unique=False)
        if (
            not isinstance(started_at, datetime)
            or started_at.tzinfo is None
            or started_at.utcoffset() != timezone.utc.utcoffset(started_at)
        ):
            raise ValueError("started_at must be an aware UTC timestamp")
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    "select * from library.begin_watcher_runtime_session(%s, %s, %s, %s)",
                    (
                        library_id,
                        session_token,
                        _ordered_sql_root_ids(logical_root_ids),
                        started_at,
                    ),
                ).fetchall()
        except Exception as exc:
            raise _runtime_session_error(exc, begin=True) from None
        recovered = tuple(
            str(row.get("recovered_logical_root_id") or "").strip() for row in rows
        )
        if any(not root_id for root_id in recovered) or len(set(recovered)) != len(recovered):
            raise RuntimeError("watcher runtime session recovery result is invalid")
        return tuple(sorted(recovered))

    def expand_runtime_session_participants(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
    ) -> None:
        self._mutate_runtime_session_participants(
            function="expand_watcher_runtime_session_participants",
            library_id=library_id,
            session_token=session_token,
            logical_root_ids=logical_root_ids,
        )

    def set_runtime_session_participants(
        self,
        *,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
    ) -> None:
        self._mutate_runtime_session_participants(
            function="set_watcher_runtime_session_participants",
            library_id=library_id,
            session_token=session_token,
            logical_root_ids=logical_root_ids,
        )

    def _mutate_runtime_session_participants(
        self,
        *,
        function: str,
        library_id: int,
        session_token: UUID,
        logical_root_ids: tuple[str, ...],
    ) -> None:
        library_id, session_token = _runtime_session_identity(library_id, session_token)
        logical_root_ids = _root_id_tuple(logical_root_ids, unique=False)
        try:
            with self._connect() as connection:
                connection.execute(
                    f"select library.{function}(%s, %s, %s)",
                    (
                        library_id,
                        session_token,
                        _ordered_sql_root_ids(logical_root_ids),
                    ),
                )
        except Exception as exc:
            raise _runtime_session_error(exc) from None

    def finish_runtime_session(
        self,
        *,
        library_id: int,
        session_token: UUID,
    ) -> bool:
        library_id, session_token = _runtime_session_identity(library_id, session_token)
        try:
            with self._connect() as connection:
                row = connection.execute(
                    "select library.finish_watcher_runtime_session(%s, %s) as finished",
                    (library_id, session_token),
                ).fetchone()
        except Exception as exc:
            raise _runtime_session_error(exc) from None
        return bool(row and row.get("finished"))

    def prepare_overflow_dirty_write(
        self,
        *,
        library_id: int,
        logical_root_ids: tuple[str, ...],
        observed_at: datetime,
        operation_deadline: float,
    ) -> WatcherDirtyWriteAttempt:
        if not isinstance(library_id, int) or isinstance(library_id, bool) or library_id < 1:
            raise ValueError("library_id must be positive")
        logical_root_ids = _root_id_tuple(logical_root_ids, unique=True)
        if not logical_root_ids:
            raise ValueError("logical_root_ids must not be empty")
        if (
            not isinstance(observed_at, datetime)
            or observed_at.tzinfo is None
            or observed_at.utcoffset() != timezone.utc.utcoffset(observed_at)
        ):
            raise ValueError("observed_at must be an aware UTC timestamp")
        try:
            operation_deadline = float(operation_deadline)
        except (TypeError, ValueError):
            raise ValueError("operation_deadline must be finite") from None
        if not math.isfinite(operation_deadline):
            raise ValueError("operation_deadline must be finite")
        return _PostgresWatcherDirtyWriteAttempt(
            database_url=self._database_url,
            connect_to_database=self._connect_to_database,
            library_id=library_id,
            logical_root_ids=logical_root_ids,
            observed_at=observed_at,
            operation_deadline=operation_deadline,
        )

    def dispatch_ready(self, *, now: datetime, limit: int = 32) -> tuple[int, ...]:
        now = _aware_utc(now, "now")
        bounded = max(1, min(int(limit), 128))
        with self._connect() as connection:
            rows = connection.execute(
                "select * from library.dispatch_ready_watcher_generations(%s, %s)",
                (now, bounded),
            ).fetchall()
        return tuple(_positive_id(row["generation_id"], "generation_id") for row in rows)

    def reconcile_due(self, *, now: datetime, limit: int = 100) -> tuple[int, ...]:
        now = _aware_utc(now, "now")
        bounded = max(1, min(int(limit), 128))
        with self._connect() as connection:
            recovered = connection.execute(
                "select generation_id from library.reconcile_due_watcher_generations(%s, %s)",
                (now, bounded),
            ).fetchall()
            remaining = bounded - len(recovered)
            dispatched = (
                connection.execute(
                    "select generation_id from library.dispatch_ready_watcher_generations(%s, %s)",
                    (now, remaining),
                ).fetchall()
                if remaining > 0
                else ()
            )
        return tuple(
            _positive_id(row["generation_id"], "generation_id")
            for row in (*recovered, *dispatched)
        )

    def _load_root_records(
        self,
        *,
        library_id: int,
        logical_root_ids: Iterable[str],
    ) -> dict[str, WatcherRootRecord]:
        requested = tuple(sorted({str(value).strip() for value in logical_root_ids if str(value).strip()}))
        if not requested:
            raise ValueError("watcher root scope is empty")
        with self._connect() as connection:
            rows = connection.execute(
                """
                select id, metadata ->> 'root_id' as logical_id, root_path
                from library.library_roots
                where library_id = %s
                  and is_active is true
                  and metadata ->> 'root_id' = any(%s::text[])
                order by id
                """,
                (library_id, list(requested)),
            ).fetchall()
        records: dict[str, WatcherRootRecord] = {}
        for row in rows:
            logical_id = str(row.get("logical_id") or "").strip()
            if not logical_id or logical_id in records:
                raise ValueError("watcher root scope is ambiguous")
            records[logical_id] = WatcherRootRecord(
                _positive_id(row.get("id"), "root_id"),
                logical_id,
                Path(str(row.get("root_path") or "")),
            )
        if set(records) != set(requested):
            raise ValueError("watcher root is missing or inactive")
        return records

    def accept_event(
        self,
        *,
        library_id: int,
        event: LibraryEvent,
        accepted_at: datetime,
    ) -> AcceptedWatcherGeneration:
        root_ids = [event.root_id]
        if event.destination_root_id:
            root_ids.append(event.destination_root_id)
        roots = self._load_root_records(
            library_id=library_id,
            logical_root_ids=root_ids,
        )
        accepted_at = _aware_utc(accepted_at, "accepted_at")
        payload = _event_payload(event, roots)
        with self._connect() as connection:
            rows = connection.execute(
                "select * from library.accept_watcher_event(%s, %s, %s::jsonb, %s)",
                (
                    library_id,
                    roots[event.root_id].database_id,
                    json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
                    accepted_at,
                ),
            ).fetchall()
        if not rows:
            raise RuntimeError("watcher acceptance returned no generation")
        generation_ids = {_positive_id(row.get("generation_id"), "generation_id") for row in rows}
        if len(generation_ids) != 1:
            raise RuntimeError("watcher acceptance returned ambiguous generations")
        return AcceptedWatcherGeneration(
            generation_id=generation_ids.pop(),
            participants=_participant_fences(rows),
            coalesced=bool(rows[0].get("coalesced")),
            needs_dispatch=bool(rows[0].get("needs_dispatch", True)),
        )

    def mark_dirty(
        self,
        *,
        library_id: int,
        logical_root_id: str,
        reason_code: str,
        observed_at: datetime,
    ) -> MarkedDirtyWatcherGeneration:
        observed_at = _aware_utc(observed_at, "observed_at")
        if reason_code not in {"root_unavailable", "overflow"}:
            raise ValueError("watcher dirty reason is invalid")
        with self._connect() as connection:
            rows = connection.execute(
                "select * from library.mark_watcher_roots_dirty(%s, %s, %s, %s)",
                (library_id, [logical_root_id], reason_code, observed_at),
            ).fetchall()
        if not rows:
            raise RuntimeError("watcher dirty request returned no generation")
        generation_ids = {_positive_id(row["generation_id"], "generation_id") for row in rows}
        if len(generation_ids) != 1:
            raise RuntimeError("watcher dirty request returned ambiguous generations")
        first = rows[0]
        incident_id = str(first.get("incident_id") or "").strip()
        warning_token = str(first.get("warning_token") or "").strip()
        if not incident_id or not warning_token:
            raise RuntimeError("watcher dirty request returned no incident identity")
        return MarkedDirtyWatcherGeneration(
            generation_id=generation_ids.pop(),
            participants=_participant_fences(rows),
            incident_id=incident_id,
            warning_token=warning_token,
        )

    def record_problem(
        self,
        *,
        library_id: int,
        problem: CoordinatorProblem,
        observed_at: datetime,
    ) -> LibraryWatchHealthProblem:
        marked = self.mark_dirty(
            library_id=library_id,
            logical_root_id=problem.root_id,
            reason_code=problem.code,
            observed_at=observed_at,
        )
        for current in self.load_status(library_id=library_id):
            if current.incident_id == marked.incident_id:
                return current
        raise RuntimeError("watcher incident was not visible after durable admission")

    def load_status(self, *, library_id: int) -> list[LibraryWatchHealthProblem]:
        with self._connect() as connection:
            rows = connection.execute(
                "select * from library.load_watcher_status(%s)",
                (_positive_id(library_id, "library_id"),),
            ).fetchall()
        problems: list[LibraryWatchHealthProblem] = []
        for row in rows:
            root_id = str(row.get("logical_root_id") or "").strip()
            state = str(row.get("state") or "").strip()
            detected_at = _timestamp_text(row.get("detected_at"))
            incident_id = str(row.get("incident_id") or "").strip()
            warning_token = str(row.get("warning_token") or "").strip()
            occurrence_count = int(row.get("occurrence_count") or 0)
            if (
                not root_id
                or state not in _FAILURE_REASONS | {"rollback_pending_work"}
                or not detected_at
                or not incident_id
                or not warning_token
                or occurrence_count < 1
            ):
                raise RuntimeError("watcher status returned an invalid incident")
            problems.append(
                LibraryWatchHealthProblem(
                    root_id=root_id,
                    state=state,
                    detected_at=detected_at,
                    incident_id=incident_id,
                    warning_token=warning_token,
                    occurrence_count=occurrence_count,
                    acknowledged=bool(row.get("acknowledged")),
                )
            )
        return problems

    def load_metrics(self, *, library_id: int) -> WatcherMetrics:
        now = datetime.now(timezone.utc)
        with self._connect() as connection:
            row = connection.execute(
                "select * from library.load_watcher_metrics(%s, %s)",
                (_positive_id(library_id, "library_id"), now),
            ).fetchone()
        if not row:
            raise RuntimeError("watcher metrics returned no result")
        return WatcherMetrics(
            ready=int(row.get("ready") or 0),
            running=int(row.get("running") or 0),
            coalesced=int(row.get("coalesced") or 0),
            dirty=int(row.get("dirty") or 0),
            barrier_waiting=int(row.get("barrier_waiting") or 0),
            lag_1_9=int(row.get("lag_1_9") or 0),
            lag_10_99=int(row.get("lag_10_99") or 0),
            lag_100_plus=int(row.get("lag_100_plus") or 0),
            coalesced_events=int(row.get("coalesced_events") or 0),
            catch_ups=int(row.get("catch_ups") or 0),
            oldest_ready_seconds=float(row.get("oldest_ready_seconds") or 0.0),
            oldest_repair_seconds=float(row.get("oldest_repair_seconds") or 0.0),
        )

    def acknowledge(
        self,
        *,
        library_id: int,
        account_id: int,
        warning_token: str,
        now: datetime,
    ) -> bool:
        now = _aware_utc(now, "now")
        with self._connect() as connection:
            row = connection.execute(
                "select library.acknowledge_watcher_incident(%s, %s, %s::uuid, %s) as acknowledged",
                (
                    _positive_id(library_id, "library_id"),
                    _positive_id(account_id, "account_id"),
                    warning_token,
                    now,
                ),
            ).fetchone()
        return bool(row and row.get("acknowledged"))

    def claim_generation(self, *, claim: object, now: datetime) -> ClaimedWatcherGeneration | None:
        now = _aware_utc(now, "now")
        with self._connect() as connection:
            row = connection.execute(
                "select * from library.load_claimed_watcher_generation(%s, %s, %s, %s, %s)",
                (claim.job_id, claim.attempt, claim.worker_id, claim.lease_token, now),
            ).fetchone()
        if not row:
            return None
        return ClaimedWatcherGeneration(
            generation_id=_positive_id(row["generation_id"], "generation_id"),
            intent_id=_positive_id(row["intent_id"], "intent_id"),
            library_id=_positive_id(row["library_id"], "library_id"),
            participants=_participant_fences(row.get("participants") or ()),
            generation_kind=str(row.get("generation_kind") or ""),
            barrier_ids=tuple(sorted({_positive_id(value, "barrier_id") for value in row.get("barrier_ids") or ()})),
        )

    def fail_generation(
        self,
        *,
        claim: object,
        generation: ClaimedWatcherGeneration,
        reason_code: str,
        now: datetime,
    ) -> bool:
        now = _aware_utc(now, "now")
        if reason_code not in _FAILURE_REASONS:
            raise ValueError("watcher failure reason is invalid")
        with self._connect() as connection:
            row = connection.execute(
                "select * from library.fail_claimed_watcher_generation(%s, %s, %s, %s, %s, %s, %s)",
                (
                    generation.generation_id,
                    claim.job_id,
                    claim.attempt,
                    claim.worker_id,
                    claim.lease_token,
                    reason_code,
                    now,
                ),
            ).fetchone()
        return bool(row and row.get("failed"))

    def complete_repair(
        self,
        *,
        claim: object,
        repair_id: int,
        inventory_revision: int,
        now: datetime,
    ) -> bool:
        now = _aware_utc(now, "now")
        with self._connect() as connection:
            row = connection.execute(
                "select library.complete_watcher_repair(%s, %s, %s, %s, %s, %s, %s) as repair_completed",
                (
                    _positive_id(repair_id, "repair_id"),
                    _positive_id(claim.job_id, "job_id"),
                    _positive_id(claim.attempt, "attempt"),
                    claim.worker_id,
                    claim.lease_token,
                    _positive_id(inventory_revision, "inventory_revision"),
                    now,
                ),
            ).fetchone()
        return bool(row and row.get("repair_completed"))

    def disable_acceptance(self, *, now: datetime) -> None:
        now = _aware_utc(now, "now")
        with self._connect() as connection:
            row = connection.execute(
                "select library.disable_watcher_acceptance(%s) as acceptance_disabled",
                (now,),
            ).fetchone()
        if not row or row.get("acceptance_disabled") is not True:
            raise RuntimeError("watcher acceptance could not be disabled")

    def prepare_legacy_rollback(self, *, now: datetime) -> WatcherRollbackResult:
        now = _aware_utc(now, "now")
        with self._connect() as connection:
            row = connection.execute(
                "select * from library.prepare_legacy_watcher_rollback(%s)",
                (now,),
            ).fetchone()
        if not row:
            raise RuntimeError("watcher rollback returned no result")
        generation_ids = tuple(sorted({
            _positive_id(value, "retained_generation_id")
            for value in row.get("retained_generation_ids") or ()
        }))
        root_ids = tuple(sorted({
            str(value).strip()
            for value in row.get("affected_logical_root_ids") or ()
            if str(value).strip()
        }))
        return WatcherRollbackResult(generation_ids, root_ids)



__all__ = [
    "AcceptedWatcherGeneration",
    "ClaimedWatcherGeneration",
    "MarkedDirtyWatcherGeneration",
    "PostgresWatcherRecoveryRepository",
    "WatcherDirtyWriteAttempt",
    "WatcherDirtyWriteOutcome",
    "WatcherMetrics",
    "WatcherParticipantFence",
    "WatcherRollbackResult",
    "WatcherRootRecord",
    "WatcherSessionReplacedError",
]
