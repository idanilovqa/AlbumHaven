from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.jobs.models import (
    ClaimedJob,
    EnqueueJob,
    JobCancellationDisposition,
    JobCancellationResult,
    JobHeartbeatResult,
    JobStatusSnapshot,
    JobState,
    JobTransitionResult,
    StaleLeaseReconciliationResult,
)
from music_app.services.jobs.repository_postgres import PostgresJobRepository


NOW = datetime(2026, 9, 5, 18, 0, tzinfo=timezone.utc)


class _Result:
    def __init__(self, *, one=None, all_rows=()):
        self._one = one
        self._all = list(all_rows)

    def fetchone(self):
        return self._one

    def fetchall(self):
        return list(self._all)


class _RecordingConnection:
    def __init__(self, results=()):
        self.results = list(results)
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        if exc_type is None:
            self.commits += 1
        else:
            self.rollbacks += 1

    def transaction(self):
        return nullcontext()

    def execute(self, statement, parameters=None):
        self.executed.append((str(statement), parameters))
        if self.results:
            return self.results.pop(0)
        return _Result()


class _Connector:
    def __init__(self, connection):
        self.connection = connection
        self.urls = []

    def __call__(self, database_url):
        self.urls.append(database_url)
        return self.connection


def _command(**overrides):
    values = {
        "kind": "full_scan",
        "subject_kind": "library",
        "subject_ref": "19",
        "parameters": {"mode": "normal"},
        "account_id": 7,
        "library_id": 19,
        "capability_key": "library.refresh",
        "request_origin_ref": "origin:accepted-42",
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "web",
        "idempotency_key": "phase8:full-scan:42",
        "scheduled_at": NOW,
        "max_attempts": 2,
        "priority": 0,
        "scope_version": None,
        "resource_revision": None,
    }
    values.update(overrides)
    return EnqueueJob(**values)


def _claim_row(**overrides):
    row = {
        "job_id": 41,
        "kind": "full_scan",
        "subject_kind": "library",
        "subject_ref": "19",
        "parameters": {"mode": "normal"},
        "account_id": 7,
        "library_id": 19,
        "capability_key": "library.refresh",
        "request_origin_id": 23,
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "web",
        "idempotency_key": "phase8:full-scan:42",
        "attempt": 1,
        "max_attempts": 2,
        "worker_id": "worker-a",
        "lease_token": "opaque-lease-a",
        "lease_expires_at": NOW + timedelta(seconds=300),
        "scheduled_at": NOW,
        "priority": 0,
        "scope_version": None,
        "resource_revision": None,
    }
    row.update(overrides)
    return row


def _repository(connection):
    connector = _Connector(connection)
    repository = PostgresJobRepository(
        database_url="postgresql://jobs-role@localhost/album_haven",
        connect_to_database=connector,
    )
    return repository, connector


def _normalized(statement):
    return " ".join(statement.casefold().split())


def test_claimed_job_orchestration_fields_have_backward_compatible_defaults():
    row = _claim_row()
    row.pop("priority")
    row.pop("scope_version")
    row.pop("resource_revision")

    claim = ClaimedJob(**row)

    assert claim.priority == 0
    assert claim.scope_version is None
    assert claim.resource_revision is None
    assert StaleLeaseReconciliationResult(0, 0, 0).canceled_count == 0


def test_enqueue_validates_before_opening_a_connection():
    connection = _RecordingConnection()
    repository, connector = _repository(connection)

    with pytest.raises(ValueError, match="job kind"):
        repository.enqueue(_command(kind="album_move"))

    assert connector.urls == []


def test_enqueue_inserts_or_returns_existing_identity_in_one_transaction():
    connection = _RecordingConnection(
        [
            _Result(one={"request_origin_id": 23}),
            _Result(one=None),
            _Result(one={"job_id": 41}),
        ]
    )
    repository, connector = _repository(connection)

    assert repository.enqueue(_command()) == 41

    assert connector.urls == ["postgresql://jobs-role@localhost/album_haven"]
    assert connection.commits == 1
    assert len(connection.executed) == 3
    origin_sql = _normalized(connection.executed[0][0])
    insert_sql = _normalized(connection.executed[1][0])
    lookup_sql = _normalized(connection.executed[2][0])
    assert "from app.request_origins" in origin_sql
    assert "insert into ops.jobs" in insert_sql
    assert "on conflict do nothing" in insert_sql
    assert "returning id as job_id" in insert_sql
    assert "request_origin_id" in insert_sql
    for orchestration_field in ("priority", "scope_version", "resource_revision"):
        assert orchestration_field in insert_sql
    assert "select" in lookup_sql and "from ops.jobs" in lookup_sql
    for identity in (
        "kind",
        "account_id",
        "library_id",
        "subject_kind",
        "subject_ref",
        "idempotency_key",
    ):
        assert identity in lookup_sql
    assert "coalesce" in lookup_sql


def test_enqueue_returns_inserted_job_without_fallback_lookup():
    connection = _RecordingConnection(
        [_Result(one={"request_origin_id": 23}), _Result(one={"job_id": 52})]
    )
    repository, _ = _repository(connection)

    assert repository.enqueue(_command()) == 52
    assert len(connection.executed) == 2


def test_enqueue_rejects_conflict_identity_that_cannot_be_reloaded():
    connection = _RecordingConnection(
        [_Result(one={"request_origin_id": 23}), _Result(one=None), _Result(one=None)]
    )
    repository, _ = _repository(connection)

    with pytest.raises(RuntimeError, match="idempotent|enqueue"):
        repository.enqueue(_command())


def test_invalid_origin_cannot_recover_an_existing_idempotent_job():
    connection = _RecordingConnection([_Result(one=None)])
    repository, _ = _repository(connection)

    with pytest.raises(ValueError, match="origin"):
        repository.enqueue(_command(request_origin_ref="origin:revoked"))


def test_enqueue_splits_origin_at_first_colon_and_compares_exact_columns():
    connection = _RecordingConnection(
        [_Result(one={"request_origin_id": 23}), _Result(one={"job_id": 41})]
    )
    repository, _ = _repository(connection)

    repository.enqueue(_command(request_origin_ref="browser:device:stable-key"))

    sql, parameters = connection.executed[0]
    normalized = _normalized(sql)
    assert "concat(" not in normalized
    assert "origin_type = %(request_origin_type)s" in normalized
    assert "origin_key = %(request_origin_key)s" in normalized
    assert parameters["request_origin_type"] == "browser"
    assert parameters["request_origin_key"] == "device:stable-key"


@pytest.mark.parametrize("request_origin_ref", ["origin", "origin:"])
def test_enqueue_rejects_malformed_structured_origin_before_connecting(
    request_origin_ref,
):
    repository, connector = _repository(_RecordingConnection())

    with pytest.raises(ValueError, match="origin"):
        repository.enqueue(_command(request_origin_ref=request_origin_ref))
    assert connector.urls == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"priority": 32768},
        {"priority": -32769},
        {"scope_version": -1},
        {"resource_revision": -1},
        {"account_id": 9_223_372_036_854_775_808},
        {"library_id": 9_223_372_036_854_775_808},
        {"scope_version": 9_223_372_036_854_775_808},
        {"resource_revision": 9_223_372_036_854_775_808},
    ],
)
def test_enqueue_validates_orchestration_fields_before_connecting(overrides):
    connection = _RecordingConnection()
    repository, connector = _repository(connection)

    with pytest.raises(ValueError, match="priority|scope|revision|account|library|id"):
        repository.enqueue(_command(**overrides))
    assert connector.urls == []


def test_claim_uses_one_nonblocking_atomic_statement_and_returns_typed_job():
    connection = _RecordingConnection([_Result(one=_claim_row())])
    repository, _ = _repository(connection)

    claimed = repository.claim(worker_id="worker-a", now=NOW, lease_seconds=300)

    assert claimed == ClaimedJob(**_claim_row())
    assert connection.commits == 1
    assert len(connection.executed) == 1
    sql = _normalized(connection.executed[0][0])
    assert "for update skip locked" in sql
    assert "update ops.jobs" in sql
    assert "insert into ops.job_transitions" in sql
    assert "returning" in sql
    assert "state in ('queued', 'retry_wait')" in sql
    assert "scheduled_at <=" in sql
    assert "cancel_requested_at is null" in sql
    assert "attempt_count < max_attempts" in sql
    assert "order by priority desc, scheduled_at, id" in sql
    assert "attempt_count =" in sql and "+ 1" in sql
    assert "lease_owner" in sql and "lease_token" in sql
    assert "lease_expires_at" in sql and "heartbeat_at" in sql


def test_claim_returns_none_when_no_work_is_runnable():
    connection = _RecordingConnection([_Result(one=None)])
    repository, _ = _repository(connection)

    assert repository.claim(worker_id="worker-a", now=NOW, lease_seconds=300) is None
    assert connection.commits == 1


def test_claim_rejects_invalid_worker_or_lease_before_connecting():
    connection = _RecordingConnection()
    repository, connector = _repository(connection)

    with pytest.raises(ValueError, match="worker"):
        repository.claim(worker_id="", now=NOW, lease_seconds=300)
    with pytest.raises(ValueError, match="lease"):
        repository.claim(worker_id="worker-a", now=NOW, lease_seconds=0)
    assert connector.urls == []


def test_heartbeat_uses_full_unexpired_lease_compare_and_set():
    connection = _RecordingConnection(
        [_Result(one={"job_id": 41, "cancel_requested": True})]
    )
    repository, _ = _repository(connection)
    claim = ClaimedJob(**_claim_row())

    assert repository.heartbeat(claim, now=NOW, lease_seconds=300) == (
        JobHeartbeatResult(active=True, cancel_requested=True)
    )
    sql = _normalized(connection.executed[0][0])
    for fragment in (
        "id =",
        "state = 'running'",
        "attempt_count =",
        "lease_token =",
        "lease_owner =",
        "lease_expires_at >",
    ):
        assert fragment in sql
    assert "heartbeat_at" in sql and "lease_expires_at" in sql
    assert "returning id as job_id" in sql
    assert "cancel_requested_at is not null as cancel_requested" in sql


def test_heartbeat_reports_lost_lease_without_mutating_a_different_attempt():
    connection = _RecordingConnection([_Result(one=None)])
    repository, _ = _repository(connection)

    assert repository.heartbeat(
        ClaimedJob(**_claim_row()), now=NOW, lease_seconds=300
    ) == JobHeartbeatResult(active=False, cancel_requested=False)
    assert connection.commits == 1


def test_cancel_queued_or_retry_work_uses_narrow_function_and_transitions_once():
    connection = _RecordingConnection(
        [
            _Result(
                one={
                    "job_id": 41,
                    "prior_state": "queued",
                    "next_state": "canceled",
                    "reason_code": "immediate_canceled",
                    "transition_recorded": True,
                }
            )
        ]
    )
    repository, _ = _repository(connection)

    assert repository.request_cancel(41, actor_account_id=7, now=NOW) == (
        JobCancellationResult(
            job_id=41,
            disposition=JobCancellationDisposition.IMMEDIATE_CANCELED,
        )
    )
    sql = _normalized(connection.executed[0][0])
    assert "ops.request_job_cancellation" in sql
    assert "update ops.jobs" not in sql
    assert len(connection.executed) == 1


def test_cancel_running_work_records_metadata_without_running_transition():
    connection = _RecordingConnection(
        [
            _Result(
                one={
                    "job_id": 41,
                    "prior_state": "running",
                    "next_state": "running",
                    "reason_code": "running_requested",
                    "transition_recorded": False,
                }
            )
        ]
    )
    repository, _ = _repository(connection)

    assert repository.request_cancel(41, actor_account_id=7, now=NOW) == (
        JobCancellationResult(
            job_id=41,
            disposition=JobCancellationDisposition.RUNNING_REQUESTED,
        )
    )
    sql = _normalized(connection.executed[0][0])
    assert "ops.request_job_cancellation" in sql
    assert "insert into ops.job_transitions" not in sql
    assert "'running', 'running'" not in sql


def test_cancel_returns_false_for_missing_or_terminal_job():
    connection = _RecordingConnection(
        [
            _Result(
                one={
                    "job_id": 404,
                    "prior_state": None,
                    "next_state": None,
                    "reason_code": "noop",
                    "transition_recorded": False,
                }
            )
        ]
    )
    repository, _ = _repository(connection)

    assert repository.request_cancel(404, actor_account_id=7, now=NOW) == (
        JobCancellationResult(
            job_id=404,
            disposition=JobCancellationDisposition.NOOP,
        )
    )


@pytest.mark.parametrize(
    ("job_id", "actor_account_id"),
    [
        (9_223_372_036_854_775_808, 7),
        (41, 9_223_372_036_854_775_808),
    ],
)
def test_cancel_rejects_oversized_ids_before_connecting(job_id, actor_account_id):
    repository, connector = _repository(_RecordingConnection())

    with pytest.raises(ValueError, match="job|actor|id"):
        repository.request_cancel(
            job_id, actor_account_id=actor_account_id, now=NOW
        )
    assert connector.urls == []


@pytest.mark.parametrize(
    "row",
    [
        {"job_id": 99, "prior_state": "queued", "next_state": "canceled", "reason_code": "canceled", "transition_recorded": True},
        {"job_id": 41, "prior_state": "running", "next_state": "running", "reason_code": "canceled", "transition_recorded": False},
        {"job_id": 41, "prior_state": "queued", "next_state": "canceled", "reason_code": "canceled", "transition_recorded": False},
    ],
)
def test_cancel_rejects_incoherent_function_rows(row):
    repository, _ = _repository(_RecordingConnection([_Result(one=row)]))

    with pytest.raises(RuntimeError, match="cancellation.*result|coherence"):
        repository.request_cancel(41, actor_account_id=7, now=NOW)


@pytest.mark.parametrize(
    ("outcome", "state_fragment", "retry_fragment"),
    [
        (
            JobTransitionResult(JobState.SUCCEEDED, "completed"),
            "'succeeded'",
            "'none'",
        ),
        (
            JobTransitionResult(
                JobState.RETRY_WAIT,
                "provider_unavailable",
                scheduled_at=NOW + timedelta(seconds=30),
            ),
            "'retry_wait'",
            "'scheduled'",
        ),
        (
            JobTransitionResult(JobState.AMBIGUOUS, "uncertain_side_effect"),
            "'ambiguous'",
            "'none'",
        ),
        (
            JobTransitionResult(JobState.CANCELED, "owner_request"),
            "'canceled'",
            "'none'",
        ),
    ],
)
def test_finish_uses_full_lease_cas_and_appends_transition(
    outcome, state_fragment, retry_fragment
):
    connection = _RecordingConnection([_Result(one={"job_id": 41})])
    repository, _ = _repository(connection)

    assert repository.finish(ClaimedJob(**_claim_row()), outcome, now=NOW) is True
    sql = _normalized(connection.executed[0][0])
    for fragment in (
        "id =",
        "state = 'running'",
        "attempt_count =",
        "lease_token =",
        "lease_owner =",
        "lease_expires_at >",
    ):
        assert fragment in sql
    assert state_fragment in sql
    assert retry_fragment in sql
    assert "lease_owner = null" in sql
    assert "lease_token = null" in sql
    assert "lease_expires_at = null" in sql
    assert "heartbeat_at = null" in sql
    assert "insert into ops.job_transitions" in sql


def test_finish_reports_lease_loss_and_rejects_illegal_outcomes():
    connection = _RecordingConnection([_Result(one=None)])
    repository, _ = _repository(connection)
    claim = ClaimedJob(**_claim_row())

    assert repository.finish(
        claim, JobTransitionResult(JobState.FAILED, "handler_failed"), now=NOW
    ) is False
    with pytest.raises(ValueError, match="outcome|state"):
        repository.finish(
            claim, JobTransitionResult(JobState.RUNNING, "still_running"), now=NOW
        )


@pytest.mark.parametrize(
    "reason_code",
    [
        r"C:\Music\private.flac",
        "member@example.test",
        "token=secret-value",
        "password=hunter2",
        "not a closed code",
    ],
)
def test_finish_rejects_unredacted_or_noncanonical_reason_before_connecting(
    reason_code,
):
    repository, connector = _repository(_RecordingConnection())

    with pytest.raises(ValueError, match="reason"):
        repository.finish(
            ClaimedJob(**_claim_row()),
            JobTransitionResult(JobState.FAILED, reason_code),
            now=NOW,
        )
    assert connector.urls == []


def test_retry_finish_requires_a_due_time_and_remaining_attempt():
    repository, _ = _repository(_RecordingConnection())

    with pytest.raises(ValueError, match="scheduled|retry"):
        repository.finish(
            ClaimedJob(**_claim_row()),
            JobTransitionResult(JobState.RETRY_WAIT, "retry"),
            now=NOW,
        )
    with pytest.raises(ValueError, match="attempt|retry"):
        repository.finish(
            ClaimedJob(**_claim_row(attempt=2)),
            JobTransitionResult(
                JobState.RETRY_WAIT,
                "retry",
                scheduled_at=NOW + timedelta(seconds=30),
            ),
            now=NOW,
        )


def test_stale_reconciliation_is_bounded_locked_and_registry_driven():
    rows = [{"retried_count": 1, "failed_count": 1, "ambiguous_count": 1, "canceled_count": 1}]
    connection = _RecordingConnection([_Result(one=rows[0])])
    repository, _ = _repository(connection)

    assert repository.reconcile_stale_leases(now=NOW, limit=25) == (
        StaleLeaseReconciliationResult(
            retried_count=1,
            failed_count=1,
            ambiguous_count=1,
            canceled_count=1,
        )
    )
    sql = _normalized(connection.executed[0][0])
    assert "for update skip locked" in sql
    assert "state = 'running'" in sql
    assert "lease_expires_at <=" in sql
    assert "order by lease_expires_at, id" in sql
    assert "limit" in sql
    assert "recovery_policy = 'retry_safe'" in sql
    assert "attempt_count < max_attempts" in sql
    assert "'retry_wait'" in sql and "'ambiguous'" in sql
    assert "cancel_requested_at is not null" in sql
    assert "then 'canceled'" in sql
    assert "recovery_policy = 'ambiguous_on_stale_lease'" in sql
    assert "insert into ops.job_transitions" in sql
    assert "as canceled_count" in sql


def test_stale_reconciliation_rejects_unbounded_limits():
    repository, _ = _repository(_RecordingConnection())

    for limit in (0, 1001):
        with pytest.raises(ValueError, match="limit"):
            repository.reconcile_stale_leases(now=NOW, limit=limit)


def test_status_returns_only_bounded_aggregate_operational_values():
    status_row = {
        "queued_count": 3,
        "running_count": 1,
        "retry_wait_count": 2,
        "failed_count": 4,
        "ambiguous_count": 1,
        "oldest_runnable_at": NOW - timedelta(seconds=12),
        "latest_worker_heartbeat_at": NOW - timedelta(seconds=2),
    }
    connection = _RecordingConnection([_Result(one=status_row)])
    repository, _ = _repository(connection)

    assert repository.status(now=NOW) == JobStatusSnapshot(**status_row)
    sql = _normalized(connection.executed[0][0])
    assert "count(*) filter" in sql
    assert "from ops.jobs" in sql
    assert "ops.worker_instances" in sql
    assert "subject_ref" not in sql
    assert "parameters" not in sql
    assert "account_id" not in sql
    assert "library_id" not in sql


def test_repository_requires_a_database_url_before_connecting():
    repository = PostgresJobRepository(
        database_url="", connect_to_database=lambda _url: None
    )

    with pytest.raises(RuntimeError, match="database url|database_url"):
        repository.claim(worker_id="worker-a", now=NOW, lease_seconds=300)
