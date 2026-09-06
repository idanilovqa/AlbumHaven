from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.jobs.auth_mail_handlers import (
    AuthMailDisposition,
    build_auth_mail_handler,
    classify_auth_mail_result,
)
from music_app.services.auth_mail import DeliveryResult
from music_app.services.auth_mail_jobs_postgres import (
    ClaimedAuthMailDeliveryContext,
    IssuedAuthMailToken,
)
from music_app.services.auth_tokens import issue_opaque_token
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobState


NOW = datetime(2026, 9, 7, 16, 0, tzinfo=timezone.utc)


def _claim(category="welcome"):
    kind, capability, maximum = {
        "welcome": ("auth_welcome_delivery", "accounts.welcome.send", 3),
        "account_invitation": (
            "auth_invitation_delivery", "accounts.invitation.send", 1
        ),
        "password_reset": (
            "auth_password_reset_delivery", "accounts.password_reset.send", 1
        ),
    }[category]
    return ClaimedJob(
        job_id=73,
        kind=kind,
        subject_kind="mail_outbox",
        subject_ref="61",
        parameters={},
        account_id=7,
        library_id=19,
        capability_key=capability,
        request_origin_id=23,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key=f"auth-mail:{category}:61:attempt:1",
        attempt=1,
        max_attempts=maximum,
        worker_id="worker-a",
        lease_token="lease-a",
        lease_expires_at=NOW + timedelta(minutes=5),
        scheduled_at=NOW,
        scope_version=3,
        resource_revision=1,
    )


class _Context:
    def __init__(self):
        self.cancel_requested = False
        self.lease_active = True
        self.decisions = []

    def reauthorize(self):
        self.decisions.append(True)
        return AuthorizationDecision(True, "authorized")


class _Repository:
    def __init__(self):
        self.calls = []
        self.next_job_id = None

    def load_claimed_delivery_context(self, **values):
        self.calls.append(("load", values))
        return ClaimedAuthMailDeliveryContext(
            outbox_id=61,
            target_account_id=9,
            username="Private User",
            recipient="private@example.test",
            target_credential_version=4,
            lifecycle_expires_at=NOW + timedelta(minutes=30),
            delivery_checkpoint="accepted",
            row_revision=3,
            accepted_attempt=1,
        )

    def issue_claimed_token_hash(self, **values):
        self.calls.append(("issue", values))
        return IssuedAuthMailToken(token_id=81, row_revision=4)

    def begin_claimed_send(self, **values):
        self.calls.append(("begin", values))
        return values["expected_row_revision"] + 1

    def finalize_claimed_delivery(self, **values):
        self.calls.append(("finish", values))
        return SimpleNamespace(next_job_id=self.next_job_id)

    def cancel_claimed_before_send(self, **values):
        self.calls.append(("cancel", values))
        return True


def _handler(category, repository, send, **overrides):
    values = dict(
        category=category,
        mail_repository=repository,
        mail_config={
            "public_base_url": "https://example.test",
            "sender_address": "noreply@example.test",
            "sender_name": "Album Haven",
        },
        send_email=send,
        token_issuer=lambda: issue_opaque_token(random_bytes=lambda _size: b"a" * 32),
        clock=lambda: NOW,
    )
    values.update(overrides)
    return build_auth_mail_handler(**values)


@pytest.mark.parametrize(
    ("category", "result", "expected"),
    [
        ("welcome", DeliveryResult(True, "delivered"), AuthMailDisposition.DELIVERED),
        ("welcome", DeliveryResult(False, "timeout"), AuthMailDisposition.KNOWN_NOT_SENT_RETRYABLE),
        ("welcome", DeliveryResult(False, "unknown"), AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS),
        ("password_reset", DeliveryResult(False, "timeout"), AuthMailDisposition.POSSIBLE_SEND_AMBIGUOUS),
        ("account_invitation", DeliveryResult(False, "refused"), AuthMailDisposition.KNOWN_NOT_SENT_TERMINAL),
    ],
)
def test_provider_classification_is_category_specific(category, result, expected):
    assert classify_auth_mail_result(category, result).disposition is expected


def test_welcome_handler_sends_once_and_fences_success():
    repository = _Repository()
    sent = []
    handler = _handler("welcome", repository, lambda message, **_kw: sent.append(message) or DeliveryResult(True, "delivered"))

    outcome = handler(_claim("welcome"), _Context())

    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "auth_mail_delivered"
    assert len(sent) == 1
    assert [name for name, _ in repository.calls] == ["load", "begin", "finish"]


def test_welcome_known_not_sent_schedules_next_domain_job():
    repository = _Repository()
    repository.next_job_id = 74
    handler = _handler("welcome", repository, lambda *_a, **_k: DeliveryResult(False, "timeout"))

    outcome = handler(_claim("welcome"), _Context())

    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "auth_mail_retry_scheduled"


def test_password_reset_issues_only_hash_then_ambiguous_timeout_without_replay():
    repository = _Repository()
    sent = []
    issued = issue_opaque_token(random_bytes=lambda _size: b"b" * 32)
    handler = _handler(
        "password_reset",
        repository,
        lambda message, **_kw: sent.append(message) or DeliveryResult(False, "unknown"),
        token_issuer=lambda: issued,
    )

    outcome = handler(_claim("password_reset"), _Context())

    assert outcome.next_state is JobState.AMBIGUOUS
    assert outcome.reason_code == "auth_mail_delivery_ambiguous"
    issue = next(values for name, values in repository.calls if name == "issue")
    assert issue["token_hash"] == issued.digest
    assert issued.raw not in repr(issue)
    finish = next(values for name, values in repository.calls if name == "finish")
    assert finish["disposition"] == "possible_send_ambiguous"
    assert len(sent) == 1


def test_cancellation_before_token_issuance_makes_no_provider_call():
    repository = _Repository()
    context = _Context()
    context.cancel_requested = True
    sends = []
    handler = _handler(
        "account_invitation",
        repository,
        lambda *_a, **_k: sends.append(True),
    )

    outcome = handler(_claim("account_invitation"), context)

    assert outcome.next_state is JobState.CANCELED
    assert sends == []
    assert [name for name, _ in repository.calls] == ["cancel"]


def test_lease_loss_after_token_issuance_never_calls_provider():
    repository = _Repository()
    context = _Context()
    original_issue = repository.issue_claimed_token_hash

    def issue(**values):
        result = original_issue(**values)
        context.lease_active = False
        return result

    repository.issue_claimed_token_hash = issue
    sends = []
    handler = _handler(
        "password_reset", repository, lambda *_a, **_k: sends.append(True)
    )

    outcome = handler(_claim("password_reset"), context)

    assert outcome.next_state is JobState.AMBIGUOUS
    assert sends == []


def test_invalid_token_generation_terminates_before_issuance_or_send():
    repository = _Repository()
    sends = []
    handler = _handler(
        "password_reset",
        repository,
        lambda *_a, **_k: sends.append(True),
        token_issuer=lambda: object(),
    )

    outcome = handler(_claim("password_reset"), _Context())

    assert outcome.next_state is JobState.CANCELED
    assert sends == []
    assert [name for name, _ in repository.calls] == ["load", "cancel"]


def test_welcome_composition_failure_terminates_before_send_checkpoint():
    repository = _Repository()
    sends = []
    handler = build_auth_mail_handler(
        category="welcome",
        mail_repository=repository,
        mail_config={},
        send_email=lambda *_a, **_k: sends.append(True),
        clock=lambda: NOW,
    )

    outcome = handler(_claim("welcome"), _Context())

    assert outcome.next_state is JobState.CANCELED
    assert sends == []
    assert [name for name, _ in repository.calls] == ["load", "cancel"]
