"""Typed lease-fenced handlers for durable authentication mail."""

from __future__ import annotations

import asyncio
import hmac
import inspect
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable, Mapping

from music_app.services.auth_invitation_models import InvitationDelivery
from music_app.services.auth_mail import (
    DeliveryResult,
    compose_invitation_email,
    compose_password_reset_email,
    compose_welcome_email,
    send_auth_email,
)
from music_app.services.auth_tokens import (
    IssuedOpaqueToken,
    hash_opaque_token,
    issue_opaque_token,
)
from music_app.services.jobs.models import ClaimedJob, JobState, JobTransitionResult


class AuthMailDisposition(str, Enum):
    DELIVERED = "delivered"
    KNOWN_NOT_SENT_RETRYABLE = "known_not_sent_retryable"
    KNOWN_NOT_SENT_TERMINAL = "known_not_sent_terminal"
    POSSIBLE_SEND_AMBIGUOUS = "possible_send_ambiguous"
    INELIGIBLE_BEFORE_TOKEN = "ineligible_before_token"
    CANCELED_BEFORE_SEND = "canceled_before_send"


@dataclass(frozen=True)
class AuthMailProviderResult:
    disposition: AuthMailDisposition
    reason_code: str


def classify_auth_mail_result(
    category: str, result: DeliveryResult
) -> AuthMailProviderResult:
    if result.delivered and result.reason == "delivered":
        return AuthMailProviderResult(AuthMailDisposition.DELIVERED, "delivered")
    if result.reason == "unknown":
        return AuthMailProviderResult(
            AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS,
            "provider_outcome_unknown",
        )
    if category == "welcome" and result.reason in {"timeout", "failed"}:
        return AuthMailProviderResult(
            AuthMailDisposition.KNOWN_NOT_SENT_RETRYABLE,
            "provider_known_not_sent",
        )
    if category in {"account_invitation", "password_reset"} and result.reason in {
        "timeout",
        "failed",
    }:
        return AuthMailProviderResult(
            AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS,
            "provider_outcome_unknown",
        )
    return AuthMailProviderResult(
        AuthMailDisposition.KNOWN_NOT_SENT_TERMINAL,
        "provider_rejected_mail",
    )


def _claim_values(claim: ClaimedJob, category: str, now: datetime) -> dict[str, object]:
    return {
        "outbox_id": int(claim.subject_ref),
        "category": category,
        "job_id": claim.job_id,
        "attempt": claim.attempt,
        "worker_id": claim.worker_id,
        "lease_token": claim.lease_token,
        "now": now,
    }


def _deliver(send_email: Callable[..., Any], message: Any, config: Mapping[str, Any]):
    result = send_email(message, config=config)
    if inspect.isawaitable(result):
        result = asyncio.run(result)
    if not isinstance(result, DeliveryResult):
        return DeliveryResult(False, "unknown")
    return result


def build_auth_mail_handler(
    *,
    category: str,
    mail_repository: Any,
    mail_config: Mapping[str, Any],
    send_email: Callable[..., Any] = send_auth_email,
    token_issuer: Callable[[], IssuedOpaqueToken] = issue_opaque_token,
    clock: Callable[[], datetime] | None = None,
) -> Callable[[ClaimedJob, Any], JobTransitionResult]:
    if category not in {"welcome", "account_invitation", "password_reset"}:
        raise ValueError("authentication mail category is invalid")
    now = clock or (lambda: datetime.now(timezone.utc))
    provider_config = dict(mail_config)

    def cancel(claim: ClaimedJob, reason: str, observed_at: datetime):
        mail_repository.cancel_claimed_before_send(
            **_claim_values(claim, category, observed_at), reason_code=reason
        )
        return JobTransitionResult(JobState.CANCELED, reason)

    def handle(claim: ClaimedJob, context: Any) -> JobTransitionResult:
        observed_at = now()
        if context.cancel_requested:
            return cancel(claim, "auth_mail_canceled_before_send", observed_at)
        if not context.lease_active:
            return JobTransitionResult(JobState.CANCELED, "auth_mail_lease_lost_before_send")
        decision = context.reauthorize()
        if not decision.allowed:
            return cancel(claim, decision.reason_code, observed_at)

        values = _claim_values(claim, category, observed_at)
        delivery_context = mail_repository.load_claimed_delivery_context(**values)
        raw_token: str | None = None
        token_id: int | None = None
        message: Any = None
        row_revision = delivery_context.row_revision
        if category == "welcome":
            try:
                message = compose_welcome_email(
                    username=delivery_context.username,
                    recipient=delivery_context.recipient,
                    config=provider_config,
                )
            except Exception:
                return cancel(
                    claim, "auth_mail_composition_failed_before_send", observed_at
                )
        try:
            if category != "welcome":
                try:
                    issued = token_issuer()
                    digest_matches = (
                        isinstance(issued, IssuedOpaqueToken)
                        and isinstance(issued.raw, str)
                        and isinstance(issued.digest, bytes)
                        and len(issued.digest) == 32
                        and hmac.compare_digest(
                            hash_opaque_token(issued.raw), issued.digest
                        )
                    )
                except Exception:
                    digest_matches = False
                if (
                    not digest_matches
                ):
                    return cancel(
                        claim, "auth_mail_token_issue_failed", observed_at
                    )
                raw_token = issued.raw
                token = mail_repository.issue_claimed_token_hash(
                    **values,
                    expected_row_revision=row_revision,
                    token_hash=issued.digest,
                    expires_at=delivery_context.lifecycle_expires_at,
                    request_ref=f"auth-mail-job-{claim.job_id}",
                )
                token_id = token.token_id
                row_revision = token.row_revision
                if context.cancel_requested or not context.lease_active:
                    return JobTransitionResult(
                        JobState.AMBIGUOUS, "auth_mail_token_issued_ambiguous"
                    )
                decision = context.reauthorize()
                if not decision.allowed:
                    return JobTransitionResult(
                        JobState.AMBIGUOUS, "auth_mail_token_issued_ambiguous"
                    )
                if category == "password_reset":
                    message = compose_password_reset_email(
                        username=delivery_context.username,
                        recipient=delivery_context.recipient,
                        token=raw_token,
                        config=provider_config,
                    )
                else:
                    message = compose_invitation_email(
                        delivery=InvitationDelivery(
                            outbox_id=delivery_context.outbox_id,
                            invitation_token_id=token_id,
                            account_id=delivery_context.target_account_id,
                            recipient=delivery_context.recipient,
                            username=delivery_context.username,
                            raw_token=raw_token,
                            expires_at=delivery_context.lifecycle_expires_at,
                        ),
                        config=provider_config,
                    )

            row_revision = mail_repository.begin_claimed_send(
                **values, expected_row_revision=row_revision
            )
            provider_result = classify_auth_mail_result(
                category, _deliver(send_email, message, provider_config)
            )
            finalization = mail_repository.finalize_claimed_delivery(
                **values,
                expected_row_revision=row_revision,
                disposition=provider_result.disposition.value,
                reason_code=provider_result.reason_code,
            )
        except Exception:
            provider_result = AuthMailProviderResult(
                AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS,
                "provider_outcome_unknown",
            )
            try:
                finalization = mail_repository.finalize_claimed_delivery(
                    **values,
                    expected_row_revision=row_revision,
                    disposition=provider_result.disposition.value,
                    reason_code=provider_result.reason_code,
                )
            except Exception:
                return JobTransitionResult(
                    JobState.AMBIGUOUS, "auth_mail_delivery_ambiguous"
                )
        finally:
            raw_token = None
            token_id = None

        if provider_result.disposition is AuthMailDisposition.DELIVERED:
            return JobTransitionResult(JobState.SUCCEEDED, "auth_mail_delivered")
        if provider_result.disposition is AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS:
            return JobTransitionResult(
                JobState.AMBIGUOUS, "auth_mail_delivery_ambiguous"
            )
        if getattr(finalization, "next_job_id", None) is not None:
            return JobTransitionResult(
                JobState.SUCCEEDED, "auth_mail_retry_scheduled"
            )
        return JobTransitionResult(JobState.SUCCEEDED, "auth_mail_delivery_terminal")

    return handle


__all__ = [
    "AuthMailDisposition",
    "AuthMailProviderResult",
    "build_auth_mail_handler",
    "classify_auth_mail_result",
]
