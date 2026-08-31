from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module, util

import pytest

from music_app.services.auth_tokens import IssuedOpaqueToken, hash_opaque_token


MODULE = "music_app.services.auth_preauth_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
RAW_TOKEN = "s" * 43


def test_auth_preauth_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None


@pytest.fixture
def preauth():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.events.append("tx:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("tx:rollback" if exc_type else "tx:commit")
        if exc_type is None and self.connection.fail_commit:
            raise RuntimeError("commit provider secret")


class RecordingConnection:
    def __init__(
        self,
        *,
        insert_rows=({"id": 71},),
        consume_rows=({"id": 71},),
        cleanup_rows=(),
        fail=None,
        fail_commit=False,
    ):
        self.insert_rows = list(insert_rows)
        self.consume_rows = list(consume_rows)
        self.cleanup_rows = list(cleanup_rows)
        self.fail = fail
        self.fail_commit = fail_commit
        self.operations = []
        self.events = []

    def __enter__(self):
        self.events.append("connection:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.events.append("connection:exit")

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=None):
        statement = " ".join(sql.casefold().split())
        self.operations.append((statement, params))
        if self.fail is not None:
            raise self.fail
        if statement.startswith("insert into app.auth_preflight_tokens"):
            return Cursor(self.insert_rows)
        if statement.startswith("update app.auth_preflight_tokens"):
            return Cursor(self.consume_rows)
        if statement.startswith("delete from app.auth_preflight_tokens"):
            return Cursor(self.cleanup_rows)
        raise AssertionError(f"unexpected SQL: {statement}")


def _config(seconds=600):
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "preauth_token_seconds": seconds,
    }


def _service(preauth, connection, *, clock=lambda: NOW, token_issuer=None):
    return preauth.PostgresPreAuthCsrfService(
        _config(),
        connect=lambda _url: connection,
        clock=clock,
        token_issuer=token_issuer or (
            lambda: IssuedOpaqueToken(RAW_TOKEN, hash_opaque_token(RAW_TOKEN))
        ),
    )


def test_issue_persists_digest_only_and_returns_redacted_token(preauth):
    connection = RecordingConnection()
    issued = _service(preauth, connection).issue_login_token()

    assert issued.raw_token == RAW_TOKEN
    assert issued.token_id == 71
    assert issued.expires_at == NOW + timedelta(minutes=10)
    assert RAW_TOKEN not in repr(issued)
    assert connection.events == ["connection:enter", "tx:enter", "tx:commit", "connection:exit"]
    sql, params = next(
        operation
        for operation in connection.operations
        if operation[0].startswith("insert into app.auth_preflight_tokens")
    )
    assert "insert into app.auth_preflight_tokens" in sql
    assert "returning id" in sql
    assert RAW_TOKEN not in repr(params)
    assert hash_opaque_token(RAW_TOKEN) in params
    assert "login" in params


def test_forgot_token_is_separately_purpose_bound(preauth):
    connection = RecordingConnection()
    service = _service(preauth, connection)

    issued = service.issue_forgot_token()
    assert issued.raw_token == RAW_TOKEN
    insert_params = next(
        params
        for sql, params in connection.operations
        if sql.startswith("insert into app.auth_preflight_tokens")
    )
    assert "forgot_password" in insert_params

    connection = RecordingConnection()
    assert _service(preauth, connection).consume_forgot_token(RAW_TOKEN) is True
    consume_params = connection.operations[0][1]
    assert "forgot_password" in consume_params


def test_issue_normalizes_aware_clock_to_utc(preauth):
    offset = NOW.astimezone(timezone(timedelta(hours=3)))
    connection = RecordingConnection()
    issued = _service(preauth, connection, clock=lambda: offset).issue_login_token()
    assert issued.expires_at.tzinfo is timezone.utc
    assert any(NOW in params for _, params in connection.operations)


def test_issue_runs_bounded_expiry_cleanup_before_insert(preauth):
    connection = RecordingConnection()
    _service(preauth, connection).issue_login_token()
    cleanup_sql, cleanup_params = connection.operations[0]
    assert cleanup_sql.startswith("delete from app.auth_preflight_tokens")
    assert "order by expires_at, id" in cleanup_sql
    assert "limit %s" in cleanup_sql
    assert cleanup_params == (NOW, 100)


@pytest.mark.parametrize("seconds", [0, 601, True, "600"])
def test_constructor_rejects_invalid_or_overlong_ttl(preauth, seconds):
    with pytest.raises((TypeError, ValueError)):
        preauth.PostgresPreAuthCsrfService(
            _config(seconds), connect=lambda _url: RecordingConnection()
        )


def test_consume_is_one_conditional_single_use_update(preauth):
    connection = RecordingConnection()
    assert _service(preauth, connection).consume_login_token(RAW_TOKEN) is True
    sql, params = connection.operations[0]
    assert sql.startswith("update app.auth_preflight_tokens")
    assert "purpose =" in sql and "consumed_at is null" in sql and "expires_at >" in sql
    assert "returning id" in sql
    assert RAW_TOKEN not in repr(params)
    assert hash_opaque_token(RAW_TOKEN) in params


@pytest.mark.parametrize("raw", [None, "", "short", "contains whitespace"])
def test_malformed_token_returns_false_without_database(preauth, raw):
    connection = RecordingConnection()
    assert _service(preauth, connection).consume_login_token(raw) is False
    assert connection.operations == []


def test_expired_or_replayed_token_returns_false(preauth):
    connection = RecordingConnection(consume_rows=())
    assert _service(preauth, connection).consume_login_token(RAW_TOKEN) is False
    assert connection.events[-2:] == ["tx:commit", "connection:exit"]


def test_multiple_rows_or_provider_failure_is_sanitized(preauth):
    connection = RecordingConnection(consume_rows=({"id": 1}, {"id": 2}))
    with pytest.raises(RuntimeError) as caught:
        _service(preauth, connection).consume_login_token(RAW_TOKEN)
    assert RAW_TOKEN not in str(caught.value)
    assert "tx:rollback" in connection.events

    failing = RecordingConnection(fail=RuntimeError("database provider secret"))
    with pytest.raises(RuntimeError) as caught:
        _service(preauth, failing).issue_login_token()
    assert "secret" not in str(caught.value)
    assert caught.value.__cause__ is None


def test_invalid_clock_and_token_provider_fail_without_secret_echo(preauth):
    for kwargs in (
        {"clock": lambda: "private clock secret"},
        {"token_issuer": lambda: "private token secret"},
    ):
        with pytest.raises(RuntimeError) as caught:
            _service(preauth, RecordingConnection(), **kwargs).issue_login_token()
        assert "secret" not in str(caught.value)
        assert caught.value.__cause__ is None


@pytest.mark.parametrize("operation", ["issue", "consume"])
def test_commit_failure_never_returns_issued_or_consumed_success(preauth, operation):
    connection = RecordingConnection(fail_commit=True)
    service = _service(preauth, connection)
    with pytest.raises(RuntimeError) as caught:
        (
            service.issue_login_token()
            if operation == "issue"
            else service.consume_login_token(RAW_TOKEN)
        )
    assert str(caught.value) == "Pre-authentication persistence operation failed."
    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
