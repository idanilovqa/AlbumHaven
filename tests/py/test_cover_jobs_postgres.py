from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
import json
from pathlib import Path
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

    def fetchall(self):
        return self.row if isinstance(self.row, list) else []


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
    assert jobs.calls == []
    sql = " ".join(statement for statement, _ in connection.executed)
    assert "ops.accept_cover_lookup" in sql
    assert "insert into ops.jobs" not in sql


def test_accept_candidate_lookup_rolls_back_domain_row_when_enqueue_fails():
    class FailingConnection(_Connection):
        def execute(self, sql, parameters=None):
            self.executed.append((" ".join(str(sql).casefold().split()), parameters))
            raise RuntimeError("acceptance unavailable")

    connection = FailingConnection([])
    jobs = _Jobs()

    with pytest.raises(RuntimeError, match="acceptance unavailable"):
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


def test_list_candidate_lookup_tasks_reloads_only_the_authorized_library():
    connection = _Connection(
        [[
            {
                "task_key": "lookup-opaque-42",
                "status": "completed",
                "requested_at": NOW,
                "completed_at": NOW,
                "provider_payload": {
                    "id": "lookup-opaque-42",
                    "status": "completed",
                    "artist": "Artist",
                },
                "metadata": {
                    "source_family": "durable_cover_lookup",
                    "notification_action_taken": False,
                },
            }
        ]]
    )
    repository = _repository(connection, _Jobs())

    tasks = repository.list_candidate_lookup_tasks(
        actor_account_id=7, library_id=19
    )

    assert tasks == [
        {
            "id": "lookup-opaque-42",
            "status": "completed",
            "artist": "Artist",
            "notification_action_taken": False,
            "notification_completed_at": NOW.isoformat(),
            "notification_expires_at": "",
        }
    ]
    sql, parameters = connection.executed[0]
    assert "library_id = %(library_id)s" in sql
    assert "source_family' = any(%(source_families)s::text[])" in sql
    assert parameters["source_families"] == [
        "cover_lookup_notifications",
        "runtime_cover_lookup_notifications_adapter",
        "durable_cover_lookup",
    ]
    assert "notification_cleared" in sql
    assert "membership.account_id = %(actor_account_id)s" in sql
    assert parameters["actor_account_id"] == 7
    assert parameters["library_id"] == 19


def test_candidate_lookup_notification_counts_are_actor_and_library_scoped():
    connection = _Connection(
        [{"total_count": 8, "active_count": 2, "finished_count": 6}]
    )
    repository = _repository(connection, _Jobs())

    counts = repository.count_candidate_lookup_task_notifications(
        actor_account_id=7, library_id=19
    )

    assert counts == {"total_count": 8, "active_count": 2, "finished_count": 6}
    sql, parameters = connection.executed[0]
    assert "library_id = %(library_id)s" in sql
    assert "membership.account_id = %(actor_account_id)s" in sql
    assert "notification_cleared" in sql
    assert parameters["actor_account_id"] == 7
    assert parameters["library_id"] == 19


def test_candidate_lookup_notification_page_is_bounded_scoped_and_cursor_based():
    first = {
        "task_key": "lookup-2",
        "status": "completed",
        "requested_at": NOW,
        "completed_at": NOW,
        "effective_timestamp": NOW,
        "provider_payload": {},
        "metadata": {
            "source_family": "cover_lookup_notifications",
            "source_payload": {"artist": "Legacy Artist"},
        },
    }
    second = {
        **first,
        "task_key": "lookup-1",
        "metadata": {
            "source_family": "durable_cover_lookup",
            "source_payload": {"artist": "Durable Artist"},
        },
    }
    connection = _Connection(
        [
            [first, second],
            {"total_count": 2, "active_count": 0, "finished_count": 2},
        ]
    )
    repository = _repository(connection, _Jobs())

    page = repository.load_candidate_lookup_task_summary_page(
        actor_account_id=7,
        library_id=19,
        limit=1,
        cursor=None,
        active_only=False,
    )

    assert page["items"] == [
        {
            "artist": "Legacy Artist",
            "id": "lookup-2",
            "status": "completed",
            "notification_action_taken": False,
            "notification_completed_at": NOW.isoformat(),
            "notification_expires_at": "",
        }
    ]
    assert page["next_cursor"]
    assert page["counts"] == {
        "total_count": 2,
        "active_count": 0,
        "finished_count": 2,
    }
    sql, parameters = connection.executed[0]
    assert "limit %(page_limit)s" in sql
    assert "membership.account_id = %(actor_account_id)s" in sql
    assert parameters["page_limit"] == 2
    assert parameters["library_id"] == 19

    with pytest.raises(ValueError, match="invalid cover lookup notification cursor"):
        repository.load_candidate_lookup_task_summary_page(
            actor_account_id=7,
            library_id=19,
            limit=1,
            cursor="not-a-cursor",
            active_only=False,
        )


def test_clear_completed_candidate_lookup_tasks_is_terminal_and_library_scoped():
    class CheckpointConnection(_Connection):
        def __init__(self):
            super().__init__([[{"task_key": "lookup-opaque-42"}]])
            self.remote_save_checkpoints = {
                "lookup-opaque-42": "publication_completed"
            }

        def execute(self, sql, parameters=None):
            if "delete from ops.cover_lookup_tasks" in " ".join(
                str(sql).casefold().split()
            ):
                raise RuntimeError("remote-save checkpoint restricts task deletion")
            return super().execute(sql, parameters)

    connection = CheckpointConnection()
    repository = _repository(connection, _Jobs())

    removed = repository.clear_completed_candidate_lookup_tasks(
        actor_account_id=7,
        library_id=19,
        task_keys=["lookup-opaque-42"],
    )

    assert removed == {"lookup-opaque-42"}
    sql, parameters = connection.executed[0]
    assert "update ops.cover_lookup_tasks" in sql
    assert "delete from ops.cover_lookup_tasks" not in sql
    assert "'{notification_cleared}'" in sql
    assert "status = any(%(terminal_statuses)s" in sql
    assert "library_id = %(library_id)s" in sql
    assert "source_family' = any(%(source_families)s::text[])" in sql
    assert "membership.account_id = %(actor_account_id)s" in sql
    assert parameters["task_keys"] == ["lookup-opaque-42"]
    assert connection.remote_save_checkpoints == {
        "lookup-opaque-42": "publication_completed"
    }


def test_mark_candidate_lookup_notification_action_is_terminal_and_library_scoped():
    connection = _Connection(
        [
            {
                "task_key": "lookup-opaque-42",
                "status": "completed",
                "requested_at": NOW,
                "completed_at": NOW,
                "provider_payload": {"id": "lookup-opaque-42"},
                "metadata": {
                    "source_family": "durable_cover_lookup",
                    "notification_action_taken": True,
                },
            }
        ]
    )
    repository = _repository(connection, _Jobs())

    task = repository.mark_candidate_lookup_notification_action_taken(
        actor_account_id=7,
        library_id=19,
        task_key="lookup-opaque-42",
    )

    assert task is not None
    assert task["id"] == "lookup-opaque-42"
    assert task["notification_action_taken"] is True
    sql, parameters = connection.executed[0]
    assert "status = any(%(terminal_statuses)s" in sql
    assert "library_id = %(library_id)s" in sql
    assert "source_family' = any(%(source_families)s::text[])" in sql
    assert "notification_cleared" in sql
    assert "membership.account_id = %(actor_account_id)s" in sql
    assert parameters["actor_account_id"] == 7


def test_claimed_automatic_cover_selection_forwards_explicit_state_and_dimensions():
    connection = _Connection(
        [
            {
                "input_path_count": 1,
                "resolved_path_count": 1,
                "selected_album_count": 1,
                "album_track_file_count": 1,
                "album_rows_updated": 1,
                "track_file_rows_updated": 1,
                "blocked_by_user_selection": False,
                "blocked_by_expected_cover_state": False,
            }
        ]
    )
    repository = _repository(connection, _Jobs())

    repository.persist_claimed_automatic_cover_selection(
        task_id=73,
        library_id=19,
        job_id=88,
        attempt=1,
        worker_id="cover-worker",
        lease_token="cover-lease",
        now=NOW,
        track_paths={"C:/Music/Artist/Album/01.flac"},
        selected_cover_path=Path("C:/Music/Artist/Album/cover.jpg"),
        cover_revision="replacement-revision",
        cover_selection_origin="automatic",
        reject_if_user_controlled=False,
        reject_if_explicit_selection=True,
        expected_cover_state=("user", "legacy-revision"),
        local_cover_width=1200,
        local_cover_height=1200,
    )

    sql, parameters = connection.executed[0]
    assert "%(reject_if_explicit_selection)s" in sql
    assert "%(local_cover_width)s" in sql
    assert "%(local_cover_height)s" in sql
    assert parameters["reject_if_explicit_selection"] is True
    assert parameters["expected_cover_selection_origin"] == "user"
    assert parameters["expected_cover_revision"] == "legacy-revision"
    assert parameters["local_cover_width"] == 1200
    assert parameters["local_cover_height"] == 1200


def test_claimed_provider_outcomes_use_worker_function_without_direct_task_dml():
    connection = _Connection([{"persisted": True}, {"persisted": True}])
    repository = _repository(connection, _Jobs())

    repository.persist_claimed_cover_provider_outcomes(
        task_id=73,
        library_id=19,
        job_id=88,
        attempt=1,
        worker_id="cover-worker",
        lease_token="cover-lease",
        now=NOW,
        album_id=31,
        album_key="artist|album|2001",
        outcomes={
            "musicbrainz": {"category": "no_candidate", "http_status": 200},
            "spotify": {"category": "rate_limit_quota", "http_status": 429},
        },
    )

    assert len(connection.executed) == 2
    assert all(
        "ops.persist_claimed_cover_provider_outcome" in sql
        and "insert into ops.cover_lookup_tasks" not in sql
        for sql, _parameters in connection.executed
    )
    first = connection.executed[0][1]
    second = connection.executed[1][1]
    assert first["task_id"] == 73
    assert first["library_id"] == 19
    assert first["outcome_task_key"] == "31:musicbrainz"
    assert first["outcome_status"] == "completed"
    assert json.loads(first["metadata"])["source_family"] == (
        "automatic_cover_provider_outcomes_v1"
    )
    assert second["outcome_task_key"] == "31:spotify"
    assert second["outcome_status"] == "failed"


def test_persist_candidate_authority_uses_one_atomic_postgres_boundary():
    connection = _Connection(
        [
            {
                "task_id": 73,
                "row_revision": 6,
                "candidate_generation": GENERATION,
            }
        ]
    )
    repository = _repository(connection, _Jobs())
    candidate = {
        "id": "candidate-1",
        "url": "https://images.example/cover.jpg",
        "art_kind": "cover",
    }

    authority = repository.persist_candidate_authority(
        task_key="lookup-opaque-42",
        library_id=19,
        album_key="scan-artist-001|album-001|2001",
        account_id=7,
        request_origin_ref="origin:accepted-42",
        deployment_mode="self_hosted_private_web",
        client_surface="web",
        candidate_generation=GENERATION,
        resource_revision=5,
        recorded_at=NOW,
        task_payload={"possible_matches": [candidate]},
        candidates=[candidate],
        best_candidate_id="candidate-1",
    )

    assert authority["task_id"] == 73
    assert authority["candidate_generation"] == GENERATION
    sql, parameters = connection.executed[0]
    assert "ops.persist_cover_candidate_authority" in sql
    assert "insert into ops.cover_lookup_tasks" not in sql
    assert parameters["candidate_generation"] == GENERATION
    assert connection.commits == 1


@pytest.mark.parametrize(
    ("method_name", "function_name", "extra"),
    [
        (
            "mutate_claimed_lookup_candidate_snapshot",
            "ops.mutate_claimed_cover_lookup_candidate_snapshot",
            {"task_key": "lookup-opaque-42", "task_id": 73},
        ),
        (
            "mutate_claimed_refresh_candidate_snapshot",
            "ops.mutate_claimed_cover_refresh_candidate_snapshot",
            {"task_id": 73},
        ),
    ],
)
def test_claimed_candidate_snapshot_mutations_use_narrow_fenced_functions(
    method_name, function_name, extra
):
    connection = _Connection([{"accepted": True}])
    repository = _repository(connection, _Jobs())

    accepted = getattr(repository, method_name)(
        library_id=19,
        job_id=88,
        attempt=1,
        worker_id="cover-worker-a",
        lease_token="lease-a",
        now=NOW,
        album_id=101,
        candidate_generation=GENERATION,
        operation="publish",
        search_kind="manual" if "lookup" in method_name else "automatic",
        search_started_at=NOW.isoformat(),
        candidates=[
            {
                "id": "candidate-1",
                "url": "https://images.example/cover.jpg",
                "art_kind": "cover",
            }
        ],
        best_candidate_id="candidate-1",
        automatic_improvement=False,
        candidate_id=None,
        **extra,
    )

    assert accepted is True
    sql, parameters = connection.executed[0]
    assert function_name in sql
    assert "local_album_cover_candidate_snapshots" not in sql
    assert parameters["lease_token"] == "lease-a"


def test_begin_claimed_cover_refresh_returns_lease_fenced_separate_release_keys():
    connection = _Connection(
        [
            {
                "task_id": 51,
                "task_key": "post-scan-12",
                "row_revision": 2,
                "file_cache": {},
                "separate_release_keys": ["artist::same title"],
                "progress_total": 0,
                "mode": "post_scan",
                "force_search": False,
            }
        ]
    )
    repository = _repository(connection, _Jobs())

    scope = repository.begin_claimed_cover_refresh(
        task_id=None,
        library_id=19,
        job_id=88,
        attempt=1,
        worker_id="cover-worker-a",
        lease_token="lease-a",
        now=NOW,
        mode="post_scan",
        inventory_revision=5,
        task_key="revision-5",
    )

    assert scope is not None
    assert scope.separate_release_keys == ("artist::same title",)
    sql = connection.executed[0][0]
    assert "ops.begin_claimed_cover_refresh" in sql
