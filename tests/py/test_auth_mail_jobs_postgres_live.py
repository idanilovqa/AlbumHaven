from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.auth_mail_jobs_postgres import PostgresAuthMailJobRepository
from music_app.services.auth_audit_postgres import PostgresSecurityAuditRepository
from music_app.services.auth_password_reset_request_postgres import (
    PostgresPasswordResetRequestService,
)
from music_app.services.auth_mail import DeliveryResult
from music_app.services.auth_mail_outbox_postgres import PostgresWelcomeOutboxService
from music_app.services.jobs.models import JobState, JobTransitionResult
from music_app.services.jobs.repository_postgres import PostgresJobRepository
from music_app.services.jobs.authorization import (
    AuthorizationDecision,
    JobAuthorizationService,
    PostgresJobAuthorizationContextRepository,
    build_auth_mail_resource_validator,
)
from music_app.services.policy_evaluator import PolicyEvaluator
from tests.e2e.support import isolatedPostgres


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
        _skip_or_fail_ci("Dedicated setup and runtime Postgres URLs are invalid.")
        raise AssertionError("unreachable")
    if not Path(str(os.environ.get("PGPASSFILE") or "")).is_file():
        _skip_or_fail_ci("Dedicated isolated Postgres PGPASSFILE is unavailable.")
    identities = {
        ((urlparse(url).hostname or "").casefold(), urlparse(url).port or 5432, urlparse(url).path)
        for url in (setup_url, runtime_url)
    }
    if len(identities) != 1:
        _skip_or_fail_ci("Dedicated Postgres roles do not share one database.")
    return setup_url, runtime_url


def _drop_schemas(setup_url: str) -> None:
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("drop schema if exists app, integration, library, ops cascade")


@pytest.fixture(scope="module")
def live_auth_mail_database():
    setup_url, runtime_url = _database_urls_or_skip()
    try:
        _drop_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        yield setup_url, runtime_url
    finally:
        _drop_schemas(setup_url)


def _seed_scope(setup_url: str) -> tuple[int, int, str]:
    suffix = uuid4().hex[:10]
    origin_key = f"mail-origin-{suffix}"
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(connection.execute(
            """
            insert into app.accounts (
              display_name, username_display, username_normalized,
              contact_email, contact_email_normalized, account_kind, is_active
            ) values (%s, %s, %s, %s, %s, 'managed', true)
            returning id
            """,
            (suffix, suffix, suffix, f"{suffix}@example.invalid", f"{suffix}@example.invalid"),
        ).fetchone()["id"])
        library_id = int(connection.execute(
            "insert into library.libraries (owner_account_id, name, library_kind) "
            "values (%s, %s, 'local') returning id",
            (account_id, f"Mail {suffix}"),
        ).fetchone()["id"])
        connection.execute(
            "insert into library.library_memberships "
            "(library_id, account_id, membership_role) values (%s, %s, 'owner')",
            (library_id, account_id),
        )
        connection.execute(
            "insert into app.request_origins "
            "(account_id, client_surface_class, origin_type, origin_key) "
            "values (%s, 'private_web', 'browser', %s)",
            (account_id, origin_key),
        )
    return account_id, library_id, origin_key


def _repository(runtime_url: str) -> PostgresAuthMailJobRepository:
    return PostgresAuthMailJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
    )


def test_live_tokenless_intent_and_job_commit_without_private_generic_data(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    account_id, library_id, origin_key = _seed_scope(setup_url)

    accepted = _repository(runtime_url).accept_intent(
        category="password_reset",
        account_id=account_id,
        actor_account_id=account_id,
        library_id=library_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=datetime.now(timezone.utc),
    )

    with isolatedPostgres._connect(setup_url) as connection:
        outbox = connection.execute(
            "select reset_token_id, invitation_token_id, current_job_id, "
            "accepted_attempt, delivery_checkpoint from app.mail_outbox where id = %s",
            (accepted.outbox_id,),
        ).fetchone()
        job = connection.execute(
            "select parameters, subject_kind, subject_ref, idempotency_key "
            "from ops.jobs where id = %s",
            (accepted.job_id,),
        ).fetchone()
    assert outbox["reset_token_id"] is None
    assert outbox["invitation_token_id"] is None
    assert int(outbox["current_job_id"]) == accepted.job_id
    assert int(outbox["accepted_attempt"]) == 1
    assert outbox["delivery_checkpoint"] == "accepted"
    assert job["parameters"] == {}
    assert job["subject_kind"] == "mail_outbox"
    assert job["subject_ref"] == str(accepted.outbox_id)
    assert job["idempotency_key"] == (
        f"auth-mail:password_reset:{accepted.outbox_id}:attempt:1"
    )


def test_live_public_reset_producer_commits_tokenless_outbox_and_job_atomically(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    account_id, _library_id, _origin_key = _seed_scope(setup_url)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into app.account_credentials "
            "(account_id, encoded_hash, credential_version) values (%s, 'opaque', 4)",
            (account_id,),
        )
        username = connection.execute(
            "select username_normalized from app.accounts where id = %s",
            (account_id,),
        ).fetchone()["username_normalized"]
    service = PostgresPasswordResetRequestService(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": runtime_url,
            "hmac": {"secret": "p" * 48, "key_version": 1},
            "reset_token_seconds": 900,
            "throttles": {
                "reset_candidate": {"limit": 5, "window_seconds": 3600},
                "reset_account": {"limit": 5, "window_seconds": 3600},
                "reset_source": {"limit": 20, "window_seconds": 3600},
            },
        },
        connect=isolatedPostgres._connect,
        audit_repository=PostgresSecurityAuditRepository(),
    )
    accepted = service.request_reset(
        candidate=username,
        source_key="live-public-reset-source-eligible",
        request_ref=f"live-reset-{uuid4().hex}",
        source_class="private",
        request_origin_ref=f"browser:public-reset-{uuid4().hex}",
        deployment_mode="self_hosted",
        client_surface="private_web",
    )
    assert accepted.accepted_job is not None
    with isolatedPostgres._connect(setup_url) as connection:
        outbox = connection.execute(
            "select reset_token_id, actor_account_id, authorization_mode, "
            "current_job_id from app.mail_outbox where id = %s",
            (accepted.accepted_job.outbox_id,),
        ).fetchone()
        tokens = connection.execute(
            "select count(*) as count from app.password_reset_tokens "
            "where account_id = %s",
            (account_id,),
        ).fetchone()
    assert outbox["reset_token_id"] is None
    assert outbox["actor_account_id"] is None
    assert outbox["authorization_mode"] == "public_lifecycle"
    assert int(outbox["current_job_id"]) == accepted.accepted_job.job_id
    assert int(tokens["count"]) == 0


def test_live_generic_enqueue_failure_rolls_back_outbox(live_auth_mail_database):
    setup_url, runtime_url = live_auth_mail_database
    account_id, library_id, origin_key = _seed_scope(setup_url)

    class _FailingJobs:
        @staticmethod
        def enqueue_in_transaction(_connection, _command):
            raise RuntimeError("forced enqueue failure")

    repository = PostgresAuthMailJobRepository(
        database_url=runtime_url,
        connect_to_database=isolatedPostgres._connect,
        job_repository=_FailingJobs(),
    )
    with pytest.raises(RuntimeError, match="forced enqueue failure"):
        repository.accept_intent(
            category="welcome",
            account_id=account_id,
            actor_account_id=account_id,
            library_id=library_id,
            request_origin_ref=f"browser:{origin_key}",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            now=datetime.now(timezone.utc),
        )

    with isolatedPostgres._connect(setup_url) as connection:
        count = int(connection.execute(
            "select count(*) as count from app.mail_outbox where account_id = %s",
            (account_id,),
        ).fetchone()["count"])
    assert count == 0


def test_live_reconciler_adopts_one_due_legacy_bootstrap_welcome(
    live_auth_mail_database,
):
    setup_url, _runtime_url = live_auth_mail_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        account_id = int(connection.execute(
            "select account_id from app.bootstrap_owners "
            "where owner_key = 'local-bootstrap-owner'"
        ).fetchone()["account_id"])
        library_row = connection.execute(
            "select id from library.libraries where owner_account_id = %s "
            "order by id limit 1",
            (account_id,),
        ).fetchone()
        library_id = int(library_row["id"]) if library_row is not None else int(
            connection.execute(
                "insert into library.libraries "
                "(owner_account_id, name, library_kind) "
                "values (%s, 'Legacy Welcome', 'local') returning id",
                (account_id,),
            ).fetchone()["id"]
        )
        outbox_id = int(connection.execute(
            "insert into app.mail_outbox "
            "(account_id, message_category, delivery_status, next_attempt_at, "
            "created_at, updated_at) "
            "values (%s, 'welcome', 'pending', %s, %s, %s) returning id",
            (account_id, now, now, now),
        ).fetchone()["id"])
    def reconcile_once(_worker: int) -> int:
        repository = PostgresAuthMailJobRepository(
            database_url=worker_url,
            connect_to_database=isolatedPostgres._connect,
        )
        return repository.reconcile_due_pending(now=now, limit=10)

    with ThreadPoolExecutor(max_workers=2) as pool:
        reconciled = list(pool.map(reconcile_once, range(2)))
    assert sorted(reconciled) == [0, 1]
    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            "select actor_account_id, accepted_attempt, current_job_id, "
            "delivery_checkpoint from app.mail_outbox where id = %s",
            (outbox_id,),
        ).fetchone()
        job = connection.execute(
            "select account_id, library_id, kind, parameters from ops.jobs "
            "where id = %s",
            (row["current_job_id"],),
        ).fetchone()
    assert int(row["actor_account_id"]) == account_id
    assert int(row["accepted_attempt"]) == 1
    assert row["delivery_checkpoint"] == "accepted"
    assert int(job["account_id"]) == account_id
    assert int(job["library_id"]) == library_id
    assert job["kind"] == "auth_welcome_delivery"
    assert job["parameters"] == {}


def test_live_reconciler_marks_token_issued_terminal_job_ambiguous_without_replay(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    accepted = _repository(runtime_url).accept_intent(
        category="account_invitation", account_id=account_id,
        actor_account_id=account_id, library_id=library_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted", client_surface="private_web", now=now,
    )
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update app.mail_outbox set delivery_status = 'sending', "
            "delivery_checkpoint = 'token_issued', lifecycle_expires_at = %s, "
            "row_revision = row_revision + 1, updated_at = %s where id = %s",
            (now + timedelta(hours=1), now, accepted.outbox_id),
        )
        connection.execute(
            "update ops.jobs set state = 'ambiguous', started_at = %s, "
            "completed_at = %s, outcome_code = 'lease_outcome_unknown', "
            "updated_at = %s where id = %s",
            (now, now, now, accepted.job_id),
        )
    repository = PostgresAuthMailJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    assert repository.reconcile_due_pending(now=now, limit=10) == 0
    with isolatedPostgres._connect(setup_url) as connection:
        outbox = connection.execute(
            "select delivery_status, delivery_checkpoint, provider_disposition, "
            "current_job_id from app.mail_outbox where id = %s",
            (accepted.outbox_id,),
        ).fetchone()
        jobs = connection.execute(
            "select count(*) as count from ops.jobs where subject_kind = 'mail_outbox' "
            "and subject_ref = %s",
            (str(accepted.outbox_id),),
        ).fetchone()
    assert outbox["delivery_status"] == "unknown"
    assert outbox["delivery_checkpoint"] == "terminal"
    assert outbox["provider_disposition"] == "possible_send_ambiguous"
    assert int(outbox["current_job_id"]) == accepted.job_id
    assert int(jobs["count"]) == 1


def test_live_concurrent_composition_converges_on_one_job(live_auth_mail_database):
    setup_url, runtime_url = live_auth_mail_database
    account_id, library_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        outbox_id = int(connection.execute(
            """
            insert into app.mail_outbox (
              account_id, message_category, delivery_status, attempt_count,
              next_attempt_at, row_revision, accepted_attempt,
              delivery_checkpoint, created_at, updated_at
            ) values (%s, 'welcome', 'pending', 0, %s, 0, 1, 'accepted', %s, %s)
            returning id
            """,
            (account_id, now, now, now),
        ).fetchone()["id"])
    values = dict(
        outbox_id=outbox_id,
        category="welcome",
        account_id=account_id,
        actor_account_id=account_id,
        library_id=library_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        scheduled_at=now,
    )

    def compose(_index):
        repository = _repository(runtime_url)
        with isolatedPostgres._connect(runtime_url) as connection:
            return repository.compose_existing_intent_in_transaction(connection, **values)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first, second = list(executor.map(compose, range(2)))

    assert first.job_id == second.job_id
    with isolatedPostgres._connect(setup_url) as connection:
        count = int(connection.execute(
            "select count(*) as count from ops.jobs "
            "where idempotency_key = %s",
            (f"auth-mail:welcome:{outbox_id}:attempt:1",),
        ).fetchone()["count"])
    assert count == 1


def test_live_migration_rerun_preserves_job_owned_rows_and_holds_legacy_token_mail(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    account_id, library_id, origin_key = _seed_scope(setup_url)
    active = _repository(runtime_url).accept_intent(
        category="password_reset",
        account_id=account_id,
        actor_account_id=account_id,
        library_id=library_id,
        request_origin_ref=f"browser:{origin_key}",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=datetime.now(timezone.utc),
    )
    legacy_account_id, _legacy_library_id, _legacy_origin = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        token_id = int(connection.execute(
            """
            insert into app.account_invitation_tokens (
              account_id, token_hash, created_at, expires_at, request_ref
            ) values (%s, %s, %s, %s, 'legacy-mail-cutover')
            returning id
            """,
            (legacy_account_id, bytes(range(32)), now, now.replace(year=now.year + 1)),
        ).fetchone()["id"])
        legacy_outbox_id = int(connection.execute(
            """
            insert into app.mail_outbox (
              account_id, invitation_token_id, message_category,
              delivery_status, attempt_count, created_at, updated_at
            ) values (%s, %s, 'account_invitation', 'pending', 0, %s, %s)
            returning id
            """,
            (legacy_account_id, token_id, now, now),
        ).fetchone()["id"])
        migration_sql = (
            Path(__file__).resolve().parents[2]
            / "migrations"
            / "postgres"
            / "0096_create_auth_mail_job_state.sql"
        ).read_text(encoding="utf-8")
        connection.execute(migration_sql)
        active_row = connection.execute(
            "select delivery_status, current_job_id from app.mail_outbox where id = %s",
            (active.outbox_id,),
        ).fetchone()
        legacy_row = connection.execute(
            "select delivery_status, delivery_checkpoint, delivery_reason_code, "
            "invitation_token_id, current_job_id from app.mail_outbox where id = %s",
            (legacy_outbox_id,),
        ).fetchone()

    assert active_row["delivery_status"] == "pending"
    assert int(active_row["current_job_id"]) == active.job_id
    assert legacy_row["delivery_status"] == "unknown"
    assert legacy_row["delivery_checkpoint"] == "terminal"
    assert legacy_row["delivery_reason_code"] == "legacy_token_unavailable"
    assert int(legacy_row["invitation_token_id"]) == token_id
    assert legacy_row["current_job_id"] is None


@pytest.mark.parametrize(
    ("result", "expected_status", "expects_due"),
    [
        (DeliveryResult(delivered=True, reason="delivered"), "sent", False),
        (DeliveryResult(delivered=False, reason="timeout"), "failed", True),
    ],
)
def test_live_additive_schema_remains_compatible_with_pre_cutover_welcome_delivery(
    live_auth_mail_database, result, expected_status, expects_due
):
    setup_url, _runtime_url = live_auth_mail_database
    account_id, _library_id, _origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        outbox_id = int(connection.execute(
            "insert into app.mail_outbox "
            "(account_id, message_category, delivery_status, attempt_count, created_at) "
            "values (%s, 'welcome', 'pending', 0, %s) returning id",
            (account_id, now),
        ).fetchone()["id"])
    clock = iter((now, now.replace(microsecond=min(999999, now.microsecond + 1))))
    service = PostgresWelcomeOutboxService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": setup_url},
        connect=isolatedPostgres._connect,
        now=lambda: next(clock),
    )

    claim = service.claim_welcome(outbox_id)
    assert claim is not None
    service.finalize_welcome(claim, result)

    with isolatedPostgres._connect(setup_url) as connection:
        row = connection.execute(
            "select delivery_status, next_attempt_at from app.mail_outbox where id = %s",
            (outbox_id,),
        ).fetchone()
    assert row["delivery_status"] == expected_status
    assert (row["next_attempt_at"] is not None) is expects_due


def test_live_worker_claim_is_exact_secret_scoped_and_role_denied(
    live_auth_mail_database,
):
    import psycopg

    setup_url, runtime_url = live_auth_mail_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=30)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into app.account_credentials "
            "(account_id, encoded_hash, credential_version) values (%s, 'opaque', 4)",
            (account_id,),
        )
        connection.execute(
            "insert into app.capabilities "
            "(account_id, capability_key, scope_kind, scope_id) "
            "values (%s, 'accounts.password_reset.send', 'library', %s)",
            (account_id, library_id),
        )
        outbox_id = int(connection.execute(
            """
            insert into app.mail_outbox (
              account_id, actor_account_id, authorization_mode,
              message_category, delivery_status, attempt_count,
              next_attempt_at, row_revision, accepted_attempt,
              delivery_checkpoint, target_credential_version,
              lifecycle_expires_at, created_at, updated_at
            ) values (
              %s, %s, 'actor', 'password_reset', 'pending', 0,
              %s, 0, 1, 'accepted', 4, %s, %s, %s
            ) returning id
            """,
            (account_id, account_id, now, expires_at, now, now),
        ).fetchone()["id"])
    repository = _repository(runtime_url)
    with isolatedPostgres._connect(runtime_url) as connection:
        accepted = repository.compose_existing_intent_in_transaction(
            connection,
            outbox_id=outbox_id,
            category="password_reset",
            account_id=account_id,
            actor_account_id=account_id,
            library_id=library_id,
            request_origin_ref=f"browser:{origin_key}",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            scheduled_at=now,
        )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="auth-mail-live",
        now=now + timedelta(seconds=1),
        lease_seconds=120,
        kinds=("auth_password_reset_delivery",),
    )
    while claim is not None and claim.job_id != accepted.job_id:
        assert jobs.finish(
            claim,
            JobTransitionResult(JobState.CANCELED, "test_scope_cleanup"),
            now=now + timedelta(seconds=2),
        )
        claim = jobs.claim(
            worker_id="auth-mail-live",
            now=now + timedelta(seconds=3),
            lease_seconds=120,
            kinds=("auth_password_reset_delivery",),
        )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_repository = _repository(worker_url)
    fence = dict(
        outbox_id=outbox_id,
        category="password_reset",
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now + timedelta(seconds=4),
    )

    assert worker_repository.validate_claimed_delivery(
        **fence,
        row_revision=accepted.row_revision,
        accepted_attempt=1,
    )
    authorization = JobAuthorizationService(
        context_repository=PostgresJobAuthorizationContextRepository(
            worker_url, connect_to_database=isolatedPostgres._connect
        ),
        policy_evaluator=PolicyEvaluator(),
        resource_validators={
            "auth_password_reset_delivery": build_auth_mail_resource_validator(
                mail_repository=worker_repository, category="password_reset"
            )
        },
    )
    assert authorization.authorize(claim, fence["now"]) in {
        AuthorizationDecision(True, "authorized"),
        AuthorizationDecision(True, "bootstrap_owner"),
    }
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update app.capabilities set revoked_at = %s "
            "where account_id = %s and capability_key = 'accounts.password_reset.send'",
            (now + timedelta(seconds=5), account_id),
        )
    assert authorization.authorize(
        claim, now + timedelta(seconds=6)
    ) == AuthorizationDecision(False, "capability_revoked")
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update app.capabilities set revoked_at = null "
            "where account_id = %s and capability_key = 'accounts.password_reset.send'",
            (account_id,),
        )
    context = worker_repository.load_claimed_delivery_context(**fence)
    assert context.target_account_id == account_id
    assert context.target_credential_version == 4
    assert "@example.invalid" not in repr(context)
    digest = bytes(reversed(range(32)))
    issued = worker_repository.issue_claimed_token_hash(
        **fence,
        expected_row_revision=accepted.row_revision,
        token_hash=digest,
        expires_at=expires_at,
        request_ref="opaque-live-request",
    )
    assert issued.row_revision == accepted.row_revision + 1
    assert worker_repository.validate_claimed_delivery(
        **fence,
        row_revision=issued.row_revision,
        accepted_attempt=1,
    )

    with isolatedPostgres._connect(setup_url) as connection:
        token = connection.execute(
            "select token_hash from app.password_reset_tokens where id = %s",
            (issued.token_id,),
        ).fetchone()
    assert bytes(token["token_hash"]) == digest
    for statement in (
        "select contact_email from app.accounts",
        "select * from app.mail_outbox",
        "select token_hash from app.password_reset_tokens",
    ):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with isolatedPostgres._connect(worker_url) as connection:
                connection.execute(statement).fetchall()

    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "update app.accounts set is_active = false, disabled_at = %s where id = %s",
            (now + timedelta(seconds=5), account_id),
        )
    assert not worker_repository.validate_claimed_delivery(
        **fence,
        row_revision=issued.row_revision,
        accepted_attempt=1,
    )


def test_live_public_reset_requires_persisted_throttle_lifecycle(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, _library_id, _origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=30)
    public_origin_key = f"public-mail-{uuid4().hex}"
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute(
            "insert into app.account_credentials "
            "(account_id, encoded_hash, credential_version) values (%s, 'opaque', 2)",
            (account_id,),
        )
        connection.execute(
            "insert into app.request_origins "
            "(account_id, client_surface_class, origin_type, origin_key) "
            "values (null, 'private_web', 'browser', %s)",
            (public_origin_key,),
        )
        throttle_id = int(connection.execute(
            """
            insert into app.auth_throttles (
              bucket_kind, bucket_hash, window_started_at,
              window_expires_at, updated_at
            ) values ('reset_account', %s, %s, %s, %s)
            returning id
            """,
            (bytes(range(32)), now, expires_at, now),
        ).fetchone()["id"])
        outbox_id = int(connection.execute(
            """
            insert into app.mail_outbox (
              account_id, actor_account_id, authorization_mode,
              message_category, delivery_status, attempt_count,
              next_attempt_at, row_revision, accepted_attempt,
              delivery_checkpoint, target_credential_version,
              lifecycle_expires_at, public_throttle_id, created_at, updated_at
            ) values (
              %s, null, 'public_lifecycle', 'password_reset', 'pending', 0,
              %s, 0, 1, 'accepted', 2, %s, %s, %s, %s
            ) returning id
            """,
            (account_id, now, expires_at, throttle_id, now, now),
        ).fetchone()["id"])
    repository = _repository(runtime_url)
    with isolatedPostgres._connect(runtime_url) as connection:
        accepted = repository.compose_existing_intent_in_transaction(
            connection,
            outbox_id=outbox_id,
            category="password_reset",
            account_id=account_id,
            actor_account_id=None,
            library_id=None,
            request_origin_ref=f"browser:{public_origin_key}",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            scheduled_at=now,
        )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="public-auth-mail-live",
        now=now + timedelta(seconds=1),
        lease_seconds=120,
        kinds=("auth_password_reset_delivery",),
    )
    while claim is not None and claim.job_id != accepted.job_id:
        assert jobs.finish(
            claim,
            JobTransitionResult(JobState.CANCELED, "test_scope_cleanup"),
            now=now + timedelta(seconds=2),
        )
        claim = jobs.claim(
            worker_id="public-auth-mail-live",
            now=now + timedelta(seconds=3),
            lease_seconds=120,
            kinds=("auth_password_reset_delivery",),
        )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_repository = _repository(worker_url)
    fence = dict(
        outbox_id=outbox_id,
        category="password_reset",
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now + timedelta(seconds=4),
        row_revision=accepted.row_revision,
        accepted_attempt=1,
    )

    assert worker_repository.validate_claimed_delivery(**fence)
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("delete from app.auth_throttles where id = %s", (throttle_id,))
    assert not worker_repository.validate_claimed_delivery(**fence)


def test_live_welcome_send_checkpoint_schedules_exact_next_domain_job(
    live_auth_mail_database,
):
    setup_url, runtime_url = live_auth_mail_database
    worker_url = str(os.environ.get("ALBUM_HAVEN_WORKER_DATABASE_URL") or "")
    account_id, library_id, origin_key = _seed_scope(setup_url)
    now = datetime.now(timezone.utc)
    with isolatedPostgres._connect(setup_url) as connection:
        outbox_id = int(connection.execute(
            """
            insert into app.mail_outbox (
              account_id, actor_account_id, authorization_mode,
              message_category, delivery_status, attempt_count,
              next_attempt_at, row_revision, accepted_attempt,
              delivery_checkpoint, created_at, updated_at
            ) values (
              %s, %s, 'actor', 'welcome', 'pending', 0,
              %s, 0, 1, 'accepted', %s, %s
            ) returning id
            """,
            (account_id, account_id, now, now, now),
        ).fetchone()["id"])
    repository = _repository(runtime_url)
    with isolatedPostgres._connect(runtime_url) as connection:
        accepted = repository.compose_existing_intent_in_transaction(
            connection,
            outbox_id=outbox_id,
            category="welcome",
            account_id=account_id,
            actor_account_id=account_id,
            library_id=library_id,
            request_origin_ref=f"browser:{origin_key}",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            scheduled_at=now,
        )
    jobs = PostgresJobRepository(
        database_url=worker_url,
        connect_to_database=isolatedPostgres._connect,
    )
    claim = jobs.claim(
        worker_id="welcome-mail-live",
        now=now + timedelta(seconds=1),
        lease_seconds=120,
        kinds=("auth_welcome_delivery",),
    )
    while claim is not None and claim.job_id != accepted.job_id:
        assert jobs.finish(
            claim,
            JobTransitionResult(JobState.CANCELED, "test_scope_cleanup"),
            now=now + timedelta(seconds=2),
        )
        claim = jobs.claim(
            worker_id="welcome-mail-live",
            now=now + timedelta(seconds=3),
            lease_seconds=120,
            kinds=("auth_welcome_delivery",),
        )
    assert claim is not None and claim.job_id == accepted.job_id
    worker_repository = _repository(worker_url)
    values = dict(
        outbox_id=outbox_id,
        category="welcome",
        job_id=claim.job_id,
        attempt=claim.attempt,
        worker_id=claim.worker_id,
        lease_token=claim.lease_token,
        now=now + timedelta(seconds=4),
    )
    context = worker_repository.load_claimed_delivery_context(**values)
    send_revision = worker_repository.begin_claimed_send(
        **values, expected_row_revision=context.row_revision
    )
    finalized = worker_repository.finalize_claimed_delivery(
        **values,
        expected_row_revision=send_revision,
        disposition="known_not_sent_retryable",
        reason_code="provider_known_not_sent",
    )

    assert finalized.next_job_id is not None
    with isolatedPostgres._connect(setup_url) as connection:
        outbox = connection.execute(
            "select delivery_status, accepted_attempt, current_job_id, "
            "next_attempt_at, row_revision from app.mail_outbox where id = %s",
            (outbox_id,),
        ).fetchone()
        next_job = connection.execute(
            "select idempotency_key, scheduled_at, scope_version, resource_revision "
            "from ops.jobs where id = %s",
            (finalized.next_job_id,),
        ).fetchone()
    assert outbox["delivery_status"] == "pending"
    assert int(outbox["accepted_attempt"]) == 2
    assert int(outbox["current_job_id"]) == finalized.next_job_id
    assert outbox["next_attempt_at"] == now + timedelta(seconds=64)
    assert next_job["idempotency_key"] == f"auth-mail:welcome:{outbox_id}:attempt:2"
    assert int(next_job["scope_version"]) == int(outbox["row_revision"])
    assert int(next_job["resource_revision"]) == 2
