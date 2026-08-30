from __future__ import annotations

import argparse
import re
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

import psycopg
from psycopg import sql


CHECKPOINT_SCHEMA = "ci_functional_checkpoint"
APPLICATION_SCHEMAS = ("app", "integration", "library", "ops")
MIGRATION_OWNED_TABLES = frozenset(
    {
        ("app", "client_surface_classes"),
        ("app", "deployment_mode_rules"),
        ("app", "e2e_problematic_file_fixture_seeds"),
        ("ops", "schema_migrations"),
    }
)


def validate_database_url(database_url: str) -> str:
    parsed = urlparse(database_url)
    if parsed.scheme not in {"postgresql", "postgres"}:
        raise ValueError("database URL scheme must be postgresql")
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("database URL must use a loopback host")
    if parsed.query or parsed.params or parsed.fragment:
        raise ValueError("database URL parameters are forbidden")
    database_name = unquote((parsed.path or "").lstrip("/"))
    if database_name == "album_haven_core":
        raise ValueError("database album_haven_core is forbidden")
    if not database_name.startswith("album_haven_ci_") or not database_name[15:]:
        raise ValueError("database name must use the album_haven_ci_ suffix contract")
    suffix = database_name.removeprefix("album_haven_ci_")
    if re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*", suffix) is None:
        raise ValueError("database name must use a strict CI suffix")
    username = unquote(parsed.username or "")
    if username != f"album_haven_migrator_{suffix}":
        raise ValueError("database URL must use the matching suffixed migrator role")
    if parsed.password is not None:
        raise ValueError("database URL must use pgpass instead of an embedded password")
    return database_url


def validate_connected_identity(connection: Any, database_url: str) -> None:
    parsed = urlparse(database_url)
    expected_database = unquote((parsed.path or "").lstrip("/"))
    expected_role = unquote(parsed.username or "")
    row = connection.execute("select current_database(), current_user").fetchone()
    if row is None or str(row[0]) != expected_database or str(row[1]) != expected_role:
        raise ValueError("connected database identity does not match checkpoint URL")


def owned_application_tables(connection: Any) -> tuple[tuple[str, str], ...]:
    rows = connection.execute(
        """
        select schemaname, tablename
        from pg_catalog.pg_tables
        where schemaname = any(%s)
        order by schemaname, tablename
        """,
        (list(APPLICATION_SCHEMAS),),
    ).fetchall()
    tables = tuple(
        (str(row[0]), str(row[1]))
        for row in rows
        if (str(row[0]), str(row[1])) not in MIGRATION_OWNED_TABLES
    )
    if not tables:
        raise ValueError("functional checkpoint requires application tables")
    return tables


def _checkpoint_table_name(table: tuple[str, str]) -> str:
    schema_name, table_name = table
    return f"{schema_name}__{table_name}"


def create_checkpoint_schema(connection: Any) -> None:
    connection.execute(
        sql.SQL("drop schema if exists {} cascade").format(sql.Identifier(CHECKPOINT_SCHEMA))
    )
    connection.execute(sql.SQL("create schema {}").format(sql.Identifier(CHECKPOINT_SCHEMA)))
    connection.execute(
        sql.SQL(
            "create table {}.inventory ("
            "schema_name text not null, table_name text not null, row_count bigint not null, "
            "primary key (schema_name, table_name))"
        ).format(sql.Identifier(CHECKPOINT_SCHEMA))
    )
    connection.execute(
        sql.SQL(
            "create table {}.sequence_state ("
            "sequence_schema text not null, sequence_name text not null, "
            "last_value bigint not null, is_called boolean not null, "
            "primary key (sequence_schema, sequence_name))"
        ).format(sql.Identifier(CHECKPOINT_SCHEMA))
    )


def capture_table(connection: Any, table: tuple[str, str]) -> None:
    schema_name, table_name = table
    connection.execute(
        sql.SQL("create table {}.{} as table {}.{}").format(
            sql.Identifier(CHECKPOINT_SCHEMA),
            sql.Identifier(_checkpoint_table_name(table)),
            sql.Identifier(schema_name),
            sql.Identifier(table_name),
        )
    )


def _owned_sequences(
    connection: Any, tables: Iterable[tuple[str, str]]
) -> tuple[tuple[str, str], ...]:
    table_set = set(tables)
    rows = connection.execute(
        """
        select distinct sequence_ns.nspname, sequence_class.relname,
                        table_ns.nspname, table_class.relname
        from pg_catalog.pg_class sequence_class
        join pg_catalog.pg_namespace sequence_ns on sequence_ns.oid = sequence_class.relnamespace
        join pg_catalog.pg_depend dependency on dependency.objid = sequence_class.oid
        join pg_catalog.pg_class table_class on table_class.oid = dependency.refobjid
        join pg_catalog.pg_namespace table_ns on table_ns.oid = table_class.relnamespace
        where sequence_class.relkind = 'S'
          and dependency.deptype = any(%s)
        order by sequence_ns.nspname, sequence_class.relname
        """,
        (["a", "i"],),
    ).fetchall()
    return tuple(
        (str(row[0]), str(row[1]))
        for row in rows
        if (str(row[2]), str(row[3])) in table_set
    )


def capture_sequences(connection: Any, tables: Iterable[tuple[str, str]]) -> None:
    for sequence_schema, sequence_name in _owned_sequences(connection, tables):
        state = connection.execute(
            sql.SQL("select last_value, is_called from {}.{}").format(
                sql.Identifier(sequence_schema), sql.Identifier(sequence_name)
            )
        ).fetchone()
        if state is None:
            raise ValueError(f"sequence state is missing: {sequence_schema}.{sequence_name}")
        connection.execute(
            sql.SQL(
                "insert into {}.sequence_state "
                "(sequence_schema, sequence_name, last_value, is_called) values (%s, %s, %s, %s)"
            ).format(sql.Identifier(CHECKPOINT_SCHEMA)),
            (sequence_schema, sequence_name, int(state[0]), bool(state[1])),
        )


def record_inventory(connection: Any, tables: Iterable[tuple[str, str]]) -> None:
    for schema_name, table_name in tables:
        row = connection.execute(
            sql.SQL("select count(*) from {}.{}").format(
                sql.Identifier(schema_name), sql.Identifier(table_name)
            )
        ).fetchone()
        if row is None:
            raise ValueError(f"table count is missing: {schema_name}.{table_name}")
        connection.execute(
            sql.SQL(
                "insert into {}.inventory (schema_name, table_name, row_count) values (%s, %s, %s)"
            ).format(sql.Identifier(CHECKPOINT_SCHEMA)),
            (schema_name, table_name, int(row[0])),
        )


def checkpoint_inventory(connection: Any) -> tuple[tuple[str, str], ...]:
    rows = connection.execute(
        sql.SQL(
            "select schema_name, table_name from {}.inventory order by schema_name, table_name"
        ).format(sql.Identifier(CHECKPOINT_SCHEMA))
    ).fetchall()
    return tuple((str(row[0]), str(row[1])) for row in rows)


def table_dependencies(
    connection: Any, tables: Iterable[tuple[str, str]]
) -> dict[tuple[str, str], set[tuple[str, str]]]:
    table_set = set(tables)
    rows = connection.execute(
        """
        select child_ns.nspname, child.relname, parent_ns.nspname, parent.relname
        from pg_catalog.pg_constraint constraint_row
        join pg_catalog.pg_class child on child.oid = constraint_row.conrelid
        join pg_catalog.pg_namespace child_ns on child_ns.oid = child.relnamespace
        join pg_catalog.pg_class parent on parent.oid = constraint_row.confrelid
        join pg_catalog.pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
        where constraint_row.contype = 'f'
        """
    ).fetchall()
    dependencies: dict[tuple[str, str], set[tuple[str, str]]] = {}
    for row in rows:
        child = (str(row[0]), str(row[1]))
        parent = (str(row[2]), str(row[3]))
        if child in table_set and parent in table_set and child != parent:
            dependencies.setdefault(child, set()).add(parent)
    return dependencies


def dependency_order(
    tables: Iterable[tuple[str, str]],
    dependencies: dict[tuple[str, str], set[tuple[str, str]]],
) -> list[tuple[str, str]]:
    ordered_input = list(tables)
    remaining = {table: set(dependencies.get(table, set())) for table in ordered_input}
    result: list[tuple[str, str]] = []
    while remaining:
        ready = [table for table in ordered_input if table in remaining and not remaining[table]]
        if not ready:
            raise ValueError("application table dependency cycle prevents checkpoint restore")
        for table in ready:
            result.append(table)
            remaining.pop(table)
        for required in remaining.values():
            required.difference_update(ready)
    return result


def truncate_application_tables(
    connection: Any, tables: Iterable[tuple[str, str]]
) -> None:
    qualified = [
        sql.SQL(".").join((sql.Identifier(schema_name), sql.Identifier(table_name)))
        for schema_name, table_name in tables
    ]
    connection.execute(
        sql.SQL("truncate table {} restart identity cascade").format(sql.SQL(", ").join(qualified))
    )


def _insertable_columns(connection: Any, table: tuple[str, str]) -> tuple[str, ...]:
    rows = connection.execute(
        """
        select attribute.attname
        from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class class_row on class_row.oid = attribute.attrelid
        join pg_catalog.pg_namespace namespace_row on namespace_row.oid = class_row.relnamespace
        where namespace_row.nspname = %s
          and class_row.relname = %s
          and attribute.attnum > 0
          and not attribute.attisdropped
          and attribute.attgenerated = ''
        order by attribute.attnum
        """,
        table,
    ).fetchall()
    columns = tuple(str(row[0]) for row in rows)
    if not columns:
        raise ValueError(f"checkpoint table has no insertable columns: {table[0]}.{table[1]}")
    return columns


def restore_table(connection: Any, table: tuple[str, str]) -> None:
    columns = _insertable_columns(connection, table)
    identifiers = sql.SQL(", ").join(sql.Identifier(column) for column in columns)
    connection.execute(
        sql.SQL("insert into {}.{} ({}) overriding system value select {} from {}.{}").format(
            sql.Identifier(table[0]),
            sql.Identifier(table[1]),
            identifiers,
            identifiers,
            sql.Identifier(CHECKPOINT_SCHEMA),
            sql.Identifier(_checkpoint_table_name(table)),
        )
    )


def restore_sequences(connection: Any) -> None:
    rows = connection.execute(
        sql.SQL(
            "select sequence_schema, sequence_name, last_value, is_called "
            "from {}.sequence_state order by sequence_schema, sequence_name"
        ).format(sql.Identifier(CHECKPOINT_SCHEMA))
    ).fetchall()
    for row in rows:
        qualified_sequence = '"{}"."{}"'.format(
            str(row[0]).replace('"', '""'), str(row[1]).replace('"', '""')
        )
        connection.execute(
            "select pg_catalog.setval(%s::regclass, %s, %s)",
            (qualified_sequence, int(row[2]), bool(row[3])),
        )


def analyze_application_tables(
    connection: Any, tables: Iterable[tuple[str, str]]
) -> None:
    for schema_name, table_name in tables:
        connection.execute(
            sql.SQL("ANALYZE {}.{}").format(
                sql.Identifier(schema_name), sql.Identifier(table_name)
            )
        )


def verify_checkpoint(
    connection: Any, expected_tables: Iterable[tuple[str, str]] | None = None
) -> None:
    expected = tuple(expected_tables or owned_application_tables(connection))
    inventory = checkpoint_inventory(connection)
    if set(inventory) != set(expected) or len(inventory) != len(expected):
        raise ValueError("checkpoint table inventory does not match application tables")
    inventory_rows = connection.execute(
        sql.SQL("select schema_name, table_name, row_count from {}.inventory").format(
            sql.Identifier(CHECKPOINT_SCHEMA)
        )
    ).fetchall()
    for schema_name, table_name, expected_count in inventory_rows:
        table = (str(schema_name), str(table_name))
        checkpoint_count = connection.execute(
            sql.SQL("select count(*) from {}.{}").format(
                sql.Identifier(CHECKPOINT_SCHEMA),
                sql.Identifier(_checkpoint_table_name(table)),
            )
        ).fetchone()
        live_count = connection.execute(
            sql.SQL("select count(*) from {}.{}").format(
                sql.Identifier(table[0]), sql.Identifier(table[1])
            )
        ).fetchone()
        if checkpoint_count is None or int(checkpoint_count[0]) != int(expected_count):
            raise ValueError(f"checkpoint row count mismatch: {table[0]}.{table[1]}")
        if live_count is None or int(live_count[0]) != int(expected_count):
            raise ValueError(f"live row count mismatch: {table[0]}.{table[1]}")


def capture_checkpoint(connection: Any) -> None:
    with connection.transaction():
        tables = owned_application_tables(connection)
        create_checkpoint_schema(connection)
        for table in tables:
            capture_table(connection, table)
        capture_sequences(connection, tables)
        record_inventory(connection, tables)
        verify_checkpoint(connection, expected_tables=tables)


def restore_checkpoint(connection: Any) -> None:
    with connection.transaction():
        tables = owned_application_tables(connection)
        inventory = checkpoint_inventory(connection)
        if set(inventory) != set(tables) or len(inventory) != len(tables):
            raise ValueError("checkpoint table inventory does not match application tables")
        order = dependency_order(tables, table_dependencies(connection, tables))
        truncate_application_tables(connection, tables)
        for table in order:
            restore_table(connection, table)
        restore_sequences(connection)
        analyze_application_tables(connection, tables)
        verify_checkpoint(connection, expected_tables=tables)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=("capture", "restore", "verify"))
    parser.add_argument("--database-url", required=True)
    args = parser.parse_args()
    database_url = validate_database_url(args.database_url)
    with psycopg.connect(database_url) as connection:
        validate_connected_identity(connection, database_url)
        connection.commit()
        if args.mode == "capture":
            capture_checkpoint(connection)
        elif args.mode == "restore":
            restore_checkpoint(connection)
        else:
            with connection.transaction():
                verify_checkpoint(connection)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
