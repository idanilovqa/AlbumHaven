from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres


MIGRATION = Path(__file__).resolve().parents[2] / "migrations/postgres/0122_preserve_cover_notification_order.sql"


def test_notification_order_migration_is_row_local_and_unprivileged():
    sql = MIGRATION.read_text(encoding="utf-8").lower()
    assert "before insert or update on ops.cover_lookup_tasks" in sql
    assert "security invoker" in sql
    assert "set search_path = pg_catalog" in sql
    assert "revoke all on function ops.preserve_cover_notification_order() from public" in sql
    assert "update ops.cover_lookup_tasks" not in sql
    assert "delete from" not in sql


def test_live_notification_order_survives_legacy_writers_and_retries():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    psycopg = pytest.importorskip("psycopg")
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    migration_sql = MIGRATION.read_text(encoding="utf-8")
    legacy_key, new_key, supplied_key = (f"order-{uuid4()}" for _ in range(3))
    original = datetime.fromisoformat("2026-05-17T00:01:00+00:00")
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        with connection.transaction(force_rollback=True):
            # Transaction rollback restores the original trigger and removes owned rows.
            connection.execute("drop trigger if exists cover_lookup_notification_order on ops.cover_lookup_tasks")
            connection.execute(
                "insert into ops.cover_lookup_tasks (task_key,status,requested_at,completed_at,metadata) "
                "values (%s,'completed','2026-05-17T00:00:00+00:00',%s,'{\"legacy\":true}')",
                (legacy_key, original),
            )
            connection.execute(migration_sql)
            connection.execute(migration_sql)
            unchanged = connection.execute(
                "select metadata from ops.cover_lookup_tasks where task_key=%s", (legacy_key,),
            ).fetchone()
            assert unchanged["metadata"] == {"legacy": True}
            connection.execute(psycopg.sql.SQL("set local role {}").format(
                psycopg.sql.Identifier(isolatedPostgres.RUNTIME_ROLE),
            ))
            assert connection.execute(
                "select has_function_privilege(current_user, "
                "'ops.preserve_cover_notification_order()', 'EXECUTE') as can_call",
            ).fetchone()["can_call"] is False
            for status in ("pending", "completed"):
                row = connection.execute(
                    "update ops.cover_lookup_tasks set requested_at='2026-11-02T12:00:00+00:00', "
                    "completed_at='2026-11-02T12:01:00+00:00', status=%s, "
                    "metadata='{\"legacy_save\":true}' where task_key=%s "
                    "returning (metadata->>'notification_order_at')::timestamptz as ordering,metadata,requested_at",
                    (status, legacy_key),
                ).fetchone()
                assert row["ordering"] == original
                assert row["metadata"]["legacy_save"] is True
                assert row["requested_at"] > original
            row = connection.execute(
                "insert into ops.cover_lookup_tasks (task_key,status,requested_at,metadata) "
                "values (%s,'pending','2026-11-02T12:00:00+00:00','{}') "
                "returning (metadata->>'notification_order_at')::timestamptz = requested_at as ordered",
                (new_key,),
            ).fetchone()
            assert row["ordered"] is True
            row = connection.execute(
                "insert into ops.cover_lookup_tasks (task_key,status,requested_at,metadata) "
                "values (%s,'pending','2026-11-02T12:00:00+00:00', "
                "jsonb_build_object('notification_order_at',%s::timestamptz)) "
                "returning (metadata->>'notification_order_at')::timestamptz as ordering",
                (supplied_key, original),
            ).fetchone()
            assert row["ordering"] == original
            row = connection.execute(
                "update ops.cover_lookup_tasks set metadata="
                "'{\"notification_order_at\":\"2030-01-01T00:00:00+00:00\"}' where task_key=%s "
                "returning (metadata->>'notification_order_at')::timestamptz = requested_at as ordered",
                (new_key,),
            ).fetchone()
            assert row["ordered"] is True
