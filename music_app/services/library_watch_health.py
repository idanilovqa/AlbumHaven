"""Persistent, path-free health reporting for library filesystem watchers."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from threading import Lock
from typing import Any
from uuid import uuid4

from music_app.services.library_watch import LibraryEvent, LibraryEventKind

try:  # pragma: no cover - optional in lightweight test environments.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None


WATCH_HEALTH_MESSAGE = "Some library changes may have been missed."
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_HEALTH_EVENT_KINDS = {
    LibraryEventKind.OVERFLOW,
    LibraryEventKind.ROOT_UNAVAILABLE,
}
_HEALTH_PROBLEM_STATES = {
    "cross_root_uncertain",
    "overflow",
    "rollback_pending_work",
    "root_unavailable",
    "reconciliation_failed",
    "stable_write_unavailable",
}

_BOOTSTRAP_LIBRARY_SQL = """
with bootstrap_library as (
  select library.libraries.id
  from app.bootstrap_owners
  join library.libraries
    on library.libraries.owner_account_id = app.bootstrap_owners.account_id
   and library.libraries.name = 'Local Library'
   and library.libraries.library_kind = 'local'
  where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
  limit 1
)
"""

_UPSERT_LIBRARY_WATCH_HEALTH_SQL = _BOOTSTRAP_LIBRARY_SQL + """
/* watch_health_upsert */
update library.libraries
set metadata = jsonb_set(
      coalesce(library.libraries.metadata, '{}'::jsonb),
      '{library_watch_health}',
      coalesce(library.libraries.metadata -> 'library_watch_health', '{}'::jsonb)
        || jsonb_build_object(
             %(root_id)s::text,
             jsonb_build_object(
               'state', %(state)s::text,
               'detected_at', %(detected_at_text)s::text,
               'event_id', %(event_id)s::text
             )
           ),
      true
    ),
    updated_at = now()
from bootstrap_library
where library.libraries.id = bootstrap_library.id
  and (
    nullif(
      library.libraries.metadata
        #>> array['library_watch_health', %(root_id)s::text, 'detected_at'],
      ''
    ) is null
    or (
      library.libraries.metadata
        #>> array['library_watch_health', %(root_id)s::text, 'detected_at']
    )::timestamptz <= %(detected_at)s::timestamptz
  );
"""

_LOAD_LIBRARY_WATCH_HEALTH_SQL = _BOOTSTRAP_LIBRARY_SQL + """,
durable_health as (
  select coalesce(
           jsonb_object_agg(
             incident.root_id,
             jsonb_build_object(
               'state', incident.state,
               'detected_at', incident.detected_at,
               'event_id', incident.event_id
             )
           ),
           '{}'::jsonb
         ) as payload
  from library.load_local_watcher_incidents() as incident
)
/* watch_health_load */
select coalesce(
         library.libraries.metadata -> 'library_watch_health', '{}'::jsonb
       ) || durable_health.payload as library_watch_health
from library.libraries
join bootstrap_library on bootstrap_library.id = library.libraries.id
cross join durable_health;
"""


class LibraryRootUnhealthyError(RuntimeError):
    """A destructive publication cannot establish healthy affected roots."""


@contextmanager
def guard_destructive_library_publication(connection, root_ids):
    # Use the publisher's transaction and a fresh statement after its advisory
    # lock. Health upserts/clears update this same row, serializing the decision
    # with other processes until inventory publication commits.
    row = connection.execute(
        _LOAD_LIBRARY_WATCH_HEALTH_SQL.rstrip().rstrip(";")
        + " for update of libraries;"
    ).fetchone()
    payload = _row_value(row, "library_watch_health")
    if not isinstance(payload, Mapping) or any(str(root_id) in payload for root_id in root_ids):
        raise LibraryRootUnhealthyError(WATCH_HEALTH_MESSAGE)
    yield

def opaque_root_key(root_id: object) -> str:
    normalized = str(root_id or "").strip()
    return f"root_{sha256(normalized.encode('utf-8')).hexdigest()[:16]}"


@dataclass(frozen=True, slots=True, init=False)
class LibraryWatchHealthProblem:
    root_id: str
    state: str
    detected_at: str
    incident_id: str
    warning_token: str
    occurrence_count: int
    acknowledged: bool

    def __init__(
        self,
        root_id: str,
        state: str,
        detected_at: str,
        incident_id: str = "",
        warning_token: str = "",
        occurrence_count: int = 1,
        acknowledged: bool = False,
        *,
        event_id: str = "",
    ) -> None:
        identity = str(incident_id or event_id or "").strip()
        object.__setattr__(self, "root_id", str(root_id or "").strip())
        object.__setattr__(self, "state", str(state or "").strip())
        object.__setattr__(self, "detected_at", str(detected_at or "").strip())
        object.__setattr__(self, "incident_id", identity)
        object.__setattr__(self, "warning_token", str(warning_token or "").strip())
        object.__setattr__(self, "occurrence_count", max(1, int(occurrence_count)))
        object.__setattr__(self, "acknowledged", bool(acknowledged))

    @property
    def event_id(self) -> str:
        """Mixed-version alias retained until legacy health is contracted."""

        return self.incident_id

    @property
    def message(self) -> str:
        return WATCH_HEALTH_MESSAGE

    def as_public_dict(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "state": self.state,
            "root_key": opaque_root_key(self.root_id),
            "detected_at": self.detected_at,
            "message": WATCH_HEALTH_MESSAGE,
        }
        if self.warning_token:
            payload.update(
                incident_id=self.incident_id,
                acknowledged=self.acknowledged,
            )
        elif self.incident_id:
            payload["event_id"] = self.incident_id
        return payload


class PostgresLibraryWatchHealthStore:
    """Store one current watcher-health problem per configured root."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def upsert(self, problem: LibraryWatchHealthProblem) -> None:
        with self._connect_to_database() as connection:
            connection.execute(
                _UPSERT_LIBRARY_WATCH_HEALTH_SQL,
                {
                    "root_id": problem.root_id,
                    "state": problem.state,
                    "detected_at": problem.detected_at,
                    "detected_at_text": problem.detected_at,
                    "event_id": problem.event_id,
                },
            )
            _commit_if_supported(connection)

    def load(self) -> list[LibraryWatchHealthProblem]:
        with self._connect_to_database() as connection:
            row = connection.execute(_LOAD_LIBRARY_WATCH_HEALTH_SQL).fetchone()
        payload = _row_value(row, "library_watch_health")
        if not isinstance(payload, Mapping):
            return []
        problems: list[LibraryWatchHealthProblem] = []
        for root_id, value in payload.items():
            if not isinstance(value, Mapping):
                continue
            normalized_root_id = str(root_id or "").strip()
            state = str(value.get("state") or "").strip()
            detected_at = str(value.get("detected_at") or "").strip()
            if normalized_root_id and state and detected_at:
                problems.append(
                    LibraryWatchHealthProblem(
                        root_id=normalized_root_id,
                        state=state,
                        detected_at=detected_at,
                        event_id=str(value.get("event_id") or "").strip(),
                    )
                )
        return sorted(problems, key=lambda problem: problem.root_id)

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for library watcher health."
            )
        return self._connect(self._database_url)


class LibraryWatchHealthService:
    def __init__(
        self,
        store: object,
        *,
        legacy_store: PostgresLibraryWatchHealthStore | None = None,
        library_id: int | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._legacy_store = legacy_store
        self._library_id = library_id
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._pending: dict[str, LibraryWatchHealthProblem] = {}
        self._lock = Lock()
        self._persistence_lock = Lock()

    def configure_mixed_version_read(
        self,
        *,
        legacy_store: PostgresLibraryWatchHealthStore,
        library_id: int,
    ) -> None:
        self._legacy_store = legacy_store
        self._library_id = library_id

    def uses_durable_repository(self, repository: object, library_id: int) -> bool:
        return self._store is repository and self._library_id == library_id

    def record_event(self, event: LibraryEvent) -> bool:
        if event.kind not in _HEALTH_EVENT_KINDS:
            return False
        return self._record(event.root_id, event.kind.value)

    def record_problem(self, problem: object) -> bool:
        """Persist a coordinator failure that means watcher events may be missing."""

        state = str(getattr(problem, "code", "") or "").strip()
        if state not in _HEALTH_PROBLEM_STATES:
            return False
        return self._record(
            getattr(problem, "root_id", None),
            state,
        )

    def _record(self, raw_root_id: object, state: str) -> bool:
        root_id = str(raw_root_id or "").strip()
        if not root_id:
            return False
        problem = LibraryWatchHealthProblem(
            root_id=root_id,
            state=state,
            detected_at=self._now().astimezone(timezone.utc).isoformat(),
            event_id=str(uuid4()),
        )
        with self._lock:
            pending = self._pending.get(root_id)
            if pending is None or pending.detected_at <= problem.detected_at:
                self._pending[root_id] = problem
        # Publish pending health before waiting, so new warnings fail closed
        # while an earlier write or recovery owns the persistence boundary.
        with self._persistence_lock:
            with self._lock:
                if self._pending.get(root_id) is not problem:
                    return True
            self._store.upsert(problem)
            with self._lock:
                if self._pending.get(root_id) is problem:
                    self._pending.pop(root_id, None)
        return True

    def load_problems(self) -> list[LibraryWatchHealthProblem]:
        load_status = getattr(self._store, "load_status", None)
        if callable(load_status):
            if not isinstance(self._library_id, int) or self._library_id < 1:
                raise RuntimeError("durable watcher library scope is unavailable")
            durable = load_status(library_id=self._library_id)
            persisted = {problem.root_id: problem for problem in durable}
            if self._legacy_store is not None:
                for problem in self._legacy_store.load():
                    persisted.setdefault(problem.root_id, problem)
        else:
            persisted = {
                problem.root_id: problem
                for problem in self._store.load()  # type: ignore[attr-defined]
            }
        with self._lock:
            persisted.update(self._pending)
        return sorted(persisted.values(), key=lambda problem: problem.root_id)

    def root_allows_destructive_reconciliation(self, root_id: object) -> bool:
        normalized = str(root_id or "").strip()
        with self._lock:
            if normalized in self._pending:
                return False
        try:
            return all(problem.root_id != normalized for problem in self.load_problems())
        except Exception:
            # A health-store outage must fail closed for destructive changes.
            return False

    @contextmanager
    def publication_guard(self, connection, root_ids):
        roots = tuple(str(root_id) for root_id in root_ids)
        # Keep failed/not-yet-persisted warnings in the same decision as the
        # database check. New local warnings linearize after this publication.
        with self._lock:
            if any(root_id in self._pending for root_id in roots):
                raise LibraryRootUnhealthyError(WATCH_HEALTH_MESSAGE)
            with guard_destructive_library_publication(connection, roots):
                yield

    def complete_repair(
        self,
        *,
        scan_mode: object,
        repair_id: int | None,
        inventory_revision: int,
        claim: object,
        now: datetime,
    ) -> bool:
        if str(scan_mode or "").strip() != "manual_full_rescan" or repair_id is None:
            return False
        return self._store.complete_repair(
            claim=claim,
            repair_id=repair_id,
            inventory_revision=inventory_revision,
            now=now,
        )


def _row_value(row: object, key: str) -> object:
    if isinstance(row, Mapping):
        return row.get(key)
    if row is None:
        return None
    try:
        return row[0]  # type: ignore[index]
    except (IndexError, KeyError, TypeError):
        return None


def _commit_if_supported(connection: Any) -> None:
    commit = getattr(connection, "commit", None)
    if callable(commit):
        commit()


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for library watcher health.")
    return psycopg.connect(database_url, row_factory=dict_row)


__all__ = (
    "LibraryEvent",
    "LibraryEventKind",
    "LibraryWatchHealthProblem",
    "LibraryWatchHealthService",
    "PostgresLibraryWatchHealthStore",
    "WATCH_HEALTH_MESSAGE",
    "opaque_root_key",
)
