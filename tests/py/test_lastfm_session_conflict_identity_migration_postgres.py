from __future__ import annotations

import os
from pathlib import Path

import pytest

from music_app.services.lastfm_postgres import LastfmPostgresAdapter
from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = (
    REPO_ROOT
    / "migrations"
    / "postgres"
    / "0029_repair_lastfm_session_conflict_identity.sql"
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


def test_live_lastfm_session_conflict_identity_repair_upgrades_partial_only_index(
    monkeypatch,
):
    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    psycopg = pytest.importorskip("psycopg")
    cleanup_complete = False
    initial_settings = {
        "username": "fixture_listener",
        "session_key": "fixture-session-one",
        "connected_at": "2026-07-22T12:00:00+00:00",
        "user_timezone": "America/Denver",
    }
    try:
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                "drop index if exists integration.lastfm_sessions_account_username_idx"
            )

        adapter = LastfmPostgresAdapter(
            {"ALBUM_HAVEN_APP_DATABASE_URL": runtime_url}
        )
        with pytest.raises(psycopg.errors.InvalidColumnReference) as exc_info:
            adapter.save_settings(initial_settings)
        assert exc_info.value.sqlstate == "42P10"
        assert "no unique or exclusion constraint" in str(exc_info.value)

        migration_sql = MIGRATION_PATH.read_text(encoding="utf-8")
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(migration_sql)
            connection.execute(migration_sql)

        adapter.save_settings(initial_settings)
        adapter.save_settings(
            {
                **initial_settings,
                "session_key": "fixture-session-two",
                "connected_at": "2026-07-22T12:01:00+00:00",
            }
        )

        with isolatedPostgres._connect(setup_url) as connection:
            index_row = connection.execute(
                """
                select indexdef
                from pg_indexes
                where schemaname = 'integration'
                  and indexname = 'lastfm_sessions_account_username_idx'
                """
            ).fetchone()
            session_rows = connection.execute(
                """
                select
                  provider_username,
                  session_key_encrypted,
                  is_active,
                  metadata ->> 'connected_at' as connected_at
                from integration.lastfm_sessions
                where provider_username = %s
                """,
                (initial_settings["username"],),
            ).fetchall()

        assert index_row is not None
        assert "UNIQUE INDEX" in index_row["indexdef"]
        assert "(account_id, provider_username)" in index_row["indexdef"]
        assert " WHERE " not in index_row["indexdef"]
        assert len(session_rows) == 1
        assert session_rows[0] == {
            "provider_username": "fixture_listener",
            "session_key_encrypted": "fixture-session-two",
            "is_active": True,
            "connected_at": "2026-07-22T12:01:00+00:00",
        }

        _drop_application_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_application_schemas(setup_url)
