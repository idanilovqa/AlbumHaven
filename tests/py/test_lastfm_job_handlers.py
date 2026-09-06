from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from music_app.jobs.lastfm_handlers import (
    LastfmProviderDisposition,
    build_lastfm_retry_handler,
    classify_lastfm_provider_error,
    classify_lastfm_provider_outcome,
    retry_delay_seconds,
)
from music_app.services.jobs.authorization import AuthorizationDecision
from music_app.services.jobs.models import ClaimedJob, JobState
from music_app.services.lastfm import LastfmError, LastfmSubmissionOutcome


NOW = datetime(2026, 9, 7, 15, 0, tzinfo=timezone.utc)


def _claim(**overrides):
    values = dict(
        job_id=71,
        kind="lastfm_scrobble_retry",
        subject_kind="pending_scrobble",
        subject_ref="53",
        parameters={"active_session_ref": "31"},
        account_id=7,
        library_id=19,
        capability_key="integration.lastfm.scrobble",
        request_origin_id=23,
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        idempotency_key="lastfm-scrobble:53:attempt:2",
        attempt=1,
        max_attempts=1,
        worker_id="worker-a",
        lease_token="lease-a",
        lease_expires_at=NOW,
        scheduled_at=NOW,
        scope_version=5,
        resource_revision=2,
    )
    values.update(overrides)
    return ClaimedJob(**values)


class _Context:
    def __init__(self, *, allowed=True, canceled=False, lease_active=True):
        self.allowed = allowed
        self.cancel_requested = canceled
        self.lease_active = lease_active
        self.calls = []

    def reauthorize(self):
        self.calls.append("reauthorize")
        return AuthorizationDecision(
            self.allowed, "authorized" if self.allowed else "capability_revoked"
        )


class _Repository:
    def __init__(self):
        self.calls = []
        self.secret = "claimed-session-secret"
        self.scope = SimpleNamespace(
            pending_scrobble_id=53,
            row_revision=6,
            accepted_attempt=2,
            listen_id="listen-53",
            payload={"artist": "Artist", "track": "Song", "timestamp": 100},
        )

    def load_claimed_session_secret(self, **values):
        self.calls.append(("secret", values))
        return self.secret

    def begin_claimed_attempt(self, **values):
        self.calls.append(("begin", values))
        return self.scope

    def finalize_claimed_attempt(self, **values):
        self.calls.append(("finish", values))
        return SimpleNamespace(domain_status="completed", next_job_id=None)

    def cancel_claimed_before_send(self, **values):
        self.calls.append(("cancel", values))
        return True


@pytest.mark.parametrize(
    ("previous_attempts", "expected"),
    [(0, 60), (1, 60), (2, 120), (3, 240), (4, 480), (5, 960)],
)
def test_retry_delay_preserves_existing_five_attempt_formula(previous_attempts, expected):
    assert retry_delay_seconds(previous_attempts) == expected


def test_provider_outcomes_are_classified_without_guessing_ambiguous_sends():
    assert classify_lastfm_provider_outcome(
        LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")
    ).disposition is LastfmProviderDisposition.ACCEPTED
    assert classify_lastfm_provider_outcome(
        LastfmSubmissionOutcome(sent=False, outcome="not_sent", message="offline")
    ).disposition is LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE
    assert classify_lastfm_provider_outcome(
        LastfmSubmissionOutcome(sent=True, accepted=0, outcome="ignored", message="ignored")
    ).disposition is LastfmProviderDisposition.PERMANENT_REJECTION


def test_provider_errors_separate_reauthentication_known_failure_and_ambiguity():
    assert classify_lastfm_provider_error(
        LastfmError("reauth", reauthentication_required=True)
    ).disposition is LastfmProviderDisposition.REAUTHENTICATION_REQUIRED
    assert classify_lastfm_provider_error(
        LastfmError("busy", code=29, retryable=True, error_kind="provider_error")
    ).disposition is LastfmProviderDisposition.KNOWN_NOT_SENT_RETRYABLE
    assert classify_lastfm_provider_error(
        LastfmError("connection lost", retryable=True, error_kind="network_error")
    ).disposition is LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS
    assert classify_lastfm_provider_error(
        LastfmError("bad xml", retryable=True, error_kind="malformed_response")
    ).disposition is LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS
    assert classify_lastfm_provider_error(TimeoutError("timed out")).disposition \
        is LastfmProviderDisposition.POSSIBLE_SEND_AMBIGUOUS


def test_handler_reauthorizes_loads_secret_marks_sending_and_finalizes_accepted():
    repository = _Repository()
    provider_calls = []
    handler = build_lastfm_retry_handler(
        retry_repository=repository,
        config={"LASTFM_API_KEY": "server-key"},
        scrobble_with_session=lambda config, payload, session_key: provider_calls.append(
            (config, payload, session_key)
        ) or LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted"),
        clock=lambda: NOW,
    )
    context = _Context()

    outcome = handler(_claim(), context)

    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "lastfm_scrobble_accepted"
    assert context.calls == ["reauthorize"]
    assert [name for name, _ in repository.calls] == ["secret", "begin", "finish"]
    assert provider_calls == [
        (
            {"LASTFM_API_KEY": "server-key"},
            {"artist": "Artist", "track": "Song", "timestamp": 100},
            "claimed-session-secret",
        )
    ]
    finish = repository.calls[-1][1]
    assert finish["disposition"] == "accepted"
    assert finish["expected_row_revision"] == 6
    assert "claimed-session-secret" not in repr(finish)


@pytest.mark.parametrize(
    ("context", "reason"),
    [
        (_Context(allowed=False), "capability_revoked"),
        (_Context(canceled=True), "lastfm_retry_canceled_before_send"),
        (_Context(lease_active=False), "lastfm_retry_lease_lost_before_send"),
    ],
)
def test_handler_cancels_before_send_without_loading_secret_or_calling_provider(context, reason):
    repository = _Repository()
    provider_calls = []
    handler = build_lastfm_retry_handler(
        retry_repository=repository,
        config={},
        scrobble_with_session=lambda *_args: provider_calls.append(True),
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), context)

    assert outcome.next_state is JobState.CANCELED
    assert outcome.reason_code == reason
    assert provider_calls == []
    assert [name for name, _ in repository.calls] == ["cancel"]


def test_handler_marks_network_loss_ambiguous_and_never_requests_generic_retry():
    repository = _Repository()
    handler = build_lastfm_retry_handler(
        retry_repository=repository,
        config={},
        scrobble_with_session=lambda *_args: (_ for _ in ()).throw(
            LastfmError("private provider detail", retryable=True, error_kind="network_error")
        ),
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), _Context())

    assert outcome.next_state is JobState.AMBIGUOUS
    assert outcome.reason_code == "lastfm_scrobble_ambiguous"
    finish = repository.calls[-1][1]
    assert finish["disposition"] == "possible_send_ambiguous"
    assert "private provider detail" not in repr(outcome)


def test_handler_schedules_domain_retry_as_successful_one_attempt_orchestration():
    repository = _Repository()
    repository.finalize_claimed_attempt = lambda **values: repository.calls.append(
        ("finish", values)
    ) or SimpleNamespace(domain_status="accepted", next_job_id=72)
    handler = build_lastfm_retry_handler(
        retry_repository=repository,
        config={},
        scrobble_with_session=lambda *_args: LastfmSubmissionOutcome(
            sent=False, outcome="not_sent", message="offline"
        ),
        clock=lambda: NOW,
    )

    outcome = handler(_claim(), _Context())

    assert outcome.next_state is JobState.SUCCEEDED
    assert outcome.reason_code == "lastfm_retry_scheduled"
    assert repository.calls[-1][1]["disposition"] == "known_not_sent_retryable"
