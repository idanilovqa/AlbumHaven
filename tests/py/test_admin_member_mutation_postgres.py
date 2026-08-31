from datetime import datetime, timedelta, timezone


NOW = datetime(2026, 8, 31, 22, 30, tzinfo=timezone.utc)


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
    def __init__(self, *, target_owner=False):
        self.target_owner = target_owner
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
        if "with locked_accounts" in statement:
            return Cursor(({
                "actor_account_id": 7,
                "library_id": 9,
                "target_account_id": 41,
                "target_is_active": True,
                "target_is_bootstrap_owner": self.target_owner,
                "target_has_library_access": True,
            },))
        return Cursor()


def _service(connection):
    from music_app.services.admin_member_mutation_postgres import (
        PostgresAdminMemberMutationService,
    )

    return PostgresAdminMemberMutationService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
        clock=lambda: NOW,
    )


def test_admin_update_replaces_membership_and_capabilities_and_revokes_on_disable():
    connection = Connection()

    _service(connection).update_account(
        actor_account_id=7,
        actor_authenticated_at=NOW - timedelta(minutes=2),
        library_id=9,
        target_account_id=41,
        is_active=False,
        current_library_access=False,
        capability_keys=("library.browse.read",),
        confirm_disable=True,
        confirm_remove_access=True,
        request_ref="admin-update-1",
    )

    statements = [sql for sql, _params in connection.operations]
    assert any(
        "set is_active = %s" in sql
        and "disabled_at" in sql
        and params[0] is False
        for sql, params in connection.operations
    )
    assert any("delete from library.library_memberships" in sql for sql in statements)
    assert any("update app.capabilities" in sql and "revoked_at" in sql for sql in statements)
    assert not any("insert into app.capabilities" in sql for sql in statements)
    assert any("update app.account_sessions" in sql and "administrator_disabled" in sql for sql in statements)
    assert any("account_updated" in sql for sql in statements)
    assert connection.events == ["begin", "commit"]


def test_admin_update_requires_recent_auth_and_explicit_destructive_confirmation():
    from music_app.services.admin_member_mutation_postgres import (
        DestructiveConfirmationRequired,
        RecentAuthenticationRequired,
    )

    connection = Connection()
    service = _service(connection)

    try:
        service.update_account(
            actor_account_id=7,
            actor_authenticated_at=NOW - timedelta(minutes=11),
            library_id=9,
            target_account_id=41,
            is_active=True,
            current_library_access=True,
            capability_keys=("library.browse.read",),
            confirm_disable=False,
            confirm_remove_access=False,
            request_ref="admin-update-2",
        )
    except RecentAuthenticationRequired:
        pass
    else:
        raise AssertionError("stale administrator authentication must fail")
    assert connection.operations == []

    try:
        service.update_account(
            actor_account_id=7,
            actor_authenticated_at=NOW,
            library_id=9,
            target_account_id=41,
            is_active=False,
            current_library_access=True,
            capability_keys=("library.browse.read",),
            confirm_disable=False,
            confirm_remove_access=False,
            request_ref="admin-update-3",
        )
    except DestructiveConfirmationRequired:
        pass
    else:
        raise AssertionError("disable without confirmation must fail")


def test_admin_update_cannot_disable_or_detach_bootstrap_owner():
    connection = Connection(target_owner=True)

    try:
        _service(connection).update_account(
            actor_account_id=7,
            actor_authenticated_at=NOW,
            library_id=9,
            target_account_id=41,
            is_active=False,
            current_library_access=False,
            capability_keys=("library.browse.read",),
            confirm_disable=True,
            confirm_remove_access=True,
            request_ref="admin-update-4",
        )
    except PermissionError:
        pass
    else:
        raise AssertionError("bootstrap owner protection must fail closed")
    assert connection.events[-1] == "rollback"


def test_admin_session_revoke_requires_confirmation_and_records_audit():
    connection = Connection()

    _service(connection).revoke_sessions(
        actor_account_id=7,
        actor_authenticated_at=NOW,
        library_id=9,
        target_account_id=41,
        confirmed=True,
        request_ref="admin-revoke-1",
    )

    statements = [sql for sql, _params in connection.operations]
    assert any("update app.account_sessions" in sql and "administrator_revoked" in sql for sql in statements)
    assert any("sessions_revoked" in sql for sql in statements)
