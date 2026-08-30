from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - allows import-time diagnostics without the Postgres driver.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "library_root_settings_runtime"
_ROOT_CATEGORY_KEYS = (
    "main_library_roots",
    "hoarding_library_roots",
    "new_arrivals_roots",
)


def is_library_roots_postgres_available(config: dict[str, object] | None) -> bool:
    if not isinstance(config, dict):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


class PostgresLibraryRootSettingsStore:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._config = config
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_settings(self, *, connection: Any | None = None) -> dict[str, object]:
        from music_app.services.library_roots import (
            empty_library_root_settings,
            normalize_persisted_library_root_settings,
        )

        if connection is None:
            with self._connect_to_database() as owned_connection:
                row = _first_row(
                    owned_connection.execute(_load_library_root_settings_sql())
                )
        else:
            row = _first_row(connection.execute(_load_library_root_settings_sql()))
        if row is None:
            return empty_library_root_settings()
        row_mapping = _row_mapping(row)
        if "settings_payload" not in row_mapping:
            raise ValueError("Postgres library root settings row is missing settings_payload.")
        return normalize_persisted_library_root_settings(row_mapping["settings_payload"])

    def save_settings(self, raw_payload: object) -> dict[str, object]:
        from music_app.services.library_roots import normalize_persisted_library_root_settings

        normalized = normalize_persisted_library_root_settings(raw_payload)
        root_rows = _library_root_rows_from_settings(normalized)
        settings_row = _library_root_settings_row(normalized, root_rows)
        move_policy_rows = _move_policy_rows_from_settings(normalized)
        active_root_paths = [str(row["root_path"]) for row in root_rows]

        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                _execute_returning_required(
                    connection,
                    _upsert_library_root_settings_sql(),
                    (
                        settings_row["layout_mode"],
                        _jsonb(settings_row["root_categories"]),
                        _jsonb(settings_row["settings_payload"]),
                    ),
                    "Postgres library root settings write did not write a row.",
                )
                for row in root_rows:
                    _execute_returning_required(
                        connection,
                        _upsert_library_root_sql(),
                        (
                            row["root_path"],
                            row["root_kind"],
                            _jsonb(row["metadata"]),
                        ),
                        f"Postgres library root write did not write row for {row['root_id']!r}.",
                    )
                connection.execute(_deactivate_removed_library_roots_sql(), (len(active_root_paths), active_root_paths))
                connection.execute(_delete_move_policy_settings_sql())
                for row in move_policy_rows:
                    connection.execute(
                        _upsert_move_policy_setting_sql(),
                        (row["policy_key"], _jsonb(row["policy_payload"])),
                    )
                for row in root_rows:
                    connection.execute(
                        _insert_library_root_provenance_sql(),
                        (
                            row["root_path"],
                            _SOURCE,
                            None,
                            _jsonb(
                                {
                                    "source": _SOURCE,
                                    "source_family": _SOURCE,
                                    "root_id": row["root_id"],
                                    "category": row["root_kind"],
                                    "category_key": row["category_key"],
                                }
                            ),
                        ),
                    )
        return normalized

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres library roots.")
        return self._connect(self._database_url)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres library roots.")
    return psycopg.connect(database_url, row_factory=dict_row)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    return _NoopTransaction()


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object) -> Mapping[str, object]:
    if isinstance(row, Mapping):
        return row
    if isinstance(row, (tuple, list)) and len(row) >= 1:
        return {"settings_payload": row[0]}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _execute_returning_required(connection: Any, sql: str, params: object, message: str) -> None:
    cursor = connection.execute(sql, params)
    if _first_row(cursor) is None:
        raise RuntimeError(message)


def _ensure_bootstrap_context(connection: Any) -> None:
    cursor = connection.execute(_bootstrap_context_ready_sql())
    if _first_row(cursor) is None:
        raise RuntimeError("Postgres library roots require the bootstrap local owner/library context.")


def _library_root_rows_from_settings(settings: dict[str, object]) -> list[dict[str, object]]:
    from music_app.services import library_roots

    rows: list[dict[str, object]] = []
    for category_key in _ROOT_CATEGORY_KEYS:
        roots = settings.get(category_key)
        if not isinstance(roots, list):
            continue
        for root in roots:
            if not isinstance(root, dict):
                continue
            root_id = str(root.get("id") or "").strip()
            root_path = str(root.get("path") or "").strip()
            if not root_id or not root_path:
                continue
            category_slug = library_roots.library_category_slug(category_key)
            metadata = {
                "source": _SOURCE,
                "root_id": root_id,
                "category": category_slug,
                "category_key": category_key,
                "category_label": library_roots.library_category_label(category_slug),
                "badge_label": library_roots.library_category_badge_label(category_slug),
            }
            if "layout_mode" in root:
                metadata["layout_mode"] = root.get("layout_mode")
            rows.append(
                {
                    "root_id": root_id,
                    "root_path": root_path,
                    "root_kind": category_slug,
                    "category_key": category_key,
                    "metadata": metadata,
                }
            )
    return rows


def _library_root_settings_row(
    settings: dict[str, object],
    root_rows: list[dict[str, object]],
) -> dict[str, object]:
    root_categories = {
        str(row.get("root_path")): {
            "root_id": row.get("root_id"),
            "category": row.get("root_kind"),
            "category_key": row.get("category_key"),
        }
        for row in root_rows
    }
    main_roots = settings.get("main_library_roots")
    first_main = main_roots[0] if isinstance(main_roots, list) and main_roots else {}
    layout_mode = "artist"
    if isinstance(first_main, dict):
        layout_mode = str(first_main.get("layout_mode") or "artist")
    return {
        "layout_mode": layout_mode,
        "root_categories": root_categories,
        "settings_payload": {
            **settings,
            "source": _SOURCE,
        },
    }


def _move_policy_rows_from_settings(settings: dict[str, object]) -> list[dict[str, object]]:
    move_policy = settings.get("move_policy")
    if not isinstance(move_policy, dict):
        return []
    rows: list[dict[str, object]] = []
    for key, value in move_policy.items():
        root_id = str(value or "").strip()
        if not key or not root_id:
            continue
        rows.append(
            {
                "policy_key": str(key),
                "policy_payload": {
                    "root_id": root_id,
                    "source": _SOURCE,
                },
            }
        )
    return rows


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


def _load_library_root_settings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select library.library_root_settings.settings_payload
        from library.library_root_settings
        join bootstrap_context
          on bootstrap_context.library_id = library.library_root_settings.library_id
        limit 1;
    """
    )


def _upsert_library_root_settings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into library.library_root_settings (
          library_id,
          layout_mode,
          root_categories,
          settings_payload
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id) do update
          set layout_mode = excluded.layout_mode,
              root_categories = excluded.root_categories,
              settings_payload = excluded.settings_payload,
              updated_at = now()
        returning 1 as saved;
    """
    )


def _upsert_library_root_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into library.library_roots (
          library_id,
          root_path,
          root_kind,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, root_path) do update
          set root_kind = excluded.root_kind,
              is_active = true,
              updated_at = now(),
              metadata = (library.library_roots.metadata - 'deactivated') || excluded.metadata
        returning 1 as saved;
    """
    )


def _deactivate_removed_library_roots_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update library.library_roots
           set is_active = false,
               updated_at = now(),
               metadata = library.library_roots.metadata
                 || '{"source":"library_root_settings_runtime","deactivated":true}'::jsonb
        from bootstrap_context
        where library.library_roots.library_id = bootstrap_context.library_id
          and (
            %s = 0
            or library.library_roots.root_path <> all(%s::text[])
          );
    """
    )


def _delete_move_policy_settings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        delete from library.move_policy_settings
        using bootstrap_context
        where library.move_policy_settings.library_id = bootstrap_context.library_id;
    """
    )


def _upsert_move_policy_setting_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into library.move_policy_settings (
          library_id,
          policy_key,
          policy_payload
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, policy_key) do update
          set policy_payload = excluded.policy_payload,
              updated_at = now();
    """
    )


def _insert_library_root_provenance_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , root_match as (
          select library.library_roots.id as library_root_id
          from library.library_roots
          join bootstrap_context on bootstrap_context.library_id = library.library_roots.library_id
          where library.library_roots.root_path = %s
          limit 1
        ),
        proposed_provenance as (
          select
            root_match.library_root_id,
            %s as source_family,
            %s as source_path,
            %s::jsonb as source_payload
          from root_match
        )
        insert into library.library_root_provenance (
          library_root_id,
          source_family,
          source_path,
          source_payload
        )
        select
          proposed_provenance.library_root_id,
          proposed_provenance.source_family,
          proposed_provenance.source_path,
          proposed_provenance.source_payload
        from proposed_provenance
        where not exists (
          select 1
          from library.library_root_provenance existing
          where existing.library_root_id = proposed_provenance.library_root_id
            and existing.source_family = proposed_provenance.source_family
            and existing.source_path is not distinct from proposed_provenance.source_path
            and existing.source_payload = proposed_provenance.source_payload
        );
    """
    )
