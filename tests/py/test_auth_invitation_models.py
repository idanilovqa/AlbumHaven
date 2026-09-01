from datetime import datetime, timezone

import pytest

from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_MESSAGE_CATEGORY,
    INVITATION_TRANSACTION_SECONDS,
    INVITATION_URL_PURPOSE,
    CopiedInvitation,
    InvitationCompletionOutcome,
    InvitationDelivery,
    IssuedInvitationTransaction,
    validated_issued_invitation_token,
)
from music_app.services.auth_tokens import IssuedOpaqueToken, issue_opaque_token


def test_invitation_models_are_purpose_bound_and_redact_bearer_values():
    expires = datetime(2026, 9, 4, tzinfo=timezone.utc)
    delivery = InvitationDelivery(
        outbox_id=7,
        invitation_token_id=8,
        account_id=9,
        recipient="listener@example.test",
        username="listener",
        raw_token="secret-token",
        expires_at=expires,
    )
    copied = CopiedInvitation(
        invitation_url="https://example.test/accept-invitation?token=secret-token",
        expires_at=expires,
    )
    transaction = IssuedInvitationTransaction(
        raw_token="transaction-secret", transaction_id=10, expires_at=expires
    )

    assert INVITATION_DB_PURPOSE == "account_invitation"
    assert INVITATION_URL_PURPOSE == "account-invitation"
    assert INVITATION_MESSAGE_CATEGORY == "account_invitation"
    assert INVITATION_TRANSACTION_SECONDS == 900
    assert InvitationCompletionOutcome.SUCCESS.value == "success"
    assert "secret-token" not in repr(delivery)
    assert "secret-token" not in repr(copied)
    assert "transaction-secret" not in repr(transaction)


def test_validated_issued_invitation_token_returns_a_valid_opaque_token():
    issued = issue_opaque_token(random_bytes=lambda count: b"v" * count)

    result = validated_issued_invitation_token(lambda: issued)

    assert result is issued
    assert isinstance(result, IssuedOpaqueToken)


@pytest.mark.parametrize(
    "digest",
    [
        "digest-is-not-bytes",
        b"mismatched-digest".ljust(32, b"!"),
    ],
)
def test_validated_issued_invitation_token_sanitizes_invalid_digests(digest):
    valid = issue_opaque_token(random_bytes=lambda count: b"v" * count)
    bearer = valid.raw
    issued = IssuedOpaqueToken(raw=bearer, digest=digest)

    with pytest.raises(RuntimeError) as caught:
        validated_issued_invitation_token(lambda: issued)

    assert str(caught.value) == "Account invitation token issuance failed."
    assert bearer not in str(caught.value)
    assert bearer not in repr(caught.value)
