from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
from uuid import UUID

import pytest

from music_app.services.cover_jobs_postgres import PostgresCoverJobRepository


NOW = datetime(2026, 9, 6, 18, 0, tzinfo=timezone.utc)
GENERATION = UUID("7fd1c5cc-6e48-41a1-8174-65bcb75d094e")


class _Result:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


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
    def __init__(self, *, job_id=88, failure=None):
        self.job_id = job_id
        self.failure = failure
        self.calls = []

    def enqueue_in_transaction(self, connection, command):
        self.calls.append((connection, command))
        if self.failure:
            raise self.failure
        return self.job_id


def _repository(connection, jobs):
    return PostgresCoverJobRepository(
        database_url="postgresql://app@localhost/album_haven",
        connect_to_database=lambda _url: connection,
        job_repository=jobs,
    )


def _accept(repository):
    return repository.accept_candidate_lookup(
        task_key="lookup-opaque-42",
        library_id=19,
        album_key="scan-artist-001|album-001|2001",
        account_id=7,
        request_origin_ref="origin:accepted-42",
        deployment_mode="self_hosted_private_web",
        client_surface="web",
        candidate_generation=GENERATION,
        resource_revision=5,
        scheduled_at=NOW,
    )


def test_accept_candidate_lookup_resolves_scope_and_enqueues_atomically():
    connection = _Connection(
        [
            {
                "local_album_id": 31,
                "library_root_id": 44,
                "candidate_generation": GENERATION,
                "candidate_revision": 5,
            },
            {"task_id": 73, "row_revision": 0},
            {"task_id": 73, "row_revision": 1, "job_id": 88},
        ]
    )
    jobs = _Jobs()

    accepted = _accept(_repository(connection, jobs))

    assert accepted.task_key == "lookup-opaque-42"
    assert accepted.task_id == 73
    assert accepted.job_id == 88
    assert accepted.row_revision == 1
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert len(jobs.calls) == 1
    command = jobs.calls[0][1]
    assert command.kind == "cover_lookup"
    assert command.subject_kind == "cover_lookup_task"
    assert command.subject_ref == "lookup-opaque-42"
    assert command.parameters == {"task_id": 73}
    assert command.account_id == 7
    assert command.library_id == 19
    assert command.capability_key == "library.covers.lookup"
    assert command.request_origin_ref == "origin:accepted-42"
    assert command.resource_revision == 5
    assert "path" not in repr(command).casefold()
    sql = " ".join(statement for statement, _ in connection.executed)
    assert "library.local_albums" in sql
    assert "library.local_track_files" in sql
    assert "library.library_roots" in sql
    assert "is_active is true" in sql
    assert "insert into ops.cover_lookup_tasks" in sql
    assert "update ops.cover_lookup_tasks" in sql


def test_accept_candidate_lookup_rolls_back_domain_row_when_enqueue_fails():
    connection = _Connection(
        [
            {
                "local_album_id": 31,
                "library_root_id": 44,
                "candidate_generation": GENERATION,
                "candidate_revision": 5,
            },
            {"task_id": 73, "row_revision": 0},
        ]
    )
    jobs = _Jobs(failure=RuntimeError("enqueue unavailable"))

    with pytest.raises(RuntimeError, match="enqueue unavailable"):
        _accept(_repository(connection, jobs))

    assert connection.commits == 0
    assert connection.rollbacks == 1


def test_get_task_is_scoped_by_library_and_task_identity():
    connection = _Connection(
        [
            {
                "id": 73,
                "task_key": "lookup-opaque-42",
                "library_id": 19,
                "status": "running",
                "row_revision": 4,
                "provider_payload": {"possible_matches": []},
                "metadata": {"source_payload": {"id": "lookup-opaque-42"}},
            }
        ]
    )
    repository = _repository(connection, _Jobs())

    task = repository.get_task(task_key="lookup-opaque-42", library_id=19)

    assert task["id"] == 73
    assert task["task_key"] == "lookup-opaque-42"
    assert task["row_revision"] == 4
    sql, parameters = connection.executed[0]
    assert "where library_id = %(library_id)s" in sql
    assert "and task_key = %(task_key)s" in sql
    assert parameters == {"library_id": 19, "task_key": "lookup-opaque-42"}
