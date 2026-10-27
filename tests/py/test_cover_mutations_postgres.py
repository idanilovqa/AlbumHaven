from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone

import pytest
from psycopg import OperationalError, errors

from music_app.services.cover_mutation_coordinator import (
    CommitOutcomeUnknown,
    CoverMutationConflict,
    CoverMutationIdentity,
    CoverMutationRecovery,
    CoverMutationRetryRequired,
    CoverMutationStatus,
    CoverSelectionCommit,
)
from music_app.services.cover_mutations_postgres import PostgresCoverMutationRepository


NOW = datetime(2026, 10, 25, 12, 0, tzinfo=timezone.utc)
PRIVATE_PATH = r"C:\private\Artist\Album\01.flac"
SHA256 = "a" * 64


class _Result:
    def __init__(self, rows):
        self._rows = rows if isinstance(rows, list) else [rows]

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _Connection:
    def __init__(self, *rows, execute_error=None, exit_error=None):
        self.rows = list(rows)
        self.execute_error = execute_error
        self.exit_error = exit_error
        self.executed: list[tuple[str, object]] = []
        self.enters = 0
        self.exits = 0

    def __enter__(self):
        self.enters += 1
        return self

    def __exit__(self, exc_type, *_args):
        self.exits += 1
        if exc_type is None and self.exit_error is not None:
            raise self.exit_error
        return False

    def execute(self, sql, parameters=None):
        normalized = " ".join(str(sql).casefold().split())
        self.executed.append((normalized, parameters))
        if "statement_timeout" in normalized:
            return _Result([])
        if self.execute_error is not None:
            raise self.execute_error
        return _Result(self.rows.pop(0) if self.rows else None)


class _Connector:
    def __init__(self, connection=None, error=None):
        self.connection = connection
        self.error = error
        self.calls: list[str] = []

    def __call__(self, database_url):
        self.calls.append(database_url)
        if self.error is not None:
            raise self.error
        return self.connection


def _repository(connection=None, *, connector=None):
    connector = connector or _Connector(connection)
    return (
        PostgresCoverMutationRepository(
            database_url="postgresql://app@localhost/album_haven",
            connect_to_database=connector,
        ),
        connector,
    )


def _commit_request(**changes) -> CoverSelectionCommit:
    values = {
        "identity": CoverMutationIdentity(library_id=7, local_album_id=91),
        "track_paths": (PRIVATE_PATH, r"C:\private\Artist\Album\02.flac"),
        "expected_inventory_revision": 20,
        "expected_cover_mutation_revision": 11,
        "expected_selected_cover_revision": "cover-11",
        "selected_cover_path": "covers/album.jpg",
        "promoted_cover_revision": "cover-12",
        "selected_origin": "user",
        "clear_selection": False,
        "remote_cover": None,
        "artifact_sha256": SHA256,
        "observed_at": NOW,
        "job_id": 101,
        "attempt": 3,
        "worker_id": "worker-a",
        "lease_token": "lease-a",
        "task_id": 103,
        "checkpoint_revision": 7,
    }
    values.update(changes)
    return CoverSelectionCommit(**values)


def _recovery_request(**changes) -> CoverMutationRecovery:
    values = {
        "identity": CoverMutationIdentity(library_id=7, local_album_id=91),
        "expected_inventory_revision": 20,
        "expected_cover_mutation_revision": 11,
        "expected_selected_cover_revision": "cover-11",
        "promoted_cover_revision": "cover-12",
        "artifact_sha256": SHA256,
        "job_id": 101,
        "attempt": 3,
        "worker_id": "worker-a",
        "lease_token": "lease-a",
        "task_id": 103,
        "checkpoint_revision": 7,
        "observed_at": NOW,
    }
    values.update(changes)
    return CoverMutationRecovery(**values)


def _call(connection: _Connection, function_name: str):
    calls = [item for item in connection.executed if function_name in item[0]]
    assert len(calls) == 1
    assert connection.executed[0][0] == "set local statement_timeout = '15s'"
    assert connection.enters == 1
    assert connection.exits == 1
    return calls[0]


def test_current_library_revision_calls_exact_function_in_one_bounded_transaction() -> None:
    connection = _Connection({"revision": 12})
    repository, _ = _repository(connection)

    assert repository.current_library_revision(library_id=7) == 12

    sql, parameters = _call(connection, "library.read_cover_mutation_revision")
    assert "%(library_id)s" in sql
    assert parameters == {"library_id": 7}


@pytest.mark.parametrize("library_id", [True, False, 0, -1, 1.5, "7"])
def test_current_library_revision_rejects_non_positive_integer_before_connecting(
    library_id,
) -> None:
    connector = _Connector(error=AssertionError("must not connect"))
    repository, _ = _repository(connector=connector)

    with pytest.raises((TypeError, ValueError)):
        repository.current_library_revision(library_id=library_id)

    assert connector.calls == []


@pytest.mark.parametrize("revision", [True, -1, "12", None])
def test_current_library_revision_rejects_invalid_database_value(revision) -> None:
    repository, _ = _repository(_Connection({"revision": revision}))

    with pytest.raises((TypeError, ValueError)):
        repository.current_library_revision(library_id=7)


def test_resolve_identity_normalizes_and_deduplicates_paths_without_case_folding() -> None:
    connection = _Connection([{"library_id": 7, "local_album_id": 91}])
    repository, _ = _repository(connection)

    identity = repository.resolve_identity(
        library_id=7,
        track_paths=(f"  {PRIVATE_PATH}  ", PRIVATE_PATH, PRIVATE_PATH.upper()),
    )

    assert identity == CoverMutationIdentity(library_id=7, local_album_id=91)
    sql, parameters = _call(connection, "library.resolve_cover_mutation_identity")
    assert "%(library_id)s" in sql
    assert "%(track_paths)s::text[]" in sql
    assert parameters == {
        "library_id": 7,
        "track_paths": [PRIVATE_PATH, PRIVATE_PATH.upper()],
    }


@pytest.mark.parametrize(
    "track_paths",
    [(), ("",), ("   ",), (PRIVATE_PATH, 7), PRIVATE_PATH],
)
def test_resolve_identity_rejects_invalid_path_sets_before_connecting(track_paths) -> None:
    connector = _Connector(error=AssertionError("must not connect"))
    repository, _ = _repository(connector=connector)

    with pytest.raises((TypeError, ValueError)) as exc_info:
        repository.resolve_identity(library_id=7, track_paths=track_paths)

    assert PRIVATE_PATH not in str(exc_info.value)
    assert connector.calls == []


@pytest.mark.parametrize(
    "rows",
    [[], [{"library_id": 7, "local_album_id": 91}, {"library_id": 7, "local_album_id": 92}]],
    ids=("missing", "ambiguous"),
)
def test_resolve_identity_requires_exactly_one_row_without_leaking_paths(rows) -> None:
    repository, _ = _repository(_Connection(rows))

    with pytest.raises(CoverMutationRetryRequired) as exc_info:
        repository.resolve_identity(library_id=7, track_paths=(PRIVATE_PATH,))

    assert PRIVATE_PATH not in str(exc_info.value)


def test_resolve_identity_rejects_mismatched_or_invalid_returned_identity() -> None:
    for row in (
        {"library_id": 8, "local_album_id": 91},
        {"library_id": 7, "local_album_id": 0},
        {"library_id": True, "local_album_id": 91},
    ):
        repository, _ = _repository(_Connection([row]))
        with pytest.raises((TypeError, ValueError)):
            repository.resolve_identity(library_id=7, track_paths=(PRIVATE_PATH,))


def test_load_baseline_maps_coherent_authority_snapshot() -> None:
    connection = _Connection(
        {
            "inventory_revision": 20,
            "cover_mutation_revision": 11,
            "selected_cover_revision": " cover-11 ",
            "selected_cover_path": " covers/album.jpg ",
        }
    )
    repository, _ = _repository(connection)

    baseline = repository.load_baseline(
        identity=CoverMutationIdentity(library_id=7, local_album_id=91)
    )

    assert baseline.inventory_revision == 20
    assert baseline.cover_mutation_revision == 11
    assert baseline.selected_cover_revision == "cover-11"
    assert baseline.selected_cover_path == "covers/album.jpg"
    sql, parameters = _call(connection, "library.cover_mutation_state")
    assert "library.local_albums" in sql
    assert parameters == {"library_id": 7, "album_id": 91}


def test_load_baseline_retries_when_identity_disappears() -> None:
    repository, _ = _repository(_Connection(None))

    with pytest.raises(CoverMutationRetryRequired, match="identity no longer exists"):
        repository.load_baseline(
            identity=CoverMutationIdentity(library_id=7, local_album_id=91)
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("inventory_revision", True),
        ("inventory_revision", -1),
        ("cover_mutation_revision", True),
        ("cover_mutation_revision", -1),
    ],
)
def test_load_baseline_rejects_invalid_authority_revisions(field, value) -> None:
    row = {
        "inventory_revision": 20,
        "cover_mutation_revision": 11,
        "selected_cover_revision": None,
        "selected_cover_path": None,
    }
    row[field] = value
    repository, _ = _repository(_Connection(row))

    with pytest.raises((TypeError, ValueError)):
        repository.load_baseline(
            identity=CoverMutationIdentity(library_id=7, local_album_id=91)
        )


def test_assert_baseline_binds_identity_paths_and_revisions_without_rewriting() -> None:
    connection = _Connection(None)
    repository, _ = _repository(connection)
    request = _commit_request()

    outcome = repository.assert_baseline(request=request)

    assert outcome.status is CoverMutationStatus.COMMITTED
    assert outcome.cover_mutation_revision == 11
    assert outcome.selected_cover_revision == "cover-11"
    sql, parameters = _call(connection, "library.assert_cover_mutation_baseline")
    assert parameters == {
        "library_id": 7,
        "album_id": 91,
        "track_paths": list(request.track_paths),
        "expected_inventory_revision": 20,
        "expected_cover_mutation_revision": 11,
    }
    for argument in parameters:
        assert f"%({argument})s" in sql


def test_assert_baseline_maps_serialization_failure_to_definite_conflict() -> None:
    repository, _ = _repository(
        _Connection(execute_error=errors.SerializationFailure("stale baseline"))
    )

    with pytest.raises(CoverMutationConflict) as exc_info:
        repository.assert_baseline(request=_commit_request())

    assert exc_info.value.reason_code == "identity_conflict"


def test_commit_selection_binds_every_field_and_maps_durable_commit() -> None:
    connection = _Connection(
        {
            "committed": True,
            "cover_mutation_revision": 12,
            "reason_code": "committed",
            "finalization_checkpoint_id": 501,
            "finalization_checkpoint_revision": 44,
        }
    )
    repository, _ = _repository(connection)
    request = _commit_request()

    outcome = repository.commit_selection(request=request)

    assert outcome.status is CoverMutationStatus.COMMITTED
    assert outcome.cover_mutation_revision == 12
    assert outcome.selected_cover_revision == "cover-12"
    assert outcome.checkpoint == "authority_committed"
    assert outcome.library_id == 7
    assert outcome.local_album_id == 91
    assert outcome.task_id == 103
    assert outcome.finalization_checkpoint_id == 501
    assert outcome.finalization_checkpoint_revision == 44
    sql, parameters = _call(connection, "library.commit_cover_selection")
    assert parameters == {
        "library_id": 7,
        "album_id": 91,
        "track_paths": list(request.track_paths),
        "expected_inventory_revision": 20,
        "expected_cover_mutation_revision": 11,
        "expected_selected_cover_revision": "cover-11",
        "selected_cover_path": "covers/album.jpg",
        "promoted_cover_revision": "cover-12",
        "selected_origin": "user",
        "explicit_selection": False,
        "local_cover_width": None,
        "local_cover_height": None,
        "clear_selection": False,
        "remote_cover": None,
        "artifact_sha256": SHA256,
        "job_id": 101,
        "attempt": 3,
        "worker_id": "worker-a",
        "lease_token": "lease-a",
        "task_id": 103,
        "checkpoint_revision": 7,
        "observed_at": NOW,
    }
    for argument in parameters:
        assert f"%({argument})s" in sql


def test_commit_selection_binds_explicit_manual_cover_dimensions() -> None:
    connection = _Connection(
        {
            "committed": True,
            "cover_mutation_revision": 12,
            "reason_code": "committed",
            "finalization_checkpoint_id": 501,
            "finalization_checkpoint_revision": 44,
        }
    )
    repository, _ = _repository(connection)

    repository.commit_selection(
        request=_commit_request(
            explicit_selection=True,
            local_cover_width=1200,
            local_cover_height=800,
        )
    )

    _, parameters = _call(connection, "library.commit_cover_selection")
    assert parameters["explicit_selection"] is True
    assert parameters["local_cover_width"] == 1200
    assert parameters["local_cover_height"] == 800


def test_commit_selection_accepts_request_owned_link_without_local_revision() -> None:
    connection = _Connection(
        {
            "committed": True,
            "cover_mutation_revision": 12,
            "reason_code": "committed",
            "finalization_checkpoint_id": None,
            "finalization_checkpoint_revision": None,
        }
    )
    repository, _ = _repository(connection)

    outcome = repository.commit_selection(
        request=_commit_request(
            selected_cover_path=None,
            promoted_cover_revision=None,
            remote_cover={"remote_cover_url": "https://images.invalid/cover.jpg"},
            artifact_sha256=None,
            job_id=None,
            attempt=None,
            worker_id=None,
            lease_token=None,
            task_id=None,
            checkpoint_revision=None,
            explicit_selection=True,
            local_cover_width=None,
            local_cover_height=None,
        )
    )

    assert outcome.status is CoverMutationStatus.COMMITTED
    _, parameters = _call(connection, "library.commit_cover_selection")
    assert parameters["promoted_cover_revision"] is None
    assert parameters["selected_cover_path"] is None
    assert parameters["explicit_selection"] is True


@pytest.mark.parametrize(
    "changes,message",
    [
        (
            {"explicit_selection": "yes"},
            "explicit_selection must be a boolean",
        ),
        (
            {"selected_origin": "automatic", "explicit_selection": True},
            "explicit selection requires user origin",
        ),
        (
            {"local_cover_width": 1200, "local_cover_height": None},
            "local cover dimensions must be paired positive integers",
        ),
        (
            {"local_cover_width": 0, "local_cover_height": 800},
            "local cover dimensions must be paired positive integers",
        ),
        (
            {"local_cover_width": True, "local_cover_height": 800},
            "local cover dimensions must be paired positive integers",
        ),
        (
            {"local_cover_width": 800, "local_cover_height": -1},
            "local cover dimensions must be paired positive integers",
        ),
        (
            {
                "local_cover_width": 800,
                "local_cover_height": 800,
                "remote_cover": {"remote_cover_url": "https://images.invalid/cover.jpg"},
                "selected_cover_path": None,
            },
            "local cover dimensions require a local replacement",
        ),
        (
            {"local_cover_width": 800, "local_cover_height": 800, "clear_selection": True},
            "local cover dimensions require a local replacement",
        ),
        (
            {
                "promoted_cover_revision": None,
                "selected_cover_path": None,
                "remote_cover": {"remote_cover_url": "https://images.invalid/cover.jpg"},
            },
            "local or claimed replacement requires revision",
        ),
    ],
)
def test_commit_selection_validates_manual_metadata_before_connecting(
    changes,
    message,
) -> None:
    connector = _Connector(error=AssertionError("must not connect"))
    repository, _ = _repository(connector=connector)

    with pytest.raises((TypeError, ValueError), match=message):
        repository.commit_selection(request=_commit_request(**changes))

    assert connector.calls == []


def test_commit_selection_maps_non_durable_no_change_without_checkpoint() -> None:
    connection = _Connection(
        {
            "committed": True,
            "cover_mutation_revision": 11,
            "reason_code": "no_change",
            "finalization_checkpoint_id": None,
            "finalization_checkpoint_revision": None,
        }
    )
    repository, _ = _repository(connection)
    request = _commit_request(
        job_id=None,
        attempt=None,
        worker_id=None,
        lease_token=None,
        task_id=None,
        checkpoint_revision=None,
    )

    outcome = repository.commit_selection(request=request)

    assert outcome.status is CoverMutationStatus.COMMITTED
    assert outcome.checkpoint is None
    assert outcome.library_id is None
    assert outcome.local_album_id is None
    assert outcome.task_id is None
    assert outcome.finalization_checkpoint_id is None
    assert outcome.finalization_checkpoint_revision is None


@pytest.mark.parametrize("reason", ["canceled", "lease_lost"])
def test_commit_selection_maps_confirmed_cancellation(reason) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "committed": False,
                "cover_mutation_revision": 11,
                "reason_code": reason,
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    assert repository.commit_selection(request=_commit_request()).status is CoverMutationStatus.CANCELED


@pytest.mark.parametrize(
    "reason",
    [
        "inventory_revision_conflict",
        "revision_conflict",
        "identity_conflict",
        "selection_conflict",
    ],
)
def test_commit_selection_maps_conflict_reason(reason) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "committed": False,
                "cover_mutation_revision": 11,
                "reason_code": reason,
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    with pytest.raises(CoverMutationConflict) as exc_info:
        repository.commit_selection(request=_commit_request())

    assert exc_info.value.reason_code == reason


@pytest.mark.parametrize(
    "committed,reason",
    [
        (True, "canceled"),
        (True, "lease_lost"),
        (True, "inventory_revision_conflict"),
        (True, "revision_conflict"),
        (True, "identity_conflict"),
        (True, "selection_conflict"),
        (False, "committed"),
        (False, "no_change"),
        (False, "unknown"),
        (True, "unknown"),
        (1, "committed"),
    ],
)
def test_commit_selection_rejects_invalid_boolean_reason_combinations(committed, reason) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "committed": committed,
                "cover_mutation_revision": 12,
                "reason_code": reason,
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    with pytest.raises((TypeError, ValueError)):
        repository.commit_selection(request=_commit_request())


@pytest.mark.parametrize(
    "checkpoint_id,checkpoint_revision",
    [(None, None), (501, None), (None, 44), (0, 44), (501, True)],
)
def test_commit_selection_requires_complete_positive_durable_checkpoint_evidence(
    checkpoint_id, checkpoint_revision
) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "committed": True,
                "cover_mutation_revision": 12,
                "reason_code": "committed",
                "finalization_checkpoint_id": checkpoint_id,
                "finalization_checkpoint_revision": checkpoint_revision,
            }
        )
    )

    with pytest.raises((TypeError, ValueError)):
        repository.commit_selection(request=_commit_request())


def test_commit_selection_rejects_checkpoint_evidence_for_non_durable_request() -> None:
    repository, _ = _repository(
        _Connection(
            {
                "committed": True,
                "cover_mutation_revision": 12,
                "reason_code": "committed",
                "finalization_checkpoint_id": 501,
                "finalization_checkpoint_revision": 44,
            }
        )
    )
    request = _commit_request(
        job_id=None,
        attempt=None,
        worker_id=None,
        lease_token=None,
        task_id=None,
        checkpoint_revision=None,
    )

    with pytest.raises(ValueError):
        repository.commit_selection(request=request)


@pytest.mark.parametrize(
    "changes",
    [
        {"identity": CoverMutationIdentity(library_id=0, local_album_id=91)},
        {"identity": CoverMutationIdentity(library_id=True, local_album_id=91)},
        {"expected_inventory_revision": True},
        {"expected_inventory_revision": -1},
        {"expected_cover_mutation_revision": True},
        {"expected_cover_mutation_revision": -1},
        {"expected_selected_cover_revision": "   "},
        {"selected_cover_path": "covers/album.jpg", "promoted_cover_revision": None},
        {"selected_cover_path": None, "promoted_cover_revision": "cover-12"},
        {"selected_origin": "provider"},
        {"artifact_sha256": "A" * 64},
        {"artifact_sha256": "a" * 63},
        {"observed_at": datetime(2026, 10, 25, 12, 0)},
        {"job_id": 0},
        {"attempt": True},
        {"worker_id": "   "},
        {"lease_token": "   "},
        {"task_id": 0},
        {"checkpoint_revision": -1},
    ],
)
def test_commit_selection_validates_request_before_connecting(changes) -> None:
    connector = _Connector(error=AssertionError("must not connect"))
    repository, _ = _repository(connector=connector)

    with pytest.raises((TypeError, ValueError)):
        repository.commit_selection(request=_commit_request(**changes))

    assert connector.calls == []


@pytest.mark.parametrize(
    "action,status",
    [
        ("committed", CoverMutationStatus.COMMITTED),
        ("compensate", CoverMutationStatus.CANCELED),
        ("ambiguous", CoverMutationStatus.AMBIGUOUS),
    ],
)
def test_recover_ambiguous_maps_action_and_database_selected_revision(action, status) -> None:
    connection = _Connection(
        {
            "recovery_action": action,
            "cover_mutation_revision": 12,
            "selected_cover_revision": "database-cover-12",
            "finalization_checkpoint_id": 501,
            "finalization_checkpoint_revision": 44,
        }
    )
    repository, _ = _repository(connection)
    request = _recovery_request()

    outcome = repository.recover_ambiguous(request=request)

    assert outcome.status is status
    assert outcome.cover_mutation_revision == 12
    assert outcome.selected_cover_revision == "database-cover-12"
    assert outcome.checkpoint == (
        "authority_committed" if action == "committed" else None
    )
    assert outcome.library_id == 7
    assert outcome.local_album_id == 91
    assert outcome.task_id == 103
    assert outcome.finalization_checkpoint_id == 501
    assert outcome.finalization_checkpoint_revision == 44
    sql, parameters = _call(connection, "library.recover_cover_mutation")
    assert parameters == {
        "library_id": 7,
        "album_id": 91,
        "expected_inventory_revision": 20,
        "expected_cover_mutation_revision": 11,
        "expected_selected_cover_revision": "cover-11",
        "promoted_cover_revision": "cover-12",
        "artifact_sha256": SHA256,
        "job_id": 101,
        "attempt": 3,
        "worker_id": "worker-a",
        "lease_token": "lease-a",
        "task_id": 103,
        "checkpoint_revision": 7,
        "observed_at": NOW,
    }
    for argument in parameters:
        assert f"%({argument})s" in sql


def test_recover_ambiguous_rejects_unknown_action() -> None:
    repository, _ = _repository(
        _Connection(
            {
                "recovery_action": "unknown",
                "cover_mutation_revision": 12,
                "selected_cover_revision": None,
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    with pytest.raises(ValueError):
        repository.recover_ambiguous(request=_recovery_request())


def test_recover_ambiguous_allows_unknown_checkpoint_without_evidence() -> None:
    repository, _ = _repository(
        _Connection(
            {
                "recovery_action": "ambiguous",
                "cover_mutation_revision": 12,
                "selected_cover_revision": "database-cover-12",
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    outcome = repository.recover_ambiguous(request=_recovery_request())

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert outcome.finalization_checkpoint_id is None
    assert outcome.finalization_checkpoint_revision is None


@pytest.mark.parametrize("action", ["committed", "compensate"])
def test_recover_ambiguous_requires_owned_checkpoint_for_decisive_action(action) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "recovery_action": action,
                "cover_mutation_revision": 12,
                "selected_cover_revision": "database-cover-12",
                "finalization_checkpoint_id": None,
                "finalization_checkpoint_revision": None,
            }
        )
    )

    with pytest.raises(ValueError):
        repository.recover_ambiguous(request=_recovery_request())


@pytest.mark.parametrize(
    "checkpoint_id,checkpoint_revision",
    [(501, None), (None, 44), (0, 44), (501, -1)],
)
def test_recover_ambiguous_rejects_invalid_checkpoint_evidence(
    checkpoint_id,
    checkpoint_revision,
) -> None:
    repository, _ = _repository(
        _Connection(
            {
                "recovery_action": "ambiguous",
                "cover_mutation_revision": 12,
                "selected_cover_revision": "database-cover-12",
                "finalization_checkpoint_id": checkpoint_id,
                "finalization_checkpoint_revision": checkpoint_revision,
            }
        )
    )

    with pytest.raises((TypeError, ValueError)):
        repository.recover_ambiguous(request=_recovery_request())


@pytest.mark.parametrize(
    "changes",
    [
        {"expected_inventory_revision": True},
        {"expected_inventory_revision": -1},
        {"expected_cover_mutation_revision": True},
        {"expected_cover_mutation_revision": -1},
        {"expected_selected_cover_revision": "   "},
        {"promoted_cover_revision": "   "},
        {"artifact_sha256": None},
        {"artifact_sha256": "A" * 64},
        {"job_id": 0},
        {"attempt": True},
        {"worker_id": "   "},
        {"lease_token": "   "},
        {"task_id": 0},
        {"checkpoint_revision": -1},
        {"observed_at": datetime(2026, 10, 25, 12, 0)},
    ],
)
def test_recover_ambiguous_validates_request_before_connecting(changes) -> None:
    connector = _Connector(error=AssertionError("must not connect"))
    repository, _ = _repository(connector=connector)

    with pytest.raises((TypeError, ValueError)):
        repository.recover_ambiguous(request=_recovery_request(**changes))

    assert connector.calls == []


def test_commit_selection_keeps_pre_execution_connection_failure_definite() -> None:
    failure = OperationalError("connect failed")
    connector = _Connector(error=failure)
    repository, _ = _repository(connector=connector)

    with pytest.raises(OperationalError) as exc_info:
        repository.commit_selection(request=_commit_request())

    assert exc_info.value is failure


@pytest.mark.parametrize("failure_stage", ["execute", "commit_ack"])
def test_commit_selection_converts_may_have_committed_connection_loss_to_unknown(
    failure_stage,
) -> None:
    failure = OperationalError("connection lost")
    connection = _Connection(
        execute_error=failure if failure_stage == "execute" else None,
        exit_error=failure if failure_stage == "commit_ack" else None,
    )
    repository, _ = _repository(connection)

    with pytest.raises(CommitOutcomeUnknown) as exc_info:
        repository.commit_selection(request=_commit_request())

    assert "connection lost" not in str(exc_info.value)
    assert PRIVATE_PATH not in str(exc_info.value)
    assert exc_info.value.__cause__ is None
    assert exc_info.value.__context__ is None


def test_commit_selection_keeps_statement_timeout_definite() -> None:
    failure = errors.QueryCanceled("statement timeout")
    repository, _ = _repository(_Connection(execute_error=failure))

    with pytest.raises(errors.QueryCanceled) as exc_info:
        repository.commit_selection(request=_commit_request())

    assert exc_info.value is failure


def test_commit_selection_keeps_definite_database_error() -> None:
    failure = RuntimeError("authorization denied")
    repository, _ = _repository(_Connection(execute_error=failure))

    with pytest.raises(RuntimeError) as exc_info:
        repository.commit_selection(request=_commit_request())

    assert exc_info.value is failure
