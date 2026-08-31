import pytest

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_passwords import PasswordCredential


class Cursor:
    def __init__(self, rows=()):
        self.rows = list(rows)

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
    def __init__(self, *, conflict=False):
        self.conflict = conflict
        self.operations = []
        self.events = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=()):
        normalized = " ".join(sql.casefold().split())
        self.operations.append((normalized, params))
        if "from app.bootstrap_owners" in normalized:
            return Cursor(({"actor_account_id": 7, "library_id": 23},))
        if "insert into app.accounts" in normalized:
            if self.conflict:
                error = RuntimeError("duplicate")
                error.diag = type("Diag", (), {"constraint_name": "accounts_username_normalized_idx"})()
                raise error
            return Cursor(({"id": 41},))
        if "insert into app.mail_outbox" in normalized:
            return Cursor(({"id": 51},))
        return Cursor()


def _create(repository):
    return repository.create_account(
        actor_account_id=7,
        library_id=23,
        username_display="Member.One",
        username_normalized="member.one",
        contact_email="Member+one@EXAMPLE.test",
        contact_email_normalized="Member+one@example.test",
        credential=PasswordCredential("$argon2id$secret-hash", 3),
        capability_keys=("library.browse.read", "library.media.read"),
    )


def test_repository_creates_active_account_credential_membership_grants_welcome_and_audit_atomically():
    from music_app.services.admin_account_creation_postgres import (
        PostgresAdminAccountRepository,
    )

    connection = Connection()
    repository = PostgresAdminAccountRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
    )

    result = _create(repository)

    assert result == CreatedAccount(account_id=41, welcome_outbox_id=51)
    assert connection.events == ["begin", "commit"]
    statements = [sql for sql, _params in connection.operations]
    assert "for update" in statements[0]
    assert any("insert into app.accounts" in sql and "is_active" in sql for sql in statements)
    assert any("insert into app.account_credentials" in sql and "administrator_set" in sql for sql in statements)
    assert any("insert into library.library_memberships" in sql for sql in statements)
    assert sum("insert into app.capabilities" in sql for sql in statements) == 2
    assert any("insert into app.mail_outbox" in sql for sql in statements)
    assert any("insert into app.security_audit_events" in sql for sql in statements)
    rendered = repr(connection.operations)
    assert "secret-hash" in rendered
    assert "password" not in rendered.casefold()


def test_unique_identity_conflict_is_stable_and_rolls_back():
    from music_app.services.admin_account_creation_postgres import (
        ManagedAccountIdentityConflict,
        PostgresAdminAccountRepository,
    )

    connection = Connection(conflict=True)
    repository = PostgresAdminAccountRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
    )

    with pytest.raises(ManagedAccountIdentityConflict):
        _create(repository)

    assert connection.events == ["begin", "rollback"]
