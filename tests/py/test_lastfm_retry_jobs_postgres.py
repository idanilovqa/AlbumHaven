from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.lastfm_retry_jobs_postgres import (
    PostgresLastfmRetryJobRepository,
)


NOW = datetime(2026, 9, 7, 12, 0, tzinfo=timezone.utc)


class _Result:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._row or []


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
    def __init__(self, *, job_id=71, failure=None):
        self.job_id = job_id
        self.failure = failure
        self.calls = []

    def enqueue_in_transaction(self, connection, command):
        self.calls.append((connection, command))
        if self.failure is not None:
            raise self.failure
        return self.job_id


def _repository(connection, jobs):
    return PostgresLastfmRetryJobRepository(
        database_url="postgresql://app@localhost/album_haven",
        connect_to_database=lambda _url: connection,
        job_repository=jobs,
    )


def _accept(repository):
    return repository.accept_retryable_pending(
        account_id=7,
        library_id=19,
        source_family="runtime_lastfm_sync_state_adapter",
        source_key="listen-42",
        track_key="opaque-track-42",
        played_at=NOW - timedelta(minutes=4),
        previous_attempts=1,
        next_attempt_at=NOW + timedelta(seconds=60),
        active_session_id=31,
        request_origin_ref="browser:origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        payload={"source_payload": {"artist": "A", "title": "T"}},
    )


def test_accept_retryable_pending_composes_domain_row_and_one_attempt_job_atomically():
    connection = _Connection(
        [
            {
                "pending_scrobble_id": 53,
                "row_revision": 4,
                "accepted_attempt": 2,
                "current_job_id": None,
            },
            {"linked": True},
        ]
    )
    jobs = _Jobs(job_id=71)

    accepted = _accept(_repository(connection, jobs))

    assert accepted.pending_scrobble_id == 53
    assert accepted.job_id == 71
    assert accepted.row_revision == 5
    assert accepted.accepted_attempt == 2
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert len(jobs.calls) == 1
    command = jobs.calls[0][1]
    assert command.kind == "lastfm_scrobble_retry"
    assert command.subject_kind == "pending_scrobble"
    assert command.subject_ref == "53"
    assert command.idempotency_key == "lastfm-scrobble:53:attempt:2"
    assert command.max_attempts == 1
    assert command.parameters == {"active_session_ref": "31"}
    assert command.scope_version == 5
    assert command.resource_revision == 2
    assert command.account_id == 7
    assert command.library_id == 19
    assert command.capability_key == "integration.lastfm.scrobble"


def test_accept_retryable_pending_returns_existing_job_for_duplicate_attempt():
    connection = _Connection(
        [
            {
                "pending_scrobble_id": 53,
                "row_revision": 5,
                "accepted_attempt": 2,
                "current_job_id": 71,
            }
        ]
    )
    jobs = _Jobs()

    accepted = _accept(_repository(connection, jobs))

    assert accepted.job_id == 71
    assert accepted.row_revision == 5
    assert jobs.calls == []


def test_accept_retryable_pending_rolls_back_domain_change_when_enqueue_fails():
    connection = _Connection(
        [
            {
                "pending_scrobble_id": 53,
                "row_revision": 4,
                "accepted_attempt": 2,
                "current_job_id": None,
            }
        ]
    )
    jobs = _Jobs(failure=RuntimeError("generic enqueue unavailable"))

    with pytest.raises(RuntimeError, match="generic enqueue unavailable"):
        _accept(_repository(connection, jobs))

    assert connection.commits == 0
    assert connection.rollbacks == 1


def test_accept_retryable_pending_rejects_exhausted_domain_attempts():
    connection = _Connection([])
    repository = _repository(connection, _Jobs())

    with pytest.raises(ValueError, match="fewer than five"):
        repository.accept_retryable_pending(
            account_id=7,
            library_id=19,
            source_family="runtime_lastfm_sync_state_adapter",
            source_key="listen-42",
            track_key="opaque-track-42",
            played_at=NOW,
            previous_attempts=5,
            next_attempt_at=NOW,
            active_session_id=31,
            request_origin_ref=None,
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            payload={},
        )


def test_adopt_due_pending_rejects_future_due_row_without_enqueuing():
    connection = _Connection([None])
    jobs = _Jobs()
    repository = _repository(connection, jobs)

    with pytest.raises(ValueError, match="not due or cannot be adopted"):
        repository.adopt_due_pending(
            pending_scrobble_id=53,
            account_id=7,
            library_id=19,
            active_session_id=31,
            request_origin_ref=None,
            deployment_mode="self_hosted_private_web",
            client_surface="worker",
            now=NOW,
        )

    assert jobs.calls == []


def test_accept_next_attempt_advances_from_exact_completed_domain_attempt():
    connection = _Connection(
        [
            {
                "pending_scrobble_id": 53,
                "row_revision": 8,
                "accepted_attempt": 3,
                "current_job_id": None,
            },
            {"linked": True},
        ]
    )
    jobs = _Jobs(job_id=72)
    repository = _repository(connection, jobs)

    accepted = repository.accept_next_attempt(
        pending_scrobble_id=53,
        account_id=7,
        library_id=19,
        active_session_id=31,
        expected_previous_attempts=2,
        request_origin_ref="browser:origin-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        now=NOW,
    )

    assert accepted.accepted_attempt == 3
    assert accepted.job_id == 72
    assert jobs.calls[0][1].idempotency_key == "lastfm-scrobble:53:attempt:3"
    _sql, values = connection.executed[0]
    assert values["expected_previous_attempts"] == 2


def test_list_due_pending_is_bounded_ordered_and_session_scoped():
    connection = _Connection(
        [[
            {
                "pending_scrobble_id": 53,
                "account_id": 7,
                "library_id": 19,
                "active_session_id": 31,
                "previous_attempts": 2,
            }
        ]]
    )
    repository = _repository(connection, _Jobs())

    due = repository.list_due_pending(now=NOW, limit=40)

    assert due[0].pending_scrobble_id == 53
    assert due[0].active_session_id == 31
    sql, values = connection.executed[0]
    assert "order by pending.next_attempt_at nulls first, pending.id" in sql
    assert "pending.current_job_id is null" in sql
    assert "pending.attempt_count < 5" in sql
    assert "orphaned_repair" not in sql
    assert values == {"now": NOW, "limit": 40}


def test_generic_retry_job_never_contains_provider_payload_or_secret():
    connection = _Connection(
        [
            {
                "pending_scrobble_id": 53,
                "row_revision": 4,
                "accepted_attempt": 2,
                "current_job_id": None,
            },
            {"linked": True},
        ]
    )
    jobs = _Jobs()

    _accept(_repository(connection, jobs))

    command = jobs.calls[0][1]
    assert set(command.parameters) == {"active_session_ref"}
    rendered = repr(command).casefold()
    assert "session_key" not in rendered
    assert "artist" not in rendered
    assert "title" not in rendered
    assert "opaque-track-42" not in rendered
