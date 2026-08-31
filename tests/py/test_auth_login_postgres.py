from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module, util
from typing import Any

import pytest
from argon2 import extract_parameters

from music_app.services.auth_passwords import PasswordCredential, PasswordVerification
from music_app.services.auth_tokens import keyed_bucket_digest


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
