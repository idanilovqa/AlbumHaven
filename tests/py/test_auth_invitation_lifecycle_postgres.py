from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import base64
import hashlib
from threading import Barrier, Lock, local

import pytest

from music_app.services.auth_audit_postgres import (
    InvitationAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_invitation_lifecycle_postgres import (
    PostgresInvitationLifecycleService,
)
from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_TRANSACTION_SECONDS,
    InvitationCompletionOutcome,
    IssuedInvitationTransaction,
)
from music_app.services.auth_passwords import PasswordCredential
from music_app.services.auth_tokens import IssuedOpaqueToken


NOW = datetime(2026, 9, 1, 18, 0, tzinfo=timezone.utc)
INVITATION_RAW = base64.urlsafe_b64encode(bytes([0x11]) * 32).decode("ascii").rstrip("=")
TRANSACTION_RAW = base64.urlsafe_b64encode(bytes([0x22]) * 32).decode("ascii").rstrip("=")
PASSWORD = "Phase Seven Recipient Passphrase 2026!"


class Cursor:
    def __init__(self, rows=(), *, rowcount=1):
        self._rows = list(rows)
        self.rowcount = rowcount

    def fetchall(self):
        return list(self._rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("begin")
        self.connection.transaction_depth += 1

    def __exit__(self, exc_type, exc, tb):
        self.connection.transaction_depth -= 1
        self.connection.events.append("rollback" if exc_type else "commit")
        self.connection.committed = exc_type is None


class Connection:
    def __init__(self, *, state="valid", exchange_inserted=True):
        self.state = state
        self.exchange_inserted = exchange_inserted
        self.events = []
        self.operations = []
        self.transaction_depth = 0
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=()):
        statement = " ".join(sql.casefold().split())
        self.operations.append((statement, params))
        invalid = self.state != "valid"
        context = {
            "transaction_id": 61,
            "invitation_token_id": 51,
            "account_id": 41,
            "username_display": "member.one",
            "contact_email": "member@example.test",
            "is_active": self.state != "disabled",
            "disabled_at": NOW if self.state == "disabled" else None,
            "invitation_expires_at": (
                NOW - timedelta(seconds=1)
                if self.state == "expired"
                else NOW + timedelta(hours=24)
            ),
            "transaction_expires_at": NOW + timedelta(minutes=15),
            "invitation_consumed_at": NOW if self.state == "consumed" else None,
            "invitation_revoked_at": NOW if self.state in {"revoked", "rotated"} else None,
            "transaction_consumed_at": NOW if self.state == "consumed" else None,
        }
        if "insert into app.account_invitation_transactions" in statement:
            return Cursor(({"id": 61},) if self.exchange_inserted else ())
        if (
            "from app.account_invitation_transactions" in statement
            and "for update" not in statement
        ) or (
            "from app.account_invitation_transactions transaction" in statement
            and "for update" not in statement
        ):
            return Cursor(() if invalid else (context,))
        if (
            "from app.account_invitation_tokens invitation" in statement
            and "token_hash" in statement
        ):
            return Cursor(() if invalid else (context,))
        if "from app.accounts" in statement and "for update" in statement:
            return Cursor(({
                "id": 41,
                "account_kind": "managed_user",
                "is_active": self.state != "disabled",
                "disabled_at": NOW if self.state == "disabled" else None,
            },))
        if "from app.account_credentials" in statement and "for update" in statement:
            return Cursor(({"account_id": 41},) if self.state == "credential_exists" else ())
        if "from app.account_invitation_tokens" in statement and "for update" in statement:
            return Cursor(({
                "id": 51,
                "account_id": 41,
                "purpose": INVITATION_DB_PURPOSE,
                "expires_at": context["invitation_expires_at"],
                "consumed_at": context["invitation_consumed_at"],
                "revoked_at": context["invitation_revoked_at"],
            },))
        if "from app.account_invitation_transactions" in statement and "for update" in statement:
            return Cursor(({
                "id": 61,
                "invitation_token_id": 51,
                "expires_at": context["transaction_expires_at"],
                "consumed_at": context["transaction_consumed_at"],
            },))
        return Cursor()


class Audit:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, _connection, **event):
        self.calls.append(event)
        return 1


def _config():
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
        "argon2": {
            "memory_cost": 65536,
            "time_cost": 3,
            "parallelism": 1,
            "salt_len": 16,
            "hash_len": 32,
        },
        "argon2_policy_version": 4,
    }


def _issued(raw):
    return IssuedOpaqueToken(raw, hashlib.sha256(raw.encode("ascii")).digest())


def _service(connection, audit=None, *, password_hasher=None):
    return PostgresInvitationLifecycleService(
        _config(),
        connect=lambda _url: connection,
        clock=lambda: NOW,
        token_issuer=lambda: _issued(TRANSACTION_RAW),
        password_hasher=password_hasher
        or (lambda *_args, **_kwargs: PasswordCredential("$argon2id$invited", 4)),
        breached_checker=lambda _password: False,
        audit_repository=audit or Audit(),
    )


def _statements(connection):
    return [sql for sql, _ in connection.operations]


def test_exchange_is_single_use_and_returns_shared_redacted_clean_url_state():
    connection = Connection()

    issued = _service(connection).exchange_invitation_token(
        INVITATION_RAW, request_ref="b" * 32
    )

    assert isinstance(issued, IssuedInvitationTransaction)
    assert issued.raw_token == TRANSACTION_RAW
    assert issued.expires_at == NOW + timedelta(seconds=INVITATION_TRANSACTION_SECONDS)
    assert TRANSACTION_RAW not in repr(issued)
    assert connection.committed is True
    assert any(
        "insert into app.account_invitation_transactions" in sql
        and "on conflict (invitation_token_id) do nothing" in sql
        for sql in _statements(connection)
    )
    assert INVITATION_RAW not in repr(connection.operations)


def test_exchange_on_conflict_loser_is_one_safe_committed_invalid_result():
    connection = Connection(exchange_inserted=False)

    result = _service(connection).exchange_invitation_token(
        INVITATION_RAW, request_ref="d" * 32
    )

    assert result is None
    assert connection.committed is True


def test_transaction_validation_is_purpose_bound_and_requires_pending_account():
    connection = Connection()

    assert _service(connection).validate_transaction(TRANSACTION_RAW) is True

    statement, params = next(
        (sql, params)
        for sql, params in connection.operations
        if "account_invitation_transactions" in sql
    )
    assert "credential.account_id is null" in statement
    assert "account.account_kind = 'managed_user'" in statement
    assert "account.is_active is true" in statement
    assert "invitation.consumed_at is null" in statement
    assert "invitation.revoked_at is null" in statement
    assert INVITATION_DB_PURPOSE in params


def test_completion_inserts_first_recipient_credential_and_consumes_exact_state():
    connection = Connection()
    audit = Audit()
    hasher_depth = []

    def password_hasher(*_args, **_kwargs):
        hasher_depth.append(connection.transaction_depth)
        return PasswordCredential("$argon2id$invited", 4)

    result = _service(
        connection, audit, password_hasher=password_hasher
    ).complete_invitation(
        TRANSACTION_RAW,
        new_password=PASSWORD,
        request_ref="c" * 32,
    )

    assert result is InvitationCompletionOutcome.SUCCESS
    assert hasher_depth == [0]
    statements = _statements(connection)
    credential_insert = next(
        sql for sql in statements if "insert into app.account_credentials" in sql
    )
    assert "credential_version, administrator_set" in credential_insert
    assert "1, false" in credential_insert
    assert any(
        "update app.account_invitation_tokens set consumed_at" in sql
        and "consumed_at is null" in sql
        and "revoked_at is null" in sql
        and "expires_at >" in sql
        for sql in statements
    )
    assert any(
        "update app.account_invitation_transactions set consumed_at" in sql
        and "consumed_at is null" in sql
        and "expires_at >" in sql
        for sql in statements
    )
    assert any(
        "update app.account_invitation_tokens set revoked_at" in sql
        and "id <>" in sql
        for sql in statements
    )
    assert any("update app.password_reset_tokens set revoked_at" in sql for sql in statements)
    assert audit.calls == [{
        "category": SecurityAuditCategory.ACCOUNT_INVITATION,
        "outcome": SecurityAuditOutcome.SUCCESS,
        "reason": InvitationAuditReason.INVITATION_ACCEPTED,
        "actor_account_id": None,
        "target_account_id": 41,
        "request_ref": "c" * 32,
        "occurred_at": NOW,
        "metadata": None,
    }]


@pytest.mark.parametrize(
    "state",
    ["expired", "revoked", "consumed", "disabled", "credential_exists", "rotated"],
)
def test_expired_revoked_consumed_disabled_credentialed_and_rotated_are_generic_invalid(state):
    connection = Connection(state=state)
    service = _service(connection)

    assert service.validate_transaction(TRANSACTION_RAW) is False
    assert service.complete_invitation(
        TRANSACTION_RAW,
        new_password=PASSWORD,
        request_ref="invalid-state",
    ) is InvitationCompletionOutcome.INVALID
    assert not any(
        "insert into app.account_credentials" in sql
        for sql in _statements(connection)
    )


@pytest.mark.parametrize("raw", [None, "short", "snowman-☃"])
def test_malformed_transaction_is_a_safe_invalid_result_without_sql(raw):
    connection = Connection()
    service = _service(connection)

    assert service.validate_transaction(raw) is False
    assert service.complete_invitation(
        raw, new_password=PASSWORD, request_ref="invalid-token"
    ) is InvitationCompletionOutcome.INVALID
    assert connection.operations == []


def test_provider_failures_are_sanitized_without_raw_invitation_or_transaction_secrets():
    class FailingConnection(Connection):
        def execute(self, sql, params=()):
            raise RuntimeError(f"database leaked {INVITATION_RAW} {TRANSACTION_RAW}")

    service = _service(FailingConnection())

    with pytest.raises(RuntimeError) as exchange_error:
        service.exchange_invitation_token(INVITATION_RAW, request_ref="exchange-error")
    with pytest.raises(RuntimeError) as validation_error:
        service.validate_transaction(TRANSACTION_RAW)
    with pytest.raises(RuntimeError) as completion_error:
        service.complete_invitation(
            TRANSACTION_RAW, new_password=PASSWORD, request_ref="complete-error"
        )

    rendered = " ".join(
        str(error.value)
        for error in (exchange_error, validation_error, completion_error)
    )
    assert INVITATION_RAW not in rendered
    assert TRANSACTION_RAW not in rendered
    assert "database leaked" not in rendered


class AtomicExchangeConnection(Connection):
    def __init__(self, barrier):
        super().__init__()
        self._barrier = barrier
        self._insert_lock = Lock()
        self._inserted = False

    def execute(self, sql, params=()):
        statement = " ".join(sql.casefold().split())
        if "insert into app.account_invitation_transactions" in statement:
            self.operations.append((statement, params))
            self._barrier.wait(timeout=10)
            with self._insert_lock:
                if self._inserted:
                    return Cursor(())
                self._inserted = True
                return Cursor(({"id": 61},))
        return super().execute(sql, params)


def test_concurrent_exchange_has_exactly_one_transaction_winner():
    connection = AtomicExchangeConnection(Barrier(2))
    service = _service(connection)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(
            lambda ref: service.exchange_invitation_token(
                INVITATION_RAW, request_ref=ref
            ),
            ("exchange-a", "exchange-b"),
        ))

    assert sum(result is not None for result in results) == 1


class SerializedCompletionTransaction(Transaction):
    def __enter__(self):
        self.connection._active.transaction = self
        return super().__enter__()

    def __exit__(self, exc_type, exc, tb):
        try:
            return super().__exit__(exc_type, exc, tb)
        finally:
            if getattr(self, "locked", False):
                self.connection._completion_lock.release()
            self.connection._active.transaction = None


class AtomicCompletionConnection(Connection):
    def __init__(self, barrier):
        super().__init__()
        self._barrier = barrier
        self._completion_lock = Lock()
        self._active = local()
        self._snapshot_count = 0
        self._credential_exists = False
        self._invitation_consumed = False
        self._transaction_consumed = False

    def transaction(self):
        return SerializedCompletionTransaction(self)

    def execute(self, sql, params=()):
        statement = " ".join(sql.casefold().split())
        is_snapshot = (
            "account_invitation_transactions" in statement
            and "transaction_hash" in statement
            and "for update" not in statement
            and "insert into" not in statement
        )
        if is_snapshot:
            result = super().execute(sql, params)
            self._snapshot_count += 1
            if self._snapshot_count <= 2:
                self._barrier.wait(timeout=10)
            return result
        if "from app.accounts" in statement and "for update" in statement:
            transaction = self._active.transaction
            self._completion_lock.acquire()
            transaction.locked = True
            return super().execute(sql, params)
        if "from app.account_credentials" in statement and "for update" in statement:
            self.operations.append((statement, params))
            return Cursor(({"account_id": 41},) if self._credential_exists else ())
        if "from app.account_invitation_tokens" in statement and "for update" in statement:
            self.operations.append((statement, params))
            return Cursor(({
                "id": 51,
                "account_id": 41,
                "purpose": INVITATION_DB_PURPOSE,
                "expires_at": NOW + timedelta(hours=24),
                "consumed_at": NOW if self._invitation_consumed else None,
                "revoked_at": None,
            },))
        if "from app.account_invitation_transactions" in statement and "for update" in statement:
            self.operations.append((statement, params))
            return Cursor(({
                "id": 61,
                "invitation_token_id": 51,
                "expires_at": NOW + timedelta(minutes=15),
                "consumed_at": NOW if self._transaction_consumed else None,
            },))
        if "insert into app.account_credentials" in statement:
            self.operations.append((statement, params))
            self._credential_exists = True
            return Cursor()
        if "update app.account_invitation_tokens set consumed_at" in statement:
            self.operations.append((statement, params))
            if self._invitation_consumed:
                return Cursor(rowcount=0)
            self._invitation_consumed = True
            return Cursor(rowcount=1)
        if "update app.account_invitation_transactions set consumed_at" in statement:
            self.operations.append((statement, params))
            if self._transaction_consumed:
                return Cursor(rowcount=0)
            self._transaction_consumed = True
            return Cursor(rowcount=1)
        return super().execute(sql, params)


def test_concurrent_completion_has_exactly_one_successful_credential_winner():
    connection = AtomicCompletionConnection(Barrier(2))
    service = _service(connection)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(
            lambda ref: service.complete_invitation(
                TRANSACTION_RAW, new_password=PASSWORD, request_ref=ref
            ),
            ("complete-a", "complete-b"),
        ))

    assert results.count(InvitationCompletionOutcome.SUCCESS) == 1
    assert results.count(InvitationCompletionOutcome.INVALID) == 1
