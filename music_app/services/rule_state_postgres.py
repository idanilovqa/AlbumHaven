from __future__ import annotations

import logging
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from music_app.services.metadata import normalize_exception_value
from music_app.services.postgres_connections import leased_connection as _leased_connection

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.errors import LockNotAvailable as _LockNotAvailable
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - allows import-time diagnostics without the Postgres driver.
    psycopg = None
    Jsonb = None

    class _LockNotAvailable(Exception):
        pass


_LOGGER = logging.getLogger(__name__)
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_rule_state_adapter"


def is_rule_state_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class RuleStatePostgresAdapter:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_ignored_version_keys(self) -> set[str]:
        return _normalized_key_set(
            self._load_rows(_load_key_table_sql("ignored_versions", "version_key")),
            "version_key",
            tuple_index=0,
        )

    def save_ignored_version_keys(self, ignored_version_keys: Iterable[object]) -> None:
        normalized = _normalize_keys(ignored_version_keys)
        self._replace_key_table_rows("ignored_versions", "version_key", normalized)

    def load_ignored_repair_keys(self) -> set[str]:
        """The stored ignored repairs with the pending intents laid over them, read in one statement (one
        snapshot): a reload shows an Ignore that a publication still holds back."""
        stored: set[str] = set()
        intents: list[Mapping[str, object]] = []
        for row in self._load_rows(_load_ignored_repairs_with_intents_sql()):
            intent = _row_mapping(row, _INTENT_FIELDS)
            if intent.get("id") is None:
                stored |= _normalize_keys(intent.get("repair_keys"))
            else:
                intents.append(intent)
        return PendingIgnoredRepairs.fold(intents).apply(stored)

    def load_complete_legacy_album_exclusion_groups(self) -> list[dict[str, object]]:
        groups: list[dict[str, object]] = []
        for row in self._load_rows(_complete_legacy_album_exclusion_groups_sql()):
            payload = _row_mapping(
                row,
                ("album_key", "album_title", "legacy_repair_keys"),
            )
            album_key = _text(payload.get("album_key"))
            album_title = str(payload.get("album_title") or "")
            legacy_repair_keys = sorted(_normalize_keys(payload.get("legacy_repair_keys")))
            if album_key and legacy_repair_keys:
                groups.append(
                    {
                        "album_key": album_key,
                        "album_title": album_title,
                        "legacy_repair_keys": legacy_repair_keys,
                    }
                )
        return groups

    def save_ignored_repair_keys(
        self,
        ignored_repair_keys: Iterable[object],
        *,
        album_keys_by_repair_key: Mapping[object, object] | None = None,
    ) -> str:
        normalized = _normalize_keys(ignored_repair_keys)
        return self._write_ignored_repairs(
            "replace", normalized, _album_keys_for(normalized, album_keys_by_repair_key), set())

    def upsert_ignored_repair_keys(
        self,
        ignored_repair_keys: Iterable[object],
        *,
        album_keys_by_repair_key: Mapping[object, object] | None = None,
        remove_repair_keys: Iterable[object] = (),
    ) -> str:
        normalized = _normalize_keys(ignored_repair_keys)
        removals = _normalize_keys(remove_repair_keys).difference(normalized)
        if not normalized and not removals:
            return "applied"
        return self._write_ignored_repairs(
            "upsert", normalized, _album_keys_for(normalized, album_keys_by_repair_key), removals)

    def delete_ignored_repair_keys(self, ignored_repair_keys: Iterable[object]) -> str:
        normalized = _normalize_keys(ignored_repair_keys)
        if not normalized:
            return "applied"
        return self._write_ignored_repairs("delete", normalized, {}, set())

    def _write_ignored_repairs(
        self, action: str, repair_keys: set[str], album_keys: dict[str, str], remove_keys: set[str],
    ) -> str:
        """"applied", or "pending" when a publication holds the inventory lock past the bound.

        An ignored repair marks every album it names (0266's trigger); a save or scan marks its albums
        under the inventory publication lock, so a write takes that lock before any row (deadlock part 3).
        It never waits longer than PUBLICATION_WAIT_MS (6.5: no unbounded wait on a request): past it, the
        write keeps a durable intent that every read already shows, and the drain applies it after the
        publication, in order (ignored_repair_intents)."""
        intent = {"action": action, "repair_keys": sorted(repair_keys), "album_keys": album_keys,
                  "remove_keys": sorted(remove_keys)}
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(f"set local lock_timeout = '{PUBLICATION_WAIT_MS}ms'")
                try:
                    with _transaction(connection):
                        connection.execute(_inventory_publication_lock_sql())
                        # Intents kept earlier come first: a write never overtakes an older one.
                        apply_pending_ignored_repair_intents(connection)
                        _apply_ignored_repair_intent(connection, intent)
                        # The same rules written again: their earlier failure is no longer news.
                        connection.execute(
                            """delete from library.ignored_repair_intents
                               where failed_at is not null and repair_keys && %s::text[]""",
                            (sorted(repair_keys | remove_keys),),
                        )
                    return "applied"
                except _LockNotAvailable:
                    connection.execute(
                        _insert_ignored_repair_intent_sql(),
                        (action, intent["repair_keys"], _jsonb(album_keys), intent["remove_keys"],
                         sorted({identity for key in [*repair_keys, *remove_keys]
                                 for identity in (ignored_repair_identity(key), album_keys.get(key, "")) if identity})),
                    )
                    return "pending"

    def load_manual_version_links(self) -> dict[str, str]:
        links: dict[str, str] = {}
        for row in self._load_rows(_load_manual_versions_sql()):
            row_payload = _row_mapping(row, ("child_key", "parent_key"))
            child = _text(row_payload.get("child_key"))
            parent = _text(row_payload.get("parent_key"))
            if child and parent and child != parent:
                links[child] = parent
        return links

    def save_manual_version_links(self, manual_version_links: Mapping[object, object] | None) -> None:
        normalized = _normalize_manual_version_links(manual_version_links)
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_delete_table_rows_sql("manual_versions"))
                for child_key, parent_key in sorted(normalized.items()):
                    connection.execute(_insert_manual_version_sql(), (child_key, parent_key))

    def load_separate_release_keys(self) -> set[str]:
        return _normalized_key_set(
            self._load_rows(_load_key_table_sql("separate_releases", "release_key")),
            "release_key",
            tuple_index=0,
        )

    def save_separate_release_keys(self, separate_release_keys: Iterable[object]) -> None:
        normalized = _normalize_keys(separate_release_keys)
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                for release_key in sorted(normalized):
                    connection.execute(
                        _upsert_separate_release_sql(),
                        (release_key,),
                    )
                connection.execute(
                    _delete_separate_releases_except_sql(),
                    (sorted(normalized),),
                )

    def load_exception_overrides(self) -> dict[str, str]:
        overrides: dict[str, str] = {}
        for row in self._load_rows(_load_exception_overrides_sql()):
            row_payload = _row_mapping(row, ("track_key", "override_payload", "exception_type"))
            track_key = _text(row_payload.get("track_key"))
            if not track_key:
                continue
            overrides[track_key] = _exception_type_from_payload(row_payload)
        return overrides

    def save_exception_overrides(self, overrides: Mapping[object, object] | None) -> None:
        normalized = _normalize_exception_overrides(overrides)
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                if not normalized:
                    connection.execute(_delete_table_rows_sql("exception_overrides"))
                    return
                for track_key, override_payload in sorted(normalized.items()):
                    connection.execute(
                        _upsert_exception_override_sql(),
                        (track_key, _jsonb(override_payload)),
                    )
                connection.execute(
                    _delete_exception_overrides_except_sql(),
                    (len(normalized), sorted(normalized)),
                )

    def upsert_exception_overrides(
        self,
        overrides: Mapping[object, object] | None,
    ) -> None:
        normalized = _normalize_exception_overrides(overrides)
        if not normalized:
            return
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                for track_key, override_payload in sorted(normalized.items()):
                    connection.execute(
                        _upsert_exception_override_sql(),
                        (track_key, _jsonb(override_payload)),
                    )

    def _load_rows(self, sql: str) -> list[object]:
        with self._connect_to_database() as connection:
            _ensure_bootstrap_context(connection)
            return list(connection.execute(sql).fetchall())

    def _replace_key_table_rows(self, table_name: str, key_column: str, keys: set[str]) -> None:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(_delete_table_rows_sql(table_name))
                for key in sorted(keys):
                    connection.execute(_insert_key_table_sql(table_name, key_column), (key,))

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres rule state.")
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    return _leased_connection(database_url)


# The longest an ignored-repair write waits for a held publication before it keeps an intent instead. The
# request answers well inside a second either way (6.5, deadlock part 3).
PUBLICATION_WAIT_MS = 500
_INTENT_FIELDS = ("id", "action", "repair_keys", "album_keys", "remove_keys")


def _inventory_publication_lock_sql() -> str:
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

    return inventory_publication_advisory_lock_sql()


@dataclass(frozen=True)
class PendingIgnoredRepairs:
    """The kept intents folded in order into one change to the stored ignored repairs: whether the stored
    keys still count (a pending replacing write drops them), the keys removed, and the keys added with the
    album each names ("" for a file's key). Reads lay it over what they load (6.5: overlay at read time)."""

    keeps_stored: bool = True
    removed: frozenset[str] = frozenset()
    added: Mapping[str, str] = field(default_factory=dict)

    def __bool__(self) -> bool:
        return not self.keeps_stored or bool(self.removed) or bool(self.added)

    def apply(self, stored: Iterable[object]) -> set[str]:
        keys = _normalize_keys(stored) if self.keeps_stored else set()
        return keys.difference(self.removed) | set(self.added)

    @classmethod
    def fold(cls, intents: Iterable[Mapping[str, object]]) -> "PendingIgnoredRepairs":
        keeps_stored, removed, added = True, set(), {}
        for intent in intents:
            repair_keys = _normalize_keys(intent.get("repair_keys"))
            album_keys = {_text(key): _text(value) for key, value in dict(intent.get("album_keys") or {}).items()}
            action = intent.get("action")
            if action == "replace":
                keeps_stored, removed, added = False, set(), {key: album_keys.get(key, "") for key in repair_keys}
                continue
            dropped = repair_keys if action == "delete" else _normalize_keys(intent.get("remove_keys"))
            for key in dropped:
                added.pop(key, None)
                removed.add(key)
            if action != "delete":
                for key in repair_keys:
                    removed.discard(key)
                    added[key] = album_keys.get(key, "")
        return cls(keeps_stored, frozenset(removed), added)


def pending_ignored_repairs(connection: Any, identities: Iterable[object] | None = None) -> PendingIgnoredRepairs:
    """The kept intents, folded, in one indexed read of a table that is empty unless a publication held an
    Ignore back. With ``identities`` (the albums and files a read shows), only the intents that name one of
    them, and any pending replacement of every rule: the rest cannot change those rows (6.5, 11-24)."""
    if identities is None:
        rows = connection.execute(_load_ignored_repair_intents_sql()).fetchall()
    else:
        rows = connection.execute(
            _load_scoped_ignored_repair_intents_sql(), {"identities": sorted(_normalize_keys(identities))},
        ).fetchall()
    return PendingIgnoredRepairs.fold(_row_mapping(row, _INTENT_FIELDS) for row in rows)


def ignored_repair_intents_with_failures(connection: Any) -> tuple[PendingIgnoredRepairs, list[dict[str, object]]]:
    """Every intent in one read: the pending ones folded, and each failed one's rules, for the Rules list."""
    pending, failed = [], []
    for row in connection.execute(_load_ignored_repair_intents_sql(include_failed=True)).fetchall():
        intent = _row_mapping(row, _INTENT_FIELDS + ("failed_at", "failure"))
        if intent.get("failed_at") is None:
            pending.append(intent)
            continue
        failed.extend(
            {"row_key": key, "action": intent.get("action"), "failure": str(intent.get("failure") or ""),
             "failed_at": intent.get("failed_at")}
            for key in sorted(_normalize_keys(intent.get("repair_keys")))
        )
    return PendingIgnoredRepairs.fold(pending), failed


def ignored_repair_identity(repair_key: str) -> str:
    """What a rule names, as the problem reads match it: an album rule's album (before "::problem-album::"),
    a file rule's file (before "::problem-file::", or before the last "::" for an older field rule)."""
    for marker in ("::problem-album::", "::problem-file::"):
        if marker in repair_key:
            return repair_key.rsplit(marker, 1)[0]
    return repair_key.rsplit("::", 1)[0]


def apply_pending_ignored_repair_intents(connection: Any) -> int:
    """Apply and drop every kept ignored-repair intent, oldest first. The caller holds the inventory
    publication lock in this transaction, so no intent is applied twice or out of order. Each applies in its
    own savepoint: one that cannot be applied is failed and logged, and the others still apply (6.5)."""
    rows = [_row_mapping(row, _INTENT_FIELDS) for row in connection.execute(
        _load_ignored_repair_intents_sql().rstrip() + " for update of intents").fetchall()]
    applied = []
    for intent in rows:
        try:
            with _transaction(connection):
                _apply_ignored_repair_intent(connection, intent)
        except Exception as error:  # this intent alone: the rest of the drain goes on
            _LOGGER.warning("An ignored-repair intent failed and was not applied (rules %s): %s",
                            ", ".join(sorted(_normalize_keys(intent.get("repair_keys")))), error)
            connection.execute(_fail_ignored_repair_intents_sql(), (str(error)[:500], [int(intent["id"])]))
            continue
        applied.append(int(intent["id"]))
    if applied:
        connection.execute("delete from library.ignored_repair_intents where id = any(%s::bigint[])", (applied,))
    return len(applied)


def fail_ignored_repair_intents_after_a_failed_drain(connection: Any, error: object, attempts: int) -> list[str]:
    """A drain pass that failed as a whole counts one attempt on every pending intent; those that have had
    ``attempts`` are failed, so nothing stays pending forever. Returns the failed intents' rules."""
    with _transaction(connection):
        connection.execute(
            "update library.ignored_repair_intents set drain_attempts = drain_attempts + 1 where failed_at is null")
        rows = connection.execute(
            """update library.ignored_repair_intents
               set failed_at = now(), failure = %s
               where failed_at is null and drain_attempts >= %s
               returning repair_keys""",
            (f"Not applied after {attempts} attempts: {error}"[:500], attempts),
        ).fetchall()
    return sorted({key for row in rows for key in _normalize_keys(_row_mapping(row, ("repair_keys",)).get("repair_keys"))})


def _apply_ignored_repair_intent(connection: Any, intent: Mapping[str, object]) -> None:
    action = intent.get("action")
    repair_keys = sorted(_normalize_keys(intent.get("repair_keys")))
    album_keys = {_text(key): _text(value) for key, value in dict(intent.get("album_keys") or {}).items()}
    if action == "delete":
        connection.execute(_delete_selected_ignored_repairs_sql(), (repair_keys,))
        return
    removals = sorted(_normalize_keys(intent.get("remove_keys")))
    if action == "upsert" and removals:
        connection.execute(_delete_selected_ignored_repairs_sql(), (removals,))
    for repair_key in repair_keys:
        album_key = album_keys.get(repair_key) or None
        connection.execute(
            _upsert_ignored_repair_sql(include_album_key=album_key is not None),
            (repair_key, album_key) if album_key is not None else (repair_key,),
        )
    if action == "replace":
        connection.execute(_delete_ignored_repairs_except_sql(), (repair_keys,))


def _fail_ignored_repair_intents_sql() -> str:
    return "update library.ignored_repair_intents set failed_at = now(), failure = %s where id = any(%s::bigint[])"


def _album_keys_for(repair_keys: set[str], album_keys_by_repair_key: Mapping[object, object] | None) -> dict[str, str]:
    return {
        repair_key: album_key
        for raw_repair_key, raw_album_key in (album_keys_by_repair_key or {}).items()
        if (repair_key := _text(raw_repair_key)) in repair_keys
        and (album_key := _text(raw_album_key))
    }


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    return _NoopTransaction()


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object, tuple_fields: tuple[str, ...]) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        return {
            field_name: row[index]
            for index, field_name in enumerate(tuple_fields)
            if index < len(row)
        }
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError("Postgres rule state requires the bootstrap local owner/library context.")


def _text(value: object) -> str:
    return str(value or "").strip()


def _normalize_keys(values: Iterable[object] | None) -> set[str]:
    if values is None:
        return set()
    return {_text(value) for value in values if _text(value)}


def _normalized_key_set(rows: Iterable[object], key_name: str, *, tuple_index: int) -> set[str]:
    normalized: set[str] = set()
    for row in rows:
        row_payload = _row_mapping(row, (key_name,))
        if isinstance(row, (tuple, list)) and tuple_index < len(row):
            value = row[tuple_index]
        else:
            value = row_payload.get(key_name)
        key = _text(value)
        if key:
            normalized.add(key)
    return normalized


def _normalize_manual_version_links(values: Mapping[object, object] | None) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for child_key, parent_key in (values or {}).items():
        child = _text(child_key)
        parent = _text(parent_key)
        if child and parent and child != parent:
            normalized[child] = parent
    return normalized


def _exception_type_from_payload(row_payload: Mapping[str, object]) -> str:
    payload = row_payload.get("override_payload")
    if isinstance(payload, Mapping):
        exception_type = normalize_exception_value(payload.get("exception_type"))
        if exception_type or "exception_type" in payload:
            return exception_type
        return normalize_exception_value(row_payload.get("exception_type"))
    fallback = payload if payload is not None else row_payload.get("exception_type")
    return normalize_exception_value(fallback)


def _normalize_exception_overrides(
    values: Mapping[object, object] | None,
) -> dict[str, dict[str, str]]:
    normalized: dict[str, dict[str, str]] = {}
    for track_key, exception_value in (values or {}).items():
        normalized_track_key = _text(track_key)
        if normalized_track_key:
            if isinstance(exception_value, Mapping):
                exception_type = normalize_exception_value(
                    exception_value.get("exception_type")
                )
                custom_collection_name = _text(
                    exception_value.get("custom_collection_name")
                )
                normalized_payload = {
                    "exception_type": exception_type,
                    "custom_collection_name": (
                        custom_collection_name
                        if exception_type == "Custom Collection"
                        else ""
                    ),
                }
            else:
                exception_type = normalize_exception_value(exception_value)
                normalized_payload = {"exception_type": exception_type}
            normalized[normalized_track_key] = normalized_payload
    return normalized


def _bootstrap_context_sql() -> str:
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
        )
    """


def _bootstrap_context_ready_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select 1 as bootstrap_context_ready
        from bootstrap_context;
    """
    )


def _load_key_table_sql(table_name: str, key_column: str) -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select library.{table_name}.{key_column}
        from library.{table_name}
        join bootstrap_context
          on bootstrap_context.library_id = library.{table_name}.library_id
        order by library.{table_name}.{key_column};
    """
    )


def _load_manual_versions_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          library.manual_versions.child_key,
          library.manual_versions.parent_key
        from library.manual_versions
        join bootstrap_context
          on bootstrap_context.library_id = library.manual_versions.library_id
        order by library.manual_versions.child_key;
    """
    )


def _load_exception_overrides_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          library.exception_overrides.track_key,
          library.exception_overrides.override_payload,
          library.exception_overrides.override_payload ->> 'exception_type' as exception_type
        from library.exception_overrides
        join bootstrap_context
          on bootstrap_context.library_id = library.exception_overrides.library_id
        order by library.exception_overrides.track_key;
    """
    )


def _delete_table_rows_sql(table_name: str) -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        delete from library.{table_name}
        using bootstrap_context
        where library.{table_name}.library_id = bootstrap_context.library_id;
    """
    )


def _insert_key_table_sql(table_name: str, key_column: str) -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        insert into library.{table_name} (library_id, {key_column}, metadata)
        select
          bootstrap_context.library_id,
          %s,
          '{{"source":"{_SOURCE}"}}'::jsonb
        from bootstrap_context;
    """
    )


def _complete_legacy_album_exclusion_groups_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , active_album_files as (
          select
            bootstrap_context.library_id,
            library.local_albums.id as album_id,
            library.local_albums.album_key,
            library.local_albums.title as album_title,
            library.local_track_files.private_path
          from bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
          join library.local_tracks
            on library.local_tracks.library_id = bootstrap_context.library_id
           and library.local_tracks.album_id = library.local_albums.id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
           and library.local_track_files.scan_file_entry_is_object is true
        ), active_album_file_counts as (
          select
            active_album_files.album_id,
            count(distinct active_album_files.private_path) as active_file_count
          from active_album_files
          group by active_album_files.album_id
        ), legacy_rows as (
          select
            active_album_files.album_id,
            active_album_files.album_key,
            active_album_files.album_title,
            active_album_files.private_path,
            library.ignored_repairs.repair_key
          from library.ignored_repairs
          join active_album_files
            on active_album_files.library_id = library.ignored_repairs.library_id
           and library.ignored_repairs.repair_key = active_album_files.private_path || '::album'
        )
        select
          legacy_rows.album_key,
          legacy_rows.album_title,
          array_agg(legacy_rows.repair_key order by legacy_rows.repair_key) as legacy_repair_keys
        from legacy_rows
        join active_album_file_counts
          on active_album_file_counts.album_id = legacy_rows.album_id
        group by
          legacy_rows.album_id,
          legacy_rows.album_key,
          legacy_rows.album_title,
          active_album_file_counts.active_file_count
        having count(distinct legacy_rows.private_path) = active_album_file_counts.active_file_count
        order by legacy_rows.album_key;
    """
    )


def _upsert_ignored_repair_sql(*, include_album_key: bool) -> str:
    metadata_sql = f"'{{\"source\":\"{_SOURCE}\"}}'::jsonb"
    if include_album_key:
        metadata_sql += " || jsonb_build_object('album_key', %s::text)"
    return (
        _bootstrap_context_sql()
        + f"""
        insert into library.ignored_repairs (library_id, repair_key, metadata)
        select
          bootstrap_context.library_id,
          %s,
          {metadata_sql}
        from bootstrap_context
        on conflict (library_id, repair_key) do update
          set metadata = coalesce(library.ignored_repairs.metadata, '{{}}'::jsonb)
                         || excluded.metadata;
    """
    )


def _load_ignored_repair_intents_sql(*, include_failed: bool = False) -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        select intents.id, intents.action, intents.repair_keys, intents.album_keys, intents.remove_keys,
               intents.failed_at, intents.failure
        from library.ignored_repair_intents intents
        join bootstrap_context on intents.library_id = bootstrap_context.library_id
        {"" if include_failed else "where intents.failed_at is null"}
        order by intents.id
    """
    )


def _load_scoped_ignored_repair_intents_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select intents.id, intents.action, intents.repair_keys, intents.album_keys, intents.remove_keys
        from library.ignored_repair_intents intents
        join bootstrap_context on intents.library_id = bootstrap_context.library_id
        where intents.failed_at is null
          and (intents.scope_identities && %(identities)s::text[] or intents.action = 'replace')
        order by intents.id
    """
    )


def _load_ignored_repairs_with_intents_sql() -> str:
    """Each stored ignored repair as an upsert of itself, then the pending intents, oldest first."""
    return (
        _bootstrap_context_sql()
        + """
        select null::bigint as id, 'upsert' as action, array[ignored.repair_key] as repair_keys,
               '{}'::jsonb as album_keys, '{}'::text[] as remove_keys
        from library.ignored_repairs ignored
        join bootstrap_context on ignored.library_id = bootstrap_context.library_id
        union all
        select intents.id, intents.action, intents.repair_keys, intents.album_keys, intents.remove_keys
        from library.ignored_repair_intents intents
        join bootstrap_context on intents.library_id = bootstrap_context.library_id
        where intents.failed_at is null
        order by id nulls first
    """
    )


def _insert_ignored_repair_intent_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into library.ignored_repair_intents
          (library_id, action, repair_keys, album_keys, remove_keys, scope_identities)
        select bootstrap_context.library_id, %s, %s::text[], %s, %s::text[], %s::text[]
        from bootstrap_context;
    """
    )


def _delete_ignored_repairs_except_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        delete from library.ignored_repairs
        using bootstrap_context
        where library.ignored_repairs.library_id = bootstrap_context.library_id
          and not (
            library.ignored_repairs.repair_key = any(%s::text[])
          );
    """
    )


def _delete_selected_ignored_repairs_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        delete from library.ignored_repairs
        using bootstrap_context
        where library.ignored_repairs.library_id = bootstrap_context.library_id
          and library.ignored_repairs.repair_key = any(%s::text[]);
    """
    )


def _upsert_separate_release_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        insert into library.separate_releases (
          library_id,
          release_key,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          '{{"source":"{_SOURCE}"}}'::jsonb
        from bootstrap_context
        on conflict (library_id, release_key) do nothing;
    """
    )


def _delete_separate_releases_except_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        delete from library.separate_releases
        using bootstrap_context
        where library.separate_releases.library_id =
              bootstrap_context.library_id
          and not (
            library.separate_releases.release_key = any(%s::text[])
          );
    """
    )


def _insert_manual_version_sql() -> str:
    return (
        _bootstrap_context_sql()
        + f"""
        insert into library.manual_versions (library_id, child_key, parent_key, metadata)
        select
          bootstrap_context.library_id,
          %s,
          %s,
          '{{"source":"{_SOURCE}"}}'::jsonb
        from bootstrap_context;
    """
    )


def _upsert_exception_override_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , input_row as (
          select
            %s as track_key,
            %s::jsonb as override_payload
        ),
        track_match as (
          select library.local_tracks.id as track_id
          from library.local_tracks
          join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
          join input_row on input_row.track_key = library.local_tracks.track_key
          limit 1
        )
        insert into library.exception_overrides (library_id, track_id, track_key, override_payload)
        select
          bootstrap_context.library_id,
          (select track_id from track_match),
          input_row.track_key,
          input_row.override_payload
        from bootstrap_context
        cross join input_row
        on conflict (library_id, track_key) do update
          set track_id = coalesce(excluded.track_id, library.exception_overrides.track_id),
              override_payload = library.exception_overrides.override_payload || excluded.override_payload,
              updated_at = now();
    """
    )


def _delete_exception_overrides_except_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        delete from library.exception_overrides
        using bootstrap_context
        where library.exception_overrides.library_id = bootstrap_context.library_id
          and (
            %s = 0
            or library.exception_overrides.track_key <> all(%s::text[])
          );
    """
    )
