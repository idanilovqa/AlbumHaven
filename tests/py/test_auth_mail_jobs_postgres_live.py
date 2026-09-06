from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import pytest

from music_app.services.auth_mail_jobs_postgres import PostgresAuthMailJobRepository
from music_app.services.auth_mail import DeliveryResult
from music_app.services.auth_mail_outbox_postgres import PostgresWelcomeOutboxService
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
            / "0079_create_auth_mail_job_state.sql"
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
