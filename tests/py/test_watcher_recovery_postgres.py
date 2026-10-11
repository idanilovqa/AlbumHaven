from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
from inspect import signature
from pathlib import Path
import re
from threading import Event, Thread
import time
from types import SimpleNamespace
from uuid import UUID

import pytest

from music_app.services.library_watch import LibraryEvent, LibraryEventKind


NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
SESSION_TOKEN = UUID("00000000-0000-0000-0000-000000000007")


def _recovery_module():
    try:
        return importlib.import_module("music_app.services.watcher_recovery_postgres")
    except ModuleNotFoundError as exc:
        if exc.name == "music_app.services.watcher_recovery_postgres":
            pytest.fail("durable watcher recovery repository is not implemented")
        raise


class _Result:
    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _Connection:
    def __init__(self, scripted_rows):
        self._scripted_rows = list(scripted_rows)
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, parameters=()):
        normalized = " ".join(str(statement).split())
        self.executed.append((normalized, parameters))
        rows = self._scripted_rows.pop(0) if self._scripted_rows else []
        return _Result(rows)


def _repository(scripted_rows):
    module = _recovery_module()
    connection = _Connection(scripted_rows)
    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=lambda _url: connection,
    )
    return repository, connection


def test_relative_path_serialization_rejects_escape_and_absolute_mismatch(tmp_path):
    module = _recovery_module()
    root = tmp_path / "root"
    root.mkdir()

    assert module._relative_path(root / "album" / "track.mp3", root) == (
        "album/track.mp3"
    )
    with pytest.raises(ValueError, match="root-relative"):
        module._relative_path(root / ".." / "secret.mp3", root)
    with pytest.raises(ValueError, match="root-relative"):
        module._relative_path(Path("C:/other/private.mp3"), root)


def test_event_payload_contains_only_canonical_relative_scope(tmp_path):
    module = _recovery_module()
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    roots = {
        "root-a": module.WatcherRootRecord(101, "root-a", source),
        "root-b": module.WatcherRootRecord(102, "root-b", destination),
    }

    payload = module._event_payload(
        LibraryEvent(
            LibraryEventKind.MOVED,
            "root-a",
            source / "old" / "track.mp3",
            destination=destination / "new" / "track.mp3",
            destination_root_id="root-b",
        ),
        roots,
    )

    assert payload == {
        "kind": "moved",
        "source_root_id": "root-a",
        "source_path": "old/track.mp3",
        "is_directory": False,
        "destination_root_id": "root-b",
        "destination_path": "new/track.mp3",
    }
    assert str(source) not in repr(payload)
    assert str(destination) not in repr(payload)


def test_root_record_loading_denies_missing_inactive_or_ambiguous_roots():
    repository, connection = _repository(
        [
            [],
            [
                {"id": 101, "logical_id": "root-a", "root_path": "C:/Music/A"},
                {"id": 102, "logical_id": "root-a", "root_path": "D:/Music/A"},
            ],
        ]
    )

    with pytest.raises(ValueError, match="missing|inactive"):
        repository._load_root_records(
            library_id=7,
            logical_root_ids=("root-a",),
        )
    with pytest.raises(ValueError, match="ambiguous"):
        repository._load_root_records(
            library_id=7,
            logical_root_ids=("root-a",),
        )
    assert all("is_active is true" in statement for statement, _ in connection.executed)


def test_accept_event_rejects_naive_database_timestamp_before_sql(tmp_path):
    module = _recovery_module()
    root = tmp_path / "root"
    root.mkdir()
    repository, connection = _repository(
        [[{"id": 101, "logical_id": "root-a", "root_path": str(root)}]]
    )

    with pytest.raises(ValueError, match="timezone-aware"):
        repository.accept_event(
            library_id=7,
            event=LibraryEvent(
                LibraryEventKind.CREATED,
                "root-a",
                root / "track.mp3",
            ),
            accepted_at=datetime(2026, 10, 9, 12, 0),
        )

    assert len(connection.executed) == 1
    assert "library.library_roots" in connection.executed[0][0]


def test_participant_fences_are_sorted_and_reject_ambiguous_or_inverted_rows():
    module = _recovery_module()
    fences = module._participant_fences(
        [
            {
                "logical_root_id": "root-b",
                "accepted_sequence_lower": 4,
                "accepted_sequence_upper": 7,
                "dirty_generation": 1,
            },
            {
                "logical_root_id": "root-a",
                "accepted_sequence_lower": 2,
                "accepted_sequence_upper": 2,
                "dirty_generation": 0,
            },
        ]
    )
    assert tuple(item.logical_root_id for item in fences) == ("root-a", "root-b")
    with pytest.raises(ValueError, match="ambiguous"):
        module._participant_fences(
            [
                {
                    "logical_root_id": "root-a",
                    "accepted_sequence_lower": 1,
                    "accepted_sequence_upper": 1,
                    "dirty_generation": 0,
                },
                {
                    "logical_root_id": "root-a",
                    "accepted_sequence_lower": 2,
                    "accepted_sequence_upper": 2,
                    "dirty_generation": 0,
                },
            ]
        )
    with pytest.raises(ValueError, match="inverted"):
        module._participant_fences(
            [
                {
                    "logical_root_id": "root-a",
                    "accepted_sequence_lower": 5,
                    "accepted_sequence_upper": 4,
                    "dirty_generation": 0,
                }
            ]
        )


def test_dispatch_repository_calls_only_worker_security_definer_function():
    repository, connection = _repository(
        [[{"generation_id": 301, "job_id": 901}, {"generation_id": 302, "job_id": 902}]]
    )

    assert repository.dispatch_ready(now=NOW, limit=32) == (301, 302)
    assert connection.executed == [
        (
            "select * from library.dispatch_ready_watcher_generations(%s, %s)",
            (NOW, 32),
        )
    ]


def test_complete_repair_uses_claim_fenced_security_definer_function():
    repository, connection = _repository([[{"repair_completed": True}]])
    claim = SimpleNamespace(
        job_id=901,
        attempt=3,
        worker_id="worker-full",
        lease_token="lease-full",
    )

    assert repository.complete_repair(
        claim=claim,
        repair_id=613,
        inventory_revision=41,
        now=NOW,
    ) is True
    assert connection.executed == [
        (
            "select library.complete_watcher_repair(%s, %s, %s, %s, %s, %s, %s) as repair_completed",
            (613, 901, 3, "worker-full", "lease-full", 41, NOW),
        )
    ]


def test_mark_dirty_maps_one_participant_and_stable_incident_identity():
    repository, connection = _repository(
        [
            [
                {
                    "logical_root_id": "root-a",
                    "generation_id": 31,
                    "accepted_sequence_lower": 8,
                    "accepted_sequence_upper": 8,
                    "dirty_generation": 3,
                    "incident_id": "11111111-1111-1111-1111-111111111111",
                    "warning_token": "22222222-2222-2222-2222-222222222222",
                }
            ]
        ]
    )

    result = repository.mark_dirty(
        library_id=7,
        logical_root_id="root-a",
        reason_code="overflow",
        observed_at=NOW,
    )

    assert result.generation_id == 31
    assert result.incident_id == "11111111-1111-1111-1111-111111111111"
    assert result.warning_token == "22222222-2222-2222-2222-222222222222"
    assert result.participants[0].logical_root_id == "root-a"
    assert connection.executed == [
        (
            "select * from library.mark_watcher_roots_dirty(%s, %s, %s, %s)",
            (7, ["root-a"], "overflow", NOW),
        )
    ]


def test_load_status_maps_stable_incident_identity_and_acknowledgement():
    repository, connection = _repository(
        [[{
            "logical_root_id": "root-a",
            "state": "root_unavailable",
            "detected_at": NOW,
            "incident_id": "11111111-1111-1111-1111-111111111111",
            "warning_token": "22222222-2222-2222-2222-222222222222",
            "occurrence_count": 2,
            "acknowledged": True,
        }]]
    )

    [problem] = repository.load_status(library_id=7)

    assert problem.root_id == "root-a"
    assert problem.state == "root_unavailable"
    assert problem.detected_at == NOW.isoformat()
    assert problem.incident_id == "11111111-1111-1111-1111-111111111111"
    assert problem.warning_token == "22222222-2222-2222-2222-222222222222"
    assert problem.occurrence_count == 2
    assert problem.acknowledged is True
    assert connection.executed == [
        ("select * from library.load_watcher_status(%s)", (7,))
    ]


def test_load_metrics_maps_only_bounded_path_free_dimensions():
    values = {
        "ready": 2,
        "running": 1,
        "coalesced": 3,
        "dirty": 1,
        "barrier_waiting": 1,
        "lag_1_9": 4,
        "lag_10_99": 2,
        "lag_100_plus": 1,
        "coalesced_events": 19,
        "catch_ups": 5,
        "oldest_ready_seconds": 12.5,
        "oldest_repair_seconds": 31.25,
    }
    repository, connection = _repository([[values]])

    metrics = repository.load_metrics(library_id=7)

    assert {
        field: getattr(metrics, field)
        for field in values
    } == values
    assert set(metrics.__dataclass_fields__) == set(values)
    [(statement, parameters)] = connection.executed
    assert "library.load_watcher_metrics" in statement
    assert parameters[0] == 7


@pytest.mark.parametrize(
    "reason_code",
    ["root_unavailable", "overflow", "stable_write_unavailable", "reconciliation_failed", "cross_root_uncertain"],
)
def test_fail_generation_accepts_only_bounded_reason_codes(reason_code):
    module = _recovery_module()
    repository, _connection = _repository([[{"failed": True}]])
    claim = SimpleNamespace(
        job_id=91,
        attempt=2,
        worker_id="worker-a",
        lease_token="opaque-lease",
    )
    generation = module.ClaimedWatcherGeneration(
        generation_id=31,
        intent_id=31,
        library_id=7,
        participants=(module.WatcherParticipantFence("root-a", 4, 5, 1),),
        generation_kind="exact",
        barrier_ids=(),
    )

    assert repository.fail_generation(
        claim=claim,
        generation=generation,
        reason_code=reason_code,
        now=NOW + timedelta(seconds=1),
    ) is True


def test_fail_generation_rejects_unbounded_exception_text_before_sql():
    module = _recovery_module()
    repository, connection = _repository([])
    generation = module.ClaimedWatcherGeneration(
        generation_id=31,
        intent_id=31,
        library_id=7,
        participants=(module.WatcherParticipantFence("root-a", 4, 5, 1),),
        generation_kind="exact",
        barrier_ids=(),
    )

    with pytest.raises(ValueError, match="reason"):
        repository.fail_generation(
            claim=SimpleNamespace(
                job_id=91,
                attempt=2,
                worker_id="worker-a",
                lease_token="opaque-lease",
            ),
            generation=generation,
            reason_code="C:/private/music/credential=secret",
            now=NOW,
        )
    assert connection.executed == []


def test_claim_generation_maps_all_participants_and_owned_barriers():
    repository, connection = _repository(
        [
            [
                {
                    "generation_id": 31,
                    "intent_id": 31,
                    "library_id": 7,
                    "participants": [
                        {
                            "logical_root_id": "root-b",
                            "accepted_sequence_lower": 5,
                            "accepted_sequence_upper": 6,
                            "dirty_generation": 1,
                        },
                        {
                            "logical_root_id": "root-a",
                            "accepted_sequence_lower": 3,
                            "accepted_sequence_upper": 4,
                            "dirty_generation": 0,
                        },
                    ],
                    "generation_kind": "exact",
                    "barrier_ids": [72, 71, 72],
                }
            ]
        ]
    )
    claim = SimpleNamespace(
        job_id=91,
        attempt=2,
        worker_id="worker-a",
        lease_token="opaque-lease",
    )

    generation = repository.claim_generation(claim=claim, now=NOW)

    assert generation.generation_id == 31
    assert tuple(item.logical_root_id for item in generation.participants) == (
        "root-a",
        "root-b",
    )
    assert generation.barrier_ids == (71, 72)
    assert "load_claimed_watcher_generation" in connection.executed[0][0]


def test_repository_does_not_duplicate_generic_job_heartbeat():
    repository, _connection = _repository([])

    assert not hasattr(repository, "heartbeat_generation")


def test_reconcile_due_recovers_before_dispatch_and_shares_one_limit():
    repository, connection = _repository(
        [[{"generation_id": 31}], [{"generation_id": 32}, {"generation_id": 33}]]
    )

    assert repository.reconcile_due(now=NOW, limit=3) == (31, 32, 33)
    assert connection.executed == [
        (
            "select generation_id from library.reconcile_due_watcher_generations(%s, %s)",
            (NOW, 3),
        ),
        (
            "select generation_id from library.dispatch_ready_watcher_generations(%s, %s)",
            (NOW, 2),
        ),
    ]


def test_repository_does_not_expose_standalone_generation_completion():
    repository, _connection = _repository([])

    assert not hasattr(repository, "complete_generation")


def test_operator_rollback_disables_acceptance_and_maps_retained_scope():
    repository, connection = _repository(
        [
            [{"acceptance_disabled": True}],
            [
                {
                    "retained_generation_ids": [33, 31, 33],
                    "affected_logical_root_ids": ["root-b", "root-a", "root-b"],
                }
            ],
        ]
    )

    repository.disable_acceptance(now=NOW)
    result = repository.prepare_legacy_rollback(now=NOW + timedelta(seconds=1))

    assert result.retained_generation_ids == (31, 33)
    assert result.affected_root_ids == ("root-a", "root-b")
    assert "disable_watcher_acceptance" in connection.executed[0][0]
    assert "prepare_legacy_watcher_rollback" in connection.executed[1][0]


def test_runtime_session_repository_uses_typed_restricted_boundaries():
    recovered = [{"recovered_logical_root_id": "root-b"}, {"recovered_logical_root_id": "root-a"}]
    repository, connection = _repository([recovered, [], [], [{"finished": True}]])

    assert repository.begin_runtime_session(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-b", "root-a"),
        started_at=NOW,
    ) == ("root-a", "root-b")
    repository.expand_runtime_session_participants(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-a", "root-b"),
    )
    repository.set_runtime_session_participants(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=("root-b",),
    )
    assert repository.finish_runtime_session(
        library_id=7,
        session_token=SESSION_TOKEN,
    ) is True

    assert connection.executed == [
        (
            "select * from library.begin_watcher_runtime_session(%s, %s, %s, %s)",
            (7, SESSION_TOKEN, ["root-a", "root-b"], NOW),
        ),
        (
            "select library.expand_watcher_runtime_session_participants(%s, %s, %s)",
            (7, SESSION_TOKEN, ["root-a", "root-b"]),
        ),
        (
            "select library.set_watcher_runtime_session_participants(%s, %s, %s)",
            (7, SESSION_TOKEN, ["root-b"]),
        ),
        (
            "select library.finish_watcher_runtime_session(%s, %s) as finished",
            (7, SESSION_TOKEN),
        ),
    ]


def test_runtime_session_repository_preserves_duplicate_roots_for_sql_rejection():
    repository, connection = _repository([[], [], []])
    duplicate_roots = ("root-b", "root-a", "root-a")

    assert repository.begin_runtime_session(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=duplicate_roots,
        started_at=NOW,
    ) == ()
    repository.expand_runtime_session_participants(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=duplicate_roots,
    )
    repository.set_runtime_session_participants(
        library_id=7,
        session_token=SESSION_TOKEN,
        logical_root_ids=duplicate_roots,
    )

    assert connection.executed == [
        (
            "select * from library.begin_watcher_runtime_session(%s, %s, %s, %s)",
            (7, SESSION_TOKEN, ["root-b", "root-a", "root-a"], NOW),
        ),
        (
            "select library.expand_watcher_runtime_session_participants(%s, %s, %s)",
            (7, SESSION_TOKEN, ["root-b", "root-a", "root-a"]),
        ),
        (
            "select library.set_watcher_runtime_session_participants(%s, %s, %s)",
            (7, SESSION_TOKEN, ["root-b", "root-a", "root-a"]),
        ),
    ]


class _DirtyConnection:
    def __init__(self, *, roots=("root-a", "root-b"), fail_commit=None):
        self.roots = tuple(roots)
        self.fail_commit = fail_commit
        self.executed = []
        self.cancel_count = 0
        self.close_count = 0
        self.closed = False
        self.committed = False
        self.rolled_back = False
        self.query_entered = Event()
        self.query_release = Event()
        self.query_release.set()
        self.commit_entered = Event()
        self.commit_release = Event()
        self.commit_release.set()

    def execute(self, statement, parameters=()):
        normalized = " ".join(str(statement).split())
        self.executed.append((normalized, parameters))
        if "mark_watcher_roots_dirty" in normalized:
            self.query_entered.set()
            assert self.query_release.wait(2.0)
            return _Result(
                {"logical_root_id": root_id} for root_id in self.roots
            )
        return _Result([])

    def commit(self):
        self.commit_entered.set()
        assert self.commit_release.wait(2.0)
        if self.fail_commit is not None:
            raise self.fail_commit
        self.committed = True

    def rollback(self):
        self.rolled_back = True

    def cancel(self):
        self.cancel_count += 1
        self.query_release.set()
        self.commit_release.set()

    def cancel_safe(self, *, timeout):
        assert timeout > 0
        self.cancel()

    def close(self):
        self.close_count += 1
        self.closed = True
        self.query_release.set()
        self.commit_release.set()


class _DirtyConnectionFactory:
    def __init__(self, connection):
        self.connection = connection
        self.calls = []
        self.connect_entered = Event()
        self.connect_release = Event()
        self.connect_release.set()

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        self.connect_entered.set()
        assert self.connect_release.wait(2.0)
        return self.connection


@pytest.mark.parametrize(
    ("method_name", "kwargs"),
    [
        (
            "begin_runtime_session",
            dict(
                library_id=0,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
                started_at=NOW,
            ),
        ),
        (
            "begin_runtime_session",
            dict(
                library_id=7,
                session_token=str(SESSION_TOKEN),
                logical_root_ids=("root-a",),
                started_at=NOW,
            ),
        ),
        (
            "begin_runtime_session",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=["root-a"],
                started_at=NOW,
            ),
        ),
        (
            "begin_runtime_session",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
                started_at=NOW.replace(tzinfo=None),
            ),
        ),
        (
            "begin_runtime_session",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
                started_at=NOW.astimezone(timezone(timedelta(hours=2))),
            ),
        ),
        (
            "expand_runtime_session_participants",
            dict(
                library_id=0,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
            ),
        ),
        (
            "expand_runtime_session_participants",
            dict(
                library_id=7,
                session_token=str(SESSION_TOKEN),
                logical_root_ids=("root-a",),
            ),
        ),
        (
            "expand_runtime_session_participants",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=["root-a"],
            ),
        ),
        (
            "set_runtime_session_participants",
            dict(
                library_id=-1,
                session_token=SESSION_TOKEN,
                logical_root_ids=("root-a",),
            ),
        ),
        (
            "set_runtime_session_participants",
            dict(
                library_id=7,
                session_token=str(SESSION_TOKEN),
                logical_root_ids=("root-a",),
            ),
        ),
        (
            "set_runtime_session_participants",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=["root-a"],
            ),
        ),
        (
            "finish_runtime_session",
            dict(library_id=0, session_token=SESSION_TOKEN),
        ),
        (
            "finish_runtime_session",
            dict(library_id=7, session_token=str(SESSION_TOKEN)),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=0,
                logical_root_ids=("root-a",),
                observed_at=NOW,
                operation_deadline=10**15,
            ),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=7,
                logical_root_ids=["root-a"],
                observed_at=NOW,
                operation_deadline=10**15,
            ),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=7,
                logical_root_ids=("",),
                observed_at=NOW,
                operation_deadline=10**15,
            ),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=7,
                logical_root_ids=("root-a", "root-a"),
                observed_at=NOW,
                operation_deadline=10**15,
            ),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=7,
                logical_root_ids=("root-a",),
                observed_at=NOW.replace(tzinfo=None),
                operation_deadline=10**15,
            ),
        ),
        (
            "prepare_overflow_dirty_write",
            dict(
                library_id=7,
                logical_root_ids=("root-a",),
                observed_at=NOW.astimezone(timezone(timedelta(hours=-7))),
                operation_deadline=10**15,
            ),
        ),
    ],
)
def test_runtime_session_repository_rejects_invalid_typed_boundaries_before_io(
    method_name, kwargs
):
    module = _recovery_module()
    connection = _DirtyConnection()
    factory = _DirtyConnectionFactory(connection)
    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=factory,
    )

    with pytest.raises(ValueError):
        getattr(repository, method_name)(**kwargs)

    assert factory.calls == []
    assert connection.executed == []


def _dirty_attempt(*, connection=None, deadline=None):
    module = _recovery_module()
    connection = connection or _DirtyConnection()
    factory = _DirtyConnectionFactory(connection)
    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=factory,
    )
    attempt = repository.prepare_overflow_dirty_write(
        library_id=7,
        logical_root_ids=("root-a", "root-b"),
        observed_at=NOW,
        operation_deadline=(deadline if deadline is not None else time.monotonic() + 5.0),
    )
    return module, attempt, factory, connection


def test_prepare_overflow_dirty_write_does_no_io_or_thread_work(monkeypatch):
    started_threads = []
    monkeypatch.setattr(Thread, "start", lambda thread: started_threads.append(thread))

    _module, attempt, factory, connection = _dirty_attempt()

    assert factory.calls == []
    assert connection.executed == []
    assert started_threads == []
    assert attempt.is_terminal is False
    assert attempt.outcome is None
    assert "reason" not in signature(
        _recovery_module().PostgresWatcherRecoveryRepository.prepare_overflow_dirty_write
    ).parameters

    outcome = attempt.execute()

    assert outcome.state == "committed"
    assert started_threads == []


def test_dirty_attempt_expired_deadline_is_owned_by_execute_not_prepare():
    _module, attempt, factory, connection = _dirty_attempt(deadline=0.0)

    assert factory.calls == []
    assert connection.executed == []
    assert attempt.is_terminal is False

    outcome = attempt.execute()

    assert outcome.state == "rolled_back"
    assert outcome.committed_root_ids == ()
    assert factory.calls == []
    assert connection.executed == []


def test_dirty_attempt_uses_overflow_and_bulk_logical_ids_only():
    _module, attempt, factory, connection = _dirty_attempt()

    outcome = attempt.execute()

    assert len(factory.calls) == 1
    dirty_calls = [
        call for call in connection.executed if "mark_watcher_roots_dirty" in call[0]
    ]
    assert dirty_calls == [
        (
            "select * from library.mark_watcher_roots_dirty(%s, %s, %s, %s)",
            (7, ["root-a", "root-b"], "overflow", NOW),
        )
    ]
    assert outcome.state == "committed"
    assert outcome.committed_root_ids == ("root-a", "root-b")


def test_dirty_attempt_sets_bounded_connect_statement_and_lock_timeouts():
    remaining = 4.0
    _module, attempt, factory, connection = _dirty_attempt(
        deadline=time.monotonic() + remaining
    )

    attempt.execute()

    [(connect_args, connect_kwargs)] = factory.calls
    connect_timeout = connect_kwargs.get("connect_timeout")
    if connect_timeout is None:
        connect_timeout = float(str(connect_args[0]).split("connect_timeout=")[-1])
    assert 0 < float(connect_timeout) <= remaining
    timeout_calls = [
        (statement, parameters)
        for statement, parameters in connection.executed
        if "statement_timeout" in statement or "lock_timeout" in statement
    ]
    assert len(timeout_calls) == 2
    for statement, parameters in timeout_calls:
        if parameters:
            timeout_ms = float(str(parameters[0]).removesuffix("ms"))
        else:
            match = re.search(r"(\d+(?:\.\d+)?)\s*ms", statement)
            assert match is not None
            timeout_ms = float(match.group(1))
        assert 0 < timeout_ms <= remaining * 1000


def test_dirty_attempt_cancel_before_connect_proves_rolled_back_without_connecting():
    _module, attempt, factory, connection = _dirty_attempt()

    attempt.cancel()
    outcome = attempt.execute()

    assert factory.calls == []
    assert connection.executed == []
    assert outcome.state == "rolled_back"
    assert outcome.committed_root_ids == ()
    assert attempt.is_terminal is True


@pytest.mark.parametrize("phase", ["connect", "query", "commit"])
def test_dirty_attempt_cancel_during_connect_query_and_commit_closes_exact_connection(phase):
    connection = _DirtyConnection()
    _module, attempt, factory, connection = _dirty_attempt(connection=connection)
    if phase == "connect":
        factory.connect_release.clear()
        entered = factory.connect_entered
    elif phase == "query":
        connection.query_release.clear()
        entered = connection.query_entered
    else:
        connection.commit_release.clear()
        entered = connection.commit_entered
    result = []
    worker = Thread(target=lambda: result.append(attempt.execute()), daemon=True)
    worker.start()
    assert entered.wait(1.0)

    attempt.cancel()
    factory.connect_release.set()
    connection.query_release.set()
    connection.commit_release.set()
    worker.join(2.0)

    assert not worker.is_alive()
    assert connection.closed is True
    assert connection.close_count >= 1
    if phase != "connect":
        assert connection.cancel_count >= 1
    assert attempt.is_terminal is True
    assert result[0].state in {"rolled_back", "indeterminate"}
    assert result[0].committed_root_ids == ()


@pytest.mark.parametrize("cancel_failure", [None, TimeoutError("cancel timed out")])
def test_dirty_attempt_cancel_uses_bounded_safe_cancel_and_always_closes(
    cancel_failure,
):
    class SafeCancelConnection(_DirtyConnection):
        def __init__(self):
            super().__init__()
            self.cancel_safe_timeouts = []
            self.unbounded_cancel_called = False

        def cancel(self):
            self.unbounded_cancel_called = True
            raise AssertionError("unbounded connection cancellation is forbidden")

        def cancel_safe(self, *, timeout):
            self.cancel_safe_timeouts.append(timeout)
            if cancel_failure is not None:
                raise cancel_failure
            self.query_release.set()

    remaining = 1.5
    connection = SafeCancelConnection()
    connection.query_release.clear()
    _module, attempt, _factory, connection = _dirty_attempt(
        connection=connection,
        deadline=time.monotonic() + remaining,
    )
    outcomes = []
    worker = Thread(target=lambda: outcomes.append(attempt.execute()), daemon=True)
    worker.start()
    assert connection.query_entered.wait(1.0)

    attempt.cancel()
    worker.join(2.0)

    assert connection.unbounded_cancel_called is False
    assert len(connection.cancel_safe_timeouts) == 1
    assert 0 < connection.cancel_safe_timeouts[0] <= remaining
    assert not worker.is_alive()
    assert connection.closed is True
    assert connection.close_count >= 1
    assert outcomes[0].state in {"rolled_back", "indeterminate"}
    assert outcomes[0].committed_root_ids == ()


def test_dirty_attempt_safe_cancel_reserves_time_to_close_and_join(monkeypatch):
    module = _recovery_module()

    class FakeMonotonic:
        def __init__(self):
            self.value = 100.0

        def __call__(self):
            return self.value

        def advance(self, seconds):
            self.value += seconds

    clock = FakeMonotonic()
    monkeypatch.setattr(module.time, "monotonic", clock)

    class WorstCaseCancelConnection(_DirtyConnection):
        def __init__(self):
            super().__init__()
            self.cancel_safe_timeouts = []
            self.cancel_returned_at = None
            self.close_times = []
            self.unbounded_cancel_called = False

        def cancel(self):
            self.unbounded_cancel_called = True
            self.query_release.set()
            raise AssertionError("unbounded connection cancellation is forbidden")

        def cancel_safe(self, *, timeout):
            self.cancel_safe_timeouts.append(timeout)
            clock.advance(timeout)
            self.cancel_returned_at = clock()
            self.query_release.set()

        def close(self):
            self.close_times.append(clock())
            super().close()

    operation_deadline = clock() + 4.0
    connection = WorstCaseCancelConnection()
    connection.query_release.clear()
    connection.commit_release.clear()
    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=_DirtyConnectionFactory(connection),
    )
    attempt = repository.prepare_overflow_dirty_write(
        library_id=7,
        logical_root_ids=("root-a", "root-b"),
        observed_at=NOW,
        operation_deadline=operation_deadline,
    )
    outcomes = []
    worker = Thread(target=lambda: outcomes.append(attempt.execute()), daemon=True)
    worker.start()
    assert connection.query_entered.wait(1.0)
    remaining_before_cancel = operation_deadline - clock()

    attempt.cancel()
    worker.join(1.0)
    connection.commit_release.set()
    worker.join(1.0)

    assert connection.unbounded_cancel_called is False
    assert len(connection.cancel_safe_timeouts) == 1
    cancel_timeout = connection.cancel_safe_timeouts[0]
    assert 0 < cancel_timeout < remaining_before_cancel
    assert connection.cancel_returned_at == 100.0 + cancel_timeout
    assert connection.close_times
    assert max(connection.close_times) < operation_deadline
    assert operation_deadline - clock() > 0
    assert not worker.is_alive()
    assert not connection.commit_entered.is_set()
    assert connection.committed is False
    assert outcomes[0].state in {"rolled_back", "indeterminate"}
    assert outcomes[0].committed_root_ids == ()


def test_dirty_attempt_commit_acknowledged_before_cancel_is_the_only_committed_outcome():
    _module, attempt, _factory, connection = _dirty_attempt()

    outcome = attempt.execute()
    attempt.cancel()

    assert connection.committed is True
    assert outcome.state == "committed"
    assert outcome.committed_root_ids == ("root-a", "root-b")
    assert attempt.outcome == outcome


def test_dirty_attempt_ambiguous_commit_retains_every_root_as_indeterminate():
    connection = _DirtyConnection(fail_commit=ConnectionError("acknowledgement lost"))
    _module, attempt, _factory, _connection = _dirty_attempt(connection=connection)

    outcome = attempt.execute()

    assert outcome.state == "indeterminate"
    assert outcome.committed_root_ids == ()
    assert attempt.is_terminal is True
    assert connection.closed is True


def test_dirty_attempt_outcome_allows_root_ids_only_for_committed_state():
    module = _recovery_module()

    assert module.WatcherDirtyWriteOutcome("committed", ("root-a",)).state == (
        "committed"
    )
    for state in ("rolled_back", "indeterminate"):
        with pytest.raises(ValueError, match="committed"):
            module.WatcherDirtyWriteOutcome(state, ("root-a",))
    with pytest.raises(ValueError, match="state"):
        module.WatcherDirtyWriteOutcome("failed")


def test_dirty_attempt_cancelled_joined_attempt_cannot_commit_later():
    class LateCommitProbeConnection(_DirtyConnection):
        def cancel(self):
            self.cancel_count += 1
            self.query_release.set()

        def close(self):
            self.close_count += 1
            self.closed = True
            self.query_release.set()

    connection = LateCommitProbeConnection()
    connection.query_release.clear()
    connection.commit_release.clear()
    _module, attempt, _factory, connection = _dirty_attempt(connection=connection)
    results = []
    worker = Thread(target=lambda: results.append(attempt.execute()), daemon=True)
    worker.start()
    assert connection.query_entered.wait(1.0)

    attempt.cancel()
    worker.join(1.0)
    was_alive_after_join = worker.is_alive()
    connection.commit_release.set()
    worker.join(2.0)

    assert was_alive_after_join is False
    assert not connection.commit_entered.is_set()
    assert not worker.is_alive()
    assert connection.closed is True
    assert connection.committed is False
    assert results[0].state in {"rolled_back", "indeterminate"}


class _SqlStateError(RuntimeError):
    def __init__(self, sqlstate, private_text):
        super().__init__(private_text)
        self.sqlstate = sqlstate


def test_begin_runtime_session_sanitizes_acceptance_disabled_without_claiming_replacement():
    module = _recovery_module()
    private_text = "acceptance disabled for private-logical-root"

    class FailingConnection(_Connection):
        def execute(self, _statement, _parameters=()):
            raise _SqlStateError("55000", private_text)

    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=lambda _url: FailingConnection([]),
    )

    with pytest.raises(RuntimeError) as raised:
        repository.begin_runtime_session(
            library_id=7,
            session_token=SESSION_TOKEN,
            logical_root_ids=("private-logical-root",),
            started_at=NOW,
        )

    error = raised.value
    assert type(error) is RuntimeError
    assert not isinstance(error, module.WatcherSessionReplacedError)
    assert str(error) == "watcher runtime session could not begin"
    assert getattr(error, "sqlstate", None) is None
    assert error.__cause__ is None
    assert private_text not in repr(error)
    assert str(SESSION_TOKEN) not in repr(error)


@pytest.mark.parametrize(
    ("method_name", "sqlstate", "kwargs"),
    [
        (
            "begin_runtime_session",
            "22023",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("private-logical-root",),
                started_at=NOW,
            ),
        ),
        (
            "expand_runtime_session_participants",
            "22023",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("private-logical-root",),
            ),
        ),
        (
            "set_runtime_session_participants",
            "22023",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("private-logical-root",),
            ),
        ),
        (
            "finish_runtime_session",
            "22023",
            dict(library_id=7, session_token=SESSION_TOKEN),
        ),
        (
            "expand_runtime_session_participants",
            "55000",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("private-logical-root",),
            ),
        ),
        (
            "set_runtime_session_participants",
            "55000",
            dict(
                library_id=7,
                session_token=SESSION_TOKEN,
                logical_root_ids=("private-logical-root",),
            ),
        ),
        (
            "finish_runtime_session",
            "55000",
            dict(library_id=7, session_token=SESSION_TOKEN),
        ),
    ],
)
def test_runtime_session_repository_maps_22023_and_55000_without_leaking_parameters(
    method_name, sqlstate, kwargs
):
    module = _recovery_module()
    token_text = str(SESSION_TOKEN)
    root_text = "private-logical-root"

    class FailingConnection(_Connection):
        def execute(self, _statement, _parameters=()):
            raise _SqlStateError(sqlstate, f"token={token_text}; root={root_text}")

    repository = module.PostgresWatcherRecoveryRepository(
        database_url="postgresql://watcher.invalid/album_haven",
        connect_to_database=lambda _url: FailingConnection([]),
    )
    expected_type = ValueError if sqlstate == "22023" else module.WatcherSessionReplacedError
    fixed_message = (
        "watcher runtime session arguments are invalid"
        if sqlstate == "22023"
        else "watcher runtime session was replaced"
    )

    with pytest.raises(expected_type) as raised:
        getattr(repository, method_name)(**kwargs)

    assert str(raised.value) == fixed_message
    assert token_text not in repr(raised.value)
    assert root_text not in repr(raised.value)
