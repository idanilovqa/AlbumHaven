from datetime import datetime, timezone

from music_app.services.auth_invitation_models import (
    INVITATION_DB_PURPOSE,
    INVITATION_MESSAGE_CATEGORY,
    INVITATION_TRANSACTION_SECONDS,
    INVITATION_URL_PURPOSE,
    CopiedInvitation,
    InvitationCompletionOutcome,
    InvitationDelivery,
    IssuedInvitationTransaction,
)


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
