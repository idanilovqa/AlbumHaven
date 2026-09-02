from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from importlib import import_module, util
from typing import Any

import pytest
from argon2 import extract_parameters

from music_app.services.auth_passwords import PasswordCredential, PasswordVerification
from music_app.services.auth_sessions_postgres import (
    IssuedBrowserSession,
    PreparedBrowserSession,
)
from music_app.services.auth_audit_postgres import (
    LoginAuditReason,
    SecurityAuditCategory,
    SecurityAuditOutcome,
)
from music_app.services.auth_tokens import hash_opaque_token, keyed_bucket_digest


MODULE = "music_app.services.auth_login_postgres"
DATABASE_URL = "postgresql://album_haven_app@localhost/album_haven_test"
NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)
WINDOW_STARTED = NOW - timedelta(minutes=1)
PASSWORD = "correct horse battery staple!"
ENCODED_HASH = "$argon2id$v=19$m=65536,t=3,p=1$0mq2vvmP2pteYxtj9UteyQ$3UsjRNlgtvr/WPWdd2JibYLE8V0Ka8ZzGAHmiGF32gw"
DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=1$p3fwDBu2UQbYqjjoxq7RRw$JLL+kTEFr3qgKpgBmjBkgLOt7J5ndC4rSbjBvyuP6D4"
WEAK_HASH = "$argon2id$v=19$m=8192,t=1,p=1$7gzHXLY+Jrk$j9w4vNiunZGDaSXcnrFOXw"
_DEFAULT_DUMMY = object()


def test_auth_login_postgres_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 login persistence service: "
        "music_app/services/auth_login_postgres.py"
    )


@pytest.fixture
def login():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    module = import_module(MODULE)
    assert callable(module.PostgresLoginAuthService)
    assert callable(module.LoginResult)
    assert set(module.LoginOutcome.__members__) == {"SUCCESS", "INVALID", "THROTTLED"}
    return module


class Cursor:
    def __init__(self, rows=(), *, rowcount=-1):
        self.rows = list(rows)
        self.rowcount = rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.transaction_depth += 1
        self.connection.events.append("tx:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("tx:rollback" if exc_type else "tx:commit")
        self.connection.transaction_depth -= 1


class RecordingConnection:
    def __init__(
        self,
        *,
        account_rows=None,
        credential_rows=None,
        throttle_rows=None,
        fail_with: Exception | None = None,
    ):
        self.account_rows = list(
            ({"id": 41, "username_normalized": "rendref", "is_active": True, "disabled_at": None},)
            if account_rows is None else account_rows
        )
        self.credential_rows = list(
            ({"account_id": 41, "encoded_hash": ENCODED_HASH, "hash_policy_version": 1, "credential_version": 1, "administrator_set": True},)
            if credential_rows is None else credential_rows
        )
        self.throttle_rows = list(
            (
                {
                    "bucket_kind": "login_account",
                    "window_started_at": WINDOW_STARTED,
                    "failure_count": 0,
                    "window_expires_at": NOW + timedelta(minutes=15),
                    "blocked_until": None,
                },
                {
                    "bucket_kind": "login_source",
                    "window_started_at": WINDOW_STARTED,
                    "failure_count": 0,
                    "window_expires_at": NOW + timedelta(minutes=15),
                    "blocked_until": None,
                },
            )
            if throttle_rows is None
            else throttle_rows
        )
        self.fail_with = fail_with
        self.operations: list[tuple[str, object]] = []
        self.events: list[str] = []
        self.transaction_depth = 0

    def __enter__(self):
        self.events.append("connection:enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.events.append("connection:exit")

    def transaction(self):
        return Transaction(self)

    def execute(self, sql: str, params: object = None):
        statement = " ".join(sql.casefold().split())
        self.operations.append((statement, params))
        if self.fail_with is not None:
            raise self.fail_with
        if "from app.accounts" in statement:
            return Cursor(self.account_rows)
        if "from app.account_credentials" in statement:
            return Cursor(self.credential_rows)
        if "from app.auth_throttles" in statement:
            return Cursor(self.throttle_rows)
        if statement.startswith("update app.account_credentials"):
            return Cursor(rowcount=1)
        if statement.startswith("update app.auth_throttles") and "greatest(failure_count - 1, 0)" in statement:
            return Cursor(rowcount=1)
        return Cursor()


class Semaphore:
    def __init__(self, acquired=True):
        self.acquired = acquired
        self.calls: list[object] = []

    def acquire(self, blocking=True):
        self.calls.append(("acquire", blocking))
        return self.acquired

    def release(self):
        self.calls.append("release")


class RecordingSessionService:
    def __init__(self):
        self.calls: list[tuple[str, object]] = []
        raw_token = "s" * 43
        self.prepared = PreparedBrowserSession(
            raw_token=raw_token,
            token_digest=hash_opaque_token(raw_token),
            account_id=41,
            authenticated_at=NOW,
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
            user_agent=None,
        )
        self.issued = IssuedBrowserSession(
            raw_token=raw_token,
            session_id=88,
            account_id=41,
            authenticated_at=NOW,
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
        )

    def prepare_session(self, account_id, *, user_agent=None):
        self.calls.append(("prepare", (account_id, user_agent)))
        return self.prepared

    def persist_prepared_for_locked_account(self, prepared, connection):
        self.calls.append(("persist", connection))
        connection.operations.append(("session:persist", None))
        return self.issued


class RecordingAuditRepository:
    def __init__(self):
        self.calls: list[dict[str, object]] = []

    def append_in_transaction(self, connection, **event):
        self.calls.append({"connection": connection, **event})
        connection.operations.append(("audit:insert", event))
        return 901


def _config():
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": DATABASE_URL,
        "hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 3},
        "argon2": {"memory_cost": 65_536, "time_cost": 3, "parallelism": 1, "salt_len": 16, "hash_len": 32},
        "argon2_policy_version": 3,
        "verification_semaphore": 2,
        "throttles": {
            "login_account": {"limit": 5, "window_seconds": 900},
            "login_source": {"limit": 20, "window_seconds": 900},
            "login_cooldown_seconds": 900,
        },
    }


def _service(
    login,
    connection,
    *,
    verifier=None,
    semaphore=None,
    rehasher=None,
    dummy_encoded_hash=_DEFAULT_DUMMY,
    session_service=None,
    audit_repository=None,
):
    observed = []
    verifier = verifier or (
        lambda raw, encoded_hash, **kwargs: observed.append((raw, encoded_hash, kwargs))
        or PasswordVerification(valid=True, needs_rehash=False)
    )
    kwargs = {
        "connect": lambda _url: connection,
        "verifier": verifier,
        "verification_semaphore": semaphore or Semaphore(),
        "clock": lambda: NOW,
        "rehasher": rehasher,
        "session_service": session_service or RecordingSessionService(),
        "audit_repository": audit_repository or RecordingAuditRepository(),
    }
    if dummy_encoded_hash is _DEFAULT_DUMMY:
        kwargs["dummy_encoded_hash"] = DUMMY_HASH
    elif dummy_encoded_hash is not None:
        kwargs["dummy_encoded_hash"] = dummy_encoded_hash
    service = login.PostgresLoginAuthService(
        _config(),
        **kwargs,
    )
    return service, observed


def test_constructor_rejects_malformed_coordination_collaborators(login):
    with pytest.raises((TypeError, ValueError)):
        login.PostgresLoginAuthService(
            _config(),
            connect=lambda _url: RecordingConnection(),
            dummy_encoded_hash=DUMMY_HASH,
            session_service=object(),
            audit_repository=object(),
        )


def _authenticate(service, **overrides):
    arguments = {
        "entered_username": "Rendref",
        "password": PASSWORD,
        "source_key": "198.51.100.7",
    }
    arguments.update(overrides)
    return service.authenticate(**arguments)


def _throttle_rows(*, started_at=WINDOW_STARTED, expires_at=None, blocked_until=None):
    expires_at = expires_at or NOW + timedelta(minutes=15)
    return tuple(
        {
            "bucket_kind": kind,
            "window_started_at": started_at,
            "failure_count": 0,
            "window_expires_at": expires_at,
            "blocked_until": blocked_until,
        }
        for kind in ("login_account", "login_source")
    )


def test_success_returns_only_safe_account_identity_and_verifies_once(login):
    connection = RecordingConnection()
    service, observed = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    assert result.account_id == 41
    assert result.administrator_set is True
    assert len(observed) == 1
    assert PASSWORD not in repr(result)
    account_selects = [
        statement
        for statement, _ in connection.operations
        if "from app.accounts" in statement
    ]
    credential_selects = [
        statement
        for statement, _ in connection.operations
        if "from app.account_credentials" in statement
    ]
    assert credential_selects and all(
        "administrator_set" in sql for sql in credential_selects
    )
    identity_locks = [sql for sql in account_selects if "for update" in sql]
    credential_locks = [
        sql
        for sql, _ in connection.operations
        if "from app.account_credentials" in sql and "for update" in sql
    ]
    assert len(identity_locks) == len(credential_locks) == 1


def test_invitation_created_credential_logs_in_as_recipient_set(login):
    connection = RecordingConnection(
        credential_rows=({
            "account_id": 41,
            "encoded_hash": ENCODED_HASH,
            "hash_policy_version": 4,
            "credential_version": 1,
            "administrator_set": False,
        },)
    )
    service, _ = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    assert result.account_id == 41
    assert result.administrator_set is False


def test_administrator_set_is_absent_on_invalid_result(login):
    connection = RecordingConnection(account_rows=())
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: PasswordVerification(False, False),
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert result.account_id is None
    assert result.administrator_set is None


@pytest.mark.parametrize(
    ("locked_account", "locked_credential"),
    [
        (
            {"id": 41, "username_normalized": "rendref", "is_active": False, "disabled_at": NOW},
            {"account_id": 41, "encoded_hash": ENCODED_HASH, "hash_policy_version": 1, "credential_version": 1},
        ),
        (
            {"id": 41, "username_normalized": "rendref", "is_active": True, "disabled_at": None},
            {"account_id": 41, "encoded_hash": "$argon2id$v=19$raced", "hash_policy_version": 2, "credential_version": 2},
        ),
    ],
)
def test_no_rehash_success_relocks_account_then_credential_and_rejects_stale_identity(
    login, locked_account, locked_credential
):
    class ConcurrentIdentityConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.accounts" in statement and "for update" in statement:
                self.operations.append((statement, params))
                return Cursor((locked_account,))
            if "from app.account_credentials" in statement and "for update" in statement:
                self.operations.append((statement, params))
                return Cursor((locked_credential,))
            return super().execute(sql, params)

    connection = ConcurrentIdentityConnection()
    service, _ = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    locks = [
        statement
        for statement, _ in connection.operations
        if "for update" in statement and "app.auth_throttles" not in statement
    ]
    assert "from app.accounts" in locks[0]
    assert "from app.account_credentials" in locks[1]


@pytest.mark.parametrize(
    ("username", "accounts", "verification"),
    [
        ("unknown", (), PasswordVerification(valid=False, needs_rehash=False)),
        ("Rendref", None, PasswordVerification(valid=False, needs_rehash=False)),
        ("Rendref", ({"id": 41, "username_normalized": "rendref", "is_active": False, "disabled_at": NOW},), PasswordVerification(valid=True, needs_rehash=False)),
        ("bad@name", (), PasswordVerification(valid=False, needs_rehash=False)),
    ],
)
def test_unknown_wrong_disabled_and_malformed_are_one_invalid_contract_with_one_verification(
    login, username, accounts, verification
):
    connection = RecordingConnection(account_rows=accounts)
    calls = []
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: calls.append((args, kwargs)) or verification,
    )

    result = _authenticate(service, entered_username=username)

    assert result.outcome is login.LoginOutcome.INVALID
    assert result.account_id is None
    assert len(calls) == 1


def test_omitted_dummy_hash_is_generated_at_the_configured_argon2_floor(login):
    calls = []
    connection = RecordingConnection(account_rows=())
    service, _ = _service(
        login,
        connection,
        dummy_encoded_hash=None,
        verifier=lambda raw, encoded_hash, **kwargs: calls.append((raw, encoded_hash, kwargs))
        or PasswordVerification(False, False),
    )

    assert _authenticate(service, entered_username="unknown").outcome is login.LoginOutcome.INVALID
    parameters = extract_parameters(calls[0][1])
    assert parameters.memory_cost == 65_536
    assert parameters.time_cost == 3
    assert parameters.parallelism == 1
    assert parameters.hash_len == 32
    assert parameters.salt_len == 16


def test_injected_dummy_hash_must_meet_the_configured_argon2_floor(login):
    with pytest.raises(ValueError):
        _service(login, RecordingConnection(), dummy_encoded_hash=WEAK_HASH)


def test_real_hash_selection_does_not_depend_on_string_identity(login):
    real_hash = ENCODED_HASH
    dummy_hash = real_hash
    assert real_hash is dummy_hash
    calls = []
    connection = RecordingConnection(
        credential_rows=((41, real_hash, 1, 1),)
    )
    service, _ = _service(
        login,
        connection,
        dummy_encoded_hash=dummy_hash,
        verifier=lambda raw, encoded_hash, **kwargs: calls.append((encoded_hash, kwargs))
        or PasswordVerification(True, False),
    )

    assert _authenticate(service).outcome is login.LoginOutcome.SUCCESS
    assert calls[0][0] is real_hash
    assert calls[0][1]["stored_policy_version"] == 1


def test_throttle_buckets_use_fixed_distinct_hmac_domains_and_digest_only_params(login):
    connection = RecordingConnection()
    service, _ = _service(login, connection)
    _authenticate(service)

    account_digest = keyed_bucket_digest(
        secret=b"0123456789abcdef0123456789abcdef",
        key_version=3,
        domain="album-haven:login-account",
        normalized_value="rendref",
    ).digest
    source_digest = keyed_bucket_digest(
        secret=b"0123456789abcdef0123456789abcdef",
        key_version=3,
        domain="album-haven:login-source",
        normalized_value="198.51.100.7",
    ).digest
    throttle_params = [
        params for sql, params in connection.operations if "app.auth_throttles" in sql
    ]
    flattened = repr(throttle_params)
    assert account_digest != source_digest
    assert any(account_digest in params for params in throttle_params)
    assert any(source_digest in params for params in throttle_params)
    assert "Rendref" not in flattened
    assert "198.51.100.7" not in flattened
    assert PASSWORD not in flattened


def test_throttles_are_upserted_then_locked_in_deterministic_two_row_order(login):
    connection = RecordingConnection()
    service, _ = _service(login, connection)
    _authenticate(service)

    sql = [statement for statement, _ in connection.operations]
    upserts = [
        index
        for index, statement in enumerate(sql)
        if "insert into app.auth_throttles" in statement and "on conflict" in statement
    ]
    lock = next(
        index
        for index, statement in enumerate(sql)
        if "from app.auth_throttles" in statement and "for update" in statement
    )
    assert len(upserts) == 2 and max(upserts) < lock
    assert "order by" in sql[lock]


@pytest.mark.parametrize(
    "rows",
    [
        (
            {"bucket_kind": "login_account", "window_started_at": WINDOW_STARTED, "failure_count": 5, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": None},
            {"bucket_kind": "login_source", "window_started_at": WINDOW_STARTED, "failure_count": 0, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": None},
        ),
        (
            {"bucket_kind": "login_account", "window_started_at": WINDOW_STARTED, "failure_count": 0, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": None},
            {"bucket_kind": "login_source", "window_started_at": WINDOW_STARTED, "failure_count": 20, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": None},
        ),
        (
            {"bucket_kind": "login_account", "window_started_at": WINDOW_STARTED, "failure_count": 1, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": NOW + timedelta(minutes=1)},
            {"bucket_kind": "login_source", "window_started_at": WINDOW_STARTED, "failure_count": 1, "window_expires_at": NOW + timedelta(minutes=5), "blocked_until": None},
        ),
    ],
)
def test_account_source_limits_and_cooldown_return_generic_throttled(login, rows):
    connection = RecordingConnection(throttle_rows=rows)
    service, _ = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.THROTTLED
    assert result.account_id is None


def test_future_cooldown_survives_expired_failure_window(login):
    blocked_until = NOW + timedelta(minutes=2)
    connection = RecordingConnection(
        throttle_rows=_throttle_rows(
            started_at=NOW - timedelta(minutes=20),
            expires_at=NOW - timedelta(seconds=1),
            blocked_until=blocked_until,
        )
    )
    service, observed = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.THROTTLED
    assert observed == []
    assert not any(
        "blocked_until = null" in statement
        for statement, _ in connection.operations
    )


def test_finalization_is_scoped_to_the_reserved_window_generation(login):
    reserved_start = NOW - timedelta(minutes=1)
    newer_start = NOW + timedelta(seconds=1)

    class WindowRolloverConnection(RecordingConnection):
        def __init__(self):
            super().__init__()
            self.throttle_reads = 0

        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.auth_throttles" in statement:
                self.operations.append((statement, params))
                self.throttle_reads += 1
                started_at = reserved_start if self.throttle_reads == 1 else newer_start
                return Cursor(_throttle_rows(started_at=started_at))
            return super().execute(sql, params)

    connection = WindowRolloverConnection()
    service, _ = _service(login, connection)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    final_updates = [
        (statement, params)
        for statement, params in connection.operations
        if statement.startswith("update app.auth_throttles")
        and "greatest(failure_count - 1, 0)" in statement
    ]
    assert len(final_updates) == 2
    assert all("window_started_at = %s" in statement for statement, _ in final_updates)
    assert all(reserved_start in params for _, params in final_updates)
    assert all(newer_start not in params for _, params in final_updates)


def test_verification_semaphore_is_nonblocking_and_capacity_is_generic(login):
    connection = RecordingConnection()
    semaphore = Semaphore(acquired=False)
    service, _ = _service(login, connection, semaphore=semaphore)

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.THROTTLED
    assert semaphore.calls == [("acquire", False)]


def test_verification_semaphore_releases_in_finally(login):
    connection = RecordingConnection()
    semaphore = Semaphore()
    service, _ = _service(
        login,
        connection,
        semaphore=semaphore,
        verifier=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("failed")),
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert semaphore.calls == [("acquire", False), "release"]


@pytest.mark.parametrize("malformed", [None, object(), {"valid": True}])
def test_malformed_verifier_result_is_invalid_and_still_finalizes_reservation(
    login, malformed
):
    class CountingConnection(RecordingConnection):
        def __init__(self):
            super().__init__()
            self.throttle_reads = 0

        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.auth_throttles" in statement:
                self.throttle_reads += 1
            return super().execute(sql, params)

    connection = CountingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: malformed,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert connection.throttle_reads == 2


@pytest.mark.parametrize(
    "verification",
    [PasswordVerification(valid=1, needs_rehash=False), PasswordVerification(valid=True, needs_rehash=1)],
)
def test_verifier_flags_must_be_exact_bool_and_malformed_results_still_finalize(
    login, verification
):
    connection = RecordingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: verification,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    throttle_locks = [
        sql
        for sql, _ in connection.operations
        if "from app.auth_throttles" in sql and "for update" in sql
    ]
    assert len(throttle_locks) == 2


@pytest.mark.parametrize("entered_username", ["private\ud800surrogate", "private\x00control"])
def test_malformed_username_uses_one_dummy_verification_without_raw_leakage(
    login, entered_username
):
    calls = []
    connection = RecordingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda raw, encoded_hash, **kwargs: calls.append((raw, encoded_hash))
        or PasswordVerification(True, False),
    )

    result = _authenticate(service, entered_username=entered_username)

    assert result.outcome is login.LoginOutcome.INVALID
    assert calls == [(PASSWORD, DUMMY_HASH)]
    assert not any("from app.accounts" in sql for sql, _ in connection.operations)
    assert "private" not in repr(connection.operations)
    assert "private" not in repr(result)


@pytest.mark.parametrize("source_key", [" private-source", "private-source\n", "private\x00source"])
def test_invalid_source_uses_one_dummy_verification_without_raw_leakage(
    login, source_key
):
    calls = []
    connection = RecordingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda raw, encoded_hash, **kwargs: calls.append((raw, encoded_hash))
        or PasswordVerification(True, False),
    )

    result = _authenticate(service, source_key=source_key)

    assert result.outcome is login.LoginOutcome.INVALID
    assert calls == [(PASSWORD, DUMMY_HASH)]
    assert not any("from app.accounts" in sql for sql, _ in connection.operations)
    assert "private" not in repr(connection.operations)
    assert "private" not in repr(result)


@pytest.mark.parametrize("password", [b"private-password", "x" * 2_000])
def test_non_string_or_oversized_password_uses_bounded_dummy_verification(login, password):
    calls = []
    connection = RecordingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda raw, encoded_hash, **kwargs: calls.append((raw, encoded_hash))
        or PasswordVerification(True, False),
    )

    result = _authenticate(service, password=password)

    assert result.outcome is login.LoginOutcome.INVALID
    assert len(calls) == 1
    assert isinstance(calls[0][0], str) and len(calls[0][0]) <= 256
    assert calls[0][1] == DUMMY_HASH
    assert repr(password) not in repr(connection.operations)


def test_rehash_happens_outside_transactions_then_locks_account_before_credential(login):
    connection = RecordingConnection()
    calls = []

    def rehasher(raw_password, *, argon2, policy_version):
        calls.append((raw_password, argon2, policy_version, connection.transaction_depth))
        return PasswordCredential(encoded_hash="$argon2id$v=19$replacement", policy_version=3)

    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: PasswordVerification(valid=True, needs_rehash=True),
        rehasher=rehasher,
    )
    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    assert calls == [(PASSWORD, _config()["argon2"], 3, 0)]
    sql = [statement for statement, _ in connection.operations]
    account_lock = next(i for i, s in enumerate(sql) if "from app.accounts" in s and "for update" in s)
    credential_lock = next(i for i, s in enumerate(sql) if "from app.account_credentials" in s and "for update" in s)
    assert account_lock < credential_lock


def test_rehash_rejects_credential_version_or_hash_race_without_overwrite(login):
    class RacingConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.account_credentials" in statement and "for update" in statement:
                self.operations.append((statement, params))
                return Cursor(({"account_id": 41, "encoded_hash": "$argon2id$v=19$raced", "hash_policy_version": 2, "credential_version": 2},))
            return super().execute(sql, params)

    connection = RacingConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: PasswordVerification(valid=True, needs_rehash=True),
        rehasher=lambda raw, *, argon2, policy_version: PasswordCredential(
            "$argon2id$v=19$replacement", policy_version
        ),
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert not any(statement.startswith("update app.account_credentials") for statement, _ in connection.operations)


def test_rehash_conditional_update_zero_rows_rejects_success(login):
    class LostUpdateConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if statement.startswith("update app.account_credentials"):
                self.operations.append((statement, params))
                return Cursor(rowcount=0)
            return super().execute(sql, params)

    connection = LostUpdateConnection()
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, True),
        rehasher=lambda raw, *, argon2, policy_version: PasswordCredential(
            "$argon2id$v=19$replacement", policy_version
        ),
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID


def test_tuple_account_credential_and_throttle_rows_follow_same_contract(login):
    connection = RecordingConnection(
        account_rows=((41, "rendref", True, None),),
        credential_rows=((41, ENCODED_HASH, 1, 1, True),),
        throttle_rows=(
            ("login_account", WINDOW_STARTED, 0, NOW + timedelta(minutes=15), None),
            ("login_source", WINDOW_STARTED, 0, NOW + timedelta(minutes=15), None),
        ),
    )
    service, _ = _service(login, connection)
    result = _authenticate(service)
    assert result.outcome is login.LoginOutcome.SUCCESS
    assert result.administrator_set is True


def test_provider_failures_are_generic_and_echo_no_private_input_or_digest(login):
    private_values = (PASSWORD, "Rendref", "198.51.100.7")
    connection = RecordingConnection(
        fail_with=RuntimeError(f"provider leaked {private_values!r}")
    )
    service, _ = _service(login, connection)

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    message = str(caught.value)
    assert all(value not in message for value in private_values)
    assert not any(
        repr(value) in message
        for _sql, params in connection.operations
        for value in (params if isinstance(params, tuple) else ())
        if isinstance(value, bytes)
    )


def test_success_coordinates_session_and_verified_audit_on_one_final_connection(login):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()
    service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    result = _authenticate(
        service,
        user_agent="Private Browser Label",
        request_ref="request-123",
        source_class="public",
    )

    assert result.outcome is login.LoginOutcome.SUCCESS
    assert result.session == session_service.issued
    assert session_service.calls[0] == ("prepare", (41, "Private Browser Label"))
    sql = [statement for statement, _ in connection.operations]
    account_lock = next(i for i, s in enumerate(sql) if "from app.accounts" in s and "for update" in s)
    credential_lock = next(i for i, s in enumerate(sql) if "from app.account_credentials" in s and "for update" in s)
    persisted = next(i for i, s in enumerate(sql) if s == "session:persist")
    throttle_lock = next(
        i
        for i, s in enumerate(sql)
        if i > persisted and "from app.auth_throttles" in s and "for update" in s
    )
    audit = next(i for i, s in enumerate(sql) if s == "audit:insert")
    assert account_lock < credential_lock < persisted < throttle_lock < audit
    assert session_service.calls[1][1] is connection
    assert audit_repository.calls[-1]["connection"] is connection
    assert audit_repository.calls[-1]["category"] is SecurityAuditCategory.LOGIN
    assert audit_repository.calls[-1]["outcome"] is SecurityAuditOutcome.SUCCESS
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.VERIFIED
    assert audit_repository.calls[-1]["request_ref"] == "request-123"


@pytest.mark.parametrize(
    ("user_agent", "request_ref", "source_class"),
    [("Private Browser Label", "request-123", "public")],
)
def test_success_audit_metadata_is_allowlisted_and_result_redacts_private_values(
    login, user_agent, request_ref, source_class
):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()
    service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    result = _authenticate(
        service,
        user_agent=user_agent,
        request_ref=request_ref,
        source_class=source_class,
    )

    metadata = audit_repository.calls[-1]["metadata"]
    assert set(metadata) <= {
        "session_id",
        "hmac_key_version",
        "argon2_policy_version",
        "credential_rehashed",
        "source_class",
    }
    assert audit_repository.calls[-1]["request_ref"] == request_ref
    assert request_ref not in metadata
    rendered = repr(result)
    assert all(secret not in rendered for secret in (PASSWORD, user_agent, request_ref))
    assert result.session.raw_token not in rendered


def test_invalid_and_throttled_outcomes_have_no_session_and_audit_after_throttle(login):
    invalid_connection = RecordingConnection()
    invalid_session = RecordingSessionService()
    invalid_audit = RecordingAuditRepository()
    invalid_service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: invalid_connection,
        verifier=lambda *args, **kwargs: PasswordVerification(False, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=invalid_session,
        audit_repository=invalid_audit,
    )
    invalid = _authenticate(invalid_service)
    assert invalid.outcome is login.LoginOutcome.INVALID
    assert invalid.session is None
    assert invalid_session.calls == []
    assert invalid_audit.calls[-1]["category"] is SecurityAuditCategory.LOGIN
    assert invalid_audit.calls[-1]["outcome"] is SecurityAuditOutcome.INVALID
    assert invalid_connection.operations[-1][0] == "audit:insert"

    throttled_connection = RecordingConnection(
        throttle_rows=_throttle_rows(
            started_at=WINDOW_STARTED,
            expires_at=NOW + timedelta(minutes=5),
            blocked_until=NOW + timedelta(minutes=1),
        )
    )
    throttled_session = RecordingSessionService()
    throttled_audit = RecordingAuditRepository()
    throttled_service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: throttled_connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=throttled_session,
        audit_repository=throttled_audit,
    )
    throttled = _authenticate(throttled_service)
    assert throttled.outcome is login.LoginOutcome.THROTTLED
    assert throttled.session is None
    assert throttled_session.calls == []
    assert throttled_audit.calls[-1]["category"] is SecurityAuditCategory.LOGIN
    assert throttled_audit.calls[-1]["outcome"] is SecurityAuditOutcome.THROTTLED


def test_credential_race_is_audited_without_issuing_session(login):
    class RacingCredentialConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.account_credentials" in statement and "for update" in statement:
                self.operations.append((statement, params))
                return Cursor(({
                    "account_id": 41,
                    "encoded_hash": ENCODED_HASH,
                    "hash_policy_version": 1,
                    "credential_version": 2,
                    "administrator_set": True,
                },))
            return super().execute(sql, params)

    connection = RacingCredentialConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()
    service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert result.session is None
    assert session_service.calls and session_service.calls[0][0] == "prepare"
    assert not any(call[0] == "persist" for call in session_service.calls)
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE


@pytest.mark.parametrize("failure_point", ["session", "audit"])
def test_final_transaction_boundary_failures_roll_back_without_rolling_back_reservation(
    login, failure_point
):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()
    if failure_point == "session":
        def fail_persist(prepared, active_connection):
            raise RuntimeError("session provider secret")
        session_service.persist_prepared_for_locked_account = fail_persist
    else:
        def fail_audit(connection, **event):
            raise RuntimeError("audit provider secret")
        audit_repository.append_in_transaction = fail_audit
    service = login.PostgresLoginAuthService(
        _config(),
        connect=lambda _url: connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, False),
        verification_semaphore=Semaphore(),
        clock=lambda: NOW,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert "secret" not in str(caught.value)
    assert connection.events.count("tx:commit") >= 1
    assert "tx:rollback" in connection.events


def test_prepare_failure_finalizes_reservation_and_audits_without_session(login):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()

    def fail_prepare(account_id, *, user_agent=None):
        raise RuntimeError("prepared token secret")

    session_service.prepare_session = fail_prepare
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert str(caught.value) == "Login persistence operation failed."
    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert not any(call[0] == "persist" for call in session_service.calls)
    assert audit_repository.calls[-1]["outcome"] is SecurityAuditOutcome.INVALID
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert connection.events.count("tx:commit") >= 1


@pytest.mark.parametrize("returned", [
    IssuedBrowserSession(
        raw_token="s" * 43,
        session_id=88,
        account_id=99,
        authenticated_at=NOW,
        idle_expires_at=NOW + timedelta(hours=12),
        absolute_expires_at=NOW + timedelta(days=7),
    ),
    object(),
])
def test_invalid_session_collaborator_return_rolls_back_without_success_audit(
    login, returned
):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    session_service.issued = returned
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert not any(
        call.get("outcome") is SecurityAuditOutcome.SUCCESS
        for call in audit_repository.calls
    )
    assert "tx:rollback" in connection.events


@pytest.mark.parametrize("replacement", [
    None,
    "raise",
])
def test_rehash_failure_is_audited_as_credential_race(login, replacement):
    connection = RecordingConnection()
    audit_repository = RecordingAuditRepository()

    def rehasher(*args, **kwargs):
        if replacement == "raise":
            raise RuntimeError("rehash provider secret")
        return None

    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: PasswordVerification(True, True),
        rehasher=rehasher,
        audit_repository=audit_repository,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert result.session is None
    assert audit_repository.calls[-1]["outcome"] is SecurityAuditOutcome.INVALID
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert all(
        call.get("reason") is not LoginAuditReason.CREDENTIAL_MISMATCH
        for call in audit_repository.calls
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("request_ref", "request with spaces"),
        ("request_ref", "request\nref"),
        ("source_class", "web"),
        ("source_class", "public\n"),
    ],
)
def test_invalid_audit_context_rejected_before_sql_semaphore_or_verification(
    login, field, value
):
    connection = RecordingConnection()
    semaphore = Semaphore()
    verifier_calls = []
    service, _ = _service(
        login,
        connection,
        semaphore=semaphore,
        verifier=lambda *args, **kwargs: verifier_calls.append(True)
        or PasswordVerification(True, False),
    )

    with pytest.raises(ValueError) as caught:
        _authenticate(service, **{field: value})

    assert caught.value.__cause__ is None
    assert value not in str(caught.value)
    assert connection.operations == []
    assert semaphore.calls == []
    assert verifier_calls == []


def test_final_commit_failure_after_session_and_audit_returns_no_session(login):
    class CommitFailTransaction(Transaction):
        def __exit__(self, exc_type, exc, tb):
            result = super().__exit__(exc_type, exc, tb)
            if exc_type is None and self.connection.events.count("tx:commit") == 3:
                raise RuntimeError("commit provider secret")
            return result

    class CommitFailConnection(RecordingConnection):
        def transaction(self):
            return CommitFailTransaction(self)

    connection = CommitFailConnection()
    session_service = RecordingSessionService()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert session_service.calls[-1][0] == "persist"
    assert audit_repository.calls[-1]["outcome"] is SecurityAuditOutcome.SUCCESS


@pytest.mark.parametrize("verifier_result", [None, object()])
def test_verifier_failure_is_invalid_and_audited_as_credential_race(
    login, verifier_result
):
    connection = RecordingConnection()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        verifier=lambda *args, **kwargs: verifier_result,
        audit_repository=audit_repository,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.INVALID
    assert result.session is None
    assert audit_repository.calls[-1]["outcome"] is SecurityAuditOutcome.INVALID
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert all(
        call["reason"] is not LoginAuditReason.CREDENTIAL_MISMATCH
        for call in audit_repository.calls
    )


@pytest.mark.parametrize(
    "mutation",
    [
        {"account_id": 99},
        {"raw_token": "x" * 43},
        {"token_digest": b"x" * 32},
        {"authenticated_at": NOW + timedelta(minutes=1)},
        {"idle_expires_at": NOW},
    ],
)
def test_malformed_prepared_session_is_rejected_before_persist_and_audited(
    login, mutation
):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    session_service.prepared = replace(session_service.prepared, **mutation)
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert session_service.calls == [("prepare", (41, None))]
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert not any(call["outcome"] is SecurityAuditOutcome.SUCCESS for call in audit_repository.calls)


@pytest.mark.parametrize(
    "issued",
    [
        IssuedBrowserSession(
            raw_token="s" * 43,
            session_id=True,
            account_id=41,
            authenticated_at=NOW,
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
        ),
        IssuedBrowserSession(
            raw_token="s" * 43,
            session_id=0,
            account_id=41,
            authenticated_at=NOW,
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
        ),
        IssuedBrowserSession(
            raw_token="bad-token",
            session_id=88,
            account_id=41,
            authenticated_at=NOW,
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
        ),
        IssuedBrowserSession(
            raw_token="s" * 43,
            session_id=88,
            account_id=41,
            authenticated_at=NOW.replace(tzinfo=None),
            idle_expires_at=NOW + timedelta(hours=12),
            absolute_expires_at=NOW + timedelta(days=7),
        ),
    ],
)
def test_malformed_issued_session_is_rejected_without_success_audit(login, issued):
    connection = RecordingConnection()
    session_service = RecordingSessionService()
    session_service.issued = issued
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert not any(call["outcome"] is SecurityAuditOutcome.SUCCESS for call in audit_repository.calls)
    assert "tx:rollback" in connection.events


def test_non_utc_clock_is_normalized_before_reservation_and_audit(login):
    offset_now = NOW.astimezone(timezone(timedelta(hours=2)))
    connection = RecordingConnection()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(login, connection, audit_repository=audit_repository)
    service._clock = lambda: offset_now

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    occurred_at = audit_repository.calls[-1]["occurred_at"]
    assert occurred_at == NOW
    assert occurred_at.tzinfo is timezone.utc
    throttle_params = [params for sql, params in connection.operations if "app.auth_throttles" in sql]
    assert any(NOW in params for params in throttle_params)


def test_session_clock_with_small_coordinator_skew_still_succeeds(login):
    class SlightlyAdvancingSessionService(RecordingSessionService):
        def prepare_session(self, account_id, *, user_agent=None):
            delta = timedelta(milliseconds=100)
            prepared = replace(
                self.prepared,
                authenticated_at=self.prepared.authenticated_at + delta,
                idle_expires_at=self.prepared.idle_expires_at + delta,
                absolute_expires_at=self.prepared.absolute_expires_at + delta,
                user_agent=user_agent,
            )
            self.calls.append(("prepare", (account_id, user_agent)))
            self.prepared = prepared
            self.issued = replace(
                self.issued,
                authenticated_at=prepared.authenticated_at,
                idle_expires_at=prepared.idle_expires_at,
                absolute_expires_at=prepared.absolute_expires_at,
            )
            return prepared

    connection = RecordingConnection()
    session_service = SlightlyAdvancingSessionService()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        session_service=session_service,
        audit_repository=audit_repository,
    )

    result = _authenticate(service)

    assert result.outcome is login.LoginOutcome.SUCCESS
    assert session_service.prepared.authenticated_at - NOW == timedelta(milliseconds=100)
    assert result.session == session_service.issued


def test_semaphore_acquire_failure_finalizes_and_audits_genericly(login):
    class AcquireFailureSemaphore(Semaphore):
        def acquire(self, blocking=True):
            raise RuntimeError("semaphore provider secret")

    connection = RecordingConnection()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        semaphore=AcquireFailureSemaphore(),
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert "tx:commit" in connection.events


def test_semaphore_release_failure_finalizes_and_audits_genericly(login):
    class ReleaseFailureSemaphore(Semaphore):
        def release(self):
            raise RuntimeError("release provider secret")

    connection = RecordingConnection()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(
        login,
        connection,
        semaphore=ReleaseFailureSemaphore(),
        audit_repository=audit_repository,
    )

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert "tx:commit" in connection.events


def test_identity_load_failure_finalizes_and_audits_genericly(login):
    class IdentityFailureConnection(RecordingConnection):
        def execute(self, sql, params=None):
            statement = " ".join(sql.casefold().split())
            if "from app.accounts" in statement and "for update" not in statement:
                raise RuntimeError("identity provider secret")
            return super().execute(sql, params)

    connection = IdentityFailureConnection()
    audit_repository = RecordingAuditRepository()
    service, _ = _service(login, connection, audit_repository=audit_repository)

    with pytest.raises(RuntimeError) as caught:
        _authenticate(service)

    assert caught.value.__cause__ is None
    assert "secret" not in str(caught.value)
    assert audit_repository.calls[-1]["reason"] is LoginAuditReason.CREDENTIAL_RACE
    assert "tx:commit" in connection.events
