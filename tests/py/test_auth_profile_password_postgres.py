from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services.auth_passwords import (
    PasswordCredential,
    PasswordVerification,
)


NOW = datetime(2026, 8, 31, 21, 0, tzinfo=timezone.utc)


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
    def __init__(self, *, current=True):
        self.current = current
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
        if "from app.accounts" in statement and "join app.account_credentials" in statement:
            if "username_display" in statement and "contact_email" not in statement:
                return Cursor(({
                    "username_display": "member.one",
                    "administrator_set": True,
                },))
            return Cursor(({
                "account_id": 41,
                "username_display": "member.one",
                "contact_email": "member@example.test",
                "is_active": True,
                "disabled_at": None,
                "encoded_hash": "$argon2id$current",
                "hash_policy_version": 3,
                "credential_version": 7,
                "administrator_set": True,
            },))
        if "from app.accounts" in statement and "for update" in statement:
            return Cursor(({"id": 41, "is_active": True, "disabled_at": None},) if self.current else ())
        if "from app.account_credentials" in statement and "for update" in statement:
            return Cursor(({
                "account_id": 41,
                "encoded_hash": "$argon2id$current",
                "hash_policy_version": 3,
                "credential_version": 7,
                "administrator_set": True,
            },) if self.current else ())
        if "from app.account_sessions" in statement and "for update" in statement:
            return Cursor(tuple({"id": identity, "idle_expires_at": NOW + timedelta(hours=1),
                "absolute_expires_at": NOW + timedelta(days=1)} for identity in (11, 12, 13)) if self.current else ())
        if "from app.account_sessions" in statement and "last_seen_at" in statement:
            return Cursor((
                {"id": 11, "user_agent": "Current browser", "last_seen_at": NOW},
                {"id": 12, "user_agent": "Android", "last_seen_at": NOW},
            ) if self.current else ())
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
        "password": {"min_codepoints": 13, "max_codepoints": 77, "max_utf8_bytes": 99},
    }


def _service(connection, audit, *, current_valid=True, password_hasher=None):
    from music_app.services.auth_profile_password_postgres import (
        PostgresProfilePasswordService,
    )

    return PostgresProfilePasswordService(
        _config(),
        connect=lambda _url: connection,
        clock=lambda: NOW,
        verifier=lambda *_args, **_kwargs: PasswordVerification(current_valid, False),
        password_hasher=password_hasher
        or (lambda *_args, **_kwargs: PasswordCredential("$argon2id$new", 4)),
        breached_checker=lambda _password: False,
        audit_repository=audit,
        attempt_guard=SimpleNamespace(reserve=lambda _username: object(),
            finalize=lambda _reservation, **_kwargs: None),
    )


def test_password_change_verifies_current_then_atomically_replaces_and_revokes_other_sessions():
    connection = Connection()
    audit = Audit()

    result = _service(connection, audit).change_password(
        account_id=41,
        current_session_id=11,
        current_password="current private password",
        new_password="new sufficiently private password",
        request_ref="profile-change-1",
    )

    assert result.value == "success"
    statements = [sql for sql, _ in connection.operations]
    assert any("credential_version = credential_version + 1" in sql for sql in statements)
    assert any("administrator_set = false" in sql for sql in statements)
    assert any("update app.password_reset_tokens" in sql and "revoked_at" in sql for sql in statements)
    assert any("update app.account_sessions" in sql and "id <>" in sql for sql in statements)
    assert any("authenticated_at" in sql and "id =" in sql for sql in statements)
    assert audit.calls[-1]["reason"].value == "password_changed"
    assert "$argon2id$new" in repr(connection.operations)
    assert "new sufficiently private password" not in repr(connection.operations)


def test_profile_change_hashes_with_the_configured_password_policy():
    connection = Connection()
    observed = []

    def password_hasher(*_args, **kwargs):
        observed.append(kwargs)
        return PasswordCredential("$argon2id$new", 4)

    result = _service(
        connection,
        Audit(),
        password_hasher=password_hasher,
    ).change_password(
        account_id=41,
        current_session_id=11,
        current_password="current private password",
        new_password="new sufficiently private password",
        request_ref="profile-policy",
    )

    assert result.value == "success"
    assert observed[0]["password_policy"] == _config()["password"]


def test_profile_view_exposes_only_display_identity_suggestion_and_active_sessions():
    connection = Connection()
    audit = Audit()

    profile = _service(connection, audit).load_profile(
        account_id=41,
        current_session_id=11,
    )

    assert profile is not None
    assert profile.username == "member.one"
    assert profile.administrator_set_suggestion is True
    assert [item.session_id for item in profile.sessions] == [11, 12]
    assert profile.sessions[0].current is True
    assert profile.sessions[1].current is False
    assert [item.device_label for item in profile.sessions] == [
        "Unknown browser",
        "Android",
    ]
    assert all(not hasattr(item, "user_agent") for item in profile.sessions)
    assert "contact_email" not in repr(profile)


@pytest.mark.parametrize(
    ("user_agent", "expected"),
    [
        ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/149 Safari/537.36", "Windows"),
        ("Mozilla/5.0 (Linux; Android 15; Pixel 9)", "Android"),
        ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone"),
        ("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)", "iPad"),
        ("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6)", "Mac"),
        ("Mozilla/5.0 (X11; Linux x86_64)", "Linux"),
        (None, "Unknown browser"),
        ("private custom agent value", "Unknown browser"),
    ],
)
def test_profile_session_labels_are_bounded_and_do_not_echo_raw_user_agents(
    user_agent, expected
):
    from music_app.services.auth_profile_password_postgres import (
        _session_device_label,
    )

    assert _session_device_label(user_agent) == expected


def test_wrong_current_password_changes_nothing_and_records_protected_invalid_reason():
    connection = Connection()
    audit = Audit()

    result = _service(connection, audit, current_valid=False).change_password(
        account_id=41,
        current_session_id=11,
        current_password="wrong password value",
        new_password="new sufficiently private password",
        request_ref="profile-change-2",
    )

    assert result.value == "current_password_invalid"
    assert not any("update app.account_credentials" in sql for sql, _ in connection.operations)
    assert audit.calls[-1]["reason"].value == "current_password_invalid"


def test_dismiss_suggestion_is_idempotent_and_never_changes_password_hash():
    connection = Connection()
    audit = Audit()

    assert _service(connection, audit).dismiss_suggestion(
        account_id=41,
        request_ref="dismiss-1",
    ) is True

    assert any(
        "update app.account_credentials" in sql
        and "administrator_set = false" in sql
        and "encoded_hash" not in sql
        for sql, _ in connection.operations
    )
    assert audit.calls[-1]["reason"].value == "suggestion_dismissed"


def _change(service):
    return service.change_password(account_id=41, current_session_id=11,
        current_password="current private password", new_password="new sufficiently private password",
        request_ref="profile-failure-boundary")


@pytest.mark.parametrize("expiry", ["idle_expires_at", "absolute_expires_at"])
def test_password_change_rejects_session_expired_during_final_lock(expiry):
    clock = [NOW]

    class ExpiringSession(Connection):
        def execute(self, sql, params=()):
            result = super().execute(sql, params)
            statement = " ".join(sql.casefold().split())
            if "from app.account_sessions" in statement and "for update" in statement:
                for row in result.rows:
                    row[expiry] = NOW + timedelta(seconds=1)
                clock[0] = NOW + timedelta(seconds=2)
            return result

    connection, audit = ExpiringSession(), Audit()
    service = _service(connection, audit)
    service._clock = lambda: clock[0]
    assert _change(service).value == "stale"
    assert not any(sql.startswith("update ") for sql, _ in connection.operations)
    assert not any(event["outcome"].value == "success" for event in audit.calls)


@pytest.mark.parametrize("failure", ["credential_changed", "session_revoked", "lost_update", "audit", "commit"])
def test_password_change_never_reports_success_after_stale_or_failed_transaction(failure):
    class FailingTransaction(Transaction):
        def __exit__(self, exc_type, exc, tb):
            wrote = any(sql.startswith("update app.account_credentials") for sql, _ in self.connection.operations)
            if failure == "commit" and wrote and exc_type is None:
                self.connection.events.append("rollback")
                raise RuntimeError("commit failed")
            return super().__exit__(exc_type, exc, tb)

    class FailureConnection(Connection):
        def transaction(self):
            return FailingTransaction(self)

        def execute(self, sql, params=()):
            result = super().execute(sql, params)
            statement = " ".join(sql.casefold().split())
            if failure == "credential_changed" and "from app.account_credentials" in statement and "for update" in statement:
                result.rows[0]["credential_version"] += 1
            if failure == "session_revoked" and "from app.account_sessions" in statement and "for update" in statement:
                result.rows = [row for row in result.rows if row["id"] != 11]
            if failure == "lost_update" and statement.startswith("update app.account_credentials"):
                result.rowcount = 0
            return result

    class FailingAudit(Audit):
        def append_in_transaction(self, connection, **kwargs):
            if failure == "audit":
                assert any(sql.startswith("update app.account_credentials") for sql, _ in connection.operations)
                raise RuntimeError("audit failed")
            return super().append_in_transaction(connection, **kwargs)

    connection, audit = FailureConnection(), FailingAudit()
    if failure in {"credential_changed", "session_revoked"}:
        assert _change(_service(connection, audit)).value == "stale"
        assert not any(sql.startswith("update ") for sql, _ in connection.operations)
    else:
        with pytest.raises(RuntimeError):
            _change(_service(connection, audit))
        assert connection.events[-1] == "rollback"
