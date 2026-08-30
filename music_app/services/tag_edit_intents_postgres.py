from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import nullcontext
from typing import Any
import uuid

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps non-Postgres tooling importable.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_UNFINISHED_STATUSES = frozenset({"prepared", "files_verified", "recovery_failed"})
_TERMINAL_STATUSES = frozenset({"completed", "rolled_back", "reconciled_external"})


class PostgresTagEditIntentRepository:
    """Durable journal for Edit Tags operations that cross file and DB boundaries."""

    def __init__(
        self,
        config: Mapping[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def prepare_intent(
        self,
        *,
        library_root_identity: str,
        changes: list[dict[str, object]],
    ) -> str:
        normalized_changes = _validate_changes(changes)
        intent_id = str(uuid.uuid4())
        params = {
            "intent_id": intent_id,
            "library_root_identity": str(library_root_identity or "").strip(),
            "changes": _jsonb(normalized_changes),
        }
        if not params["library_root_identity"]:
            raise ValueError("Tag edit intent requires a library root identity.")
        with self._connect_to_database() as connection:
            with _transaction(connection):
                row = _first_row(connection.execute(_prepare_intent_sql(), params))
        return str(_row_mapping(row).get("id") or intent_id)

    def mark_files_verified(self, intent_id: str) -> None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _require_updated_intent(
                    connection.execute(
                        _mark_files_verified_sql(),
                        {"intent_id": str(intent_id)},
                    ),
                    intent_id,
                )

    def mark_terminal_in_transaction(
        self,
        connection: Any,
        intent_id: str,
        *,
        status: str,
        last_error: str | None = None,
    ) -> None:
        normalized_status = str(status or "").strip().casefold()
        if normalized_status not in _TERMINAL_STATUSES:
            raise ValueError("Tag edit intent terminal status is invalid.")
        _require_updated_intent(
            connection.execute(
                _mark_terminal_sql(),
                {
                    "intent_id": str(intent_id),
                    "status": normalized_status,
                    "last_error": str(last_error) if last_error else None,
                },
            ),
            intent_id,
        )

    def mark_terminal(
        self,
        intent_id: str,
        *,
        status: str,
        last_error: str | None = None,
    ) -> None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                self.mark_terminal_in_transaction(
                    connection,
                    intent_id,
                    status=status,
                    last_error=last_error,
                )

    def complete_in_transaction(
        self,
        connection: Any,
        intent_id: str,
        *,
        exception_updates: Mapping[str, object] | None = None,
        status: str = "completed",
        last_error: str | None = None,
    ) -> None:
        normalized_updates = {
            str(path or "").strip(): str(value or "").strip()
            for path, value in (exception_updates or {}).items()
            if str(path or "").strip()
        }
        if normalized_updates:
            if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
                raise RuntimeError(
                    "Postgres tag edit intent requires the bootstrap local library context."
                )
            for track_key, exception_type in sorted(normalized_updates.items()):
                connection.execute(
                    _upsert_exception_override_sql(),
                    {
                        "track_key": track_key,
                        "override_payload": _jsonb(
                            {"exception_type": exception_type}
                        ),
                    },
                )
        self.mark_terminal_in_transaction(
            connection,
            intent_id,
            status=status,
            last_error=last_error,
        )

    def complete(
        self,
        intent_id: str,
        *,
        exception_updates: Mapping[str, object] | None = None,
        status: str = "completed",
        last_error: str | None = None,
    ) -> None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                self.complete_in_transaction(
                    connection,
                    intent_id,
                    exception_updates=exception_updates,
                    status=status,
                    last_error=last_error,
                )

    def mark_recovery_failed(self, intent_id: str, error: object) -> None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _require_updated_intent(
                    connection.execute(
                        _mark_recovery_failed_sql(),
                        {
                            "intent_id": str(intent_id),
                            "last_error": str(error),
                        },
                    ),
                    intent_id,
                )

    def load_unfinished_intents(
        self,
        *,
        library_root_identity: str,
    ) -> list[dict[str, object]]:
        normalized_identity = str(library_root_identity or "").strip()
        if not normalized_identity:
            raise ValueError(
                "Tag edit intent recovery requires a library root identity."
            )
        with self._connect_to_database() as connection:
            rows = list(
                connection.execute(
                    _load_unfinished_sql(),
                    {"library_root_identity": normalized_identity},
                ).fetchall()
            )
        return [_intent_from_row(row) for row in rows]

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for tag edit intents."
            )
        return self._connect(self._database_url)


class _FallbackJsonb:
    def __init__(self, value: object) -> None:
        self.obj = value


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for tag edit intents.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    return transaction() if callable(transaction) else nullcontext()


def _jsonb(value: object) -> object:
    return Jsonb(value) if Jsonb is not None else _FallbackJsonb(value)


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    return fetchone() if callable(fetchone) else None


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _validate_changes(changes: list[dict[str, object]]) -> list[dict[str, object]]:
    if not changes:
        raise ValueError("Tag edit intent requires at least one changed path.")
    normalized: list[dict[str, object]] = []
    for raw_change in changes:
        path = str(raw_change.get("path") or "").strip()
        old_values = raw_change.get("old_values")
        requested_values = raw_change.get("requested_values")
        if not path:
            raise ValueError("Tag edit intent requires every changed path.")
        if (
            not isinstance(old_values, Mapping)
            or not isinstance(requested_values, Mapping)
            or not old_values
            or set(old_values) != set(requested_values)
        ):
            raise ValueError(
                "Tag edit intent requires matching old and requested values."
            )
        normalized.append(
            {
                "path": path,
                "old_values": dict(old_values),
                "requested_values": dict(requested_values),
            }
        )
    return normalized


def _intent_from_row(row: object) -> dict[str, object]:
    payload = _row_mapping(row)
    changes = payload.get("changes")
    payload["changes"] = [dict(change) for change in changes] if isinstance(changes, list) else []
    return payload


def _require_updated_intent(cursor: object, intent_id: object) -> None:
    if _first_row(cursor) is None:
        raise RuntimeError(f"Tag edit intent {intent_id!s} was not updated.")


def _prepare_intent_sql() -> str:
    return """
        insert into library.tag_edit_intents (
          id, library_root_identity, status, changes
        ) values (
          %(intent_id)s::uuid, %(library_root_identity)s, 'prepared', %(changes)s::jsonb
        )
        returning id::text as id
    """


def _mark_files_verified_sql() -> str:
    return """
        update library.tag_edit_intents
        set status = 'files_verified', updated_at = now(), last_error = null
        where id = %(intent_id)s::uuid
          and status in ('prepared', 'recovery_failed')
        returning id::text as id
    """


def _mark_terminal_sql() -> str:
    return """
        update library.tag_edit_intents
        set status = %(status)s,
            updated_at = now(),
            completed_at = now(),
            last_error = %(last_error)s
        where id = %(intent_id)s::uuid
          and status in ('prepared', 'files_verified', 'recovery_failed')
        returning id::text as id
    """


def _mark_recovery_failed_sql() -> str:
    return """
        update library.tag_edit_intents
        set status = 'recovery_failed', updated_at = now(), last_error = %(last_error)s
        where id = %(intent_id)s::uuid
          and status in ('prepared', 'files_verified', 'recovery_failed')
        returning id::text as id
    """


def _load_unfinished_sql() -> str:
    return """
        select id::text as id,
               library_root_identity,
               status,
               changes,
               created_at,
               updated_at,
               completed_at,
               last_error
        from library.tag_edit_intents
        where status in ('prepared', 'files_verified', 'recovery_failed')
          and library_root_identity = %(library_root_identity)s
        order by created_at, id
    """


def _bootstrap_context_ready_sql() -> str:
    return """
        select true as ready
        from app.bootstrap_owners
        join library.libraries
          on library.libraries.owner_account_id = app.bootstrap_owners.account_id
         and library.libraries.name = 'Local Library'
         and library.libraries.library_kind = 'local'
        where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
        limit 1
    """


def _upsert_exception_override_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ), track_match as (
          select library.local_tracks.id as track_id
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          where library.local_tracks.track_key = %(track_key)s
          limit 1
        )
        insert into library.exception_overrides (
          library_id, track_id, track_key, override_payload
        )
        select
          bootstrap_context.library_id,
          (select track_id from track_match),
          %(track_key)s,
          %(override_payload)s::jsonb
        from bootstrap_context
        on conflict (library_id, track_key) do update
          set track_id = coalesce(
                excluded.track_id,
                library.exception_overrides.track_id
              ),
              override_payload = library.exception_overrides.override_payload
                || excluded.override_payload,
              updated_at = now()
    """
