from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
import os
from pathlib import Path
from threading import Barrier, Event
from urllib.parse import urlparse

import pytest

from music_app.services.jobs.models import (
    EnqueueJob,
    JobCancellationDisposition,
    JobState,
    JobTransitionResult,
)
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from tests.e2e.support import isolatedPostgres


def _skip_or_fail_ci(message: str) -> None:
    is_ci = any(
        str(os.environ.get(name) or "").strip().casefold()
        in {"1", "true", "yes"}
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
    worker_url = str(
        os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or ""
    ).strip()
    if not worker_url:
        _skip_or_fail_ci("Dedicated worker Postgres URL is not configured.")
    pgpass = Path(str(os.environ.get("PGPASSFILE") or ""))
    if not pgpass.is_file():
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
            isolatedPostgres._assert_connected_role(
                connection, "album_haven_worker"
            )
    except Exception:
        _skip_or_fail_ci("Dedicated worker Postgres role is unavailable.")
    return setup_url, runtime_url, worker_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(
            connection, isolatedPostgres.SETUP_ROLE
        )
        connection.execute("drop schema if exists app, integration, library, ops cascade")


def _repository(url: str) -> PostgresJobRepository:
    return PostgresJobRepository(
        database_url=url,
        connect_to_database=isolatedPostgres._connect,
    )


def _insert_job(
    setup_url: str,
    key: str,
    priority: int = 0,
    account_id: int | None = None,
) -> int:
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            """
            insert into ops.jobs (
              kind, subject_kind, subject_ref, parameters, deployment_mode,
              client_surface, idempotency_key, priority, max_attempts,
              recovery_policy, account_id, scheduled_at
            ) values (
              'auth_password_reset_delivery', 'mail_outbox', %s, '{}'::jsonb,
              'self_hosted_private_web', 'private_web', %s, %s, 1,
              'ambiguous_on_stale_lease', %s, now() - interval '1 second'
            ) returning id
            """,
            (key, f"phase8:{key}", priority, account_id),
        ).fetchone()
    return int(row["id"])


def test_live_repository_concurrency_cas_cancellation_and_recovery_contracts():
    setup_url, runtime_url, worker_url = _database_urls_or_skip()
    cleanup_complete = False
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        app = _repository(runtime_url)
        worker = _repository(worker_url)

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                insert into app.request_origins (
                  client_surface_class, origin_type, origin_key
                ) values ('private_web', 'origin', 'phase8-enqueue')
                on conflict (client_surface_class, origin_type, origin_key)
                do nothing
                """
            )
            actor_account_id = int(
                connection.execute(
                    "select min(id) as account_id from app.accounts"
                ).fetchone()["account_id"]
            )
        command = EnqueueJob(
            kind="auth_password_reset_delivery",
            subject_kind="mail_outbox",
            subject_ref="phase8-duplicate",
            parameters={},
            account_id=None,
            library_id=None,
            capability_key=None,
            request_origin_ref="origin:phase8-enqueue",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            idempotency_key="phase8:duplicate",
            scheduled_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
            max_attempts=1,
        )
        with ThreadPoolExecutor(max_workers=2) as executor:
            duplicate_ids = list(executor.map(lambda _: app.enqueue(command), range(2)))
        assert len(set(duplicate_ids)) == 1

        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                """
                insert into app.request_origins (
                  client_surface_class, origin_type, origin_key
                ) values ('private_web', 'origin', 'phase8-enqueue-retry')
                on conflict (client_surface_class, origin_type, origin_key)
                do nothing
                """
            )
        retried_from_another_origin = app.enqueue(
            replace(command, request_origin_ref="origin:phase8-enqueue-retry")
        )
        assert retried_from_another_origin == duplicate_ids[0]

        locked_id = _insert_job(setup_url, "locked", 100)
        available_id = _insert_job(setup_url, "available", 90)
        lock_ready = Barrier(2)
        release_lock = Event()

        def hold_lock() -> None:
            with isolatedPostgres._connect(setup_url) as connection:
                connection.execute(
                    "select id from ops.jobs where id = %s for update", (locked_id,)
                )
                lock_ready.wait(timeout=5)
                assert release_lock.wait(timeout=5)

        with ThreadPoolExecutor(max_workers=2) as executor:
            holder = executor.submit(hold_lock)
            lock_ready.wait(timeout=5)
            claimant = executor.submit(
                worker.claim,
                worker_id="worker-skip-locked",
                now=datetime.now(timezone.utc),
                lease_seconds=300,
            )
            nonblocking_claim = claimant.result(timeout=2)
            release_lock.set()
            holder.result(timeout=5)
        assert nonblocking_claim is not None
        assert nonblocking_claim.job_id == available_id

        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(
                executor.map(
                    lambda name: worker.claim(
                        worker_id=name,
                        now=datetime.now(timezone.utc),
                        lease_seconds=300,
                    ),
                    ("worker-a", "worker-b"),
                )
            )
        successes = [claim for claim in claims if claim is not None]
        assert len(successes) == 1
        assert successes[0].job_id == locked_id

        observed_id = _insert_job(
            setup_url, "cancel-heartbeat", 85, account_id=actor_account_id
        )
        observed_claim = worker.claim(
            worker_id="worker-observe-cancel",
            now=datetime.now(timezone.utc),
            lease_seconds=300,
        )
        assert observed_claim is not None and observed_claim.job_id == observed_id
        observed_cancel = app.request_cancel(
            observed_id,
            actor_account_id=actor_account_id,
            now=datetime.now(timezone.utc),
        )
        assert observed_cancel.disposition is JobCancellationDisposition.RUNNING_REQUESTED
        heartbeat = worker.heartbeat(
            observed_claim,
            now=datetime.now(timezone.utc),
            lease_seconds=300,
        )
        assert heartbeat.active is True
        assert heartbeat.cancel_requested is True
        assert worker.finish(
            observed_claim,
            JobTransitionResult(JobState.CANCELED, "owner_request"),
            now=datetime.now(timezone.utc),
        ) is True

        cancel_id = _insert_job(
            setup_url, "cancel-race", 80, account_id=actor_account_id
        )
        cancel_claim = worker.claim(
            worker_id="worker-cancel",
            now=datetime.now(timezone.utc),
            lease_seconds=300,
        )
        assert cancel_claim is not None and cancel_claim.job_id == cancel_id
        race = Barrier(3)

        def cancel():
            race.wait(timeout=5)
            return app.request_cancel(
                cancel_id,
                actor_account_id=actor_account_id,
                now=datetime.now(timezone.utc),
            )

        def finish():
            race.wait(timeout=5)
            return worker.finish(
                cancel_claim,
                JobTransitionResult(JobState.CANCELED, "owner_request"),
                now=datetime.now(timezone.utc),
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            cancel_future = executor.submit(cancel)
            finish_future = executor.submit(finish)
            race.wait(timeout=5)
            cancel_result = cancel_future.result(timeout=5)
            finish_result = finish_future.result(timeout=5)
        assert cancel_result.disposition in {
            JobCancellationDisposition.RUNNING_REQUESTED,
            JobCancellationDisposition.NOOP,
        }
        assert finish_result is True
        with isolatedPostgres._connect(setup_url) as connection:
            evidence = connection.execute(
                """
                select jobs.state,
                  count(*) filter (where prior_state='running' and next_state='running')
                    as illegal_count,
                  count(*) filter (where prior_state='running' and next_state='canceled')
                    as canceled_count
                from ops.jobs jobs left join ops.job_transitions transitions
                  on transitions.job_id=jobs.id
                where jobs.id=%s group by jobs.state
                """,
                (cancel_id,),
            ).fetchone()
        assert evidence == {
            "state": "canceled",
            "illegal_count": 0,
            "canceled_count": 1,
        }

        stale_id = _insert_job(
            setup_url, "stale-late", account_id=actor_account_id
        )
        stale_claim = worker.claim(
            worker_id="worker-stale",
            now=datetime.now(timezone.utc),
            lease_seconds=300,
        )
        assert stale_claim is not None and stale_claim.job_id == stale_id
        app.request_cancel(
            stale_id,
            actor_account_id=actor_account_id,
            now=datetime.now(timezone.utc),
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                "update ops.jobs set lease_expires_at=now()-interval '1 second' "
                "where id=%s",
                (stale_id,),
            )
        reconciliation = worker.reconcile_stale_leases(
            now=datetime.now(timezone.utc), limit=25
        )
        assert reconciliation.ambiguous_count == 1
        assert worker.finish(
            stale_claim,
            JobTransitionResult(JobState.SUCCEEDED, "late_success"),
            now=datetime.now(timezone.utc),
        ) is False

        with isolatedPostgres._connect(setup_url) as connection:
            safe_canceled_id = int(
                connection.execute(
                    """
                    insert into ops.jobs (
                      kind, state, subject_kind, subject_ref, parameters,
                      account_id, deployment_mode, client_surface,
                      idempotency_key, attempt_count, max_attempts,
                      recovery_policy, lease_owner, lease_token,
                      lease_expires_at, heartbeat_at, started_at
                    ) values (
                      'full_scan', 'running', 'library', 'safe-canceled',
                      '{}'::jsonb, %s, 'self_hosted_private_web', 'private_web',
                      'phase8:safe-canceled', 1, 2, 'retry_safe',
                      'dead-safe-worker', 'dead-safe-lease',
                      now()+interval '300 seconds', now(), now()
                    ) returning id
                    """,
                    (actor_account_id,),
                ).fetchone()["id"]
            )
        app.request_cancel(
            safe_canceled_id,
            actor_account_id=actor_account_id,
            now=datetime.now(timezone.utc),
        )
        with isolatedPostgres._connect(setup_url) as connection:
            connection.execute(
                "update ops.jobs set lease_expires_at=now()-interval '1 second' "
                "where id=%s",
                (safe_canceled_id,),
            )
        safe_reconciliation = worker.reconcile_stale_leases(
            now=datetime.now(timezone.utc), limit=25
        )
        assert safe_reconciliation.canceled_count == 1
        with isolatedPostgres._connect(setup_url) as connection:
            assert connection.execute(
                "select state from ops.jobs where id=%s", (safe_canceled_id,)
            ).fetchone()["state"] == "canceled"

        with isolatedPostgres._connect(setup_url) as connection:
            exhausted_id = int(
                connection.execute(
                    """
                    insert into ops.jobs (
                      kind, state, subject_kind, subject_ref, parameters,
                      deployment_mode, client_surface, idempotency_key,
                      attempt_count, max_attempts, recovery_policy, lease_owner,
                      lease_token, lease_expires_at, heartbeat_at, started_at
                    ) values (
                      'full_scan', 'running', 'library', 'exhausted', '{}'::jsonb,
                      'self_hosted_private_web', 'private_web', 'phase8:exhausted',
                      2, 2, 'retry_safe', 'dead-worker', 'dead-lease',
                      now()-interval '1 second', now()-interval '2 seconds', now()
                    ) returning id
                    """
                ).fetchone()["id"]
            )
        exhausted = worker.reconcile_stale_leases(
            now=datetime.now(timezone.utc), limit=25
        )
        assert exhausted.failed_count == 1
        with isolatedPostgres._connect(setup_url) as connection:
            state = connection.execute(
                "select state from ops.jobs where id=%s", (exhausted_id,)
            ).fetchone()["state"]
        assert state == "failed"

        _drop_schemas(setup_url)
        cleanup_complete = True
    finally:
        if not cleanup_complete:
            _drop_schemas(setup_url)
