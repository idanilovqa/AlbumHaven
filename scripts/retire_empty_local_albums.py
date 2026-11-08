"""Report, and on explicit approval retire, empty local album rows.

An empty row has no track of any state. It is retirable only when it also
carries no user decision (see `RETIREMENT_GUARDS`). Rows referenced from a
table this code does not classify are kept and reported.

The default run is a read-only dry run. `--apply` needs the exact database
name and the dry run's retirable count, writes a JSON backup of every row it
deletes before committing, and refuses the shared core database unless the
owner has authorized that run.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music_app.services.empty_local_album_retirement import (  # noqa: E402
    GUARDED_ALBUM_CHILD_TABLES,
    RETIRABLE_EMPTY_ALBUM_PREDICATE_SQL,
    RETIREMENT_GUARDS,
    SCAN_OWNED_ALBUM_CHILD_TABLES,
)

SHARED_CORE_DATABASE = "album_haven_core"
_DEFAULT_URL_ENV = "ALBUM_HAVEN_DATABASE_URL"
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_IN_FLIGHT_TAG_EDIT_STATUSES = ("prepared", "files_verified")
_LOCAL_LIBRARY_ID_SQL = """
    select owned_library.id from library.libraries as owned_library
    join app.bootstrap_owners as owner on owner.account_id = owned_library.owner_account_id
    where owner.owner_key = 'local-bootstrap-owner'
      and owned_library.name = 'Local Library'
      and owned_library.library_kind = 'local'
"""
# Rows that deleting a retirable album cascades; the guards leave only
# scan-derived ones (ratings are all seeded from file tags).
_CASCADED_CHILD_ROWS = {
    "featured_artists": "select * from library.local_album_featured_artists where album_id = any(%(ids)s)",
    "cover_candidate_snapshots": "select * from library.local_album_cover_candidate_snapshots where album_id = any(%(ids)s)",
    "album_ratings": """select rating.* from app.album_ratings as rating
        join library.local_albums as album
          on album.library_id = rating.library_id and album.album_key = rating.album_key
        where album.id = any(%(ids)s)""",
}


class RetirementRefused(RuntimeError):
    """Raised when a guarded apply precondition does not hold."""


def _unclassified_child_guards(connection: Any) -> list[tuple[str, str]]:
    rows = connection.execute("""
        select child_namespace.nspname as schema_name, child.relname as table_name,
               child_column.attname as column_name,
               cardinality(constraint_row.conkey) as key_column_count,
               parent_column.attname as parent_column_name
        from pg_constraint as constraint_row
        join pg_class as child on child.oid = constraint_row.conrelid
        join pg_namespace as child_namespace on child_namespace.oid = child.relnamespace
        join pg_attribute as child_column
          on child_column.attrelid = constraint_row.conrelid
         and child_column.attnum = constraint_row.conkey[1]
        join pg_attribute as parent_column
          on parent_column.attrelid = constraint_row.confrelid
         and parent_column.attnum = constraint_row.confkey[1]
        where constraint_row.contype = 'f'
          and constraint_row.confrelid = 'library.local_albums'::regclass
        order by 1, 2, 3
    """).fetchall()
    known = SCAN_OWNED_ALBUM_CHILD_TABLES | GUARDED_ALBUM_CHILD_TABLES
    guards = []
    for row in rows:
        table = f"{row['schema_name']}.{row['table_name']}"
        if table in known:
            continue
        names = (row["schema_name"], row["table_name"], row["column_name"])
        if (
            row["key_column_count"] != 1
            or row["parent_column_name"] != "id"
            or not all(_IDENTIFIER.match(name) for name in names)
        ):
            raise RetirementRefused(f"Cannot classify the album reference from {table}.")
        guards.append((f"unclassified:{table}", (
            f'not exists (select 1 from "{names[0]}"."{names[1]}" as child '
            f'where child."{names[2]}" = album.id)'
        )))
    return guards


def _empty_album_rows(
    connection: Any, guards: list[tuple[str, str]], *, lock: bool
) -> list[dict[str, Any]]:
    kept_columns = ",\n".join(
        f"not ({clause}) as kept_{index}" for index, (_name, clause) in enumerate(guards)
    )
    rows = connection.execute(f"""
        select album.id, album.album_key, album.title,
               album.first_seen_at, album.last_seen_at,
               {kept_columns}
        from library.local_albums as album
        where album.library_id = ({_LOCAL_LIBRARY_ID_SQL})
          and not exists (
            select 1 from library.local_tracks as track where track.album_id = album.id
          )
        order by album.id
        {"for update of album" if lock else ""}
    """).fetchall()
    return [
        {
            "id": int(row["id"]),
            "album_key": row["album_key"],
            "title": row["title"],
            "first_seen_at": row["first_seen_at"].isoformat(),
            "last_seen_at": row["last_seen_at"].isoformat(),
            "kept_by": [name for index, (name, _clause) in enumerate(guards) if row[f"kept_{index}"]],
        }
        for row in rows
    ]


def classify(connection: Any, *, lock: bool = False) -> dict[str, Any]:
    """Classify every empty album row; the caller owns the transaction."""
    guards = [*RETIREMENT_GUARDS, *_unclassified_child_guards(connection)]
    empty = _empty_album_rows(connection, guards, lock=lock)
    kept_counts = {name: 0 for name, _clause in guards if name != "has_tracks"}
    for row in empty:
        for name in row["kept_by"]:
            kept_counts[name] += 1
    retirable = [row for row in empty if not row["kept_by"]]
    return {
        "database": connection.execute("select current_database() as name").fetchone()["name"],
        "album_count": connection.execute(
            f"select count(*) as n from library.local_albums where library_id = ({_LOCAL_LIBRARY_ID_SQL})"
        ).fetchone()["n"],
        "empty_album_count": len(empty),
        "retirable_count": len(retirable),
        "kept_count": len(empty) - len(retirable),
        "kept_by_reason": kept_counts,
        "retirable": retirable,
        "kept": [row for row in empty if row["kept_by"]],
    }


def assert_apply_target(database: str, *, confirm_database: str, owner_authorized_core: bool) -> None:
    if confirm_database != database:
        raise RetirementRefused(f"--confirm-database must be the connected database, {database}.")
    if database == SHARED_CORE_DATABASE and not owner_authorized_core:
        raise RetirementRefused(
            f"{SHARED_CORE_DATABASE} needs --owner-authorized-core and must run from sandbox2."
        )


def retire(
    connection: Any,
    *,
    expected_count: int,
    backup_path: Path,
    confirm_database: str,
    owner_authorized_core: bool = False,
) -> dict[str, Any]:
    """Delete the retirable rows in one transaction, after writing a backup.

    The backup file is removed again when the transaction does not commit.
    """
    try:
        with connection.transaction():
            connection.execute(
                "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"
            )
            in_flight = connection.execute(
                "select count(*) as n from library.tag_edit_intents where status = any(%(statuses)s)",
                {"statuses": list(_IN_FLIGHT_TAG_EDIT_STATUSES)},
            ).fetchone()["n"]
            if in_flight:
                raise RetirementRefused(f"{in_flight} tag edits are in flight; rerun after they finish.")
            report = classify(connection, lock=True)
            assert_apply_target(
                report["database"],
                confirm_database=confirm_database,
                owner_authorized_core=owner_authorized_core,
            )
            if report["retirable_count"] != expected_count:
                raise RetirementRefused(
                    f"Expected {expected_count} retirable rows but found {report['retirable_count']}."
                )
            ids = [row["id"] for row in report["retirable"]]
            backup = {
                "database": report["database"],
                "written_at": datetime.now(timezone.utc).isoformat(),
                "albums": [
                    row["row"] for row in connection.execute(
                        "select to_jsonb(album) as row from library.local_albums as album "
                        "where album.id = any(%(ids)s) order by album.id",
                        {"ids": ids},
                    ).fetchall()
                ],
                **{
                    name: [
                        row["row"] for row in connection.execute(
                            f"select to_jsonb(child) as row from ({sql}) as child", {"ids": ids}
                        ).fetchall()
                    ]
                    for name, sql in _CASCADED_CHILD_ROWS.items()
                },
            }
            backup_path.write_text(json.dumps(backup, indent=2, default=str), encoding="utf-8")
            # Re-check every guard: text-keyed decisions have no row lock.
            still_retirable = " and ".join([
                RETIRABLE_EMPTY_ALBUM_PREDICATE_SQL,
                *(f"({clause})" for _name, clause in _unclassified_child_guards(connection)),
            ])
            deleted = connection.execute(
                f"delete from library.local_albums as album "
                f"where album.id = any(%(ids)s) and {still_retirable}",
                {"ids": ids},
            ).rowcount
            if deleted != len(ids):
                raise RetirementRefused(f"Deleted {deleted} rows instead of {len(ids)}.")
            if ids:
                connection.execute(f"""
                    update library.libraries
                    set metadata = jsonb_set(metadata, '{{inventory_mutation_revision}}', to_jsonb(
                      coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0) + 1))
                    where id = ({_LOCAL_LIBRARY_ID_SQL})
                """)
    except BaseException:
        backup_path.unlink(missing_ok=True)
        raise
    return {**report, "retired_count": deleted, "backup_path": str(backup_path)}


def _connect(database_url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url-env", default=_DEFAULT_URL_ENV,
                        help="Environment variable holding the database URL.")
    parser.add_argument("--report", type=Path, help="Write the full classification as JSON.")
    parser.add_argument("--apply", action="store_true", help="Retire the retirable rows.")
    parser.add_argument("--expected-count", type=int, help="Retirable count from the dry run.")
    parser.add_argument("--confirm-database", help="Exact name of the target database.")
    parser.add_argument("--backup", type=Path, help="JSON backup file written before deletion.")
    parser.add_argument("--owner-authorized-core", action="store_true",
                        help=f"Owner authorized this run on {SHARED_CORE_DATABASE}.")
    args = parser.parse_args(argv)
    database_url = str(os.environ.get(args.database_url_env) or "").strip()
    if not database_url:
        parser.error(f"{args.database_url_env} is not set.")
    if args.apply and (args.expected_count is None or not args.confirm_database or not args.backup):
        parser.error("--apply needs --expected-count, --confirm-database and --backup.")

    with _connect(database_url) as connection:
        if args.apply:
            result = retire(
                connection,
                expected_count=args.expected_count,
                backup_path=args.backup,
                confirm_database=args.confirm_database,
                owner_authorized_core=args.owner_authorized_core,
            )
        else:
            with connection.transaction():
                connection.execute("set transaction read only")
                result = classify(connection)
    if args.report:
        args.report.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    summary = {key: value for key, value in result.items() if key not in {"retirable", "kept"}}
    print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
