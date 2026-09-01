from __future__ import annotations

from datetime import datetime, timezone
from importlib import import_module, util
from types import SimpleNamespace

import pytest
from argon2 import PasswordHasher
from argon2.low_level import Type


MODULE = "music_app.services.auth_break_glass_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 8, 31, 23, 0, tzinfo=timezone.utc)
ENCODED_HASH = PasswordHasher(
    memory_cost=65_536,
    time_cost=3,
    parallelism=1,
    salt_len=16,
    hash_len=32,
    type=Type.ID,
).hash("synthetic break-glass fixture password")


def test_auth_break_glass_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 break-glass persistence service: "
        "music_app/services/auth_break_glass_postgres.py"
    )


@pytest.fixture
def break_glass():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("transaction:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append(
            "transaction:rollback" if exc_type else "transaction:commit"
        )


class RecordingConnection:
    def __init__(
        self,
        *,
        owner_rows=({"account_id": 41},),
        account_rows=({"id": 41, "is_active": True, "account_kind": "bootstrap_owner"},),
        credential_rows=({"account_id": 41, "credential_version": 7},),
        reset_rows=({"id": 61}, {"id": 62}),
        session_rows=({"id": 71}, {"id": 72}, {"id": 73}),
    ):
        self.owner_rows = list(owner_rows)
        self.account_rows = list(account_rows)
        self.credential_rows = list(credential_rows)
        self.reset_rows = list(reset_rows)
        self.session_rows = list(session_rows)
        self.operations = []
        self.events = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return None

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=None):
        normalized = " ".join(sql.casefold().split())
        self.operations.append((normalized, params))
        if "from app.bootstrap_owners" in normalized:
            return Cursor(self.owner_rows)
        if "from app.accounts" in normalized:
            return Cursor(self.account_rows)
        if "from app.account_credentials" in normalized:
            return Cursor(self.credential_rows)
        if normalized.startswith("select id from app.password_reset_tokens"):
            return Cursor(self.reset_rows)
        if normalized.startswith("update app.password_reset_tokens"):
            return Cursor(self.reset_rows)
        if normalized.startswith("update app.password_reset_transactions"):
            return Cursor(({"id": 81},))
        if normalized.startswith("select id from app.account_sessions"):
            return Cursor(self.session_rows)
        if normalized.startswith("update app.account_sessions"):
            return Cursor(self.session_rows)
        if normalized.startswith("update app.account_credentials"):
            return Cursor(({"credential_version": 8},))
        return Cursor()


class AuditRepository:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, connection, **kwargs):
        self.calls.append((connection, kwargs))
        connection.operations.append(("audit", kwargs))
        return 91


def _service(module, connection, audit=None, *, config=None):
    values = {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "argon2": {
            "memory_cost": 65_536,
            "time_cost": 3,
            "parallelism": 1,
            "salt_len": 16,
            "hash_len": 32,
        },
        "argon2_policy_version": 3,
    }
    if config is not None:
        values = config
    return module.PostgresAuthBreakGlassService(
        values,
        connect=lambda database_url: connection,
        audit_repository=audit or AuditRepository(),
        clock=lambda: NOW,
    )


def _reset(service):
    return service.reset_owner(
        encoded_hash=ENCODED_HASH,
        hash_policy_version=3,
        request_ref="break-glass_123",
    )


def _index(connection, fragment):
    return next(
        index
        for index, (statement, _params) in enumerate(connection.operations)
        if fragment in statement
    )


def test_break_glass_requires_database_url(break_glass):
    service = _service(break_glass, RecordingConnection(), config={})

    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_APP_DATABASE_URL"):
        _reset(service)


def test_break_glass_uses_one_short_deterministically_ordered_transaction(break_glass):
    connection = RecordingConnection()

    result = _reset(_service(break_glass, connection))

    assert result.account_id == 41
    assert result.credential_version == 8
    assert result.revoked_sessions == 3
    assert result.revoked_reset_tokens == 2
    assert connection.events == ["transaction:enter", "transaction:commit"]
    ordered = [
        "from app.bootstrap_owners",
        "from app.accounts",
        "from app.account_credentials",
        "select id from app.password_reset_tokens",
        "select id from app.account_sessions",
        "audit",
    ]
    assert [_index(connection, fragment) for fragment in ordered] == sorted(
        _index(connection, fragment) for fragment in ordered
    )


def test_break_glass_replaces_credential_and_revokes_lifecycle_state(break_glass):
    connection = RecordingConnection()

    _reset(_service(break_glass, connection))

    credential = next(
        item
        for item in connection.operations
        if item[0].startswith("update app.account_credentials")
    )
    assert ENCODED_HASH in credential[1]
    assert "credential_version = credential_version + 1" in credential[0]
    assert "administrator_set = false" in credential[0]
    reset = next(
        item
        for item in connection.operations
        if item[0].startswith("update app.password_reset_tokens")
    )
    assert "revoked_at" in reset[0]
    transaction = next(
        item
        for item in connection.operations
        if item[0].startswith("update app.password_reset_transactions")
    )
    assert "consumed_at" in transaction[0]
    sessions = next(
        item
        for item in connection.operations
        if item[0].startswith("update app.account_sessions")
    )
    assert "revocation_reason = 'break_glass'" in sessions[0]


def test_break_glass_emits_one_secret_free_emergency_audit(break_glass):
    connection = RecordingConnection()
    audit = AuditRepository()

    _reset(_service(break_glass, connection, audit))

    assert len(audit.calls) == 1
    received_connection, payload = audit.calls[0]
    assert received_connection is connection
    assert payload["category"].value == "credential"
    assert payload["outcome"].value == "success"
    assert payload["reason"].value == "break_glass_reset"
    assert payload["actor_account_id"] is None
    assert payload["target_account_id"] == 41
    assert payload["request_ref"] == "break-glass_123"
    assert payload["occurred_at"] == NOW
    assert payload["metadata"] == {"argon2_policy_version": 3}
    assert ENCODED_HASH not in repr(payload)


@pytest.mark.parametrize(
    "overrides",
    [
        {"owner_rows": ()},
        {"owner_rows": ({"account_id": 41}, {"account_id": 42})},
        {"account_rows": ()},
        {"account_rows": ({"id": 41, "is_active": False, "account_kind": "bootstrap_owner"},)},
        {"account_rows": ({"id": 41, "is_active": True, "account_kind": "managed"},)},
        {"credential_rows": ()},
        {"credential_rows": ({"account_id": 41, "credential_version": 0},)},
    ],
)
def test_break_glass_rejects_invalid_owner_context_before_mutation(
    break_glass, overrides
):
    connection = RecordingConnection(**overrides)

    with pytest.raises(RuntimeError):
        _reset(_service(break_glass, connection))

    assert connection.events[-1] == "transaction:rollback"
    assert not any(
        statement.startswith("update ") or statement == "audit"
        for statement, _params in connection.operations
    )


def test_break_glass_rejects_invalid_hash_before_connect(break_glass):
    connection = RecordingConnection()

    with pytest.raises(ValueError):
        _service(break_glass, connection).reset_owner(
            encoded_hash="$argon2id$v=19$malformed",
            hash_policy_version=3,
            request_ref="break-glass_123",
        )

    assert connection.operations == []


def test_break_glass_rolls_back_when_audit_fails(break_glass):
    connection = RecordingConnection()

    class BrokenAudit:
        def append_in_transaction(self, *_args, **_kwargs):
            raise RuntimeError("private-audit-failure")

    with pytest.raises(RuntimeError) as caught:
        _reset(_service(break_glass, connection, BrokenAudit()))

    assert "private-audit-failure" not in str(caught.value)
    assert connection.events[-1] == "transaction:rollback"
