"""Purpose-bound, secret-redacting invitation value objects."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import hmac

from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
)

INVITATION_DB_PURPOSE = "account_invitation"
INVITATION_URL_PURPOSE = "account-invitation"
INVITATION_MESSAGE_CATEGORY = "account_invitation"
INVITATION_TRANSACTION_SECONDS = 15 * 60


class InvitationCompletionOutcome(str, Enum):
    SUCCESS = "success"
    INVALID = "invalid"


@dataclass(frozen=True, repr=False, slots=True)
class InvitationDelivery:
    outbox_id: int
    invitation_token_id: int
    account_id: int
    recipient: str
    username: str
    raw_token: str
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(outbox_id={self.outbox_id!r}, "
            f"invitation_token_id={self.invitation_token_id!r}, "
            f"account_id={self.account_id!r}, recipient=<redacted>, "
            f"username={self.username!r}, raw_token=<redacted>, "
            f"expires_at={self.expires_at!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class CopiedInvitation:
    invitation_url: str
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(invitation_url=<redacted>, "
            f"expires_at={self.expires_at!r})"
        )


@dataclass(frozen=True, repr=False, slots=True)
class IssuedInvitationTransaction:
    raw_token: str
    transaction_id: int
    expires_at: datetime

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(raw_token=<redacted>, "
            f"transaction_id={self.transaction_id!r}, expires_at={self.expires_at!r})"
        )


def validated_issued_invitation_token(provider) -> IssuedOpaqueToken:
    value = provider()
    if not isinstance(value, IssuedOpaqueToken):
        raise RuntimeError("Account invitation token issuance failed.")
    try:
        expected = hash_opaque_token(value.raw)
    except (TypeError, ValueError):
        raise RuntimeError("Account invitation token issuance failed.") from None
    if not hmac.compare_digest(expected, value.digest):
        raise RuntimeError("Account invitation token issuance failed.")
    return value
