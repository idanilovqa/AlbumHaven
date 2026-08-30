from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any

from music_app.services.metadata import normalize_exception_value

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - allows import-time diagnostics without the Postgres driver.
    psycopg = None
    dict_row = None
    Jsonb = None


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
        return _normalized_key_set(
            self._load_rows(_load_key_table_sql("ignored_repairs", "repair_key")),
            "repair_key",
            tuple_index=0,
        )

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
    ) -> None:
        normalized = _normalize_keys(ignored_repair_keys)
        normalized_album_keys = {
            repair_key: album_key
            for raw_repair_key, raw_album_key in (album_keys_by_repair_key or {}).items()
            if (repair_key := _text(raw_repair_key)) in normalized
            and (album_key := _text(raw_album_key))
        }
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                for repair_key in sorted(normalized):
                    album_key = normalized_album_keys.get(repair_key)
                    connection.execute(
                        _upsert_ignored_repair_sql(
                            include_album_key=album_key is not None,
                        ),
                        (repair_key, album_key) if album_key is not None else (repair_key,),
                    )
                connection.execute(
                    _delete_ignored_repairs_except_sql(),
                    (sorted(normalized),),
                )

    def upsert_ignored_repair_keys(
        self,
        ignored_repair_keys: Iterable[object],
        *,
        album_keys_by_repair_key: Mapping[object, object] | None = None,
        remove_repair_keys: Iterable[object] = (),
    ) -> None:
        normalized = _normalize_keys(ignored_repair_keys)
        removals = _normalize_keys(remove_repair_keys).difference(normalized)
        if not normalized and not removals:
            return
        normalized_album_keys = {
            repair_key: album_key
            for raw_repair_key, raw_album_key in (album_keys_by_repair_key or {}).items()
            if (repair_key := _text(raw_repair_key)) in normalized
            and (album_key := _text(raw_album_key))
        }
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                if removals:
                    connection.execute(
                        _delete_selected_ignored_repairs_sql(),
                        (sorted(removals),),
                    )
                for repair_key in sorted(normalized):
                    album_key = normalized_album_keys.get(repair_key)
                    connection.execute(
                        _upsert_ignored_repair_sql(
                            include_album_key=album_key is not None,
                        ),
                        (repair_key, album_key) if album_key is not None else (repair_key,),
                    )

    def delete_ignored_repair_keys(self, ignored_repair_keys: Iterable[object]) -> None:
        normalized = _normalize_keys(ignored_repair_keys)
        if not normalized:
            return
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                connection.execute(
                    _delete_selected_ignored_repairs_sql(),
                    (sorted(normalized),),
                )

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
                for track_key, exception_type in sorted(normalized.items()):
                    connection.execute(
                        _upsert_exception_override_sql(),
                        (track_key, _jsonb({"exception_type": exception_type})),
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
                for track_key, exception_type in sorted(normalized.items()):
                    connection.execute(
                        _upsert_exception_override_sql(),
                        (track_key, _jsonb({"exception_type": exception_type})),
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
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres rule state.")
    return psycopg.connect(database_url, row_factory=dict_row)


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


def _normalize_exception_overrides(values: Mapping[object, object] | None) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for track_key, exception_value in (values or {}).items():
        normalized_track_key = _text(track_key)
        if normalized_track_key:
            normalized[normalized_track_key] = normalize_exception_value(exception_value)
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
