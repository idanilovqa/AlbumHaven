from datetime import datetime, timedelta, timezone
import hashlib

from music_app.services.auth_passwords import PasswordCredential
from music_app.services.auth_tokens import IssuedOpaqueToken


NOW = datetime(2026, 8, 31, 20, 0, tzinfo=timezone.utc)
RESET_RAW = "s" * 43
LIFECYCLE_RAW = "c" * 43


class Cursor:
    def __init__(self, rows=(), rowcount=1):
        self.rows = list(rows)
        self.rowcount = rowcount

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
    def __init__(self, *, valid=True):
        self.valid = valid
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
        context = {
            "transaction_id": 61,
            "reset_token_id": 51,
            "account_id": 41,
            "username_display": "member.one",
            "contact_email": "member@example.test",
            "credential_version": 3,
            "is_active": True,
            "disabled_at": None,
            "reset_expires_at": NOW + timedelta(minutes=20),
            "transaction_expires_at": NOW + timedelta(minutes=10),
            "reset_consumed_at": None,
            "reset_revoked_at": None,
            "transaction_consumed_at": None,
        }
        if "insert into app.password_reset_transactions" in statement:
            return Cursor(({"id": 61},))
        if "from app.password_reset_transactions" in statement and "for update" in statement:
            return Cursor(({
                "id": 61,
                "reset_token_id": 51,
                "expires_at": NOW + timedelta(minutes=10),
                "consumed_at": None,
            },) if self.valid else ())
        if "from app.password_reset_transactions" in statement:
            return Cursor((context,) if self.valid else ())
        if "from app.password_reset_tokens" in statement and "token_hash" in statement:
            return Cursor((context,) if self.valid else ())
        if "from app.accounts" in statement and "for update" in statement:
            return Cursor(({"id": 41, "is_active": True, "disabled_at": None},) if self.valid else ())
        if "from app.account_credentials" in statement and "for update" in statement:
            return Cursor(({"account_id": 41, "credential_version": 3},) if self.valid else ())
        if "from app.password_reset_tokens" in statement and "for update" in statement:
            return Cursor(({
                "id": 51,
                "account_id": 41,
                "credential_version": 3,
                "expires_at": NOW + timedelta(minutes=20),
                "consumed_at": None,
                "revoked_at": None,
            },) if self.valid else ())
        if "from app.account_sessions" in statement and "for update" in statement:
            return Cursor(({"id": 1}, {"id": 2}))
        return Cursor()


class Audit:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, _connection, **kwargs):
        self.calls.append(kwargs)
        return 1


def _config():
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
        "argon2": {"memory_cost": 65536, "time_cost": 3, "parallelism": 1, "salt_len": 16, "hash_len": 32},
        "argon2_policy_version": 4,
    }


def _service(connection, audit):
    from music_app.services.auth_password_reset_lifecycle_postgres import (
        PostgresPasswordResetLifecycleService,
    )

    return PostgresPasswordResetLifecycleService(
        _config(),
        connect=lambda _url: connection,
        clock=lambda: NOW,
        token_issuer=lambda: IssuedOpaqueToken(
            LIFECYCLE_RAW, hashlib.sha256(LIFECYCLE_RAW.encode("ascii")).digest()
        ),
        password_hasher=lambda *_args, **_kwargs: PasswordCredential("$argon2id$replacement", 4),
        breached_checker=lambda _password: False,
        audit_repository=audit,
    )


def test_exchange_validates_without_consuming_and_returns_redacted_clean_url_state():
    connection = Connection()
    issued = _service(connection, Audit()).exchange_reset_token(
        RESET_RAW, request_ref="exchange-1"
    )

    assert issued is not None
    assert issued.raw_token == LIFECYCLE_RAW
    assert issued.expires_at == NOW + timedelta(minutes=15)
    assert LIFECYCLE_RAW not in repr(issued)
    statements = [sql for sql, _ in connection.operations]
    assert any("insert into app.password_reset_transactions" in sql for sql in statements)
    assert not any("set consumed_at" in sql for sql in statements)
    assert RESET_RAW not in repr(connection.operations)


def test_completion_replaces_credential_increments_version_and_revokes_all_state():
    connection = Connection()
    audit = Audit()
    result = _service(connection, audit).complete_reset(
        LIFECYCLE_RAW,
        new_password="a sufficiently private replacement",
        request_ref="complete-1",
    )

    assert result.value == "success"
    statements = [sql for sql, _ in connection.operations]
    assert any("update app.account_credentials" in sql and "credential_version = credential_version + 1" in sql for sql in statements)
    assert any("update app.password_reset_tokens" in sql and "consumed_at" in sql for sql in statements)
    assert any("update app.password_reset_tokens" in sql and "revoked_at" in sql for sql in statements)
    assert any("update app.account_sessions" in sql and "password_reset" in sql for sql in statements)
    assert any("update app.password_reset_transactions" in sql and "consumed_at" in sql for sql in statements)
    assert audit.calls[-1]["reason"].value == "reset_completed"


def test_invalid_or_replayed_lifecycle_state_is_one_safe_result():
    connection = Connection(valid=False)
    result = _service(connection, Audit()).complete_reset(
        LIFECYCLE_RAW,
        new_password="a sufficiently private replacement",
        request_ref="complete-2",
    )

    assert result.value == "invalid"
    assert not any("update app.account_credentials" in sql for sql, _ in connection.operations)
