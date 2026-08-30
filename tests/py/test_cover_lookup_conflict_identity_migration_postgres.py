from __future__ import annotations

import os
from pathlib import Path

import pytest

from music_app.services.cover_lookup_tasks_postgres import CoverLookupTasksPostgresAdapter
from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0028_repair_cover_lookup_task_conflict_identity.sql"
)
def _dedicated_database_urls_or_skip(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[str, str]:
    setup_value = str(os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV) or "").strip()
    runtime_value = str(os.environ.get(isolatedPostgres.RUNTIME_DATABASE_ENV) or "").strip()
    if not setup_value and not runtime_value:
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")

    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    pgpass_value = str(os.environ.get("PGPASSFILE") or "").strip()
    if not pgpass_value:
        pytest.skip("Dedicated isolated Postgres PGPASSFILE is not configured.")
    pgpass_path = Path(pgpass_value)
    if not pgpass_path.is_file():
        pytest.skip(f"Dedicated isolated Postgres pgpass file is unavailable: {pgpass_path}")
    monkeypatch.setenv("PGPASSFILE", str(pgpass_path))

    psycopg = pytest.importorskip("psycopg")
    try:
        with isolatedPostgres._connect(setup_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        with isolatedPostgres._connect(runtime_url) as connection:
            isolatedPostgres._assert_connected_role(connection, isolatedPostgres.RUNTIME_ROLE)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Dedicated isolated Postgres database is unavailable: {exc}")
    return setup_url, runtime_url


def _drop_application_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def test_live_cover_lookup_conflict_identity_repair_upgrades_legacy_index_and_persists_scoped_rows(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    psycopg = pytest.importorskip("psycopg")
    cleanup_complete = False
    task = {
        "id": "legacy-metallica-kill-em-all",
        "status": "running",
        "created_at": "2026-07-21T12:00:00+00:00",
        "artist": "Metallica",
        "album": "Kill 'Em All",
        "possible_matches": [
            {
                "id": "fake-cover-candidate",
                "source": "fixture-provider",
                "image_url": "http://127.0.0.1:4175/fake-cover.jpg",
            }
        ],
    }
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute("drop index if exists ops.cover_lookup_tasks_task_key_idx")
            connection.execute(
                "create unique index cover_lookup_tasks_task_key_idx "
                "on ops.cover_lookup_tasks (task_key)"
            )

        adapter = CoverLookupTasksPostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
        )
        with pytest.raises(psycopg.errors.InvalidColumnReference) as exc_info:
            adapter.upsert_notification(task)
        assert exc_info.value.sqlstate == "42P10"
        assert "no unique or exclusion constraint" in str(exc_info.value)

        migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(migration_sql)
            connection.execute(migration_sql)
            bootstrap_library_id = int(
                connection.execute(
                    """
                    select library.libraries.id
                    from app.bootstrap_owners
                    join library.libraries
                      on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                     and library.libraries.name = 'Local Library'
                     and library.libraries.library_kind = 'local'
                    where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                    limit 1
                    """
                ).fetchone()["id"]
            )
            second_account_id = int(
                connection.execute(
                    """
                    insert into app.accounts (display_name, account_kind)
                    values ('Second Cover Lookup Owner', 'local')
                    returning id
                    """
                ).fetchone()["id"]
            )
            second_library_id = int(
                connection.execute(
                    """
                    insert into library.libraries (owner_account_id, name, library_kind)
                    values (%s, 'Second Cover Lookup Library', 'local')
                    returning id
                    """,
                    (second_account_id,),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into ops.cover_lookup_tasks (
                  library_id,
                  task_key,
                  status,
                  requested_at,
                  provider_payload,
                  metadata
                )
                values (
                  %s,
                  %s,
                  'completed',
                  '2026-07-21T11:59:00+00:00'::timestamptz,
                  '{"legacy":true}'::jsonb,
                  '{"source_family":"cover_lookup_notifications"}'::jsonb
                )
                """,
                (bootstrap_library_id, task["id"]),
            )
            connection.execute(
                """
                insert into ops.cover_lookup_tasks (
                  library_id,
                  task_key,
                  status,
                  requested_at,
                  provider_payload,
                  metadata
                )
                values (
                  %s,
                  %s,
                  'running',
                  '2026-07-21T11:58:00+00:00'::timestamptz,
                  '{"second_library":true}'::jsonb,
                  '{"source_family":"runtime_cover_lookup_notifications_adapter"}'::jsonb
                )
                """,
                (second_library_id, task["id"]),
            )

        adapter.upsert_notification(task)
        updated_task = {
            **task,
            "status": "completed",
            "notification_completed_at": "2026-07-21T12:00:05+00:00",
        }
        adapter.upsert_notification(updated_task)

        with isolatedPostgres._connect(setup_url) as connection:
            rows = connection.execute(
                """
                select
                  library_id,
                  task_key,
                  status,
                  provider_payload,
                  metadata ->> 'source_family' as source_family
                from ops.cover_lookup_tasks
                where task_key = %s
                order by source_family
                """,
                (task["id"],),
            ).fetchall()
        assert len(rows) == 3
        rows_by_identity = {
            (int(row["library_id"]), row["source_family"]): row for row in rows
        }
        assert set(rows_by_identity) == {
            (bootstrap_library_id, "cover_lookup_notifications"),
            (bootstrap_library_id, "runtime_cover_lookup_notifications_adapter"),
            (second_library_id, "runtime_cover_lookup_notifications_adapter"),
        }
        legacy_row = rows_by_identity[
            (bootstrap_library_id, "cover_lookup_notifications")
        ]
        assert legacy_row["status"] == "completed"
        assert legacy_row["provider_payload"] == {
            "legacy": True
        }
        runtime_row = rows_by_identity[
            (bootstrap_library_id, "runtime_cover_lookup_notifications_adapter")
        ]
        assert runtime_row["status"] == "completed"
        assert runtime_row["provider_payload"]["possible_matches"] == task["possible_matches"]
        second_library_row = rows_by_identity[
            (second_library_id, "runtime_cover_lookup_notifications_adapter")
        ]
        assert second_library_row["status"] == "running"
        assert second_library_row["provider_payload"] == {"second_library": True}

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)
