from datetime import datetime, timezone
import hashlib

from music_app.services.auth_tokens import IssuedOpaqueToken


NOW = datetime(2026, 8, 31, 18, 0, tzinfo=timezone.utc)
RAW_TOKEN = "A" * 43
TOKEN_DIGEST = hashlib.sha256(RAW_TOKEN.encode("ascii")).digest()


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
    def __init__(self, *, account=None, blocked_kind=None):
        self.account = account
        self.blocked_kind = blocked_kind
        self.events = []
        self.operations = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=()):
        normalized = " ".join(sql.casefold().split())
        self.operations.append((normalized, params))
        if "from app.accounts" in normalized and "account_credentials" in normalized:
            return Cursor(() if self.account is None else (self.account,))
        if "from app.auth_throttles" in normalized and "for update" in normalized:
            kinds = ("reset_account", "reset_candidate", "reset_source") if self.account else (
                "reset_candidate", "reset_source"
            )
            return Cursor(
                {
                    "bucket_kind": kind,
                    "window_started_at": NOW,
                    "failure_count": 5 if kind == self.blocked_kind else 0,
                    "window_expires_at": NOW.replace(hour=19),
                    "blocked_until": None,
                }
                for kind in kinds
            )
        if "insert into app.password_reset_tokens" in normalized:
            return Cursor(({"id": 71},))
        if "insert into app.mail_outbox" in normalized:
            return Cursor(({"id": 81},))
        return Cursor()


class Audit:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, connection, **values):
        self.calls.append(values)
        return 91


def _config():
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
        "hmac": {"secret": "s" * 32, "key_version": 4},
        "reset_token_seconds": 1800,
        "throttles": {
            "reset_candidate": {"limit": 5, "window_seconds": 3600},
            "reset_account": {"limit": 5, "window_seconds": 3600},
            "reset_source": {"limit": 20, "window_seconds": 3600},
        },
    }


def _service(connection, audit):
    from music_app.services.auth_password_reset_request_postgres import (
        PostgresPasswordResetRequestService,
    )

    return PostgresPasswordResetRequestService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: IssuedOpaqueToken(RAW_TOKEN, TOKEN_DIGEST),
        clock=lambda: NOW,
        audit_repository=audit,
    )


def test_eligible_request_charges_three_buckets_and_commits_one_reset_and_outbox():
    account = {
        "id": 41,
        "is_active": True,
        "disabled_at": None,
        "contact_email": "Member+one@example.test",
        "credential_version": 3,
    }
    connection = Connection(account=account)
    audit = Audit()

    result = _service(connection, audit).request_reset(
        candidate="Member+one@example.test",
        source_key="203.0.113.9",
        request_ref="forgot-1",
        source_class="public",
    )

    assert result.accepted is True
    assert result.delivery is not None
    assert result.delivery.raw_token == RAW_TOKEN
    assert result.delivery.outbox_id == 81
    assert result.delivery.recipient == "Member+one@example.test"
    assert RAW_TOKEN not in repr(result)
    assert connection.events == ["begin", "commit"]
    statements = [sql for sql, _ in connection.operations]
    assert sum("insert into app.auth_throttles" in sql for sql in statements) == 3
    assert any("update app.password_reset_tokens" in sql and "revoked_at" in sql for sql in statements)
    assert any("insert into app.password_reset_tokens" in sql for sql in statements)
    assert any("insert into app.mail_outbox" in sql for sql in statements)
    assert audit.calls[0]["target_account_id"] == 41


def test_unknown_request_charges_candidate_and_source_and_returns_same_public_shape():
    connection = Connection()
    audit = Audit()

    result = _service(connection, audit).request_reset(
        candidate="unknown.user",
        source_key="203.0.113.9",
        request_ref="forgot-2",
        source_class="public",
    )

    assert result.accepted is True
    assert result.delivery is None
    assert connection.events == ["begin", "commit"]
    statements = [sql for sql, _ in connection.operations]
    assert sum("insert into app.auth_throttles" in sql for sql in statements) == 2
    assert not any("insert into app.password_reset_tokens" in sql for sql in statements)
    assert audit.calls[0]["target_account_id"] is None


def test_blocked_request_is_generic_and_does_not_issue_or_revoke_reset():
    account = {
        "id": 41,
        "is_active": True,
        "disabled_at": None,
        "contact_email": "member@example.test",
        "credential_version": 3,
    }
    connection = Connection(account=account, blocked_kind="reset_candidate")
    audit = Audit()

    result = _service(connection, audit).request_reset(
        candidate="member",
        source_key="203.0.113.9",
        request_ref="forgot-3",
        source_class="public",
    )

    assert result.accepted is True
    assert result.delivery is None
    statements = [sql for sql, _ in connection.operations]
    assert not any("password_reset_tokens" in sql for sql in statements)
    assert audit.calls[0]["outcome"].value == "throttled"
