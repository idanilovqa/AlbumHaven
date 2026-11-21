from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from music_app.services.jobs.status import PostgresJobStatusService


NOW = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)
DATABASE_URL = "postgresql://worker-role@localhost/album_haven"


class _Result:
    def __init__(self, row):
        self._row = row

    def fetchone(self):
        return self._row


class _RecordingConnection:
    def __init__(self, rows=()):
        self.rows = list(rows)
        self.executed = []
        self.entries = 0
        self.exits = 0

    def __enter__(self):
        self.entries += 1
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exits += 1

    def execute(self, statement, parameters=None):
        self.executed.append((str(statement), parameters))
        return _Result(self.rows.pop(0) if self.rows else None)


class _Connector:
    def __init__(self, connection):
        self.connection = connection
        self.urls = []

    def __call__(self, database_url):
        self.urls.append(database_url)
        return self.connection


def _service(*rows):
    connection = _RecordingConnection(rows)
    connector = _Connector(connection)
    service = PostgresJobStatusService(
        database_url=DATABASE_URL,
        connect_to_database=connector,
    )
    return service, connector, connection


def _worker_row(**overrides):
    row = {
        "instance_id": "worker-opaque-a",
        "lifecycle_state": "running",
        "last_heartbeat_at": NOW - timedelta(seconds=30),
    }
    row.update(overrides)
    return row


def _aggregate_row(**overrides):
    row = {
        "queued_count": 3,
        "running_count": 2,
        "retry_count": 1,
        "failed_count": 4,
        "ambiguous_count": 1,
        "oldest_queued_at": NOW - timedelta(seconds=120),
        "oldest_claimed_at": NOW - timedelta(seconds=45),
    }
    row.update(overrides)
    return row


def _metrics_row(**overrides):
    row = {
        "claim_latency_seconds": 2.5,
        "run_duration_seconds": 8.25,
        "retry_delay_seconds": 60.0,
        "lease_recovery_count": 3,
        "backlog_by_kind": {
            "full_scan": 2,
            "auth_password_reset_delivery": 1,
        },
        "completion_by_state": {
            "succeeded": 9,
            "failed": 2,
            "canceled": 1,
            "ambiguous": 1,
        },
    }
    row.update(overrides)
    return row


def _normalized(statement):
    return " ".join(statement.casefold().split())


@pytest.mark.parametrize(
    ("heartbeat_age_seconds", "expected"),
    [
        (0, "worker_ready"),
        (90, "worker_ready"),
        (91, "worker_degraded"),
        (300, "worker_degraded"),
        (301, "worker_unavailable"),
    ],
)
def test_public_health_projects_deterministic_heartbeat_thresholds(
    heartbeat_age_seconds,
    expected,
):
    service, connector, connection = _service(
        _worker_row(last_heartbeat_at=NOW - timedelta(seconds=heartbeat_age_seconds))
    )

    assert service.public_health(NOW) == {
        "status": "ok",
        "worker_status": expected,
    }

    assert connector.urls == [DATABASE_URL]
    assert connection.entries == connection.exits == 1
    assert len(connection.executed) == 1


@pytest.mark.parametrize(
    "worker_row",
    [
        None,
        _worker_row(lifecycle_state="stopped"),
        _worker_row(last_heartbeat_at=None),
    ],
)
def test_public_health_treats_missing_stopped_or_unstamped_worker_as_unavailable(worker_row):
    service, _connector, _connection = _service(worker_row)

    assert service.public_health(NOW) == {
        "status": "ok",
        "worker_status": "worker_unavailable",
    }


def test_public_health_clamps_future_heartbeat_age_to_zero():
    service, _connector, _connection = _service(
        _worker_row(last_heartbeat_at=NOW + timedelta(minutes=5))
    )

    assert service.public_health(NOW) == {
        "status": "ok",
        "worker_status": "worker_ready",
    }


@pytest.mark.parametrize("invalid_now", [None, "2026-09-06T12:00:00Z", datetime(2026, 9, 6, 12, 0)])
def test_status_methods_require_timezone_aware_now_before_connecting(invalid_now):
    service, connector, connection = _service(_worker_row(), _aggregate_row())

    with pytest.raises(ValueError, match="timezone-aware"):
        service.public_health(invalid_now)
    with pytest.raises(ValueError, match="timezone-aware"):
        service.operator_status(invalid_now)

    assert connector.urls == []
    assert connection.executed == []


def test_operator_status_uses_only_worker_and_aggregate_job_queries():
    service, connector, connection = _service(
        _worker_row(), _aggregate_row(), _metrics_row()
    )

    assert service.operator_status(NOW) == {
        "worker_status": "worker_ready",
        "worker": {
            "instance_id": "worker-opaque-a",
            "lifecycle_state": "running",
            "heartbeat_age_seconds": 30,
        },
        "jobs": {
            "queued_count": 3,
            "running_count": 2,
            "retry_count": 1,
            "failed_count": 4,
            "ambiguous_count": 1,
            "oldest_queue_age_seconds": 120,
            "claim_lag_seconds": 45,
        },
        "metrics": {
            "claim_latency_seconds": 2.5,
            "run_duration_seconds": 8.25,
            "retry_delay_seconds": 60.0,
            "lease_recovery_count": 3,
            "backlog_by_kind": {
                "auth_password_reset_delivery": 1,
                "full_scan": 2,
            },
            "completion_by_state": {
                "ambiguous": 1,
                "canceled": 1,
                "failed": 2,
                "succeeded": 9,
            },
        },
    }

    assert connector.urls == [DATABASE_URL]
    assert connection.entries == connection.exits == 1
    assert len(connection.executed) == 3
    combined_sql = " ".join(_normalized(statement) for statement, _params in connection.executed)
    assert "ops.worker_instances" in combined_sql
    assert "ops.jobs" in combined_sql
    assert "count(" in combined_sql
    assert "min(" in combined_sql
    for private_field in (
        "subject_ref",
        "parameters",
        "account_id",
        "library_id",
        "raw_path",
        "request_origin_id",
        "idempotency_key",
    ):
        assert private_field not in combined_sql


def test_operator_status_clamps_ages_and_counts_to_bounded_nonnegative_integers():
    service, _connector, _connection = _service(
        _worker_row(last_heartbeat_at=NOW + timedelta(seconds=1)),
        _aggregate_row(
            queued_count=-3,
            running_count=10**30,
            retry_count=None,
            failed_count=-1,
            ambiguous_count=10**30,
            oldest_queued_at=NOW + timedelta(minutes=2),
            oldest_claimed_at=NOW + timedelta(minutes=2),
        ),
        _metrics_row(
            claim_latency_seconds=-2.0,
            run_duration_seconds=10**30,
            retry_delay_seconds=None,
            lease_recovery_count=10**30,
            backlog_by_kind={"full_scan": -1},
            completion_by_state={"succeeded": 10**30},
        ),
    )

    payload = service.operator_status(NOW)

    assert payload["worker"]["heartbeat_age_seconds"] == 0
    assert payload["jobs"]["oldest_queue_age_seconds"] == 0
    assert payload["jobs"]["claim_lag_seconds"] == 0
    for field in (
        "queued_count",
        "running_count",
        "retry_count",
        "failed_count",
        "ambiguous_count",
    ):
        value = payload["jobs"][field]
        assert type(value) is int
        assert 0 <= value <= 2_147_483_647
    assert payload["metrics"] == {
        "claim_latency_seconds": 0.0,
        "run_duration_seconds": 2_147_483_647.0,
        "retry_delay_seconds": 0.0,
        "lease_recovery_count": 2_147_483_647,
        "backlog_by_kind": {"full_scan": 0},
        "completion_by_state": {"succeeded": 2_147_483_647},
    }


def test_operator_metrics_reject_private_or_unbounded_labels_fail_closed():
    service, _connector, _connection = _service(
        _worker_row(),
        _aggregate_row(),
        _metrics_row(backlog_by_kind={"person@example.test": 1}),
    )

    assert service.operator_status(NOW)["metrics"] == {
        "claim_latency_seconds": 0.0,
        "run_duration_seconds": 0.0,
        "retry_delay_seconds": 0.0,
        "lease_recovery_count": 0,
        "backlog_by_kind": {},
        "completion_by_state": {},
    }


class _FailingConnector:
    def __init__(self, message):
        self.message = message

    def __call__(self, _database_url):
        raise RuntimeError(self.message)


def test_database_failure_returns_exact_sanitized_public_and_operator_projections():
    secret = "postgresql://user:password@private-host/album?subject_ref=C:/Music"
    service = PostgresJobStatusService(
        database_url=secret,
        connect_to_database=_FailingConnector(secret),
    )

    public = service.public_health(NOW)
    operator = service.operator_status(NOW)

    assert public == {"status": "ok", "worker_status": "worker_unavailable"}
    assert operator == {
        "worker_status": "worker_unavailable",
        "worker": None,
        "jobs": {
            "queued_count": 0,
            "running_count": 0,
            "retry_count": 0,
            "failed_count": 0,
            "ambiguous_count": 0,
            "oldest_queue_age_seconds": 0,
            "claim_lag_seconds": 0,
        },
        "metrics": {
            "claim_latency_seconds": 0.0,
            "run_duration_seconds": 0.0,
            "retry_delay_seconds": 0.0,
            "lease_recovery_count": 0,
            "backlog_by_kind": {},
            "completion_by_state": {},
        },
    }
    assert secret not in repr(public)
    assert secret not in repr(operator)
