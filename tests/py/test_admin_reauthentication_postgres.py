from datetime import datetime, timezone

from music_app.services.auth_passwords import PasswordVerification


NOW = datetime(2026, 8, 31, 23, 0, tzinfo=timezone.utc)


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
        if "join app.account_credentials" in statement and "for update" not in statement:
            return Cursor(({
                "account_id": 7,
                "is_active": True,
                "disabled_at": None,
                "encoded_hash": "$argon2id$current",
                "hash_policy_version": 3,
                "credential_version": 7,
            },))
        if "for update" in statement and "app.account_sessions" in statement:
            return Cursor(({
                "account_id": 7,
                "is_active": True,
                "disabled_at": None,
                "encoded_hash": "$argon2id$current",
                "credential_version": 7,
                "session_id": 11,
            },) if self.current else ())
        return Cursor()


class Audit:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, _connection, **kwargs):
        self.calls.append(kwargs)
        return 1


def _service(connection, audit, *, valid=True):
    from music_app.services.admin_reauthentication_postgres import (
        PostgresAdminReauthenticationService,
    )

    return PostgresAdminReauthenticationService(
        {
            "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
            "argon2": {"memory_cost": 65536, "time_cost": 3, "parallelism": 1},
            "argon2_policy_version": 4,
        },
        connect=lambda _url: connection,
        clock=lambda: NOW,
        verifier=lambda *_args, **_kwargs: PasswordVerification(valid, False),
        audit_repository=audit,
    )


def test_admin_reauthentication_verifies_own_password_and_refreshes_current_session():
    connection = Connection()
    audit = Audit()

    result = _service(connection, audit).reauthenticate(
        account_id=7,
        session_id=11,
        password="administrator private password",
        request_ref="admin-reauth-1",
    )

    assert result.value == "success"
    assert any(
        "update app.account_sessions" in sql and "authenticated_at" in sql
        for sql, _params in connection.operations
    )
    assert audit.calls[-1]["reason"].value == "administrator_reauthenticated"
    assert "administrator private password" not in repr(connection.operations)


def test_admin_reauthentication_invalid_password_updates_no_session():
    connection = Connection()
    audit = Audit()

    result = _service(connection, audit, valid=False).reauthenticate(
        account_id=7,
        session_id=11,
        password="wrong private password",
        request_ref="admin-reauth-2",
    )

    assert result.value == "invalid"
    assert not any("update app.account_sessions" in sql for sql, _ in connection.operations)
    assert audit.calls[-1]["reason"].value == "administrator_reauthentication_invalid"


def test_admin_reauthentication_fails_stale_if_session_or_credential_changed():
    connection = Connection(current=False)
    audit = Audit()

    result = _service(connection, audit).reauthenticate(
        account_id=7,
        session_id=11,
        password="administrator private password",
        request_ref="admin-reauth-3",
    )

    assert result.value == "stale"
    assert not any("update app.account_sessions" in sql for sql, _ in connection.operations)
