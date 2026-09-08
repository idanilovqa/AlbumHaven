"""Persistent, path-free health reporting for library filesystem watchers."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from threading import Lock
from typing import Any

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
    "overflow",
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
               'detected_at', %(detected_at_text)s::text
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

_LOAD_LIBRARY_WATCH_HEALTH_SQL = _BOOTSTRAP_LIBRARY_SQL + """
/* watch_health_load */
select coalesce(
         library.libraries.metadata -> 'library_watch_health',
         '{}'::jsonb
       ) as library_watch_health
from library.libraries
join bootstrap_library on bootstrap_library.id = library.libraries.id;
"""

_CLEAR_LIBRARY_WATCH_HEALTH_SQL = _BOOTSTRAP_LIBRARY_SQL + """
/* watch_health_clear */
update library.libraries
set metadata = jsonb_set(
      coalesce(library.libraries.metadata, '{}'::jsonb),
      '{library_watch_health}',
      coalesce(
        (
          select jsonb_object_agg(health_entry.key, health_entry.value)
          from jsonb_each(
            coalesce(
              library.libraries.metadata -> 'library_watch_health',
              '{}'::jsonb
            )
          ) as health_entry
          where not (
            health_entry.key = any(%(root_ids)s::text[])
            and nullif(health_entry.value ->> 'detected_at', '') is not null
            and (health_entry.value ->> 'detected_at')::timestamptz
              <= %(detected_before)s::timestamptz
          )
        ),
        '{}'::jsonb
      ),
      true
    ),
    updated_at = now()
from bootstrap_library
where library.libraries.id = bootstrap_library.id;
"""


def opaque_root_key(root_id: object) -> str:
    normalized = str(root_id or "").strip()
    return f"root_{sha256(normalized.encode('utf-8')).hexdigest()[:16]}"


@dataclass(frozen=True, slots=True)
class LibraryWatchHealthProblem:
    root_id: str
    state: str
    detected_at: str

    @property
    def message(self) -> str:
        return WATCH_HEALTH_MESSAGE

    def as_public_dict(self) -> dict[str, str]:
        return {
            "state": self.state,
            "root_key": opaque_root_key(self.root_id),
            "detected_at": self.detected_at,
            "message": WATCH_HEALTH_MESSAGE,
        }


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
                    )
                )
        return sorted(problems, key=lambda problem: problem.root_id)

    def clear(
        self,
        root_ids: Iterable[object],
        *,
        detected_before: str,
    ) -> int:
        normalized = list(
            dict.fromkeys(
                root_id
                for value in root_ids
                if (root_id := str(value or "").strip())
            )
        )
        if not normalized:
            return 0
        existing = {
            problem.root_id
            for problem in self.load()
            if problem.detected_at <= detected_before
        }
        with self._connect_to_database() as connection:
            connection.execute(
                _CLEAR_LIBRARY_WATCH_HEALTH_SQL,
                {
                    "root_ids": normalized,
                    "detected_before": detected_before,
                },
            )
            _commit_if_supported(connection)
        return len(existing.intersection(normalized))

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for library watcher health."
            )
        return self._connect(self._database_url)


class LibraryWatchHealthService:
    def __init__(
        self,
        store: PostgresLibraryWatchHealthStore,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._store = store
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._pending: dict[str, LibraryWatchHealthProblem] = {}
        self._lock = Lock()

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
        )
        with self._lock:
            self._pending[root_id] = problem
        self._store.upsert(problem)
        with self._lock:
            if self._pending.get(root_id) is problem:
                self._pending.pop(root_id, None)
        return True

    def load_problems(self) -> list[LibraryWatchHealthProblem]:
        persisted = {problem.root_id: problem for problem in self._store.load()}
        with self._lock:
            persisted.update(self._pending)
        return sorted(persisted.values(), key=lambda problem: problem.root_id)

    def root_allows_destructive_reconciliation(self, root_id: object) -> bool:
        normalized = str(root_id or "").strip()
        with self._lock:
            if normalized in self._pending:
                return False
        try:
            return all(
                problem.root_id != normalized for problem in self._store.load()
            )
        except Exception:
            # A health-store outage must fail closed for destructive changes.
            return False

    def clear_after_scan(
        self,
        *,
        scan_mode: object,
        observed_root_ids: Iterable[object],
        scan_started_at: object | None = None,
    ) -> int:
        if str(scan_mode or "").strip() != "manual_full_rescan":
            return 0
        normalized = {
            root_id
            for value in observed_root_ids
            if (root_id := str(value or "").strip())
        }
        detected_before = _normalized_cutoff(
            scan_started_at,
            fallback=self._now,
        )
        cleared = self._store.clear(
            normalized,
            detected_before=detected_before,
        )
        with self._lock:
            for root_id in normalized:
                problem = self._pending.get(root_id)
                if problem is not None and problem.detected_at <= detected_before:
                    self._pending.pop(root_id, None)
        return cleared


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


def _normalized_cutoff(
    value: object,
    *,
    fallback: Callable[[], datetime],
) -> str:
    if isinstance(value, datetime):
        cutoff = value
    elif isinstance(value, (int, float)):
        cutoff = datetime.fromtimestamp(float(value), timezone.utc)
    elif str(value or "").strip():
        normalized = str(value).strip().replace("Z", "+00:00")
        cutoff = datetime.fromisoformat(normalized)
    else:
        cutoff = fallback()
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    return cutoff.astimezone(timezone.utc).isoformat()


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
