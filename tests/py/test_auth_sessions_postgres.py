from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone, tzinfo
from importlib import import_module, util
from typing import Any

import pytest

from music_app.services.auth_tokens import IssuedOpaqueToken, hash_opaque_token


MODULE = "music_app.services.auth_sessions_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
RAW_TOKEN = "s" * 43


class RaisingTzinfo(tzinfo):
    def utcoffset(self, _dt):
        raise RuntimeError("private clock secret")


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
        if statement.startswith("update app.account_sessions"):
            revoked_ids = params[2] if isinstance(params, tuple) and len(params) > 2 else ()
            return Cursor(rowcount=len(revoked_ids) if isinstance(revoked_ids, list) else 0)
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


def test_prepare_session_issues_and_validates_before_any_database_transaction(sessions):
    connection = RecordingConnection()
    issuer_observations = []
    service = sessions.PostgresAuthSessionService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: issuer_observations.append(
            (list(connection.events), list(connection.operations))
        ) or RAW_TOKEN,
        clock=lambda: NOW,
    )

    prepared = service.prepare_session(41, user_agent="Private Browser Label")

    assert issuer_observations == [([], [])]
    assert connection.events == [] and connection.operations == []
    assert prepared.account_id == 41
    assert prepared.raw_token == RAW_TOKEN
    assert prepared.token_digest == hash_opaque_token(RAW_TOKEN)
    assert prepared.authenticated_at == NOW
    assert prepared.idle_expires_at == NOW + timedelta(hours=12)
    assert prepared.absolute_expires_at == NOW + timedelta(days=7)
    assert prepared.user_agent == "Private Browser Label"
    rendered = repr(prepared)
    assert RAW_TOKEN not in rendered
    assert repr(prepared.token_digest) not in rendered
    assert "Private Browser Label" not in rendered


@pytest.mark.parametrize(
    "user_agent", ["browser\tname", "browser\x7fname", "browser\u0085name"]
)
def test_prepare_session_rejects_user_agent_before_token_or_database(
    sessions, user_agent
):
    connection = RecordingConnection()
    token_calls = []
    service = sessions.PostgresAuthSessionService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: token_calls.append(True) or RAW_TOKEN,
        clock=lambda: NOW,
    )

    with pytest.raises(ValueError):
        service.prepare_session(41, user_agent=user_agent)

    assert token_calls == []
    assert connection.events == [] and connection.operations == []


@pytest.mark.parametrize("user_agent", [123, "x" * 1025])
def test_prepare_session_rejects_invalid_user_agent_before_token_or_database(
    sessions, user_agent
):
    connection = RecordingConnection()
    token_calls = []
    service = sessions.PostgresAuthSessionService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: token_calls.append(True) or RAW_TOKEN,
        clock=lambda: NOW,
    )

    with pytest.raises(ValueError):
        service.prepare_session(41, user_agent=user_agent)

    assert token_calls == []
    assert connection.events == [] and connection.operations == []


def test_prepare_session_sanitizes_clock_timezone_failure_before_database(sessions):
    connection = RecordingConnection()
    service = sessions.PostgresAuthSessionService(
        _config(),
        connect=lambda _url: connection,
        token_issuer=lambda: RAW_TOKEN,
        clock=lambda: datetime(2026, 8, 30, 12, 0, tzinfo=RaisingTzinfo()),
    )

    with pytest.raises(RuntimeError, match="^Session clock is unavailable\\.$") as caught:
        service.prepare_session(41)

    assert caught.value.__cause__ is None
    assert "private clock secret" not in str(caught.value)
    assert connection.events == [] and connection.operations == []


def test_persist_prepared_uses_caller_connection_without_account_query_or_transaction(
    sessions,
):
    connection = RecordingConnection()
    service = _service(sessions, connection)
    prepared = service.prepare_session(41, user_agent="Private Browser Label")

    issued = service.persist_prepared_for_locked_account(prepared, connection)

    assert connection.events == []
    assert not any("from app.accounts" in sql for sql in _sql(connection))
    active = next(
        i for i, sql in enumerate(_sql(connection))
        if "from app.account_sessions" in sql
    )
    inserted = next(
        i for i, sql in enumerate(_sql(connection))
        if "insert into app.account_sessions" in sql
    )
    assert active < inserted
    assert "order by created_at, id" in _sql(connection)[active]
    assert "for update" in _sql(connection)[active]
    insert_params = connection.operations[inserted][1]
    assert prepared.token_digest in insert_params
    assert RAW_TOKEN not in repr(insert_params)
    assert issued.raw_token == RAW_TOKEN and issued.session_id == 88
    assert issued.account_id == prepared.account_id
    assert issued.authenticated_at == prepared.authenticated_at
    assert issued.idle_expires_at == prepared.idle_expires_at
    assert issued.absolute_expires_at == prepared.absolute_expires_at
    assert RAW_TOKEN not in repr(issued)
    assert "Private Browser Label" not in repr(issued)


@pytest.mark.parametrize("inserted_row", [{"id": 88}, (88,)])
def test_persist_prepared_accepts_dict_and_tuple_returning_rows(sessions, inserted_row):
    class ReturningConnection(RecordingConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "insert into app.account_sessions" in " ".join(sql.casefold().split()):
                return Cursor((inserted_row,))
            return cursor

    connection = ReturningConnection()
    service = _service(sessions, connection)
    prepared = service.prepare_session(41)

    assert service.persist_prepared_for_locked_account(
        prepared, connection
    ).session_id == 88


def test_persist_prepared_requires_truthful_cap_revocation_before_insert(sessions):
    class LostRevocationConnection(RecordingConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if " ".join(sql.casefold().split()).startswith(
                "update app.account_sessions"
            ):
                return Cursor(rowcount=0)
            return cursor

    connection = LostRevocationConnection(active_rows=({"id": 1}, {"id": 2}))
    service = _service(sessions, connection)
    prepared = service.prepare_session(41)

    with pytest.raises(RuntimeError):
        service.persist_prepared_for_locked_account(prepared, connection)

    assert not any("insert into app.account_sessions" in sql for sql in _sql(connection))


def test_persist_prepared_rejects_boolean_cap_rowcount_before_insert(sessions):
    class BooleanRowcountConnection(RecordingConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if " ".join(sql.casefold().split()).startswith(
                "update app.account_sessions"
            ):
                return Cursor(rowcount=True)
            return cursor

    connection = BooleanRowcountConnection(active_rows=({"id": 1}, {"id": 2}))
    service = _service(sessions, connection)
    prepared = service.prepare_session(41)

    with pytest.raises(RuntimeError):
        service.persist_prepared_for_locked_account(prepared, connection)

    assert not any("insert into app.account_sessions" in sql for sql in _sql(connection))


def test_persist_prepared_sanitizes_timestamp_timezone_failure_before_sql(sessions):
    connection = RecordingConnection()
    service = _service(sessions, connection)
    prepared = replace(
        service.prepare_session(41),
        authenticated_at=datetime(2026, 8, 30, 12, 0, tzinfo=RaisingTzinfo()),
    )

    with pytest.raises(ValueError, match="^Prepared session is invalid\\.$") as caught:
        service.persist_prepared_for_locked_account(prepared, connection)

    assert caught.value.__cause__ is None
    assert "private clock secret" not in str(caught.value)
    assert connection.operations == [] and connection.events == []


def test_persist_prepared_revokes_exact_excess_before_insert(sessions):
    connection = RecordingConnection(active_rows=({"id": 1}, {"id": 2}))
    service = _service(sessions, connection)
    prepared = service.prepare_session(41)

    issued = service.persist_prepared_for_locked_account(prepared, connection)

    assert issued.session_id == 88
    update = next(
        (sql, params)
        for sql, params in connection.operations
        if sql.startswith("update app.account_sessions")
    )
    assert update[1][2] == [1]
    assert _sql(connection).index(update[0]) < next(
        i for i, sql in enumerate(_sql(connection))
        if "insert into app.account_sessions" in sql
    )


@pytest.mark.parametrize(
    "mutation",
    [
        {"account_id": 0},
        {"raw_token": "t" * 43},
        {"token_digest": b"x" * 32},
        {"authenticated_at": NOW.replace(tzinfo=None)},
        {"idle_expires_at": NOW},
        {"absolute_expires_at": NOW},
        {"user_agent": "private\nagent"},
    ],
)
def test_persist_prepared_rejects_tampering_before_sql(sessions, mutation):
    connection = RecordingConnection()
    service = _service(sessions, connection)
    prepared = replace(service.prepare_session(41), **mutation)

    with pytest.raises((TypeError, ValueError)) as caught:
        service.persist_prepared_for_locked_account(prepared, connection)

    assert RAW_TOKEN not in str(caught.value)
    assert "private" not in str(caught.value)
    assert connection.operations == [] and connection.events == []


@pytest.mark.parametrize("prepared", [None, object(), {"account_id": 41}])
def test_persist_prepared_rejects_wrong_object_before_sql(sessions, prepared):
    connection = RecordingConnection()
    with pytest.raises((TypeError, ValueError)):
        _service(sessions, connection).persist_prepared_for_locked_account(
            prepared, connection
        )
    assert connection.operations == [] and connection.events == []


def test_persist_prepared_missing_insert_row_fails_without_secret_leak(sessions):
    class MissingInsertConnection(RecordingConnection):
        def execute(self, sql, params=None):
            cursor = super().execute(sql, params)
            if "insert into app.account_sessions" in " ".join(sql.casefold().split()):
                return Cursor(())
            return cursor

    connection = MissingInsertConnection()
    service = _service(sessions, connection)
    prepared = service.prepare_session(41, user_agent="Private Browser Label")

    with pytest.raises(RuntimeError) as caught:
        service.persist_prepared_for_locked_account(prepared, connection)

    rendered = f"{caught.value!s} {caught.value!r}"
    assert RAW_TOKEN not in rendered
    assert "Private Browser Label" not in rendered


def test_persist_prepared_provider_error_is_secret_safe(sessions):
    class LeakyConnection(RecordingConnection):
        def execute(self, sql, params=None):
            raise RuntimeError(f"provider leaked {params!r} Private Browser Label")

    connection = LeakyConnection()
    service = _service(sessions, connection)
    prepared = service.prepare_session(41, user_agent="Private Browser Label")

    with pytest.raises(RuntimeError) as caught:
        service.persist_prepared_for_locked_account(prepared, connection)

    rendered = f"{caught.value!s} {caught.value!r}"
    assert RAW_TOKEN not in rendered
    assert repr(prepared.token_digest) not in rendered
    assert "Private Browser Label" not in rendered
    assert caught.value.__cause__ is None


def test_issue_session_composes_prepare_and_persist_without_behavior_regression(
    sessions,
):
    connection = RecordingConnection()
    service = _service(sessions, connection)
    calls = []
    original_prepare = service.prepare_session
    original_persist = service.persist_prepared_for_locked_account

    def recording_prepare(*args, **kwargs):
        calls.append(("prepare", list(connection.events)))
        return original_prepare(*args, **kwargs)

    def recording_persist(prepared, active_connection):
        calls.append(("persist", active_connection, list(connection.events)))
        return original_persist(prepared, active_connection)

    service.prepare_session = recording_prepare
    service.persist_prepared_for_locked_account = recording_persist

    issued = service.issue_session(41, user_agent="Album Haven Browser")

    assert issued.raw_token == RAW_TOKEN and issued.session_id == 88
    assert calls[0] == ("prepare", [])
    assert calls[1][0] == "persist"
    assert calls[1][1] is connection
    assert "tx:enter" in calls[1][2]
    sql = _sql(connection)
    assert any("from app.accounts" in item and "for update" in item for item in sql)
    assert sql[-1].startswith("insert into app.account_sessions")
