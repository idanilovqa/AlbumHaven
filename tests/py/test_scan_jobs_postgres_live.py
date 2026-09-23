from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from urllib.parse import urlparse

import pytest

from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.current_actor import (
    ActorState,
    CapabilityGrant,
    CurrentActor,
    LibraryRelationship,
)
from music_app.services.jobs.models import EnqueueJob, JobCancellationDisposition, JobKind
from music_app.services.library_event_coordinator import (
    TargetedMove,
    TargetedReconciliationRequest,
)
from music_app.services.scan_jobs_postgres import PostgresScanJobRepository
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.policy_evaluator import PolicyEvaluator
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


def _settle_post_scan_cover_follow_ups(setup_url: str, library_id: int) -> None:
    """Keep module-scoped claim tests independent after inspecting a follow-up."""

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set state = 'succeeded', started_at = now(), "
            "completed_at = now(), "
            "outcome_code = 'test_observed', updated_at = now() "
            "where kind = 'post_scan_cover_refresh' and library_id = %s "
            "and state = 'queued'",
            (library_id,),
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


def _cancel_evaluation(account_id: int, library_id: int):
    actor = CurrentActor(
        state=ActorState.ACTIVE,
        account_id=account_id,
        current_library_id=library_id,
        library_relationships=(LibraryRelationship(library_id, "operator", False),),
        capability_grants=(
            CapabilityGrant("library.refresh.cancel", "library", library_id),
        ),
    )
    return PolicyEvaluator().evaluate(
        PolicyContext.build(
            actor=actor,
            action="library.refresh.cancel",
            library_id=library_id,
            deployment_mode="self_hosted_private_web",
            request_origin=RequestOrigin("browser", "cancel-origin"),
            client_surface_class="private_web",
        )
    )


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
        "library.create_full_scan_intent_v2(bigint,bigint,varchar,varchar,varchar,varchar,varchar,boolean,bigint[],timestamptz)",
        "library.create_targeted_reconciliation_intent(bigint,bigint,varchar,varchar,varchar,varchar,text[],text[],text[],text[],jsonb,timestamptz)",
        "library.link_scan_intent_job(varchar,bigint,bigint)",
        "library.request_active_full_scan_cancellation(bigint,bigint,timestamptz)",
        "library.load_claimed_full_scan_intent(bigint,varchar,varchar)",
        "library.load_claimed_targeted_reconciliation_intent(bigint,varchar,varchar)",
        "library.checkpoint_claimed_scan_intent(varchar,bigint,bigint,integer,varchar,varchar,varchar,bigint,bigint,bigint,timestamptz)",
        "library.repair_orphaned_scan_intents(timestamptz,integer)",
    )
    producer_procedures = procedures[:5]
    retired_worker_procedures = (
        procedures[5],
        procedures[7],
        "library.fence_full_scan_publication(bigint,bigint,integer,varchar,varchar,bigint,timestamptz)",
    )
    loader_procedures = (
        procedures[6],
        procedures[8],
        "library.load_claimed_full_scan_intent_v2(bigint,varchar,varchar)",
        "library.load_claimed_full_scan_scope(bigint,bigint,bigint,integer,varchar,varchar,timestamptz)",
        "library.checkpoint_claimed_full_scan(bigint,bigint,integer,varchar,varchar,varchar,bigint,bigint,text,timestamptz)",
        "library.checkpoint_claimed_full_scan_v2(bigint,bigint,integer,varchar,varchar,varchar,bigint,bigint,text,timestamptz,double precision,double precision,double precision,bigint,bigint)",
        "library.publish_claimed_full_scan_preview(bigint,bigint,integer,varchar,varchar,jsonb,text[],bigint,timestamptz)",
        "library.load_claimed_full_scan_cache(bigint,bigint,integer,varchar,varchar,timestamptz)",
        "library.publish_claimed_full_scan(bigint,bigint,integer,varchar,varchar,bigint,jsonb,text[],timestamptz)",
        "library.validate_claimed_post_scan_cover_refresh(bigint,bigint,bigint,integer,varchar,varchar,timestamptz)",
        "app.load_claimed_job_authorization_context(bigint,integer,varchar,varchar,timestamptz)",
    )
    app_read_procedures = (
        "library.load_authorized_full_scan_status(bigint)",
        "library.load_authorized_album_total(bigint)",
        "library.load_authorized_full_scan_metrics(bigint)",
        "library.load_authorized_full_scan_preview(bigint)",
        "library.load_authorized_full_scan_relation_status(bigint)",
    )
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
                "select to_regprocedure(%s) is not null as present", (procedure,)
            ).fetchone()["present"] is True
            assert connection.execute(
                "select has_function_privilege('album_haven_worker', %s, 'EXECUTE') as allowed",
                (procedure,),
            ).fetchone()["allowed"] is True
            for role in ("album_haven_app", "album_haven_readonly"):
                assert connection.execute(
                    "select has_function_privilege(%s, %s, 'EXECUTE') as allowed",
                    (role, procedure),
                ).fetchone()["allowed"] is False
        for procedure in retired_worker_procedures:
            assert connection.execute(
                "select has_function_privilege('album_haven_worker', %s, 'EXECUTE') as allowed",
                (procedure,),
            ).fetchone()["allowed"] is False
        for procedure in app_read_procedures:
            assert connection.execute(
                "select to_regprocedure(%s) is not null as present", (procedure,)
            ).fetchone()["present"] is True
            assert connection.execute(
                "select has_function_privilege('album_haven_app', %s, 'EXECUTE') as allowed",
                (procedure,),
            ).fetchone()["allowed"] is True
            for role in ("album_haven_worker", "album_haven_readonly"):
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


def test_live_targeted_paths_moves_and_preserved_subtrees_round_trip_through_claimed_loader(
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
        preserved_subtrees=frozenset(
            {Path(r"C:\Music\Gone\Recreated Disc")}
        ),
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
    assert loaded.request == request
    assert loaded.intent_id == enqueue_result.intent_id
    assert loaded.exception_overrides == {}
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
        (
            "preserved_subtree",
            str(Path(r"C:\Music\Gone\Recreated Disc")),
            0,
        ),
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


def test_live_authorized_operator_cancels_linked_scan_without_resetting_progress(
    live_scan_database,
):
    setup_url, runtime_url, _ = live_scan_database
    initiating_account_id, library_id = _seed_scope(setup_url, "operator-cancel")
    accepted = _scan_repository(runtime_url).enqueue_full_scan(
        **_full_scan_arguments(
            initiating_account_id, library_id, "operator-cancel"
        )
    )
    with isolatedPostgres._connect(setup_url) as connection:
        operator_account_id = int(
            connection.execute(
                """
                insert into app.accounts (
                  display_name, username_display, username_normalized,
                  contact_email, contact_email_normalized, account_kind, is_active
                ) values (%s, %s, %s, %s, %s, 'managed', true)
                returning id
                """,
                (
                    "Scan Operator",
                    "scan-operator-cancel",
                    "scan-operator-cancel",
                    "scan-operator-cancel@example.invalid",
                    "scan-operator-cancel@example.invalid",
                ),
            ).fetchone()["id"]
        )
        connection.execute(
            """
            insert into library.library_memberships (
              library_id, account_id, membership_role
            ) values (%s, %s, 'operator')
            """,
            (library_id, operator_account_id),
        )
        connection.execute(
            """
            insert into app.capabilities (
              account_id, capability_key, scope_kind, scope_id
            ) values (%s, 'library.refresh.cancel', 'library', %s)
            """,
            (operator_account_id, library_id),
        )
        connection.execute(
            """
            update library.full_scan_intents
               set progress_current = 3, progress_total = 5
             where id = %s
            """,
            (accepted.intent_id,),
        )

    result = _scan_repository(runtime_url).cancel_authorized_full_scan(
        policy_evaluation=_cancel_evaluation(operator_account_id, library_id),
        library_id=library_id,
        now=datetime(2099, 1, 2, tzinfo=timezone.utc),
    )

    assert result is not None
    assert result.job_id == accepted.job_id
    assert result.disposition is JobCancellationDisposition.IMMEDIATE_CANCELED
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            """
            select intent.state, intent.progress_current, intent.progress_total,
                   job.cancel_requested_by_account_id
              from library.full_scan_intents as intent
              join ops.jobs as job on job.id = intent.job_id
             where intent.id = %s
            """,
            (accepted.intent_id,),
        ).fetchone()
    assert row == {
        "state": "canceled",
        "progress_current": 3,
        "progress_total": 5,
        "cancel_requested_by_account_id": operator_account_id,
    }


def test_live_cancellation_ignores_unlinked_full_scan_job(live_scan_database):
    setup_url, runtime_url, _ = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "unlinked-cancel")
    job_id = PostgresJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    ).enqueue(
        EnqueueJob(
            kind=JobKind.FULL_SCAN,
            subject_kind="full_scan_intent",
            subject_ref="999999",
            parameters={"intent_id": 999999},
            account_id=account_id,
            library_id=library_id,
            capability_key="library.refresh",
            request_origin_ref="browser:scan-jobs-unlinked-cancel",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            idempotency_key="full-scan-unlinked-live",
            scheduled_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
            max_attempts=2,
        )
    )

    result = _scan_repository(runtime_url).cancel_authorized_full_scan(
        policy_evaluation=_cancel_evaluation(account_id, library_id),
        library_id=library_id,
        now=datetime(2099, 1, 2, tzinfo=timezone.utc),
    )

    assert result is None
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select state from ops.jobs where id = %s", (job_id,)
        ).fetchone()["state"] == "queued"


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

    scan_repository = _scan_repository(worker_url)
    intent = scan_repository.load_claimed_full_scan(
        job_id=claimed.job_id,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
    )
    checkpoint = {
        "intent_id": accepted.intent_id,
        "job_id": claimed.job_id,
        "attempt": claimed.attempt,
        "worker_id": claimed.worker_id,
        "lease_token": claimed.lease_token,
        "phase": "indexing",
        "current": 40,
        "total": 100,
        "current_path": "C:/private/phase8/transitions/track.flac",
        "now": datetime.now(timezone.utc),
    }
    assert intent.inventory_mutation_revision >= 0
    assert scan_repository.checkpoint_claimed_full_scan(
        **{**checkpoint, "attempt": claimed.attempt + 1}
    ) is False
    assert scan_repository.checkpoint_claimed_full_scan(
        **{**checkpoint, "worker_id": "wrong-worker"}
    ) is False
    assert scan_repository.checkpoint_claimed_full_scan(
        **{**checkpoint, "lease_token": "wrong-token"}
    ) is False
    assert scan_repository.checkpoint_claimed_full_scan(**checkpoint) is True
    advanced = {**checkpoint, "current": 80, "now": datetime.now(timezone.utc)}
    assert scan_repository.checkpoint_claimed_full_scan(**advanced) is True
    assert scan_repository.checkpoint_claimed_full_scan(**checkpoint) is False

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
            "committed_inventory_revision": None,
        }
        connection.execute(
            "update ops.jobs set lease_expires_at = %s where id = %s",
            (datetime.now(timezone.utc) - timedelta(seconds=1), claimed.job_id),
        )
    assert scan_repository.checkpoint_claimed_full_scan(
        **{**advanced, "current": 90, "now": datetime.now(timezone.utc)}
    ) is False

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


def _enqueue_and_claim_targeted(
    *, setup_url: str, runtime_url: str, worker_url: str, suffix: str
):
    _, library_id = _seed_scope(setup_url, suffix)
    accepted_root = rf"C:\private\scan-jobs-{suffix}\a"
    accepted = _scan_repository(runtime_url).enqueue_targeted_reconciliation(
        library_id=library_id,
        request=TargetedReconciliationRequest(
            root_id="root-a",
            paths=frozenset({Path(accepted_root) / "Artist" / "Album" / "01.flac"}),
        ),
        producer_request_key=f"watcher-{suffix}-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    claimed = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id=f"scan-{suffix}-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claimed is not None and claimed.job_id == accepted.job_id
    return library_id, accepted, claimed


def test_live_worker_reconstructs_claimed_paths_from_current_root_and_scope(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    suffix = "current-root"
    library_id, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix=suffix,
    )
    current_root = rf"E:\relocated\scan-jobs-{suffix}\a"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into library.exception_overrides (library_id, track_key, override_payload) values (%s, %s, %s::jsonb)",
            (
                library_id,
                rf"C:\private\scan-jobs-{suffix}\a\Artist\Album\02.flac",
                json.dumps({"exception_type": "Interview"}),
            ),
        )
        connection.execute(
            """
            update library.library_roots set root_path = %s
             where library_id = %s and metadata ->> 'root_id' = 'root-a'
            """,
            (current_root, library_id),
        )

    worker_repository = _scan_repository(worker_url)
    loaded = worker_repository.load_claimed_targeted_reconciliation(
        job_id=claimed.job_id,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
    )
    scope = worker_repository.load_claimed_targeted_reconciliation_scope(
        intent_id=accepted.intent_id,
        library_id=library_id,
        job_id=claimed.job_id,
        attempt=claimed.attempt,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
        now=datetime.now(timezone.utc),
    )

    assert loaded.paths == frozenset(
        {Path(current_root) / "Artist" / "Album" / "01.flac"}
    )
    assert loaded.exception_overrides == {
        str(Path(current_root) / "Artist" / "Album" / "02.flac"): "Interview"
    }
    assert scope.root_healthy is True
    assert scope.roots == (
        {
            "id": "root-a",
            "path": Path(current_root),
            "category": "main",
            "library_id": library_id,
            "is_active": True,
        },
    )


def test_live_worker_scope_reports_persisted_unhealthy_root(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    library_id, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix="unhealthy-root",
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            """
            update library.libraries
               set metadata = metadata || jsonb_build_object(
                 'library_watch_health',
                 jsonb_build_object('root-a', jsonb_build_object(
                   'state', 'unavailable'
                 ))
               )
             where id = %s
            """,
            (library_id,),
        )

    scope = _scan_repository(worker_url).load_claimed_targeted_reconciliation_scope(
        intent_id=accepted.intent_id,
        library_id=library_id,
        job_id=claimed.job_id,
        attempt=claimed.attempt,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
        now=datetime.now(timezone.utc),
    )

    assert scope.root_healthy is False


def test_live_worker_scope_fails_closed_when_one_move_root_was_removed(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    _, library_id = _seed_scope(setup_url, "removed-move-root")
    accepted = _scan_repository(runtime_url).enqueue_targeted_reconciliation(
        library_id=library_id,
        request=TargetedReconciliationRequest(
            root_id="root-a",
            moves=(
                TargetedMove(
                    source=Path(
                        r"C:\private\scan-jobs-removed-move-root\a\Artist\01.flac"
                    ),
                    destination=Path(
                        r"D:\private\scan-jobs-removed-move-root\b\Artist\01.flac"
                    ),
                    source_root_id="root-a",
                    destination_root_id="root-b",
                ),
            ),
        ),
        producer_request_key="watcher-removed-move-root-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    claimed = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id="scan-removed-move-root-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claimed is not None and claimed.job_id == accepted.job_id
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update library.library_roots set is_active = false where library_id = %s and metadata ->> 'root_id' = 'root-b'",
            (library_id,),
        )

    scope = _scan_repository(worker_url).load_claimed_targeted_reconciliation_scope(
        intent_id=accepted.intent_id,
        library_id=library_id,
        job_id=claimed.job_id,
        attempt=claimed.attempt,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
        now=datetime.now(timezone.utc),
    )

    assert {root["id"] for root in scope.roots} == {"root-a"}
    assert scope.scope_complete is False


def test_live_claim_fence_publishes_once_for_the_exact_attempt(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    _, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix="publication-once",
    )
    repository = _scan_repository(worker_url)
    with isolatedPostgres._connect(worker_url) as connection:
        assert repository.fence_targeted_reconciliation_publication(
            connection=connection,
            claim=claimed,
            intent_id=accepted.intent_id,
            commit=connection.commit,
            now=datetime.now(timezone.utc),
        ) is True
        assert repository.fence_targeted_reconciliation_publication(
            connection=connection,
            claim=claimed,
            intent_id=accepted.intent_id,
            commit=connection.commit,
            now=datetime.now(timezone.utc),
        ) is False
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select publication_attempt from library.targeted_reconciliation_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()["publication_attempt"] == claimed.attempt


def test_live_claimed_publication_commits_inventory_revision_exactly_once(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    library_id, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix="authoritative-publication",
    )
    with isolatedPostgres._connect(setup_url) as connection:
        owner_account_id = connection.execute(
            "select owner_account_id from library.libraries where id = %s",
            (library_id,),
        ).fetchone()["owner_account_id"]
        connection.execute(
            "update app.bootstrap_owners set account_id = %s where owner_key = 'local-bootstrap-owner'",
            (owner_account_id,),
        )
        connection.execute(
            "update library.libraries set name = 'Local Library' where id = %s",
            (library_id,),
        )

    repository = _scan_repository(worker_url)
    private_path = rf"C:\private\scan-jobs-authoritative-publication\a\Artist\Album\01.flac"
    inventory = {
        "artists": [
            {
                "artist_key": "artist",
                "name": "Artist",
                "sort_name": "Artist",
                "metadata": {},
            }
        ],
        "albums": [
            {
                "artist_key": "artist",
                "album_key": "artist::album",
                "title": "Album",
                "release_year": 2026,
                "cover_path": None,
                "metadata": {},
            }
        ],
        "featured_artists": [],
        "tracks": [
            {
                "album_key": "artist::album",
                "artist_key": "artist",
                "track_key": "artist::album::01",
                "title": "Track",
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 180,
                "metadata": {},
            }
        ],
        "track_files": [
            {
                "track_key": "artist::album::01",
                "private_path": private_path,
                "relative_path": r"Artist\Album\01.flac",
                "file_size_bytes": 1024,
                "modified_at_epoch": 1_788_710_400.0,
                "metadata": {},
            }
        ],
    }
    first = repository.publish_claimed_targeted_reconciliation(
        claim=claimed,
        intent_id=accepted.intent_id,
        inventory=inventory,
        stale_scopes=(),
        now=datetime.now(timezone.utc),
    )
    second = repository.publish_claimed_targeted_reconciliation(
        claim=claimed,
        intent_id=accepted.intent_id,
        inventory=inventory,
        stale_scopes=(),
        now=datetime.now(timezone.utc),
    )

    import psycopg

    tampered_inventory = json.loads(json.dumps(inventory))
    tampered_inventory["track_files"][0]["private_path"] = (
        r"C:\private\unrelated\Secret\01.flac"
    )
    with pytest.raises(psycopg.errors.RaiseException, match="file scope"):
        repository.publish_claimed_targeted_reconciliation(
            claim=claimed,
            intent_id=accepted.intent_id,
            inventory=tampered_inventory,
            stale_scopes=(),
            now=datetime.now(timezone.utc),
        )
    with pytest.raises(psycopg.errors.RaiseException, match="stale scope"):
        repository.publish_claimed_targeted_reconciliation(
            claim=claimed,
            intent_id=accepted.intent_id,
            inventory=inventory,
            stale_scopes=(
                {
                    "root_id": "root-a",
                    "paths": [r"C:\private\unrelated\Secret\01.flac"],
                    "subtrees": [],
                },
            ),
            now=datetime.now(timezone.utc),
        )

    assert first["publication_won"] is True
    assert first["inventory_mutation_revision"] == 1
    assert second == {
        "publication_won": False,
        "inventory_mutation_revision": 1,
        "affected_album_keys": ("artist::album",),
    }
    with isolatedPostgres._connect(setup_url) as connection:
        intent = connection.execute(
            "select publication_attempt, committed_inventory_revision from library.targeted_reconciliation_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()
        assert intent == {
            "publication_attempt": claimed.attempt,
            "committed_inventory_revision": 1,
        }
        assert connection.execute(
            "select metadata #>> '{scan_cache,relation_projection,status}' as status from library.libraries where id = %s",
            (library_id,),
        ).fetchone()["status"] == "stale"
        assert connection.execute(
            "select count(*) as count from library.local_track_files where private_path = %s",
            (private_path,),
        ).fetchone()["count"] == 1


def test_live_targeted_publication_reuses_unseparated_semantic_album_identity(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    suffix = "semantic-album-identity"
    library_id, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix=suffix,
    )
    with isolatedPostgres._connect(setup_url) as connection:
        owner_account_id = connection.execute(
            "select owner_account_id from library.libraries where id = %s",
            (library_id,),
        ).fetchone()["owner_account_id"]
        connection.execute(
            "update app.bootstrap_owners set account_id = %s "
            "where owner_key = 'local-bootstrap-owner'",
            (owner_account_id,),
        )
        connection.execute(
            "update library.libraries set name = 'Local Library' where id = %s",
            (library_id,),
        )
        artist_id = connection.execute(
            "insert into library.local_artists "
            "(library_id, artist_key, name, sort_name, metadata) "
            "values (%s, 'artist', 'Artist', 'Artist', '{}'::jsonb) returning id",
            (library_id,),
        ).fetchone()["id"]
        existing_album_id = connection.execute(
            "insert into library.local_albums "
            "(library_id, artist_id, album_key, title, release_year, metadata) "
            "values (%s, %s, 'artist::album', 'Album', 2026, "
            "jsonb_build_object('album_artist', 'Artist')) returning id",
            (library_id, artist_id),
        ).fetchone()["id"]

    private_path = (
        rf"C:\private\scan-jobs-{suffix}\a\Artist\Album\01.flac"
    )
    result = _scan_repository(worker_url).publish_claimed_targeted_reconciliation(
        claim=claimed,
        intent_id=accepted.intent_id,
        inventory={
            "artists": [{
                "artist_key": "artist",
                "name": "Artist",
                "sort_name": "Artist",
                "metadata": {},
            }],
            "albums": [{
                "artist_key": "artist",
                "album_key": "artist::album::year::2026",
                "title": "Album",
                "release_year": 2026,
                "cover_path": None,
                "metadata": {"album_artist": "Artist"},
            }],
            "featured_artists": [],
            "tracks": [{
                "album_key": "artist::album::year::2026",
                "artist_key": "artist",
                "track_key": "artist::album::01",
                "title": "Track",
                "disc_number": 1,
                "track_number": 1,
                "duration_seconds": 180,
                "metadata": {},
            }],
            "track_files": [{
                "track_key": "artist::album::01",
                "private_path": private_path,
                "relative_path": r"Artist\Album\01.flac",
                "file_size_bytes": 1024,
                "modified_at_epoch": 1_788_710_400.0,
                "metadata": {},
            }],
        },
        stale_scopes=(),
        now=datetime.now(timezone.utc),
    )

    assert result["publication_won"] is True
    with isolatedPostgres._connect(setup_url) as connection:
        albums = connection.execute(
            "select id, album_key from library.local_albums where library_id = %s",
            (library_id,),
        ).fetchall()
        track = connection.execute(
            "select album_id from library.local_tracks "
            "where library_id = %s and track_key = 'artist::album::01'",
            (library_id,),
        ).fetchone()
    assert albums == [{"id": existing_album_id, "album_key": "artist::album"}]
    assert track["album_id"] == existing_album_id


def test_live_lost_lease_rolls_back_pending_publication_transaction(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    _, accepted, claimed = _enqueue_and_claim_targeted(
        setup_url=setup_url,
        runtime_url=runtime_url,
        worker_url=worker_url,
        suffix="lease-loss",
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update ops.jobs set lease_expires_at = now() - interval '1 second' where id = %s",
            (claimed.job_id,),
        )

    repository = _scan_repository(worker_url)
    with isolatedPostgres._connect(worker_url) as connection:
        assert repository.fence_targeted_reconciliation_publication(
            connection=connection,
            claim=claimed,
            intent_id=accepted.intent_id,
            commit=connection.commit,
            now=datetime.now(timezone.utc),
        ) is False
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select publication_attempt from library.targeted_reconciliation_intents where id = %s",
            (accepted.intent_id,),
        ).fetchone()["publication_attempt"] is None


@pytest.mark.parametrize(
    "statement",
    (
        "select id from library.library_roots limit 1",
        "select id from library.libraries limit 1",
        "select id from app.accounts limit 1",
        "select id from app.capabilities limit 1",
        "select id from app.request_origins limit 1",
    ),
)
def test_live_worker_role_cannot_read_unrelated_library_or_app_data(
    live_scan_database, statement
):
    import psycopg

    _, _, worker_url = live_scan_database
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with isolatedPostgres._connect(worker_url) as connection:
            connection.execute(statement).fetchone()


@pytest.mark.parametrize(
    "table",
    (
        "library.local_artists",
        "library.local_albums",
        "library.local_tracks",
        "library.local_track_files",
        "library.local_album_featured_artists",
    ),
)
@pytest.mark.parametrize("privilege", ("SELECT", "INSERT", "UPDATE", "DELETE"))
def test_live_worker_has_no_direct_inventory_table_privileges(
    live_scan_database, table, privilege
):
    setup_url, _, _ = live_scan_database

    with isolatedPostgres._connect(setup_url) as connection:
        allowed = connection.execute(
            "select has_table_privilege('album_haven_worker', %s, %s) as allowed",
            (table, privilege),
        ).fetchone()["allowed"]

    assert allowed is False


def test_live_full_scan_worker_publishes_only_through_claim_scoped_function(
    live_scan_database,
):
    import psycopg

    setup_url, runtime_url, worker_url = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "full-publication")
    arguments = _full_scan_arguments(account_id, library_id, "full-publication")
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    worker_jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = worker_jobs.claim(
        worker_id="full-publication-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claim is not None and claim.job_id == accepted.job_id
    scans = _scan_repository(worker_url)
    intent = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    scope = scans.load_claimed_full_scan_scope(
        intent_id=intent.intent_id,
        library_id=intent.library_id,
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=datetime.now(timezone.utc),
    )
    with isolatedPostgres._connect(setup_url) as connection:
        assert connection.execute(
            "select count(*) as count from ops.jobs "
            "where kind = 'post_scan_cover_refresh' and library_id = %s",
            (library_id,),
        ).fetchone()["count"] == 0
    result = scans.publish_claimed_full_scan(
        claim=claim,
        intent_id=intent.intent_id,
        expected_inventory_mutation_revision=intent.inventory_mutation_revision,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=[root["id"] for root in scope.roots],
        now=datetime.now(timezone.utc),
    )
    assert result == {
        "publication_won": True,
        "inventory_mutation_revision": intent.inventory_mutation_revision + 1,
    }
    with isolatedPostgres._connect(setup_url) as connection:
        follow_ups = connection.execute(
            "select subject_kind, subject_ref, parameters, account_id, "
            "capability_key, request_origin_id, resource_revision, "
            "idempotency_key from ops.jobs "
            "where kind = 'post_scan_cover_refresh' and library_id = %s",
            (library_id,),
        ).fetchall()
        album_total = connection.execute(
            "select library.load_authorized_album_total(%s) as album_total",
            (library_id,),
        ).fetchone()
        cover_status = connection.execute(
            "select * from ops.load_authorized_cover_refresh_status(%s)",
            (library_id,),
        ).fetchone()
    assert len(follow_ups) == 1
    assert dict(follow_ups[0]) == {
        "subject_kind": "inventory_revision",
        "subject_ref": f"revision-{intent.inventory_mutation_revision + 1}",
        "parameters": {
            "inventory_revision": intent.inventory_mutation_revision + 1
        },
        "account_id": None,
        "capability_key": None,
        "request_origin_id": None,
        "resource_revision": intent.inventory_mutation_revision + 1,
        "idempotency_key": (
            f"post-scan-cover-refresh:{library_id}:"
            f"{intent.inventory_mutation_revision + 1}"
        ),
    }
    assert album_total["album_total"] == 0
    assert cover_status == {
        "covers_in_progress": True,
        "covers_processed": 0,
        "covers_total": 0,
        "covers_downloaded": 0,
        "covers_current_folder": "",
    }
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with isolatedPostgres._connect(worker_url) as connection:
            connection.execute(
                "select private_path from library.local_track_files"
            ).fetchall()
    recovered = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    assert (
        recovered.committed_inventory_revision
        == result["inventory_mutation_revision"]
    )
    _settle_post_scan_cover_follow_ups(setup_url, library_id)


def test_live_full_scan_publication_rollback_cannot_lose_cover_follow_up(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "full-publication-rollback")
    arguments = _full_scan_arguments(account_id, library_id, "full-publication-rollback")
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    claim = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id="full-publication-rollback-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claim is not None and claim.job_id == accepted.job_id
    scans = _scan_repository(worker_url)
    intent = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    inventory = {
        "artists": [],
        "albums": [],
        "featured_artists": [],
        "tracks": [],
        "track_files": [],
    }

    connection = isolatedPostgres._connect(worker_url)
    try:
        row = connection.execute(
            "select * from library.publish_claimed_full_scan("
            "%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)",
            (
                intent.intent_id,
                claim.job_id,
                claim.attempt,
                claim.worker_id,
                claim.lease_token,
                intent.inventory_mutation_revision,
                json.dumps(inventory),
                list(intent.root_ids),
                datetime.now(timezone.utc),
            ),
        ).fetchone()
        assert row["publication_won"] is True
        connection.rollback()
    finally:
        connection.close()

    with isolatedPostgres._connect(setup_url) as setup:
        assert setup.execute(
            "select committed_inventory_revision from library.full_scan_intents "
            "where id = %s",
            (intent.intent_id,),
        ).fetchone()["committed_inventory_revision"] is None
        assert setup.execute(
            "select count(*) as count from ops.jobs "
            "where kind = 'post_scan_cover_refresh' and library_id = %s",
            (library_id,),
        ).fetchone()["count"] == 0

    result = scans.publish_claimed_full_scan(
        claim=claim,
        intent_id=intent.intent_id,
        expected_inventory_mutation_revision=intent.inventory_mutation_revision,
        inventory=inventory,
        observed_root_ids=intent.root_ids,
        now=datetime.now(timezone.utc),
    )
    assert result["publication_won"] is True
    with isolatedPostgres._connect(setup_url) as setup:
        assert setup.execute(
            "select count(*) as count from ops.jobs "
            "where kind = 'post_scan_cover_refresh' and library_id = %s",
            (library_id,),
        ).fetchone()["count"] == 1
    _settle_post_scan_cover_follow_ups(setup_url, library_id)


def test_live_full_scan_publication_rolls_back_on_follow_up_identity_collision(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    account_id, library_id = _seed_scope(setup_url, "full-follow-up-collision")
    arguments = _full_scan_arguments(account_id, library_id, "full-follow-up-collision")
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    claim = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id="full-follow-up-collision-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claim is not None and claim.job_id == accepted.job_id
    scans = _scan_repository(worker_url)
    intent = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )
    committed_revision = intent.inventory_mutation_revision + 1
    with isolatedPostgres._connect(setup_url) as setup:
        setup.execute(
            "insert into ops.jobs (kind, subject_kind, subject_ref, parameters, "
            "library_id, deployment_mode, client_surface, resource_revision, "
            "idempotency_key, scheduled_at, max_attempts, recovery_policy) "
            "values ('post_scan_cover_refresh', 'inventory_revision', %s, %s::jsonb, "
            "%s, 'self_hosted_private_web', 'private_web', %s, %s, now(), 2, "
            "'retry_safe')",
            (
                f"revision-{committed_revision}",
                json.dumps({"inventory_revision": committed_revision + 99}),
                library_id,
                committed_revision + 99,
                f"post-scan-cover-refresh:{library_id}:{committed_revision}",
            ),
        )

    with pytest.raises(Exception, match="follow-up identity conflict"):
        scans.publish_claimed_full_scan(
            claim=claim,
            intent_id=intent.intent_id,
            expected_inventory_mutation_revision=intent.inventory_mutation_revision,
            inventory={
                "artists": [],
                "albums": [],
                "featured_artists": [],
                "tracks": [],
                "track_files": [],
            },
            observed_root_ids=intent.root_ids,
            now=datetime.now(timezone.utc),
        )

    with isolatedPostgres._connect(setup_url) as setup:
        assert setup.execute(
            "select committed_inventory_revision from library.full_scan_intents "
            "where id = %s",
            (intent.intent_id,),
        ).fetchone()["committed_inventory_revision"] is None
        assert setup.execute(
            "select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0) "
            "as revision from library.libraries where id = %s",
            (library_id,),
        ).fetchone()["revision"] == intent.inventory_mutation_revision
        setup.execute(
            "delete from ops.jobs where kind = 'post_scan_cover_refresh' "
            "and library_id = %s",
            (library_id,),
        )


@pytest.mark.parametrize("revocation", ("cancel", "account", "root"))
def test_live_full_scan_publication_revalidates_claim_authority_and_roots(
    live_scan_database,
    revocation,
):
    setup_url, runtime_url, worker_url = live_scan_database
    suffix = f"full-revoked-{revocation}"
    account_id, library_id = _seed_scope(setup_url, suffix)
    arguments = _full_scan_arguments(account_id, library_id, suffix)
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    claim = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id=f"{suffix}-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claim is not None and claim.job_id == accepted.job_id
    scans = _scan_repository(worker_url)
    intent = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )

    with isolatedPostgres._connect(setup_url) as connection:
        if revocation == "cancel":
            connection.execute(
                "update ops.jobs set cancel_requested_at = now(), "
                "cancel_reason_code = 'user_requested' where id = %s",
                (claim.job_id,),
            )
        elif revocation == "account":
            connection.execute(
                "update app.accounts set is_active = false where id = %s",
                (account_id,),
            )
        else:
            connection.execute(
                "update library.library_roots set is_active = false "
                "where library_id = %s and metadata ->> 'root_id' = 'root-a'",
                (library_id,),
            )

    result = scans.publish_claimed_full_scan(
        claim=claim,
        intent_id=intent.intent_id,
        expected_inventory_mutation_revision=intent.inventory_mutation_revision,
        inventory={
            "artists": [],
            "albums": [],
            "featured_artists": [],
            "tracks": [],
            "track_files": [],
        },
        observed_root_ids=intent.root_ids,
        now=datetime.now(timezone.utc),
    )

    assert result["publication_won"] is False
    with isolatedPostgres._connect(setup_url) as connection:
        revision = connection.execute(
            "select coalesce(nullif(metadata ->> 'inventory_mutation_revision', '')::bigint, 0) as revision "
            "from library.libraries where id = %s",
            (library_id,),
        ).fetchone()["revision"]
        follow_up_count = connection.execute(
            "select count(*) as count from ops.jobs "
            "where kind = 'post_scan_cover_refresh' and library_id = %s",
            (library_id,),
        ).fetchone()["count"]
    assert revision == intent.inventory_mutation_revision
    assert follow_up_count == 0


def test_live_full_scan_publication_waits_for_concurrent_authority_revocation(
    live_scan_database,
):
    setup_url, runtime_url, worker_url = live_scan_database
    suffix = "full-concurrent-revocation"
    account_id, library_id = _seed_scope(setup_url, suffix)
    arguments = _full_scan_arguments(account_id, library_id, suffix)
    arguments["scheduled_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
    accepted = _scan_repository(runtime_url).enqueue_full_scan(**arguments)
    claim = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id=f"{suffix}-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claim is not None and claim.job_id == accepted.job_id
    scans = _scan_repository(worker_url)
    intent = scans.load_claimed_full_scan(
        job_id=claim.job_id,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
    )

    def publish():
        return scans.publish_claimed_full_scan(
            claim=claim,
            intent_id=intent.intent_id,
            expected_inventory_mutation_revision=intent.inventory_mutation_revision,
            inventory={
                "artists": [],
                "albums": [],
                "featured_artists": [],
                "tracks": [],
                "track_files": [],
            },
            observed_root_ids=intent.root_ids,
            now=datetime.now(timezone.utc),
        )

    with isolatedPostgres._connect(setup_url) as revoker:
        revoker.execute(
            "update app.accounts set is_active = false where id = %s",
            (account_id,),
        )
        with ThreadPoolExecutor(max_workers=1) as executor:
            publication = executor.submit(publish)
            with pytest.raises(FutureTimeoutError):
                publication.result(timeout=0.2)
            revoker.commit()
            result = publication.result(timeout=5)

    assert result["publication_won"] is False


def test_live_worker_loads_active_directory_membership_without_private_reads(
    live_scan_database,
    tmp_path,
):
    import psycopg

    from music_app.services.scan_cache_persistence import (
        DurableTargetedReconciliationPreparationAdapter,
    )

    setup_url, runtime_url, worker_url = live_scan_database
    suffix = "worker-preparation-directory"
    _, library_id = _seed_scope(setup_url, suffix)
    root = tmp_path / "library"
    active_directory = root / "Artist" / "Album" / "Disc 2"
    active_directory.mkdir(parents=True)
    disc_one_path = root / "Artist" / "Album" / "Disc 1" / "01.flac"
    disc_two_path = active_directory / "01.flac"

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            """
            update library.library_roots
               set root_path = %s
             where library_id = %s
               and metadata ->> 'root_id' = 'root-a'
            """,
            (str(root), library_id),
        )
        artist_id = connection.execute(
            """
            insert into library.local_artists (library_id, artist_key, name)
            values (%s, 'artist', 'Artist')
            returning id
            """,
            (library_id,),
        ).fetchone()["id"]
        album_id = connection.execute(
            """
            insert into library.local_albums (
              library_id, artist_id, album_key, title
            ) values (%s, %s, 'artist::album', 'Album')
            returning id
            """,
            (library_id, artist_id),
        ).fetchone()["id"]
        for disc_number, private_path in (
            (1, disc_one_path),
            (2, disc_two_path),
        ):
            track_id = connection.execute(
                """
                insert into library.local_tracks (
                  library_id, album_id, artist_id, track_key, title,
                  disc_number, track_number
                ) values (%s, %s, %s, %s, 'Track 1', %s, 1)
                returning id
                """,
                (
                    library_id,
                    album_id,
                    artist_id,
                    f"artist::album::disc-{disc_number}::track-1",
                    disc_number,
                ),
            ).fetchone()["id"]
            connection.execute(
                """
                insert into library.local_track_files (track_id, private_path)
                values (%s, %s)
                """,
                (track_id, str(private_path)),
            )

    accepted = _scan_repository(runtime_url).enqueue_targeted_reconciliation(
        library_id=library_id,
        request=TargetedReconciliationRequest(
            root_id="root-a",
            paths=frozenset({active_directory}),
        ),
        producer_request_key=f"watcher-{suffix}-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    claimed = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    ).claim(
        worker_id=f"scan-{suffix}-worker",
        now=datetime.now(timezone.utc),
        lease_seconds=300,
    )
    assert claimed is not None and claimed.job_id == accepted.job_id

    worker_repository = _scan_repository(worker_url)
    preparation = worker_repository.load_claimed_targeted_reconciliation_preparation(
        intent_id=accepted.intent_id,
        library_id=library_id,
        job_id=claimed.job_id,
        attempt=claimed.attempt,
        worker_id=claimed.worker_id,
        lease_token=claimed.lease_token,
        now=datetime.now(timezone.utc),
    )

    assert preparation.separate_release_keys == ()
    assert [
        membership["private_path"]
        for membership in preparation.existing_memberships
    ] == [str(disc_two_path)]

    class PublicationGuard:
        def publish_prepared(self, *, inventory, stale_scopes):
            return worker_repository.publish_claimed_targeted_reconciliation(
                claim=claimed,
                intent_id=accepted.intent_id,
                inventory=inventory,
                stale_scopes=stale_scopes,
                now=datetime.now(timezone.utc),
            )

    result = DurableTargetedReconciliationPreparationAdapter(
        build_albums=lambda _cache, _separate: []
    ).persist_targeted_inventory_mutation(
        root_id="root-a",
        active_file_entries={},
        preparation_scope=preparation,
        publication_guard=PublicationGuard(),
    )

    assert result["publication_won"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with isolatedPostgres._connect(worker_url) as connection:
            connection.execute(
                "select release_key from library.separate_releases "
                "where library_id = %s",
                (library_id,),
            ).fetchall()
