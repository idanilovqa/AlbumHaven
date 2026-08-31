from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from importlib import import_module, util
from types import SimpleNamespace

import pytest


MODULE = "music_app.services.auth_mail_outbox_postgres"
NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


def test_welcome_outbox_contract_is_present():
    assert util.find_spec(MODULE) is not None


@pytest.fixture
def outbox():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
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
        self.connection.events.append("transaction:enter")

    def __exit__(self, exc_type, exc, tb):
        self.connection.events.append(
            "transaction:rollback" if exc_type else "transaction:commit"
        )


class Connection:
    def __init__(self, *, claim_rows=(), finalize_rows=(), stale_rows=()):
        self.claim_rows = list(claim_rows)
        self.finalize_rows = list(finalize_rows)
        self.stale_rows = list(stale_rows)
        self.operations = []
        self.events = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def transaction(self):
        return Transaction(self)

    def execute(self, sql, params=None):
        normalized = " ".join(sql.casefold().split())
        self.operations.append((normalized, params))
        if "set delivery_status = 'unknown'" in normalized:
            return Cursor(self.stale_rows)
        if "from app.mail_outbox" in normalized and "join app.accounts" in normalized:
            return Cursor(self.claim_rows)
        if "from app.mail_outbox" in normalized and "join app.accounts" not in normalized:
            return Cursor(self.finalize_rows)
        return Cursor()


def _service(outbox, connection):
    return outbox.PostgresWelcomeOutboxService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@localhost/db"},
        connect=lambda _url: connection,
        now=lambda: NOW,
    )


def _reset_service(outbox, connection):
    return outbox.PostgresPasswordResetOutboxService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://app@localhost/db"},
        connect=lambda _url: connection,
        now=lambda: NOW,
    )


def _claim_row(**overrides):
    row = {
        "id": 91,
        "account_id": 41,
        "username_display": "Rendref",
        "contact_email": "Rendref+owner@example.test",
        "attempt_count": 0,
    }
    row.update(overrides)
    return row


def test_claim_is_short_locked_eligible_welcome_only_and_secret_free(outbox):
    connection = Connection(claim_rows=(_claim_row(),))

    claim = _service(outbox, connection).claim_welcome(91)

    assert claim.outbox_id == 91
    assert claim.account_id == 41
    assert claim.username == "Rendref"
    assert claim.recipient == "Rendref+owner@example.test"
    assert claim.attempt_count == 1
    assert connection.events == ["transaction:enter", "transaction:commit"]
    select = next(sql for sql, _ in connection.operations if "join app.accounts" in sql)
    assert "message_category = 'welcome'" in select
    assert "delivery_status in ('pending', 'failed')" in select
    assert "attempt_count <" in select
    assert "from app.mail_outbox outbox" in select
    assert "for update of outbox skip locked" in select
    update = next(sql for sql, _ in connection.operations if sql.startswith("update app.mail_outbox"))
    assert "delivery_status = 'sending'" in update
    rendered = repr(claim) + repr(connection.operations)
    for forbidden in ("password", "encoded_hash", "reset_token", "smtp-secret"):
        assert forbidden not in rendered


def test_ineligible_or_concurrently_claimed_welcome_returns_none(outbox):
    connection = Connection(claim_rows=())
    assert _service(outbox, connection).claim_welcome(91) is None
    assert not any(
        "set delivery_status = 'sending'" in sql
        for sql, _ in connection.operations
    )


def test_claim_reconciles_expired_sending_lease_as_unknown_before_selection(outbox):
    connection = Connection(claim_rows=(), stale_rows=({"id": 91},))

    outcome = _service(outbox, connection).claim_welcome(91)

    assert isinstance(outcome, outbox.AmbiguousWelcomeClaim)
    assert outcome.outbox_id == 91

    stale_update = next(
        (sql, params)
        for sql, params in connection.operations
        if sql.startswith("update app.mail_outbox")
    )
    assert "delivery_status = 'unknown'" in stale_update[0]
    assert "delivery_status = 'sending'" in stale_update[0]
    assert "claimed_at <=" in stale_update[0]
    assert stale_update[1][0] == 91


def test_delivery_returns_unknown_when_stale_send_is_reconciled(outbox):
    class Repository:
        def claim_welcome(self, _outbox_id):
            return outbox.AmbiguousWelcomeClaim(outbox_id=91)

        def finalize_welcome(self, _claim, _result):
            raise AssertionError("an ambiguous prior send must not be finalized or retried")

    result = asyncio.run(
        outbox.deliver_welcome(
            91,
            config={"public_base_url": "https://music.example.test"},
            repository=Repository(),
        )
    )

    assert result == outbox.DeliveryResult(delivered=False, reason="unknown")


@pytest.mark.parametrize(
    ("reason", "status", "has_retry"),
    [
        ("delivered", "sent", False),
        ("unknown", "unknown", False),
        ("timeout", "failed", True),
        ("failed", "failed", True),
        ("refused", "failed", False),
        ("invalid_config", "failed", False),
    ],
)
def test_finalize_maps_delivery_outcome_without_retrying_ambiguous_send(
    outbox, reason, status, has_retry
):
    connection = Connection(finalize_rows=({"id": 91},))
    service = _service(outbox, connection)
    claim = outbox.WelcomeClaim(
        outbox_id=91,
        account_id=41,
        username="Rendref",
        recipient="Rendref+owner@example.test",
        attempt_count=1,
        claimed_at=NOW,
    )

    service.finalize_welcome(
        claim,
        SimpleNamespace(delivered=(reason == "delivered"), reason=reason),
    )

    update = [item for item in connection.operations if item[0].startswith("update app.mail_outbox")][-1]
    assert status in update[1]
    next_attempt = update[1][2]
    assert (next_attempt is not None) is has_retry
    assert "smtp-secret" not in repr(connection.operations)


def test_fifth_attempt_is_terminal_even_for_retryable_failure(outbox):
    connection = Connection(finalize_rows=({"id": 91},))
    claim = outbox.WelcomeClaim(91, 41, "Rendref", "owner@example.test", 5, NOW)

    _service(outbox, connection).finalize_welcome(
        claim, SimpleNamespace(delivered=False, reason="timeout")
    )

    update = [item for item in connection.operations if item[0].startswith("update app.mail_outbox")][-1]
    assert update[1][2] is None


def test_delivery_composes_and_sends_only_after_claim_transaction_commits(outbox):
    events = []
    claim = outbox.WelcomeClaim(91, 41, "Rendref", "owner@example.test", 1, NOW)

    class Repository:
        def claim_welcome(self, outbox_id):
            assert outbox_id == 91
            events.extend(("claim", "claim:commit"))
            return claim

        def finalize_welcome(self, received, result):
            assert received is claim
            events.append(("finalize", result.reason))

    def composer(**kwargs):
        events.append(("compose", kwargs["username"], kwargs["recipient"]))
        return "safe-message"

    async def sender(message, *, config):
        assert message == "safe-message"
        events.append("send")
        return outbox.DeliveryResult(delivered=True, reason="delivered")

    result = asyncio.run(
        outbox.deliver_welcome(
            91,
            config={"public_base_url": "https://music.example.test"},
            repository=Repository(),
            composer=composer,
            sender=sender,
        )
    )

    assert result.delivered is True
    assert events == [
        "claim",
        "claim:commit",
        ("compose", "Rendref", "owner@example.test"),
        "send",
        ("finalize", "delivered"),
    ]


def test_delivery_is_non_gating_when_transport_raises(outbox):
    claim = outbox.WelcomeClaim(91, 41, "Rendref", "owner@example.test", 1, NOW)
    finalized = []

    class Repository:
        def claim_welcome(self, _outbox_id):
            return claim

        def finalize_welcome(self, _claim, result):
            finalized.append(result)

    async def broken_sender(_message, *, config):
        raise RuntimeError("smtp-secret")

    result = asyncio.run(
        outbox.deliver_welcome(
            91,
            config={"public_base_url": "https://music.example.test"},
            repository=Repository(),
            composer=lambda **_kwargs: "safe-message",
            sender=broken_sender,
        )
    )

    assert result.delivered is False
    assert result.reason == "failed"
    assert finalized[-1].reason == "failed"
    assert "smtp-secret" not in repr(result)


def test_password_reset_delivery_claims_matching_active_token_and_finalizes_once(outbox):
    from music_app.services.auth_password_reset_request_postgres import (
        PasswordResetDelivery,
    )

    events = []
    delivery = PasswordResetDelivery(81, 41, "member@example.test", "r" * 43)
    claim = outbox.PasswordResetClaim(
        outbox_id=81,
        account_id=41,
        username="member.one",
        recipient="member@example.test",
        attempt_count=1,
        claimed_at=NOW,
    )

    class Repository:
        def claim_password_reset(self, received):
            assert received is delivery
            events.append("claim")
            return claim

        def finalize_password_reset(self, received, result):
            assert received is claim
            events.append(("finalize", result.reason))

    def composer(**kwargs):
        assert kwargs["username"] == "member.one"
        assert kwargs["recipient"] == "member@example.test"
        assert kwargs["token"] == "r" * 43
        events.append("compose")
        return "message"

    async def sender(message, *, config):
        assert message == "message"
        events.append("send")
        return outbox.DeliveryResult(True, "delivered")

    result = asyncio.run(
        outbox.deliver_password_reset(
            delivery,
            config={"public_base_url": "https://music.example.test"},
            repository=Repository(),
            composer=composer,
            sender=sender,
        )
    )

    assert result.delivered is True
    assert events == ["claim", "compose", "send", ("finalize", "delivered")]
    assert "r" * 43 not in repr(claim)


def test_password_reset_repository_claim_requires_matching_active_digest_and_is_not_retryable(outbox):
    from music_app.services.auth_password_reset_request_postgres import (
        PasswordResetDelivery,
    )

    connection = Connection(claim_rows=(_claim_row(id=81, username_display="member.one"),))
    delivery = PasswordResetDelivery(81, 41, "Rendref+owner@example.test", "s" * 43)

    claim = _reset_service(outbox, connection).claim_password_reset(delivery)

    assert claim.outbox_id == 81
    select, params = next(
        item for item in connection.operations
        if "join app.password_reset_tokens" in item[0]
    )
    assert "message_category = 'password_reset'" in select
    assert "delivery_status = 'pending'" in select
    assert "attempt_count = 0" in select
    assert "credential_version" in select
    assert "consumed_at is null" in select and "revoked_at is null" in select
    assert "token_hash = %s" in select
    assert "s" * 43 not in repr(params)
    assert any("delivery_status = 'sending'" in sql for sql, _ in connection.operations)

    final_connection = Connection(finalize_rows=({"id": 81},))
    _reset_service(outbox, final_connection).finalize_password_reset(
        claim,
        outbox.DeliveryResult(False, "timeout"),
    )
    update_params = [
        params for sql, params in final_connection.operations
        if sql.startswith("update app.mail_outbox")
    ][-1]
    assert update_params[0] == "failed"
    assert not any(value is not None for value in update_params[1:2])
