from __future__ import annotations

import json
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path

import pytest

from music_app.services.library_event_coordinator import (
    TargetedMove,
    TargetedReconciliationRequest,
)


NOW = datetime(2026, 9, 6, 18, 0, tzinfo=timezone.utc)


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
        self.executed.append((str(statement), parameters or {}))
        if self.results:
            result = self.results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result
        return _Result()


class _Connector:
    def __init__(self, connection):
        self.connection = connection
        self.urls = []

    def __call__(self, database_url):
        self.urls.append(database_url)
        return self.connection


class _JobRepository:
    def __init__(self, *, job_id=901, error=None):
        self.job_id = job_id
        self.error = error
        self.calls = []
        self.sql_seen_at_enqueue = []

    def enqueue_in_transaction(self, connection, command):
        self.calls.append((connection, command))
        self.sql_seen_at_enqueue.append(
            tuple(_normalized(statement) for statement, _ in connection.executed)
        )
        if self.error is not None:
            raise self.error
        return self.job_id


def _repository(connection, *, jobs=None):
    from music_app.services.scan_jobs_postgres import PostgresScanJobRepository

    connector = _Connector(connection)
    jobs = jobs or _JobRepository()
    repository = PostgresScanJobRepository(
        database_url="postgresql://app-role@localhost/album_haven",
        connect_to_database=connector,
        job_repository=jobs,
    )
    return repository, connector, jobs


def _normalized(statement):
    return " ".join(statement.casefold().split())


def _root_row(logical_root_id, root_id, *, library_id=19, is_active=True):
    return {
        "logical_root_id": logical_root_id,
        "root_id": root_id,
        "library_id": library_id,
        "is_active": is_active,
    }


def _targeted_request():
    return TargetedReconciliationRequest(
        root_id="root-a",
        paths=frozenset(
            {
                Path("C:/Music/Zulu/02.flac"),
                Path("C:/Music/Alpha/01.flac"),
            }
        ),
        deleted_paths=frozenset({Path("C:/Music/Old/03.flac")}),
        deleted_subtrees=frozenset({Path("C:/Music/Gone")}),
        moves=(
            TargetedMove(
                source=Path("C:/Music/Old Album"),
                destination=Path("D:/Music/New Album"),
                source_root_id="root-a",
                destination_root_id="root-b",
                is_directory=True,
            ),
            TargetedMove(
                source=Path("C:/Music/Alpha/04.flac"),
                destination=Path("C:/Music/Alpha/05.flac"),
                source_root_id="root-a",
                destination_root_id="root-a",
                is_directory=False,
            ),
        ),
    )


def test_full_scan_domain_record_is_created_before_path_free_job_in_one_transaction():
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 71}),
            _Result(one={"intent_id": 71}),
        ]
    )
    repository, connector, jobs = _repository(connection)

    result = repository.enqueue_full_scan(
        library_id=19,
        account_id=7,
        capability_key="library.refresh",
        request_origin_ref="origin:refresh-42",
        deployment_mode="self_hosted_private_web",
        client_surface="web",
        root_ids=("root-a", "root-b"),
        mode="normal",
        force=True,
        scheduled_at=NOW,
    )

    assert result.intent_id == 71
    assert result.job_id == 901
    assert connector.urls == ["postgresql://app-role@localhost/album_haven"]
    assert connection.commits == 1
    assert connection.rollbacks == 0
    assert len(jobs.calls) == 1
    assert jobs.calls[0][0] is connection
    assert any(
        "create_full_scan_intent" in sql
        for sql in jobs.sql_seen_at_enqueue[0]
    )
    assert not any(
        "link_scan_intent_job" in sql
        for sql in jobs.sql_seen_at_enqueue[0]
    )
    create_index = next(
        index
        for index, (sql, _) in enumerate(connection.executed)
        if "create_full_scan_intent" in _normalized(sql)
    )
    link_index = next(
        index
        for index, (sql, _) in enumerate(connection.executed)
        if "link_scan_intent_job" in _normalized(sql)
    )
    assert create_index < link_index

    command = jobs.calls[0][1]
    assert command.subject_kind == "full_scan_intent"
    assert command.subject_ref == "71"
    assert command.parameters == {"intent_id": 71}
    assert command.library_id == 19
    assert command.account_id == 7
    assert command.capability_key == "library.refresh"
    assert command.request_origin_ref == "origin:refresh-42"
    assert command.idempotency_key == "full-scan-intent:71"


def test_targeted_intent_preserves_exact_ordered_paths_and_moves_before_enqueue():
    request = _targeted_request()
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84}),
            _Result(one={"intent_id": 84}),
        ]
    )
    repository, _, jobs = _repository(connection)

    result = repository.enqueue_targeted_reconciliation(
        library_id=19,
        request=request,
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=NOW,
    )

    assert result.intent_id == 84
    assert result.job_id == 901
    assert connection.commits == 1
    create_sql, values = next(
        (sql, values)
        for sql, values in connection.executed
        if "create_targeted_reconciliation_intent" in _normalized(sql)
    )
    assert "select" in _normalized(create_sql)
    assert values["active_paths"] == [
        str(Path("C:/Music/Alpha/01.flac")),
        str(Path("C:/Music/Zulu/02.flac")),
    ]
    assert values["deleted_paths"] == [str(Path("C:/Music/Old/03.flac"))]
    assert values["deleted_subtrees"] == [str(Path("C:/Music/Gone"))]
    assert values["primary_root_id"] == 31
    assert json.loads(values["moves_json"]) == [
        {
            "destination_path": str(Path("D:/Music/New Album")),
            "destination_root_id": 32,
            "is_directory": True,
            "ordinal": 0,
            "source_path": str(Path("C:/Music/Old Album")),
            "source_root_id": 31,
        },
        {
            "destination_path": str(Path("C:/Music/Alpha/05.flac")),
            "destination_root_id": 31,
            "is_directory": False,
            "ordinal": 1,
            "source_path": str(Path("C:/Music/Alpha/04.flac")),
            "source_root_id": 31,
        },
    ]


def test_targeted_generic_job_contains_only_stable_intent_identity_not_paths():
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84}),
            _Result(one={"intent_id": 84}),
        ]
    )
    repository, _, jobs = _repository(connection)

    repository.enqueue_targeted_reconciliation(
        library_id=19,
        request=_targeted_request(),
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=NOW,
    )

    command = jobs.calls[0][1]
    assert command.subject_kind == "targeted_reconciliation_intent"
    assert command.subject_ref == "84"
    assert command.parameters == {"intent_id": 84}
    assert command.idempotency_key.startswith("targeted-reconciliation-request:")
    assert command.idempotency_key != "targeted-reconciliation-intent:84"
    assert command.account_id is None
    assert command.capability_key is None
    assert command.request_origin_ref is None
    serialized_identity = json.dumps(
        {
            "subject_kind": command.subject_kind,
            "subject_ref": command.subject_ref,
            "parameters": command.parameters,
            "idempotency_key": command.idempotency_key,
        },
        sort_keys=True,
    )
    assert "Music" not in serialized_identity
    assert ".flac" not in serialized_identity


def test_job_enqueue_failure_rolls_back_targeted_domain_record():
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84}),
        ]
    )
    jobs = _JobRepository(error=RuntimeError("database write failed"))
    repository, _, _ = _repository(connection, jobs=jobs)

    with pytest.raises(RuntimeError, match="database write failed"):
        repository.enqueue_targeted_reconciliation(
            library_id=19,
            request=_targeted_request(),
            deployment_mode="self_hosted_private_web",
            client_surface="library_watcher",
            scheduled_at=NOW,
        )

    assert connection.commits == 0
    assert connection.rollbacks == 1
    assert len(jobs.calls) == 1
    assert not any(
        "link_scan_intent_job" in _normalized(sql)
        for sql, _ in connection.executed
    )


@pytest.mark.parametrize(
    "root_rows",
    [
        (),
        (_root_row("root-a", 31, is_active=False),),
        (_root_row("root-a", 31, library_id=27),),
        (_root_row("root-a", 31),),
    ],
    ids=("unknown-primary", "inactive-primary", "cross-library-primary", "missing-move-root"),
)
def test_targeted_enqueue_rejects_invalid_inactive_or_cross_library_roots(root_rows):
    connection = _RecordingConnection([_Result(all_rows=root_rows)])
    repository, _, jobs = _repository(connection)

    with pytest.raises(ValueError, match="root"):
        repository.enqueue_targeted_reconciliation(
            library_id=19,
            request=_targeted_request(),
            deployment_mode="self_hosted_private_web",
            client_surface="library_watcher",
            scheduled_at=NOW,
        )

    assert jobs.calls == []
    assert len(connection.executed) == 1
    root_sql = _normalized(connection.executed[0][0])
    assert "from library.library_roots" in root_sql
    assert "library_id" in root_sql
    assert "is_active is true" in root_sql
    assert not any(
        "create_targeted_reconciliation_intent" in _normalized(sql)
        for sql, _ in connection.executed
    )


def test_claimed_targeted_intent_reload_is_immutable_and_exact():
    loaded = {
        "intent_id": 84,
        "library_id": 19,
        "logical_root_id": "root-a",
        "active_paths": [
            str(Path("C:/Music/Alpha/01.flac")),
            str(Path("C:/Music/Zulu/02.flac")),
        ],
        "deleted_paths": [str(Path("C:/Music/Old/03.flac"))],
        "deleted_subtrees": [str(Path("C:/Music/Gone"))],
        "moves": [
            {
                "source_path": str(Path("C:/Music/Old Album")),
                "destination_path": str(Path("D:/Music/New Album")),
                "source_root_ref": "root-a",
                "destination_root_ref": "root-b",
                "is_directory": True,
            }
        ],
        "exception_overrides": {
            str(Path("C:/Music/Alpha/01.flac")): "Interview"
        },
    }
    connection = _RecordingConnection(
        [_Result(one=dict(loaded)), _Result(one=dict(loaded))]
    )
    repository, _, _ = _repository(connection)

    first = repository.load_claimed_targeted_reconciliation(
        job_id=901,
        worker_id="worker-a",
        lease_token="lease-a",
    )
    second = repository.load_claimed_targeted_reconciliation(
        job_id=901,
        worker_id="worker-a",
        lease_token="lease-a",
    )

    assert first == second
    assert first.root_id == "root-a"
    assert first.paths == frozenset(Path(path) for path in loaded["active_paths"])
    assert first.deleted_paths == frozenset(
        Path(path) for path in loaded["deleted_paths"]
    )
    assert first.deleted_subtrees == frozenset(
        Path(path) for path in loaded["deleted_subtrees"]
    )
    assert first.moves == (
        TargetedMove(
            source=Path("C:/Music/Old Album"),
            destination=Path("D:/Music/New Album"),
            source_root_id="root-a",
            destination_root_id="root-b",
            is_directory=True,
        ),
    )
    assert first.exception_overrides == {
        str(Path("C:/Music/Alpha/01.flac")): "Interview"
    }
    for statement, values in connection.executed:
        sql = _normalized(statement)
        assert "load_claimed_targeted_reconciliation_intent" in sql
        assert not any(token in sql for token in (" insert ", " update ", " delete "))
        assert values == {
            "job_id": 901,
            "worker_id": "worker-a",
            "lease_token": "lease-a",
        }


def test_duplicate_logical_root_rows_fail_closed_before_domain_or_job_write():
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-a", 32),
                )
            )
        ]
    )
    repository, _, jobs = _repository(connection)

    with pytest.raises(ValueError, match="duplicate|ambiguous.*root"):
        repository.enqueue_full_scan(
            library_id=19,
            account_id=7,
            capability_key="library.refresh",
            request_origin_ref="origin:refresh-42",
            deployment_mode="self_hosted_private_web",
            client_surface="private_web",
            root_ids=("root-a",),
            mode="normal",
            force=False,
            scheduled_at=NOW,
        )

    assert jobs.calls == []
    assert len(connection.executed) == 1


def test_claimed_full_scan_loader_returns_exact_immutable_root_snapshot():
    connection = _RecordingConnection(
        [
            _Result(
                one={
                    "intent_id": 71,
                    "library_id": 19,
                    "initiating_account_id": 7,
                    "mode": "manual_full_rescan",
                    "force": True,
                    "logical_root_ids": ["root-a", "root-b"],
                }
            )
        ]
    )
    repository, _, _ = _repository(connection)

    intent = repository.load_claimed_full_scan(
        job_id=901,
        worker_id="worker-a",
        lease_token="lease-a",
    )

    assert intent.intent_id == 71
    assert intent.library_id == 19
    assert intent.initiating_account_id == 7
    assert intent.mode == "manual_full_rescan"
    assert intent.force is True
    assert intent.root_ids == ("root-a", "root-b")
    [(statement, values)] = connection.executed
    assert "load_claimed_full_scan_intent" in _normalized(statement)
    assert values == {
        "job_id": 901,
        "worker_id": "worker-a",
        "lease_token": "lease-a",
    }


def test_targeted_producer_request_key_converges_intent_and_job_idempotency():
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84, "job_id": None}),
            _Result(one={"intent_id": 84}),
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84, "job_id": 901}),
        ]
    )
    repository, _, jobs = _repository(connection)
    call = {
        "library_id": 19,
        "request": _targeted_request(),
        "producer_request_key": "watcher-root-a-batch-20260906-0001",
        "deployment_mode": "self_hosted_private_web",
        "client_surface": "library_watcher",
        "scheduled_at": NOW,
    }

    first = repository.enqueue_targeted_reconciliation(**call)
    second = repository.enqueue_targeted_reconciliation(**call)

    assert first == second
    create_calls = [
        values
        for statement, values in connection.executed
        if "create_targeted_reconciliation_intent" in _normalized(statement)
    ]
    assert [values["producer_request_key"] for values in create_calls] == [
        call["producer_request_key"],
        call["producer_request_key"],
    ]
    assert len(jobs.calls) == 1
    assert jobs.calls[0][1].idempotency_key == (
        "targeted-reconciliation-request:watcher-root-a-batch-20260906-0001"
    )
    assert jobs.calls[0][1].subject_ref == "84"


def test_scan_intent_create_functions_receive_exact_accepted_context():
    full_connection = _RecordingConnection(
        [
            _Result(all_rows=(_root_row("root-a", 31),)),
            _Result(one={"intent_id": 71, "job_id": None}),
            _Result(one={"intent_id": 71}),
        ]
    )
    full_repository, _, _ = _repository(full_connection)
    full_repository.enqueue_full_scan(
        library_id=19,
        account_id=7,
        capability_key="library.refresh",
        request_origin_ref="origin:refresh-42",
        deployment_mode="self_hosted_private_web",
        client_surface="private_web",
        root_ids=("root-a",),
        mode="normal",
        force=False,
        scheduled_at=NOW,
    )
    _, full_values = next(
        item
        for item in full_connection.executed
        if "create_full_scan_intent" in _normalized(item[0])
    )
    assert full_values["capability_key"] == "library.refresh"
    assert full_values["request_origin_ref"] == "origin:refresh-42"
    assert full_values["deployment_mode"] == "self_hosted_private_web"
    assert full_values["client_surface"] == "private_web"

    targeted_connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84, "job_id": None}),
            _Result(one={"intent_id": 84}),
        ]
    )
    targeted_repository, _, _ = _repository(targeted_connection)
    targeted_repository.enqueue_targeted_reconciliation(
        library_id=19,
        request=_targeted_request(),
        producer_request_key="watcher-context-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=NOW,
    )
    _, targeted_values = next(
        item
        for item in targeted_connection.executed
        if "create_targeted_reconciliation_intent" in _normalized(item[0])
    )
    assert targeted_values["deployment_mode"] == "self_hosted_private_web"
    assert targeted_values["client_surface"] == "library_watcher"


def test_targeted_same_producer_key_with_different_payload_fails_closed():
    collision = RuntimeError("targeted reconciliation request key payload mismatch")
    connection = _RecordingConnection(
        [
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            _Result(one={"intent_id": 84, "job_id": None}),
            _Result(one={"intent_id": 84}),
            _Result(
                all_rows=(
                    _root_row("root-a", 31),
                    _root_row("root-b", 32),
                )
            ),
            collision,
        ]
    )
    repository, _, jobs = _repository(connection)
    repository.enqueue_targeted_reconciliation(
        library_id=19,
        request=_targeted_request(),
        producer_request_key="watcher-collision-0001",
        deployment_mode="self_hosted_private_web",
        client_surface="library_watcher",
        scheduled_at=NOW,
    )
    changed_request = TargetedReconciliationRequest(
        root_id="root-a",
        paths=frozenset({Path("C:/Music/Different/99.flac")}),
    )

    with pytest.raises(RuntimeError, match="payload mismatch"):
        repository.enqueue_targeted_reconciliation(
            library_id=19,
            request=changed_request,
            producer_request_key="watcher-collision-0001",
            deployment_mode="self_hosted_private_web",
            client_surface="library_watcher",
            scheduled_at=NOW,
        )

    assert len(jobs.calls) == 1
    assert connection.commits == 1
    assert connection.rollbacks == 1
    assert sum(
        "link_scan_intent_job" in _normalized(statement)
        for statement, _ in connection.executed
    ) == 1
