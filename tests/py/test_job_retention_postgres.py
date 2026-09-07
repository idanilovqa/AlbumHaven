from datetime import datetime, timedelta, timezone
import re

import pytest

from music_app.services.jobs.retention_postgres import PostgresJobRetentionService
from music_app.services.jobs.retention_postgres import _DELETE_TOMBSTONES


NOW = datetime(2026, 9, 5, 18, 30, tzinfo=timezone.utc)
DATABASE_URL = "postgresql://jobs-retention@localhost/album_haven"


def test_tombstone_candidates_skip_restrictive_domain_evidence_before_limit():
    normalized = " ".join(_DELETE_TOMBSTONES.lower().split())

    for relation in (
        "library.full_scan_intents",
        "library.targeted_reconciliation_intents",
        "ops.cover_remote_save_checkpoints",
    ):
        assert f"not exists ( select 1 from {relation}" in normalized
    assert normalized.index("not exists") < normalized.index("order by")
    assert normalized.index("order by") < normalized.index("limit %s")


class Result:
    def __init__(self, count):
        self.rowcount = count
        self._count = count

    def fetchone(self):
        return (self._count,)

    def fetchall(self):
        return [(self._count,)]


class Transaction:
    def __init__(self, connection):
        self._connection = connection

    def __enter__(self):
        self._connection.transaction_enters += 1
        return self

    def __exit__(self, *_args):
        self._connection.transaction_exits += 1
        return False


class Connection:
    def __init__(self, counts=(2, 3, 5, 7), *, failure=None):
        self._counts = iter(counts)
        self._failure = failure
        self.operations = []
        self.connection_enters = 0
        self.connection_exits = 0
        self.transaction_calls = 0
        self.transaction_enters = 0
        self.transaction_exits = 0

    def __enter__(self):
        self.connection_enters += 1
        return self

    def __exit__(self, *_args):
        self.connection_exits += 1
        return False

    def transaction(self):
        self.transaction_calls += 1
        return Transaction(self)

    def execute(self, sql, params):
        self.operations.append((_normalized_sql(sql), params))
        if self._failure is not None:
            raise self._failure
        return Result(next(self._counts))


def _normalized_sql(sql):
    return " ".join(str(sql).lower().split())


def _service(connection, connected_urls=None):
    connected_urls = connected_urls if connected_urls is not None else []

    def connect(database_url):
        connected_urls.append(database_url)
        return connection

    return PostgresJobRetentionService(
        database_url=DATABASE_URL,
        connect_to_database=connect,
    )


@pytest.mark.parametrize("batch_size", [0, -1, True, 10_001, 100.0, "100"])
def test_cleanup_rejects_invalid_batch_size_before_connecting(batch_size):
    connected_urls = []
    service = _service(Connection(), connected_urls)

    with pytest.raises(ValueError, match="batch size"):
        service.cleanup(batch_size=batch_size, now=NOW)

    assert connected_urls == []


@pytest.mark.parametrize(
    "now",
    [
        datetime(2026, 9, 5, 18, 30),
        "2026-09-05T18:30:00Z",
        None,
    ],
)
def test_cleanup_requires_an_aware_datetime_before_connecting(now):
    connected_urls = []
    service = _service(Connection(), connected_urls)

    with pytest.raises(ValueError, match="timestamp"):
        service.cleanup(batch_size=100, now=now)

    assert connected_urls == []


@pytest.mark.parametrize("batch_size", [1, 10_000])
def test_cleanup_accepts_inclusive_batch_bounds_in_one_connection_and_transaction(
    batch_size,
):
    connection = Connection()
    connected_urls = []

    result = _service(connection, connected_urls).cleanup(
        batch_size=batch_size,
        now=NOW,
    )

    assert result == {
        "transitions": 2,
        "compacted_jobs": 3,
        "tombstones": 5,
        "worker_instances": 7,
    }
    assert connected_urls == [DATABASE_URL]
    assert connection.connection_enters == 1
    assert connection.connection_exits == 1
    assert connection.transaction_calls == 1
    assert connection.transaction_enters == 1
    assert connection.transaction_exits == 1
    assert len(connection.operations) == 4


def test_cleanup_uses_four_ordered_bounded_skip_locked_ctes_with_exact_cutoffs():
    batch_size = 250
    connection = Connection()

    _service(connection).cleanup(batch_size=batch_size, now=NOW)

    transitions, compacted_jobs, tombstones, worker_instances = connection.operations

    assert transitions[1] == (NOW - timedelta(days=90), batch_size)
    assert compacted_jobs[1] == (
        NOW - timedelta(days=90),
        batch_size,
        NOW,
    )
    assert tombstones[1] == (NOW - timedelta(days=365), batch_size)
    assert worker_instances[1] == (NOW - timedelta(days=7), batch_size)

    for sql, _params in connection.operations:
        assert sql.startswith("with ")
        assert "limit %s" in sql
        assert "for update" in sql
        assert "skip locked" in sql

    transitions_sql = transitions[0]
    assert "delete from ops.job_transitions" in transitions_sql
    assert "order by" in transitions_sql
    assert re.search(r"order by [a-z_.]*transitioned_at, [a-z_.]*id", transitions_sql)

    compacted_jobs_sql = compacted_jobs[0]
    assert "update ops.jobs" in compacted_jobs_sql
    assert re.search(r"order by [a-z_.]*completed_at, [a-z_.]*id", compacted_jobs_sql)

    tombstones_sql = tombstones[0]
    assert "delete from ops.jobs" in tombstones_sql
    assert re.search(r"order by [a-z_.]*tombstoned_at, [a-z_.]*id", tombstones_sql)

    workers_sql = worker_instances[0]
    assert "delete from ops.worker_instances" in workers_sql
    assert re.search(
        r"order by [a-z_.]*last_heartbeat_at, [a-z_.]*instance_id",
        workers_sql,
    )


def test_cleanup_limits_job_retention_to_non_held_unambiguous_terminal_jobs():
    connection = Connection()

    _service(connection).cleanup(batch_size=100, now=NOW)

    for sql, _params in connection.operations[:3]:
        assert re.search(
            r"state in \('succeeded', 'failed', 'canceled'\)",
            sql,
        )
        assert re.search(r"audit_hold\s*=\s*false", sql)
        assert "'ambiguous'" not in sql
        assert "'queued'" not in sql
        assert "'running'" not in sql
        assert "'retry_wait'" not in sql

    compacted_jobs_sql = connection.operations[1][0]
    tombstones_sql = connection.operations[2][0]
    assert re.search(r"tombstoned_at\s+is\s+null", compacted_jobs_sql)
    assert re.search(r"tombstoned_at\s+is\s+not\s+null", tombstones_sql)


def test_compaction_clears_details_without_rewriting_job_identity():
    connection = Connection()

    _service(connection).cleanup(batch_size=100, now=NOW)

    sql = connection.operations[1][0]
    set_clause = sql[sql.index(" set ") : sql.index(" from ", sql.index(" set "))]
    assert re.search(r"parameters\s*=\s*'\{\}'::jsonb", set_clause)
    assert re.search(r"request_origin_id\s*=\s*null", set_clause)
    assert re.search(r"cancel_requested_at\s*=\s*null", set_clause)
    assert re.search(r"cancel_requested_by_account_id\s*=\s*null", set_clause)
    assert re.search(r"cancel_reason_code\s*=\s*null", set_clause)
    assert re.search(r"tombstoned_at\s*=\s*%s", set_clause)

    for identity_column in (
        "id",
        "kind",
        "state",
        "subject_kind",
        "subject_ref",
        "account_id",
        "library_id",
        "deployment_mode",
        "client_surface",
        "idempotency_key",
        "created_at",
        "completed_at",
    ):
        assert not re.search(rf"\b{identity_column}\s*=", set_clause)


def test_worker_cleanup_requires_stopped_state_and_excludes_active_job_leases():
    connection = Connection()

    _service(connection).cleanup(batch_size=100, now=NOW)

    sql = connection.operations[3][0]
    assert re.search(r"lifecycle_state\s*=\s*'stopped'", sql)
    assert "not exists" in sql
    assert "from ops.jobs" in sql
    assert re.search(r"state\s*=\s*'running'", sql)
    assert re.search(r"lease_owner\s*=\s*[a-z_.]*instance_id", sql)


def test_cleanup_redacts_database_failures():
    secret = "postgresql://user:private-password@private-host/jobs"
    connection = Connection(failure=RuntimeError(secret))
    service = PostgresJobRetentionService(
        database_url=secret,
        connect_to_database=lambda _database_url: connection,
    )

    with pytest.raises(RuntimeError, match="Job retention cleanup failed") as raised:
        service.cleanup(batch_size=100, now=NOW)

    assert "private-password" not in str(raised.value)
    assert "private-host" not in str(raised.value)
