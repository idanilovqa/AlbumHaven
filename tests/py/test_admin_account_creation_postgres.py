from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.admin_account_creation import CreatedAccount
from music_app.services.auth_invitation_models import InvitationDelivery
from music_app.services.auth_tokens import issue_opaque_token


CREATED_AT = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
EXPIRES_AT = CREATED_AT + timedelta(hours=72)
ISSUED = issue_opaque_token(random_bytes=lambda count: b"x" * count)


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
        if "insert into app.account_invitation_tokens" in normalized:
            return Cursor(({"id": 61},))
        if "insert into app.mail_outbox" in normalized:
            return Cursor(({"id": 51},))
        return Cursor()


def _create(repository, *, invitation=None, invitation_expires_at=None, created_at=CREATED_AT):
    return repository.create_account(
        actor_account_id=7,
        library_id=23,
        username_display="Member.One",
        username_normalized="member.one",
        contact_email="Member+one@EXAMPLE.test",
        contact_email_normalized="Member+one@example.test",
        capability_keys=("library.browse.read", "library.media.read"),
        invitation=invitation,
        invitation_expires_at=invitation_expires_at,
        created_at=created_at,
        request_ref="r" * 32,
    )


@pytest.mark.parametrize("with_invitation", [False, True])
def test_repository_creates_pending_account_and_optionally_links_invitation_outbox_atomically(with_invitation):
    from music_app.services.admin_account_creation_postgres import (
        PostgresAdminAccountRepository,
    )

    connection = Connection()
    repository = PostgresAdminAccountRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"},
        connect=lambda _url: connection,
    )

    result = _create(
        repository,
        invitation=ISSUED if with_invitation else None,
        invitation_expires_at=EXPIRES_AT if with_invitation else None,
    )

    delivery = (
        InvitationDelivery(
            outbox_id=51, invitation_token_id=61, account_id=41,
            recipient="Member+one@EXAMPLE.test", username="Member.One",
            raw_token=ISSUED.raw, expires_at=EXPIRES_AT,
        ) if with_invitation else None
    )
    assert result == CreatedAccount(account_id=41, invitation_delivery=delivery)
    assert connection.events == ["begin", "commit"]
    statements = [sql for sql, _params in connection.operations]
    assert "for update" in statements[0]
    assert any("insert into app.accounts" in sql and "is_active" in sql for sql in statements)
    assert all("insert into app.account_credentials" not in sql for sql in statements)
    assert any("insert into library.library_memberships" in sql for sql in statements)
    assert sum("insert into app.capabilities" in sql for sql in statements) == 2
    token_indexes = [i for i, sql in enumerate(statements) if "insert into app.account_invitation_tokens" in sql]
    outbox_indexes = [i for i, sql in enumerate(statements) if "insert into app.mail_outbox" in sql]
    assert len(token_indexes) == int(with_invitation)
    assert len(outbox_indexes) == int(with_invitation)
    if with_invitation:
        assert token_indexes[0] < outbox_indexes[0]
        assert connection.operations[token_indexes[0]][1] == (
            41, ISSUED.digest, CREATED_AT, EXPIRES_AT, "r" * 32,
        )
        assert connection.operations[outbox_indexes[0]][1] == (41, 61, CREATED_AT)
    assert any("insert into app.security_audit_events" in sql for sql in statements)
    audit = next(item for item in connection.operations if "insert into app.security_audit_events" in item[0])
    assert "account_created_pending_invitation" in audit[0]
    assert audit[1] == (7, 41, "r" * 32, CREATED_AT)
    rendered = repr(connection.operations)
    assert ISSUED.raw not in rendered
    assert "welcome" not in rendered.casefold()


@pytest.mark.parametrize(
    ("invitation", "expires_at", "created_at"),
    [
        (None, EXPIRES_AT, CREATED_AT),
        (ISSUED, CREATED_AT, CREATED_AT),
        (ISSUED, EXPIRES_AT, datetime(2026, 9, 1, 12, 30)),
    ],
)
def test_repository_rejects_inconsistent_or_naive_invitation_timestamps(invitation, expires_at, created_at):
    from music_app.services.admin_account_creation_postgres import PostgresAdminAccountRepository

    connection = Connection()
    repository = PostgresAdminAccountRepository(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app"}, connect=lambda _url: connection,
    )
    with pytest.raises(ValueError, match="timestamp|expiry"):
        _create(repository, invitation=invitation, invitation_expires_at=expires_at, created_at=created_at)
    assert connection.events == []


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
