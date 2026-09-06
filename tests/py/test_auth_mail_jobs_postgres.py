from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.auth_mail_jobs_postgres import (
    ClaimedAuthMailDeliveryContext,
    PostgresAuthMailJobRepository,
)


NOW = datetime(2026, 9, 7, 14, 0, tzinfo=timezone.utc)


class _Result:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _Connection:
    def __init__(self, rows):
        self.rows = list(rows)
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_args):
        if exc_type is None:
            self.commits += 1
        else:
            self.rollbacks += 1

    def transaction(self):
        return nullcontext()

    def execute(self, sql, parameters=None):
        self.executed.append((" ".join(str(sql).casefold().split()), parameters))
        return _Result(self.rows.pop(0) if self.rows else None)


class _Jobs:
    def __init__(self, *, job_id=73, failure=None):
        self.job_id = job_id
        self.failure = failure
        self.calls = []

    def enqueue_in_transaction(self, connection, command):
        self.calls.append((connection, command))
        if self.failure is not None:
            raise self.failure
        return self.job_id


def _repository(connection, jobs):
    return PostgresAuthMailJobRepository(
        database_url="postgresql://app@localhost/album_haven",
        connect_to_database=lambda _url: connection,
        job_repository=jobs,
    )


def _accept(repository, *, category="welcome"):
    return repository.accept_intent(
        category=category,
        account_id=7,
        actor_account_id=7,
        library_id=19,
        request_origin_ref="browser:origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=NOW,
    )


def test_accept_welcome_intent_inserts_outbox_and_job_in_one_transaction():
    connection = _Connection([
        {"outbox_id": 61, "row_revision": 0, "accepted_attempt": 1},
        {"linked": True},
    ])
    jobs = _Jobs()

    accepted = _accept(_repository(connection, jobs))

    assert accepted.outbox_id == 61
    assert accepted.job_id == 73
    assert accepted.accepted_attempt == 1
    assert accepted.row_revision == 1
    assert connection.commits == 1
    assert connection.rollbacks == 0
    command = jobs.calls[0][1]
    assert command.kind == "auth_welcome_delivery"
    assert command.subject_kind == "mail_outbox"
    assert command.subject_ref == "61"
    assert command.parameters == {}
    assert command.idempotency_key == "auth-mail:welcome:61:attempt:1"
    assert command.account_id == 7
    assert command.library_id == 19
    assert command.capability_key == "accounts.welcome.send"
    assert command.max_attempts == 3
    assert command.scope_version == 1
    assert command.resource_revision == 1


@pytest.mark.parametrize(
    ("category", "kind", "capability", "maximum"),
    [
        ("account_invitation", "auth_invitation_delivery", "accounts.invitation.send", 1),
        ("password_reset", "auth_password_reset_delivery", "accounts.password_reset.send", 1),
    ],
)
def test_token_bearing_categories_are_accepted_without_a_token(
    category, kind, capability, maximum
):
    connection = _Connection([
        {"outbox_id": 62, "row_revision": 0, "accepted_attempt": 1},
        {"linked": True},
    ])
    jobs = _Jobs()

    _accept(_repository(connection, jobs), category=category)

    insert_sql, insert_values = connection.executed[0]
    assert "insert into app.mail_outbox" in insert_sql
    assert insert_values["reset_token_id"] is None
    assert insert_values["invitation_token_id"] is None
    command = jobs.calls[0][1]
    assert command.kind == kind
    assert command.capability_key == capability
    assert command.max_attempts == maximum
    assert command.parameters == {}


def test_public_password_reset_records_target_without_synthesizing_actor_authority():
    connection = _Connection([
        {"outbox_id": 63, "row_revision": 0, "accepted_attempt": 1},
        {"linked": True},
    ])
    jobs = _Jobs()

    accepted = _repository(connection, jobs).accept_intent(
        category="password_reset",
        account_id=7,
        actor_account_id=None,
        library_id=None,
        request_origin_ref="browser:public-origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="public_web",
        now=NOW,
    )

    assert accepted.outbox_id == 63
    assert connection.executed[0][1]["authorization_mode"] == "public_lifecycle"
    command = jobs.calls[0][1]
    assert command.account_id is None
    assert command.library_id is None
    assert command.capability_key is None


def test_public_lifecycle_is_rejected_for_non_reset_categories():
    connection = _Connection([])

    with pytest.raises(ValueError, match="only password reset"):
        _repository(connection, _Jobs()).accept_intent(
            category="account_invitation",
            account_id=7,
            actor_account_id=None,
            library_id=None,
            request_origin_ref="browser:public-origin-42",
            deployment_mode="self_hosted_private_web",
            client_surface="public_web",
            now=NOW,
        )

    assert connection.executed == []


def test_public_lifecycle_rejects_actor_library_scope():
    connection = _Connection([])

    with pytest.raises(ValueError, match="cannot carry actor library"):
        _repository(connection, _Jobs()).accept_intent(
            category="password_reset",
            account_id=7,
            actor_account_id=None,
            library_id=19,
            request_origin_ref="browser:public-origin-42",
            deployment_mode="self_hosted_private_web",
            client_surface="public_web",
            now=NOW,
        )

    assert connection.executed == []


def test_enqueue_failure_rolls_back_the_new_outbox_intent():
    connection = _Connection([
        {"outbox_id": 61, "row_revision": 0, "accepted_attempt": 1},
    ])
    jobs = _Jobs(failure=RuntimeError("generic enqueue unavailable"))

    with pytest.raises(RuntimeError, match="generic enqueue unavailable"):
        _accept(_repository(connection, jobs))

    assert connection.commits == 0
    assert connection.rollbacks == 1


def test_existing_attempt_returns_its_current_job_without_duplicate_enqueue():
    connection = _Connection([{
        "outbox_id": 61,
        "account_id": 7,
        "message_category": "welcome",
        "row_revision": 4,
        "accepted_attempt": 2,
        "current_job_id": 74,
    }])
    jobs = _Jobs()

    accepted = _repository(connection, jobs).compose_existing_intent_in_transaction(
        connection,
        outbox_id=61,
        category="welcome",
        account_id=7,
        actor_account_id=7,
        library_id=19,
        request_origin_ref="browser:origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        scheduled_at=NOW,
    )

    assert accepted.job_id == 74
    assert jobs.calls == []


def test_known_not_sent_welcome_schedules_exact_next_domain_attempt():
    connection = _Connection([
        {
            "outbox_id": 61,
            "account_id": 7,
            "row_revision": 5,
            "accepted_attempt": 2,
            "current_job_id": None,
            "next_attempt_at": NOW + timedelta(seconds=60),
        },
        {"linked": True},
    ])
    jobs = _Jobs(job_id=75)

    accepted = _repository(connection, jobs).schedule_next_welcome_attempt(
        outbox_id=61,
        account_id=7,
        actor_account_id=7,
        library_id=19,
        expected_row_revision=4,
        completed_attempt=1,
        request_origin_ref="browser:origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=NOW,
    )

    assert accepted.accepted_attempt == 2
    assert accepted.job_id == 75
    assert jobs.calls[0][1].scheduled_at == NOW + timedelta(seconds=60)
    assert jobs.calls[0][1].idempotency_key == "auth-mail:welcome:61:attempt:2"


@pytest.mark.parametrize("category", ["", "other", "WELCOME", None])
def test_unknown_mail_category_is_rejected_before_database_access(category):
    connection = _Connection([])

    with pytest.raises(ValueError, match="category"):
        _accept(_repository(connection, _Jobs()), category=category)

    assert connection.executed == []


def test_generic_job_never_contains_mail_or_bearer_material():
    connection = _Connection([
        {"outbox_id": 61, "row_revision": 0, "accepted_attempt": 1},
        {"linked": True},
    ])
    jobs = _Jobs()

    _accept(_repository(connection, jobs), category="password_reset")

    rendered = repr(jobs.calls[0][1]).casefold()
    assert jobs.calls[0][1].parameters == {}
    for forbidden in (
        "recipient@example.test",
        "raw_token",
        "token_hash",
        "smtp_password",
        "message_subject",
        "message_body",
    ):
        assert forbidden not in rendered


def test_claimed_delivery_validation_passes_complete_lease_and_domain_fence():
    connection = _Connection([{"valid": True}])
    repository = _repository(connection, _Jobs())

    valid = repository.validate_claimed_delivery(
        outbox_id=61,
        category="password_reset",
        job_id=73,
        attempt=1,
        worker_id="worker-a",
        lease_token="lease-a",
        now=NOW,
        row_revision=3,
        accepted_attempt=1,
    )

    assert valid is True
    sql, values = connection.executed[0]
    assert "ops.validate_claimed_auth_mail" in sql
    assert values["outbox_id"] == 61
    assert values["row_revision"] == 3
    assert values["accepted_attempt"] == 1


def test_claimed_delivery_context_is_local_and_redacts_identity():
    connection = _Connection([{
        "outbox_id": 61,
        "target_account_id": 9,
        "username_display": "Private User",
        "contact_email": "private@example.test",
        "target_credential_version": 4,
        "lifecycle_expires_at": NOW + timedelta(minutes=30),
        "delivery_checkpoint": "accepted",
        "row_revision": 3,
        "accepted_attempt": 1,
    }])
    repository = _repository(connection, _Jobs())

    context = repository.load_claimed_delivery_context(
        outbox_id=61,
        category="password_reset",
        job_id=73,
        attempt=1,
        worker_id="worker-a",
        lease_token="lease-a",
        now=NOW,
    )

    assert isinstance(context, ClaimedAuthMailDeliveryContext)
    assert context.username == "Private User"
    assert context.recipient == "private@example.test"
    assert "Private User" not in repr(context)
    assert "private@example.test" not in repr(context)
    assert "token" not in repr(context).casefold()


def test_claimed_token_issuer_accepts_only_hash_and_returns_fenced_revision():
    connection = _Connection([{"token_id": 81, "row_revision": 4}])
    repository = _repository(connection, _Jobs())
    digest = bytes(range(32))

    issued = repository.issue_claimed_token_hash(
        outbox_id=61,
        category="password_reset",
        job_id=73,
        attempt=1,
        worker_id="worker-a",
        lease_token="lease-a",
        now=NOW,
        expected_row_revision=3,
        token_hash=digest,
        expires_at=NOW + timedelta(minutes=30),
        request_ref="opaque-request-42",
    )

    assert issued.token_id == 81
    assert issued.row_revision == 4
    sql, values = connection.executed[0]
    assert "ops.issue_claimed_auth_mail_token_hash" in sql
    assert values["token_hash"] == digest
    assert "raw" not in values


@pytest.mark.parametrize("digest", [b"short", "not-bytes", None])
def test_claimed_token_issuer_rejects_invalid_digest_before_database(digest):
    connection = _Connection([])

    with pytest.raises(ValueError, match="token_hash"):
        _repository(connection, _Jobs()).issue_claimed_token_hash(
            outbox_id=61,
            category="password_reset",
            job_id=73,
            attempt=1,
            worker_id="worker-a",
            lease_token="lease-a",
            now=NOW,
            expected_row_revision=3,
            token_hash=digest,
            expires_at=NOW + timedelta(minutes=30),
            request_ref="opaque-request-42",
        )

    assert connection.executed == []
