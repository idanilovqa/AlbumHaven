from __future__ import annotations

from datetime import datetime, timedelta, timezone
from importlib import import_module, util
from urllib.parse import parse_qs, urlsplit

import pytest

from music_app.services.auth_tokens import hash_opaque_token, issue_opaque_token


MODULE = "music_app.services.admin_account_invitations_postgres"
NOW = datetime(2026, 9, 1, 12, 30, tzinfo=timezone.utc)
OWNER_ID = 7
LIBRARY_ID = 9
PENDING_ID = 41


def test_admin_account_invitation_service_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing managed-account invitation rotation service: "
        "music_app/services/admin_account_invitations_postgres.py"
    )


@pytest.fixture
def invitations():
    if util.find_spec(MODULE) is None:
        pytest.skip("contract presence is covered by the dedicated RED test")
    return import_module(MODULE)


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
        return self

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append("rollback" if exc_type else "commit")


class Connection:
    def __init__(self, *, eligible=True):
        self.eligible = eligible
        self.events = []
        self.operations = []
        self.next_token_id = 61
        self.next_outbox_id = 71
        self.active_digest = None
        self.revoked_digests = []

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
            rows = ({
                "id": PENDING_ID,
                "username_display": "member.one",
                "contact_email": "member+one@example.test",
            },) if self.eligible else ()
            return Cursor(rows)
        if statement.startswith("select id from app.account_invitation_tokens"):
            return Cursor(() if self.active_digest is None else ({"id": 60},))
        if statement.startswith("update app.account_invitation_tokens"):
            if self.active_digest is not None:
                self.revoked_digests.append(self.active_digest)
                self.active_digest = None
            return Cursor()
        if statement.startswith("insert into app.account_invitation_tokens"):
            token_id = self.next_token_id
            self.next_token_id += 1
            self.active_digest = params[1]
            return Cursor(({"id": token_id},))
        if statement.startswith("insert into app.mail_outbox"):
            outbox_id = self.next_outbox_id
            self.next_outbox_id += 1
            return Cursor(({"id": outbox_id},))
        return Cursor()


class AuditRepository:
    def __init__(self):
        self.calls = []

    def append_in_transaction(self, connection, **payload):
        self.calls.append(payload)
        connection.operations.append(("audit", payload))
        return 81


class TokenIssuer:
    def __init__(self):
        self.count = 0

    def __call__(self):
        self.count += 1
        byte = bytes((64 + self.count,))
        return issue_opaque_token(random_bytes=lambda count: byte * count)


def _service(module, connection, audit=None, **overrides):
    values = {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app",
        "public_base_url": "https://example.test",
        "invitation_token_seconds": 259_200,
    }
    values.update(overrides.pop("config", {}))
    return module.PostgresAdminAccountInvitationService(
        values,
        connect=lambda _url: connection,
        clock=lambda: NOW,
        token_issuer=overrides.pop("token_issuer", TokenIssuer()),
        audit_repository=audit or AuditRepository(),
        **overrides,
    )


def _issue(service, *, request_ref="a" * 32, authenticated_at=NOW):
    return service.issue_copy(
        actor_account_id=OWNER_ID,
        actor_authenticated_at=authenticated_at,
        library_id=LIBRARY_ID,
        target_account_id=PENDING_ID,
        request_ref=request_ref,
    )


def test_copy_rotates_prior_token_and_keeps_raw_tokens_out_of_audit(invitations):
    connection = Connection()
    audit = AuditRepository()
    service = _service(invitations, connection, audit)

    first = _issue(service)
    first_token = parse_qs(urlsplit(first.invitation_url).query)["token"][0]
    second = _issue(service, request_ref="b" * 32)
    second_query = parse_qs(urlsplit(second.invitation_url).query)
    second_token = second_query["token"][0]

    assert first.invitation_url.startswith("https://example.test/accept-invitation?")
    assert second_query["purpose"] == ["account-invitation"]
    assert first_token != second_token
    assert connection.active_digest == hash_opaque_token(second_token)
    assert connection.revoked_digests == [hash_opaque_token(first_token)]
    serialized_audit = repr(audit.calls)
    assert first_token not in serialized_audit
    assert second_token not in serialized_audit
    assert [call["reason"].value for call in audit.calls] == [
        "invitation_copied", "invitation_copied"
    ]
    assert connection.events == ["begin", "commit", "begin", "commit"]


def test_email_rotation_links_outbox_to_new_token_and_returns_redacting_delivery(
    invitations,
):
    connection = Connection()
    audit = AuditRepository()

    delivery = _service(invitations, connection, audit).queue_email(
        actor_account_id=OWNER_ID,
        actor_authenticated_at=NOW,
        library_id=LIBRARY_ID,
        target_account_id=PENDING_ID,
        request_ref="send-request_123",
    )

    outbox = next(
        (sql, params) for sql, params in connection.operations
        if sql.startswith("insert into app.mail_outbox")
    )
    assert outbox[1][:3] == (PENDING_ID, delivery.invitation_token_id, "account_invitation")
    assert delivery.outbox_id == 71
    assert delivery.recipient == "member+one@example.test"
    assert delivery.username == "member.one"
    assert delivery.expires_at == NOW + timedelta(hours=72)
    assert delivery.raw_token not in repr(delivery)
    assert audit.calls[0]["reason"].value == "invitation_queued"
    assert delivery.raw_token not in repr(audit.calls)


@pytest.mark.parametrize(
    "scenario",
    ["actor-not-owner", "target-owner", "target-disabled", "wrong-library", "credentialed"],
)
def test_copy_rejects_every_ineligible_authority_or_target_context(
    invitations, scenario
):
    connection = Connection(eligible=False)
    service = _service(invitations, connection)

    with pytest.raises(PermissionError, match="not permitted"):
        _issue(service, request_ref=f"reject-{scenario}")

    assert connection.events == ["begin", "rollback"]
    assert not any(
        sql.startswith("insert into app.account_invitation_tokens")
        or sql.startswith("insert into app.mail_outbox")
        for sql, _params in connection.operations
    )


@pytest.mark.parametrize(
    "authenticated_at",
    [NOW - timedelta(minutes=10, microseconds=1), NOW + timedelta(minutes=5, microseconds=1), datetime(2026, 9, 1, 12, 30)],
)
def test_rotation_requires_recent_aware_administrator_auth_before_connect(
    invitations, authenticated_at
):
    connection = Connection()
    service = _service(invitations, connection)

    with pytest.raises(PermissionError, match="Recent authentication"):
        _issue(service, authenticated_at=authenticated_at)

    assert connection.operations == []


def test_rotation_locks_account_before_invitation_state_and_audits_last(invitations):
    connection = Connection()
    _issue(_service(invitations, connection))

    statements = [sql for sql, _params in connection.operations]
    account_lock = next(i for i, sql in enumerate(statements) if "with locked_accounts" in sql)
    authority_sql = statements[account_lock]
    assert "join app.bootstrap_owners authority" in authority_sql
    assert "join library.library_memberships membership" in authority_sql
    assert "left join app.bootstrap_owners target_owner" in authority_sql
    assert "left join app.account_credentials credential" in authority_sql
    assert "actor.is_active is true" in authority_sql
    assert "actor.disabled_at is null" in authority_sql
    assert "target.account_kind = 'managed_user'" in authority_sql
    assert "target.is_active is true" in authority_sql
    assert "target.disabled_at is null" in authority_sql
    assert "target_owner.account_id is null" in authority_sql
    assert "credential.account_id is null" in authority_sql
    authority_sql = statements[account_lock]
    assert "join app.bootstrap_owners authority" in authority_sql
    assert "join library.library_memberships membership" in authority_sql
    assert "left join app.bootstrap_owners target_owner" in authority_sql
    assert "left join app.account_credentials credential" in authority_sql
    assert "actor.is_active is true" in authority_sql
    assert "actor.disabled_at is null" in authority_sql
    assert "target.account_kind = 'managed_user'" in authority_sql
    assert "target.is_active is true" in authority_sql
    assert "target.disabled_at is null" in authority_sql
    assert "target_owner.account_id is null" in authority_sql
    assert "credential.account_id is null" in authority_sql
    token_lock = next(i for i, sql in enumerate(statements) if sql.startswith("select id from app.account_invitation_tokens"))
    revoke = next(i for i, sql in enumerate(statements) if sql.startswith("update app.account_invitation_tokens"))
    insert = next(i for i, sql in enumerate(statements) if sql.startswith("insert into app.account_invitation_tokens"))
    audit = statements.index("audit")
    assert account_lock < token_lock < revoke < insert < audit
