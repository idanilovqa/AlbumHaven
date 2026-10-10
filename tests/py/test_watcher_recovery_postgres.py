from __future__ import annotations

from datetime import datetime, timedelta, timezone
import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.library_watch import LibraryEvent, LibraryEventKind


NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)


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
