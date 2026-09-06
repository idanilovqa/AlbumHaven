from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.auth_mail_jobs_postgres import AcceptedAuthMailJob


NOW = datetime(2026, 8, 31, 23, 0, tzinfo=timezone.utc)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("begin")

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("rollback" if exc_type else "commit")


class Connection:
    def __init__(
        self, *, throttle_count=0, active=True, account_kind="bootstrap_owner"
    ):
        self.throttle_count = throttle_count
        self.active = active
        self.account_kind = account_kind
        self.events = []
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=()):
        statement = " ".join(sql.casefold().split())
        self.operations.append((statement, params))
        if "with locked_accounts" in statement:
            return Cursor(({
                "actor_account_id": 7,
                "library_id": 9,
                "target_account_id": 41,
                "target_account_kind": self.account_kind,
                "target_is_active": self.active,
                "target_disabled_at": None if self.active else NOW,
                "contact_email": "listener@example.test",
                "credential_version": 3,
            },))
        if "from app.auth_throttles" in statement:
            return Cursor(({
                "bucket_kind": params[1],
                "window_started_at": NOW,
                "failure_count": self.throttle_count,
                "window_expires_at": NOW + timedelta(days=1),
                "blocked_until": None,
            },))
        if "insert into app.password_reset_tokens" in statement:
            return Cursor(({"id": 61},))
        if "insert into app.mail_outbox" in statement:
            return Cursor(({"id": 71},))
        return Cursor()


class Jobs:
    def __init__(self, *, fail=False):
        self.calls = []
        self.fail = fail

    def compose_existing_intent_in_transaction(self, connection, **values):
        self.calls.append((connection, values))
        if self.fail:
            raise RuntimeError("job enqueue failed")
        return AcceptedAuthMailJob(values["outbox_id"], 91, 1, 1)


def _service(connection, jobs=None):
    from music_app.services.admin_mail_actions_postgres import (
        PostgresAdminMailActionService,
    )

    return PostgresAdminMailActionService(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
            "hmac": {"secret": "s" * 48, "key_version": 2},
            "throttles": {
                "welcome_account": {"limit": 5, "window_seconds": 86400},
                "reset_account": {"limit": 4, "window_seconds": 3600},
            },
            "reset_token_seconds": 900,
        },
        connect=lambda _url: connection,
        clock=lambda: NOW,
        job_repository=jobs or Jobs(),
    )


def test_welcome_resend_is_recent_authenticated_durably_throttled_and_audited():
    connection = Connection()

    result = _service(connection).queue_welcome(
        actor_account_id=7,
        actor_authenticated_at=NOW - timedelta(minutes=2),
        library_id=9,
        target_account_id=41,
        request_ref="welcome-resend-1",
    )

    assert result.accepted is True
    assert result.welcome_outbox_id == 71
    statements = [sql for sql, _params in connection.operations]
    assert any("bucket_kind" in sql and "auth_throttles" in sql for sql in statements)
    assert any("message_category" in sql and "'welcome'" in sql for sql in statements)
    assert any("welcome_resend_queued" in sql for sql in statements)
    assert connection.events == ["begin", "commit"]


def test_welcome_throttle_is_ambiguous_and_does_not_queue_another_message():
    connection = Connection(throttle_count=5)

    result = _service(connection).queue_welcome(
        actor_account_id=7,
        actor_authenticated_at=NOW,
        library_id=9,
        target_account_id=41,
        request_ref="welcome-resend-2",
    )

    assert result.accepted is True
    assert result.welcome_outbox_id is None
    assert not any("insert into app.mail_outbox" in sql for sql, _ in connection.operations)
    assert "throttled" in repr(result)


def test_welcome_resend_remains_bootstrap_owner_only_for_managed_accounts():
    connection = Connection(account_kind="managed_user")

    result = _service(connection).queue_welcome(
        actor_account_id=7,
        actor_authenticated_at=NOW,
        library_id=9,
        target_account_id=41,
        request_ref="managed-welcome-ineligible",
    )

    assert result.accepted is True
    assert result.welcome_outbox_id is None
    authority_sql = next(
        sql for sql, _ in connection.operations if "with locked_accounts" in sql
    )
    assert "account_kind" in authority_sql
    assert not any(
        "insert into app.mail_outbox" in sql
        for sql, _ in connection.operations
    )


def test_admin_password_reset_accepts_tokenless_job_without_issuing_a_token():
    connection = Connection()
    jobs = Jobs()

    result = _service(connection, jobs).queue_password_reset(
        actor_account_id=7,
        actor_authenticated_at=NOW,
        library_id=9,
        target_account_id=41,
        request_ref="admin-reset-1",
    )

    assert result.accepted is True
    assert result.accepted_job == AcceptedAuthMailJob(71, 91, 1, 1)
    assert jobs.calls[0][1]["category"] == "password_reset"
    statements = [sql for sql, _params in connection.operations]
    assert not any("password_reset_tokens" in sql for sql in statements)
    assert any("'password_reset'" in sql and "insert into app.mail_outbox" in sql for sql in statements)
    assert any("password_reset_queued" in sql for sql in statements)


def test_mail_actions_reject_stale_authentication_before_database_work():
    from music_app.services.admin_member_mutation_postgres import (
        RecentAuthenticationRequired,
    )

    connection = Connection()
    try:
        _service(connection).queue_welcome(
            actor_account_id=7,
            actor_authenticated_at=NOW - timedelta(minutes=11),
            library_id=9,
            target_account_id=41,
            request_ref="welcome-resend-3",
        )
    except RecentAuthenticationRequired:
        pass
    else:
        raise AssertionError("stale administrator authentication must fail")
    assert connection.operations == []


def test_inactive_target_has_ambiguous_success_without_issuing_mail_or_token():
    connection = Connection(active=False)

    result = _service(connection).queue_password_reset(
        actor_account_id=7,
        actor_authenticated_at=NOW,
        library_id=9,
        target_account_id=41,
        request_ref="admin-reset-2",
    )

    assert result.accepted is True
    assert result.password_reset_delivery is None
    assert not any("insert into app.password_reset_tokens" in sql for sql, _ in connection.operations)
    assert not any("insert into app.mail_outbox" in sql for sql, _ in connection.operations)


def test_job_enqueue_failure_rolls_back_admin_outbox_and_audit():
    connection = Connection()
    with pytest.raises(RuntimeError, match="could not be queued"):
        _service(connection, Jobs(fail=True)).queue_welcome(
            actor_account_id=7, actor_authenticated_at=NOW, library_id=9,
            target_account_id=41, request_ref="welcome-enqueue-failure",
        )
    assert connection.events == ["begin", "rollback"]
    assert not any("welcome_resend_queued" in sql for sql, _ in connection.operations)
