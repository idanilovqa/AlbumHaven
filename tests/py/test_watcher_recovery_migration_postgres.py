from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from tests.e2e.support import isolatedPostgres


REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = REPO_ROOT / "migrations" / "postgres"
WATCHER_MIGRATION = MIGRATIONS_DIR / "0107_create_durable_watcher_recovery.sql"


def _migration_sql() -> str:
    assert WATCHER_MIGRATION.is_file(), "missing watcher recovery migration 0107"
    return WATCHER_MIGRATION.read_text(encoding="utf-8")


def _skip_or_fail_ci(message: str) -> None:
    if any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    ):
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str]:
    try:
        setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated watcher migration Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, runtime_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Watcher migration role URLs do not share one database.")
    return setup_url, runtime_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def watcher_migration_database():
    setup_url, runtime_url = _database_urls_or_skip()
    migrations = sorted(
        path
        for path in MIGRATIONS_DIR.glob("*.sql")
        if path.name < WATCHER_MIGRATION.name
    )
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.apply_migrations(setup_url, migrations)
        yield setup_url
    finally:
        _drop_schemas(setup_url)


def _seed_legacy_health(
    setup_url: str,
    *,
    suffix: str = "default",
    detected_at: str = "2026-10-09T12:00:00+00:00",
) -> tuple[int, int]:
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(
            connection.execute(
                """
                insert into app.accounts (
                  display_name, username_display, username_normalized,
                  contact_email, contact_email_normalized, account_kind, is_active
                ) values (
                      %s, %s, %s, %s, %s, 'managed', true
                    ) returning id
                    """,
                    (
                        f"Watcher Migration {suffix}",
                        f"watcher-migration-{suffix}",
                        f"watcher-migration-{suffix}",
                        f"watcher-migration-{suffix}@example.invalid",
                        f"watcher-migration-{suffix}@example.invalid",
                    ),
                ).fetchone()["id"]
            )
        library_id = int(
            connection.execute(
                """
                insert into library.libraries (
                  owner_account_id, name, library_kind, metadata
                ) values (%s, 'Watcher Migration', 'local', %s::jsonb)
                returning id
                """,
                (
                    account_id,
                    json.dumps(
                        {
                            "library_watch_health": {
                                "root-a": {
                                    "state": "overflow",
                                    "detected_at": detected_at,
                                }
                            }
                        }
                    ),
                ),
            ).fetchone()["id"]
        )
        root_id = int(
            connection.execute(
                """
                insert into library.library_roots (
                  library_id, root_path, root_kind, is_active, metadata
                ) values (%s, 'C:/private/watcher-migration/root-a', 'main', true,
                          '{"root_id":"root-a"}'::jsonb)
                returning id
                """,
                (library_id,),
            ).fetchone()["id"]
        )
    return library_id, root_id


def test_0107_can_be_reapplied_after_imported_incident_is_resolved(
    watcher_migration_database,
):
    setup_url = watcher_migration_database
    library_id, root_id = _seed_legacy_health(setup_url)
    migration_sql = _migration_sql()

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(migration_sql)
        lane = connection.execute(
            """
            select successor_generation_id, accepted_sequence, dirty_generation
            from library.watcher_lanes where library_id = %s and root_id = %s
            """,
            (library_id, root_id),
        ).fetchone()
        assert lane["successor_generation_id"] is not None
        connection.execute(
            """
            update library.watcher_lanes
            set applied_sequence = accepted_sequence,
                repaired_dirty_generation = dirty_generation,
                successor_generation_id = null,
                disposition_code = 'idle'
            where library_id = %s and root_id = %s
            """,
            (library_id, root_id),
        )
        connection.execute(
            """
            update library.watcher_incidents set resolved_at = now()
            where library_id = %s and root_id = %s and resolved_at is null
            """,
            (library_id, root_id),
        )
        connection.execute(
            "delete from library.targeted_reconciliation_intents where id = %s",
            (lane["successor_generation_id"],),
        )
        before = connection.execute(
            """
            select
              (select count(*) from library.watcher_legacy_health_imports
               where library_id = %s and root_id = %s) as evidence_count,
              (select count(*) from library.watcher_incidents
               where library_id = %s and root_id = %s) as incident_count,
              (select accepted_sequence from library.watcher_lanes
               where library_id = %s and root_id = %s) as accepted_sequence
            """,
            (library_id, root_id, library_id, root_id, library_id, root_id),
        ).fetchone()
        connection.execute(migration_sql)
        after = connection.execute(
            """
            select
              (select count(*) from library.watcher_legacy_health_imports
               where library_id = %s and root_id = %s) as evidence_count,
              (select count(*) from library.watcher_incidents
               where library_id = %s and root_id = %s) as incident_count,
              (select accepted_sequence from library.watcher_lanes
               where library_id = %s and root_id = %s) as accepted_sequence,
              (select successor_generation_id from library.watcher_lanes
               where library_id = %s and root_id = %s) as successor_generation_id,
              (select count(*) from library.watcher_incidents
               where library_id = %s and root_id = %s and resolved_at is null)
                as unresolved_count
            """,
            (
                library_id,
                root_id,
                library_id,
                root_id,
                library_id,
                root_id,
                library_id,
                root_id,
                library_id,
                root_id,
            ),
        ).fetchone()

    assert after["evidence_count"] == before["evidence_count"] == 1
    assert after["incident_count"] == before["incident_count"] == 1
    assert after["accepted_sequence"] == before["accepted_sequence"]
    assert after["successor_generation_id"] is None
    assert after["unresolved_count"] == 0


def test_0107_imports_malformed_legacy_timestamp_with_database_time_fallback(
    watcher_migration_database,
):
    setup_url = watcher_migration_database
    library_id, root_id = _seed_legacy_health(
        setup_url,
        suffix="malformed-time",
        detected_at="not-a-timestamp",
    )

    with isolatedPostgres._connect(setup_url) as connection:
        before = connection.execute(
            "select clock_timestamp() as observed_at"
        ).fetchone()["observed_at"]
        connection.execute(_migration_sql())
        after = connection.execute(
            "select clock_timestamp() as observed_at"
        ).fetchone()["observed_at"]
        incident = connection.execute(
            """
            select first_seen_at, last_seen_at, reason_code
            from library.watcher_incidents
            where library_id = %s and root_id = %s and resolved_at is null
            """,
            (library_id, root_id),
        ).fetchone()

    assert incident["reason_code"] == "overflow"
    assert before <= incident["first_seen_at"] <= after
    assert incident["last_seen_at"] == incident["first_seen_at"]


def test_0107_publication_contract_has_one_reserved_overload_per_job_kind(
    watcher_migration_database,
):
    setup_url = watcher_migration_database
    _migration_sql()
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(_migration_sql())
        rows = connection.execute(
            """
            select proname,
                   pg_get_function_identity_arguments(proc.oid) as arguments,
                   pg_get_function_result(proc.oid) as result_type,
                   has_function_privilege(
                     'album_haven_worker', proc.oid, 'EXECUTE'
                   ) as worker_allowed,
                   has_function_privilege(
                     'album_haven_app', proc.oid, 'EXECUTE'
                   ) as app_allowed,
                   has_function_privilege(
                     'album_haven_readonly', proc.oid, 'EXECUTE'
                   ) as readonly_allowed
            from pg_proc proc
            join pg_namespace namespace on namespace.oid = proc.pronamespace
            where namespace.nspname = 'library'
              and proname in (
                'publish_claimed_full_scan',
                'publish_claimed_targeted_reconciliation'
              )
            order by proname, arguments
            """
        ).fetchall()

    expected = {
        (
            "publish_claimed_full_scan",
            "p_intent_id bigint, p_job_id bigint, p_attempt integer, "
            "p_worker_id character varying, p_lease_token character varying, "
            "p_expected_inventory_revision bigint, p_inventory jsonb, "
            "p_observed_root_ids text[], p_now timestamp with time zone",
        ),
        (
            "publish_claimed_targeted_reconciliation",
            "p_intent_id bigint, p_job_id bigint, p_attempt integer, "
            "p_worker_id character varying, p_lease_token character varying, "
            "p_inventory jsonb, p_stale_scopes jsonb, "
            "p_now timestamp with time zone",
        ),
    }
    assert {(row["proname"], row["arguments"]) for row in rows} == expected
    expected_results = {
        "publish_claimed_full_scan": (
            "TABLE(publication_won boolean, inventory_mutation_revision bigint, "
            "cover_publication_stale boolean, cover_mutation_revision bigint)"
        ),
        "publish_claimed_targeted_reconciliation": (
            "TABLE(publication_won boolean, inventory_mutation_revision bigint, "
            "affected_album_keys text[], cover_publication_stale boolean, "
            "cover_mutation_revision bigint)"
        ),
    }
    assert {row["proname"]: row["result_type"] for row in rows} == expected_results
    assert all(row["worker_allowed"] is True for row in rows)
    assert all(row["app_allowed"] is False for row in rows)
    assert all(row["readonly_allowed"] is False for row in rows)
