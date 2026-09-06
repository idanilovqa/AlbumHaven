from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.library_event_coordinator import (
    TargetedMove,
    TargetedReconciliationRequest,
)
from music_app.services.scan_jobs_postgres import PostgresScanJobRepository
from tests.e2e.support import isolatedPostgres


def _skip_or_fail_ci(message: str) -> None:
    is_ci = any(
        str(os.environ.get(name) or "").strip().casefold() in {"1", "true", "yes"}
        for name in ("CI", "GITHUB_ACTIONS")
    )
    if is_ci:
        pytest.fail(message, pytrace=False)
    pytest.skip(message)


def _database_urls_or_skip() -> tuple[str, str, str]:
    try:
        setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    except RuntimeError:
        _skip_or_fail_ci("Dedicated setup and runtime Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "").strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated worker Postgres URL is not configured.")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        (
            (urlparse(value).hostname or "").casefold(),
            urlparse(value).port or 5432,
            urlparse(value).path.lstrip("/"),
        )
        for value in (setup_url, runtime_url, worker_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Dedicated Postgres role URLs do not share one database.")
    try:
        with isolatedPostgres._connect(worker_url) as connection:
            isolatedPostgres._assert_connected_role(connection, "album_haven_worker")
    except Exception:
        _skip_or_fail_ci("Dedicated worker Postgres role is unavailable.")
    return setup_url, runtime_url, worker_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def live_scan_database():
    setup_url, runtime_url, worker_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        yield setup_url, runtime_url, worker_url
    except Exception as exc:
        if exc.__class__.__module__.startswith("psycopg"):
            pytest.fail("Dedicated scan-job Postgres verification failed.", pytrace=False)
        raise
    finally:
        _drop_schemas(setup_url)


def _scan_repository(database_url: str) -> PostgresScanJobRepository:
    return PostgresScanJobRepository(
        database_url=database_url,
        connect_to_database=isolatedPostgres._connect,
    )


def _seed_scope(setup_url: str, suffix: str) -> tuple[int, int]:
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(
            connection.execute(
                """
                insert into app.accounts (
                  display_name, username_display, username_normalized,
                  contact_email, contact_email_normalized, account_kind, is_active
                ) values (%s, %s, %s, %s, %s, 'managed', true)
                returning id
                """,
                (
                    f"Scan Jobs {suffix}",
                    f"scan-jobs-{suffix}",
                    f"scan-jobs-{suffix}",
                    f"scan-jobs-{suffix}@example.invalid",
                    f"scan-jobs-{suffix}@example.invalid",
                ),
            ).fetchone()["id"]
        )
        library_id = int(
            connection.execute(
                """
                insert into library.libraries (owner_account_id, name, library_kind)
                values (%s, %s, 'local') returning id
                """,
                (account_id, f"Scan Jobs {suffix}"),
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.library_memberships (
              library_id, account_id, membership_role
            ) values (%s, %s, 'owner')
            """,
            (library_id, account_id),
        )
        connection.execute(
            """
            insert into app.capabilities (
              account_id, capability_key, scope_kind, scope_id
            ) values (%s, 'library.refresh', 'library', %s)
            """,
            (account_id, library_id),
        )
        connection.execute(
            """
            insert into app.request_origins (
              account_id, client_surface_class, origin_type, origin_key
            ) values (%s, 'private_web', 'browser', %s)
            """,
            (account_id, f"scan-jobs-{suffix}"),
        )
        for logical_id, root_path in (
            ("root-a", rf"C:\private\scan-jobs-{suffix}\a"),
            ("root-b", rf"D:\private\scan-jobs-{suffix}\b"),
        ):
            connection.execute(
                """
                insert into library.library_roots (
                  library_id, root_path, root_kind, is_active, metadata
                ) values (%s, %s, 'main', true, %s::jsonb)
                """,
                (library_id, root_path, json.dumps({"root_id": logical_id})),
            )
    return account_id, library_id


def _full_scan_arguments(account_id: int, library_id: int, suffix: str) -> dict:
    return {
        "library_id": library_id,
        "account_id": account_id,
        "capability_key": "library.refresh",
        "request_origin_ref": f"browser:scan-jobs-{suffix}",
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "private_web",
        "root_ids": ("root-a", "root-b"),
        "mode": "normal",
        "force": False,
        "scheduled_at": datetime(2099, 1, 1, tzinfo=timezone.utc),
    }


def test_live_scan_migration_compiles_and_effectively_denies_private_storage(
    live_scan_database,
):
    setup_url, _, _ = live_scan_database
    tables = (
        "library.full_scan_intents",
        "library.full_scan_intent_roots",
        "library.targeted_reconciliation_intents",
        "library.targeted_reconciliation_intent_paths",
        "library.targeted_reconciliation_intent_moves",
    )
    sequences = (
        "library.full_scan_intents_id_seq",
        "library.targeted_reconciliation_intents_id_seq",
    )
    procedures = (
        "library.create_full_scan_intent(bigint,bigint,varchar,varchar,varchar,varchar,varchar,boolean,bigint[],timestamptz)",
        "library.create_targeted_reconciliation_intent(bigint,bigint,varchar,varchar,varchar,varchar,text[],text[],text[],jsonb,timestamptz)",
        "library.link_scan_intent_job(varchar,bigint,bigint)",
        "library.load_claimed_full_scan_intent(bigint,varchar,varchar)",
        "library.load_claimed_targeted_reconciliation_intent(bigint,varchar,varchar)",
        "library.checkpoint_claimed_scan_intent(varchar,bigint,bigint,integer,varchar,varchar,varchar,bigint,bigint,bigint,timestamptz)",
        "library.repair_orphaned_scan_intents(timestamptz,integer)",
    )
    producer_procedures = procedures[:3]
    loader_procedures = procedures[3:]
    with isolatedPostgres._connect(setup_url) as connection:
        for procedure in procedures:
            assert connection.execute(
                "select to_regprocedure(%s) is not null as present", (procedure,)
            ).fetchone()["present"] is True
        for role in ("album_haven_app", "album_haven_worker", "album_haven_readonly"):
            for table in tables:
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                    assert connection.execute(
                        "select has_table_privilege(%s, %s, %s) as allowed",
                        (role, table, privilege),
                    ).fetchone()["allowed"] is False
            for sequence in sequences:
                for privilege in ("USAGE", "SELECT", "UPDATE"):
                    assert connection.execute(
                        "select has_sequence_privilege(%s, %s, %s) as allowed",
                        (role, sequence, privilege),
                    ).fetchone()["allowed"] is False
        for procedure in producer_procedures:
            assert connection.execute(
                "select has_function_privilege('album_haven_app', %s, 'EXECUTE') as allowed",
                (procedure,),
            ).fetchone()["allowed"] is True
            for role in ("album_haven_worker", "album_haven_readonly"):
                assert connection.execute(
                    "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                    (role, procedure),
                ).fetchone()["allowed"] is False
        for procedure in loader_procedures:
            assert connection.execute(
                "select has_function_privilege('album_haven_worker', %s, 'EXECUTE') as allowed",
                (procedure,),
            ).fetchone()["allowed"] is True
            for role in ("album_haven_app", "album_haven_readonly"):
                assert connection.execute(
                    "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                    (role, procedure),
                ).fetchone()["allowed"] is False


def test_live_full_scan_rolls_back_domain_record_when_job_creation_fails(
    live_scan_database,
):
    setup_url, runtime_url, _ = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "rollback")
    arguments = _full_scan_arguments(account_id, library_id, "rollback")
    arguments["request_origin_ref"] = "browser:missing-origin"

    with pytest.raises(ValueError, match="origin"):
        _scan_repository(runtime_url).enqueue_full_scan(**arguments)

    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from library.full_scan_intents where library_id = %s",
            (library_id,),
        ).fetchone()["count"] == 0


def test_live_concurrent_full_scan_requests_converge_on_one_intent_and_job(
    live_scan_database,
):
    setup_url, runtime_url, _ = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "concurrent")
    arguments = _full_scan_arguments(account_id, library_id, "concurrent")

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda _: _scan_repository(runtime_url).enqueue_full_scan(**arguments),
                range(2),
            )
        )

    assert results[0] == results[1]
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            """
            select count(distinct intent.id) as intents,
                   count(distinct job.id) as jobs
              from library.full_scan_intents as intent
              left join ops.jobs as job on job.id = intent.job_id
             where intent.library_id = %s
            """,
            (library_id,),
        ).fetchone()
    assert row == {"intents": 1, "jobs": 1}


def test_live_targeted_paths_and_moves_round_trip_exactly_through_claimed_loader(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    _, library_id = _seed_scope(setup_url, "roundtrip")
    request = TargetedReconciliationRequest(
        root_id="root-a",
        paths=frozenset(
            {Path(r"C:\Music\Zulu\02.flac"), Path(r"C:\Music\Alpha\01.flac")}
        ),
        deleted_paths=frozenset({Path(r"C:\Music\Old\03.flac")}),
        deleted_subtrees=frozenset({Path(r"C:\Music\Gone")}),
        moves=(
            TargetedMove(
                source=Path(r"C:\Music\Old Album"),
                destination=Path(r"D:\Music\New Album"),
                source_root_id="root-a",
                destination_root_id="root-b",
                is_directory=True,
            ),
        ),
    )
    enqueue_result = _scan_repository(runtime_url).enqueue_targeted_reconciliation(
        library_id=library_id,
        request=request,
        producer_request_key="watcher-roundtrip-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    claimed = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id="scan-jobs-roundtrip-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )

    assert claimed is not None
    assert claimed.job_id == enqueue_result.job_id
    loaded = _scan_repository(worker_url).load_claimed_targeted_reconciliation(
        job_id=claimed.job_id,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
    )
    assert loaded == request
    with isolatedPostgres._connect(setup_url) as connection:
        path_rows = connection.execute(
            """
            select path_kind, path, ordinal
              from library.targeted_reconciliation_intent_paths
             where intent_id = %s
             order by path_kind, ordinal
            """,
            (enqueue_result.intent_id,),
        ).fetchall()
        move_rows = connection.execute(
            """
            select move.source_path, move.destination_path,
                   source_root.metadata ->> 'root_id' as source_root_ref,
                   destination_root.metadata ->> 'root_id' as destination_root_ref,
                   move.is_directory, move.ordinal
              from library.targeted_reconciliation_intent_moves as move
              join library.library_roots as source_root on source_root.id = move.source_root_id
              join library.library_roots as destination_root on destination_root.id = move.destination_root_id
             where move.intent_id = %s order by move.ordinal
            """,
            (enqueue_result.intent_id,),
        ).fetchall()
    assert [(row["path_kind"], row["path"], row["ordinal"]) for row in path_rows] == [
        ("active", str(Path(r"C:\Music\Alpha\01.flac")), 0),
        ("active", str(Path(r"C:\Music\Zulu\02.flac")), 1),
        ("deleted", str(Path(r"C:\Music\Old\03.flac")), 0),
        ("deleted_subtree", str(Path(r"C:\Music\Gone")), 0),
    ]
    assert [dict(row) for row in move_rows] == [
        {
            "source_path": str(Path(r"C:\Music\Old Album")),
            "destination_path": str(Path(r"D:\Music\New Album")),
            "source_root_ref": "root-a",
            "destination_root_ref": "root-b",
            "is_directory": True,
            "ordinal": 0,
        }
    ]


def test_live_targeted_producer_key_collision_rolls_back_without_extra_rows(
    live_scan_database,
):
    import psycopg

    setup_url, runtime_url, _ = live_scan_database
    _, library_id = _seed_scope(setup_url, "collision")
    repository = _scan_repository(runtime_url)
    original = TargetedReconciliationRequest(
        root_id="root-a",
        paths=frozenset({Path(r"C:\Music\Original\01.flac")}),
    )
    first = repository.enqueue_targeted_reconciliation(
        library_id=library_id,
        request=original,
        producer_request_key="watcher-collision-live-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
    )

    with pytest.raises(psycopg.errors.RaiseException, match="payload mismatch"):
        repository.enqueue_targeted_reconciliation(
            library_id=library_id,
            request=TargetedReconciliationRequest(
                root_id="root-a",
                paths=frozenset({Path(r"C:\Music\Different\99.flac")}),
            ),
            producer_request_key="watcher-collision-live-0001",
            deployment_mode="self_hosted_private_web",
            client_surface="library_watcher",
            scheduled_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
        )

    with isolatedPostgres._connect(setup_url) as connection:
        counts = connection.execute(
            """
            select count(distinct intent.id) as intents,
                   count(distinct job.id) as jobs,
                   count(distinct path.path) as paths,
                   count(distinct move.ordinal) as moves
              from library.targeted_reconciliation_intents as intent
              left join ops.jobs as job on job.id = intent.job_id
              left join library.targeted_reconciliation_intent_paths as path
                on path.intent_id = intent.id
              left join library.targeted_reconciliation_intent_moves as move
                on move.intent_id = intent.id
             where intent.library_id = %s
            """,
            (library_id,),
        ).fetchone()
    assert dict(counts) == {"intents": 1, "jobs": 1, "paths": 1, "moves": 0}
    assert first.intent_id > 0 and first.job_id > 0


def test_live_job_trigger_checkpoint_and_bounded_orphan_repair_contracts(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "transitions")
    arguments = _full_scan_arguments(account_id, library_id, "transitions")
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    worker = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claimed = worker.claim(
        worker_id="scan-transition-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claimed is not None and claimed.job_id == accepted.job_id

    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select state from library.full_scan_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()["state"] == "running"

    checkpoint_sql = """
        select library.checkpoint_claimed_scan_intent(
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
        ) as applied
    """
    valid_values = (
        "full_scan",
        accepted.intent_id,
        claimed.job_id,
        claimed.attempt,
        claimed.worker_id,
        claimed.lease_token,
        "running",
        40,
        100,
        17,
        datetime.now(timezone.utc),
    )
    invalid_values = (
        (*valid_values[:3], claimed.attempt + 1, *valid_values[4:]),
        (*valid_values[:4], "wrong-worker", *valid_values[5:]),
        (
            *valid_values[:5],
            "wrong-token",
            *valid_values[6:],
        ),
    )
    with isolatedPostgres._connect(worker_url) as connection:
        for values in invalid_values:
            assert connection.execute(checkpoint_sql, values).fetchone()["applied"] is False
        assert connection.execute(checkpoint_sql, valid_values).fetchone()["applied"] is True
        advanced_values = valid_values[:7] + (80, 100, 23, valid_values[-1])
        assert connection.execute(checkpoint_sql, advanced_values).fetchone()["applied"] is True
        assert connection.execute(checkpoint_sql, valid_values).fetchone()["applied"] is False

    with isolatedPostgres._connect(setup_url) as connection:
        progress = connection.execute(
            """
            select progress_current, progress_total, committed_inventory_revision
              from library.full_scan_intents where id = %s
            """,
            (accepted.intent_id,),
        ).fetchone()
        assert dict(progress) == {
            "progress_current": 80,
            "progress_total": 100,
            "committed_inventory_revision": 23,
        }
        connection.execute(
            "update ops.jobs set lease_expires_at = %s where id = %s",
            (datetime.now(timezone.utc) - timedelta(seconds=1), claimed.job_id),
        )
    with isolatedPostgres._connect(worker_url) as connection:
        assert connection.execute(
            checkpoint_sql, valid_values[:-1] + (datetime.now(timezone.utc),)
        ).fetchone()["applied"] is False

    stale_result = worker.reconcile_stale_leases(
        now=datetime.now(timezone.utc), limit=1000
    )
    assert stale_result.retried_count == 1
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select state from library.full_scan_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()["state"] == "retry_wait"
        connection.execute(
            "update ops.jobs set scheduled_at = %s where id = %s",
            (datetime(2099, 1, 1, tzinfo=timezone.utc), claimed.job_id),
        )

        root_ids = [
            row["id"]
            for row in connection.execute(
                "select id from library.library_roots where library_id = %s order by id",
                (library_id,),
            ).fetchall()
        ]
        old_ids = []
        for minutes_old in (30, 20):
            old_ids.append(
                connection.execute(
                    """
                    insert into library.full_scan_intents (
                      library_id, initiating_account_id, capability_key,
                      request_origin_id, deployment_mode, client_surface,
                      mode, force, accepted_at
                    )
                    select %s, %s, 'library.refresh', origin.id,
                           'self_hosted_private_web', 'private_web',
                           'normal', false, now() - (%s * interval '1 minute')
                      from app.request_origins as origin
                     where origin.origin_key = 'scan-jobs-transitions'
                    returning id
                    """,
                    (library_id, account_id, minutes_old),
                ).fetchone()["id"]
            )
            connection.execute(
                """
                insert into library.full_scan_intent_roots (intent_id, root_id, ordinal)
                values (%s, %s, 0)
                """,
                (old_ids[-1], root_ids[0]),
            )
        recent_id = connection.execute(
            """
            insert into library.full_scan_intents (
              library_id, initiating_account_id, capability_key,
              request_origin_id, deployment_mode, client_surface,
              mode, force, accepted_at
            )
            select %s, %s, 'library.refresh', origin.id,
                   'self_hosted_private_web', 'private_web',
                   'normal', false, now()
              from app.request_origins as origin
             where origin.origin_key = 'scan-jobs-transitions'
            returning id
            """,
            (library_id, account_id),
        ).fetchone()["id"]
        repaired = connection.execute(
            "select library.repair_orphaned_scan_intents(%s, 1) as repaired",
            (datetime.now(timezone.utc),),
        ).fetchone()["repaired"]
        orphan_states = {
            row["id"]: row["state"]
            for row in connection.execute(
                """
                select id, state from library.full_scan_intents
                 where id = any(%s) and job_id is null
                """,
                (old_ids + [recent_id],),
            ).fetchall()
        }
    assert repaired == 1
    assert sorted(orphan_states[intent_id] for intent_id in old_ids) == [
        "accepted",
        "failed",
    ]
    assert orphan_states[recent_id] == "accepted"


@pytest.mark.parametrize(
    ("job_state", "intent_state"),
    (
        ("succeeded", "succeeded"),
        ("failed", "failed"),
        ("ambiguous", "failed"),
        ("canceled", "canceled"),
    ),
)
def test_live_job_trigger_maps_terminal_states_atomically(
    live_scan_database, job_state, intent_state
):
    setup_url, runtime_url, worker_url = live_scan_database
    suffix = f"terminal-{job_state}"
    account_id, library_id = _seed_scope(setup_url, suffix)
    arguments = _full_scan_arguments(account_id, library_id, suffix)
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    claimed = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id=f"scan-{job_state}-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claimed is not None and claimed.job_id == accepted.job_id

    outcome = f"scan_{job_state}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            """
            update ops.jobs
               set state = %s, lease_owner = null, lease_token = null,
                   lease_expires_at = null, heartbeat_at = null,
                   completed_at = now(), outcome_code = %s, updated_at = now()
             where id = %s
            """,
            (job_state, outcome, claimed.job_id),
        )
        intent = connection.execute(
            """
            select state, outcome_code, completed_at
              from library.full_scan_intents where id = %s
            """,
            (accepted.intent_id,),
        ).fetchone()
    assert intent["state"] == intent_state
    assert intent["completed_at"] is not None
    assert intent["outcome_code"] == outcome


def test_live_full_scan_link_rejects_wrong_capability_without_mutating_intent(
    live_scan_database,
):
    import psycopg

    setup_url, runtime_url, _ = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "link-authority")
    with isolatedPostgres._connect(setup_url) as connection:
        origin_id = connection.execute(
            "select id from app.request_origins where origin_key = 'scan-jobs-link-authority'"
        ).fetchone()["id"]
        intent_id = connection.execute(
            """
            insert into library.full_scan_intents (
              library_id, initiating_account_id, capability_key,
              request_origin_id, deployment_mode, client_surface,
              mode, force, accepted_at
            ) values (
              %s, %s, 'library.refresh', %s,
              'self_hosted_private_web', 'private_web', 'normal', false, now()
            ) returning id
            """,
            (library_id, account_id, origin_id),
        ).fetchone()["id"]
        job_id = connection.execute(
            """
            insert into ops.jobs (
              kind, subject_kind, subject_ref, parameters, account_id, library_id,
              capability_key, request_origin_id, deployment_mode, client_surface,
              idempotency_key, scheduled_at, max_attempts, recovery_policy
            ) values (
              'full_scan', 'full_scan_intent', %s, jsonb_build_object('intent_id', %s),
              %s, %s, 'library.write', %s, 'self_hosted_private_web', 'private_web',
              %s, %s, 2, 'retry_safe'
            ) returning id
            """,
            (
                str(intent_id),
                intent_id,
                account_id,
                library_id,
                origin_id,
                f"full-scan-intent:{intent_id}",
                datetime(2099, 1, 1, tzinfo=timezone.utc),
            ),
        ).fetchone()["id"]

    with pytest.raises(psycopg.errors.RaiseException, match="link failed"):
        with isolatedPostgres._connect(runtime_url) as connection:
            connection.execute(
                "select * from library.link_scan_intent_job('full_scan', %s, %s)",
                (intent_id, job_id),
            ).fetchone()
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select job_id from library.full_scan_intents where id = %s", (intent_id,)
        ).fetchone()["job_id"] is None
