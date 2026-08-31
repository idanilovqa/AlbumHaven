from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module, util
from typing import Any

import pytest

from music_app.services.auth_tokens import IssuedOpaqueToken, hash_opaque_token


MODULE = "music_app.services.auth_sessions_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
RAW_TOKEN = "s" * 43


def test_auth_sessions_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 session persistence service: "
        "music_app/services/auth_sessions_postgres.py"
    )


@pytest.fixture
def sessions():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


class Cursor:
    def __init__(self, rows=(), *, rowcount=-1):
        self.rows = list(rows)
        self.rowcount = rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class Tx:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("tx:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("tx:rollback" if exc_type else "tx:commit")


class RecordingConnection:
    def __init__(self, *, account_rows=None, session_rows=None, active_rows=()):
        self.account_rows = list(
            ({"id": 41, "is_active": True, "disabled_at": None},)
            if account_rows is None else account_rows
        )
        self.session_rows = list(() if session_rows is None else session_rows)
        self.active_rows = list(active_rows)
        self.operations: list[tuple[str, object]] = []
        self.events: list[str] = []

    def __enter__(self):
        self.events.append("connection:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.events.append("connection:exit")

    def transaction(self):
        return Tx(self)

    def execute(self, sql: str, params: object = None):
        statement = " ".join(sql.casefold().split())
        self.operations.append((statement, params))
        if "insert into app.account_sessions" in statement:
            return Cursor(({"id": 88},))
        if "from app.accounts" in statement:
            return Cursor(self.account_rows)
        if "from app.account_sessions" in statement and "join app.accounts" in statement:
            return Cursor(self.session_rows)
        if "from app.account_sessions" in statement and "account_id" in statement:
            return Cursor(self.active_rows)
        return Cursor()


def _config(**session_overrides: Any):
    policy = {
        "idle_seconds": 12 * 60 * 60,
        "absolute_seconds": 7 * 24 * 60 * 60,
        "activity_write_seconds": 5 * 60,
        "active_cap": 2,
    }
    policy.update(session_overrides)
    return {"ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL, "session": policy}


def _service(sessions, connection, **config_overrides):
    return sessions.PostgresAuthSessionService(
        _config(**config_overrides),
        connect=lambda _url: connection,
        token_issuer=lambda: RAW_TOKEN,
        clock=lambda: NOW,
    )


def _resolved_row(**overrides):
    row = {
        "session_id": 88,
        "account_id": 41,
        "is_active": True,
        "disabled_at": None,
        "created_at": NOW - timedelta(hours=1),
        "authenticated_at": NOW - timedelta(hours=1),
        "last_seen_at": NOW - timedelta(minutes=6),
        "idle_expires_at": NOW + timedelta(hours=11),
        "absolute_expires_at": NOW + timedelta(days=6),
        "revoked_at": None,
        "revocation_reason": None,
        "user_agent": "Album Haven Browser",
    }
    row.update(overrides)
    return row


def _sql(connection):
    return [statement for statement, _ in connection.operations]


def test_constructor_requires_database_url(sessions):
    with pytest.raises(RuntimeError, match="ALBUM_HAVEN_APP_DATABASE_URL"):
        sessions.PostgresAuthSessionService({"session": _config()["session"]})


def test_issue_uses_one_owned_transaction_digest_only_lifetimes_and_lock_order(sessions):
    connection = RecordingConnection()
    result = _service(sessions, connection).issue_session(
        account_id=41, user_agent="Album Haven Browser"
    )

    assert result.raw_token == RAW_TOKEN
    assert result.account_id == 41 and result.session_id == 88
    assert result.authenticated_at == NOW
    assert result.idle_expires_at == NOW + timedelta(hours=12)
    assert result.absolute_expires_at == NOW + timedelta(days=7)
    assert RAW_TOKEN not in repr(result)
    assert connection.events == [
        "connection:enter", "tx:enter", "tx:commit", "connection:exit"
    ]
    sql = _sql(connection)
    account = next(i for i, item in enumerate(sql) if "from app.accounts" in item)
    active = next(i for i, item in enumerate(sql) if "from app.account_sessions" in item)
    inserted = next(i for i, item in enumerate(sql) if "insert into app.account_sessions" in item)
    assert account < active < inserted
    assert "for update" in sql[account]
    assert "order by" in sql[active] and "for update" in sql[active]
    insert_params = connection.operations[inserted][1]
    assert RAW_TOKEN not in repr(insert_params)
    assert any(isinstance(value, bytes) and len(value) == 32 for value in insert_params)
    assert "Album Haven Browser" in insert_params


def test_issue_rejects_inactive_account_before_insert_and_closes_owned_transaction(sessions):
    connection = RecordingConnection(
        account_rows=({"id": 41, "is_active": False, "disabled_at": NOW},)
    )
    with pytest.raises(RuntimeError) as caught:
        _service(sessions, connection).issue_session(account_id=41)
    assert RAW_TOKEN not in str(caught.value)
    assert not any("insert into app.account_sessions" in item for item in _sql(connection))
    assert "tx:rollback" in connection.events


def test_issue_revokes_oldest_over_cap_before_insert(sessions):
    connection = RecordingConnection(active_rows=({"id": 1}, {"id": 2}))
    _service(sessions, connection).issue_session(account_id=41)
    sql = _sql(connection)
    revoked = next(i for i, item in enumerate(sql) if item.startswith("update app.account_sessions"))
    inserted = next(i for i, item in enumerate(sql) if "insert into app.account_sessions" in item)
    assert revoked < inserted


def test_issue_with_caller_connection_uses_no_nested_transaction(sessions):
    connection = RecordingConnection()
    _service(sessions, connection).issue_session(account_id=41, connection=connection)
    assert connection.events == []


@pytest.mark.parametrize("raw", [None, "", "short", "contains whitespace"])
def test_resolve_malformed_token_fails_without_database(sessions, raw):
    connection = RecordingConnection()
    assert _service(sessions, connection).resolve_session(raw) is None
    assert connection.operations == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"is_active": False},
        {"disabled_at": NOW},
        {"revoked_at": NOW - timedelta(seconds=1)},
        {"idle_expires_at": NOW},
        {"absolute_expires_at": NOW},
    ],
)
def test_resolve_rejects_disabled_revoked_or_exactly_expired(sessions, overrides):
    connection = RecordingConnection(session_rows=(_resolved_row(**overrides),))
    assert _service(sessions, connection).resolve_session(RAW_TOKEN) is None
    assert not any(item.startswith("update app.account_sessions") for item in _sql(connection))


def test_resolve_writes_activity_at_threshold_and_clamps_idle_to_absolute(sessions):
    connection = RecordingConnection(session_rows=(_resolved_row(
        last_seen_at=NOW - timedelta(minutes=5),
        absolute_expires_at=NOW + timedelta(minutes=30),
    ),))
    result = _service(sessions, connection).resolve_session(RAW_TOKEN)
    assert result.account_id == 41 and result.session_id == 88
    assert RAW_TOKEN not in repr(result)
    update = next(item for item in connection.operations if item[0].startswith("update app.account_sessions"))
    assert NOW in update[1]
    assert NOW + timedelta(minutes=30) in update[1]


def test_resolve_below_activity_threshold_does_not_write(sessions):
    connection = RecordingConnection(session_rows=(_resolved_row(
        last_seen_at=NOW - timedelta(minutes=4, seconds=59)
    ),))
    assert _service(sessions, connection).resolve_session(RAW_TOKEN).account_id == 41
    assert not any(item.startswith("update app.account_sessions") for item in _sql(connection))


@pytest.mark.parametrize("method", ["resolve_session", "revoke_current"])
def test_digest_operations_discover_then_lock_account_before_session(sessions, method):
    connection = RecordingConnection(session_rows=(_resolved_row(),))
    getattr(_service(sessions, connection), method)(RAW_TOKEN)

    sql = _sql(connection)
    discovery = next(
        i for i, statement in enumerate(sql)
        if "session_token_hash" in statement and "for update" not in statement
    )
    account = next(i for i, statement in enumerate(sql) if "from app.accounts" in statement)
    locked_session = next(
        i for i, statement in enumerate(sql)
        if "session_token_hash" in statement and "for update" in statement
    )
    assert discovery < account < locked_session
    assert "order by" in sql[locked_session]


def test_resolve_accepts_tuple_rows_without_exposing_digest_or_token(sessions):
    row = _resolved_row()
    connection = RecordingConnection(session_rows=(tuple(row.values()),))
    result = _service(sessions, connection).resolve_session(RAW_TOKEN)
    assert result.account_id == 41
    assert RAW_TOKEN not in repr(result)
    assert all(RAW_TOKEN not in repr(params) for _, params in connection.operations)


def test_revoke_current_and_all_are_idempotent_reason_bound_and_digest_only(sessions):
    connection = RecordingConnection()
    service = _service(sessions, connection)
    reason = sessions.SessionRevocationReason.LOGOUT
    assert service.revoke_current(RAW_TOKEN, reason=reason) in {True, False}
    assert service.revoke_all(41, reason=reason) >= 0
    assert RAW_TOKEN not in repr(connection.operations)
    updates = [item for item in connection.operations if item[0].startswith("update app.account_sessions")]
    assert updates and all("revoked_at is null" in statement for statement, _ in updates)
    assert all(reason.value in params for _, params in updates)
    with pytest.raises((TypeError, ValueError)):
        service.revoke_all(41, reason="logout")


def test_revoke_current_true_means_newly_revoked_and_repeat_is_false(sessions):
    class RevocationConnection(RecordingConnection):
        remaining = 1

        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            statement = " ".join(sql.casefold().split())
            if statement.startswith("update app.account_sessions"):
                if self.remaining:
                    self.remaining -= 1
                    return Cursor(({"id": 88},), rowcount=1)
                return Cursor((), rowcount=0)
            return cursor

    connection = RevocationConnection(session_rows=(_resolved_row(),))
    service = _service(sessions, connection)
    assert service.revoke_current(RAW_TOKEN) is True
    assert service.revoke_current(RAW_TOKEN) is False


def test_revoke_all_caller_connection_locks_account_then_sessions_without_nested_tx(sessions):
    connection = RecordingConnection(active_rows=({"id": 88},))
    service = _service(sessions, connection)
    service.revoke_all(
        41,
        reason=sessions.SessionRevocationReason.LOGOUT,
        connection=connection,
    )
    sql = _sql(connection)
    account = next(i for i, item in enumerate(sql) if "from app.accounts" in item)
    sessions_lock = next(i for i, item in enumerate(sql) if "from app.account_sessions" in item)
    assert account < sessions_lock
    assert "for update" in sql[account]
    assert "order by" in sql[sessions_lock] and "for update" in sql[sessions_lock]
    assert connection.events == []


def test_driver_and_transaction_fail_closed_without_leaking_token(sessions):
    def broken(_url):
        raise RuntimeError("database unavailable")

    service = sessions.PostgresAuthSessionService(
        _config(), connect=broken, token_issuer=lambda: RAW_TOKEN, clock=lambda: NOW
    )
    with pytest.raises(RuntimeError) as caught:
        service.issue_session(account_id=41)
    assert RAW_TOKEN not in str(caught.value)


def test_injected_token_digest_must_match_returned_raw_token(sessions):
    connection = RecordingConnection()
    service = sessions.PostgresAuthSessionService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: IssuedOpaqueToken(raw=RAW_TOKEN, digest=b"x" * 32),
        clock=lambda: NOW,
    )

    with pytest.raises(ValueError) as caught:
        service.issue_session(account_id=41)

    assert RAW_TOKEN not in str(caught.value)
    assert connection.operations == []


@pytest.mark.parametrize("user_agent", ["browser\tname", "browser\x7fname", "browser\u0085name"])
def test_issue_rejects_all_control_characters_in_user_agent(sessions, user_agent):
    connection = RecordingConnection()
    with pytest.raises(ValueError):
        _service(sessions, connection).issue_session(
            account_id=41, user_agent=user_agent
        )
    assert connection.operations == []


def test_database_failures_do_not_echo_session_digest_or_raw_token(sessions):
    digest = hash_opaque_token(RAW_TOKEN)

    class LeakyConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "insert into app.account_sessions" in statement:
                raise RuntimeError(f"database rejected {params!r}")
            return super().execute(sql, params)

    connection = LeakyConnection()
    with pytest.raises(RuntimeError) as caught:
        _service(sessions, connection).issue_session(account_id=41)

    message = str(caught.value)
    assert RAW_TOKEN not in message
    assert repr(digest) not in message
