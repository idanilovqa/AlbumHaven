from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import cover_mutation_coordinator
from music_app.services.cover_mutation_coordinator import (
    CommitOutcomeUnknown,
    CoverArtifactIdentity,
    CoverMutationBaseline,
    CoverMutationConflict,
    CoverMutationIdentity,
    CoverMutationOutcome,
    CoverMutationRequest,
    CoverMutationRetryRequired,
    CoverMutationStatus,
    compensate_if_still_owned,
    cover_advisory_keys,
    execute_cover_mutation,
    serialize_cover_mutation,
)


_DIGEST = "a" * 64
_NOW = datetime(2026, 10, 25, tzinfo=timezone.utc)
_DURABLE_FENCE = {
    "job_id": 101,
    "attempt": 2,
    "worker_id": "worker-1",
    "lease_token": "lease-1",
    "task_id": 202,
    "checkpoint_revision": 3,
}


class _UnlockRow(dict):
    def __getitem__(self, key):
        if key == 0:
            return self["unlocked"]
        if key == "pg_advisory_unlock":
            return self["unlocked"]
        return super().__getitem__(key)


class _QueryResult:
    def __init__(self, row=None):
        self._row = row

    def fetchone(self):
        return self._row


class _RecordingConnection:
    def __init__(
        self,
        events: list[str],
        *,
        acquire_error: BaseException | None = None,
        unlock_result: bool = True,
        unlock_error: BaseException | None = None,
    ) -> None:
        self.events = events
        self.acquire_error = acquire_error
        self.unlock_result = unlock_result
        self.unlock_error = unlock_error
        self.close_calls = 0

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _traceback):
        return False

    def cursor(self):
        return self

    def execute(self, query, _parameters=None):
        normalized = " ".join(str(query).casefold().split())
        if "pg_advisory_unlock" in normalized:
            self.events.append("advisory-release")
            if self.unlock_error is not None:
                raise self.unlock_error
            return _QueryResult(_UnlockRow(unlocked=self.unlock_result))
        if "pg_advisory_lock" in normalized:
            self.events.append("advisory-acquire")
            if self.acquire_error is not None:
                raise self.acquire_error
            return _QueryResult()
        raise AssertionError(f"unexpected query: {query}")

    def close(self):
        self.close_calls += 1


def _install_cover_lock_connection(monkeypatch, connection):
    @contextmanager
    def cover_lock_connection(_database_url):
        yield connection

    monkeypatch.setattr(
        cover_mutation_coordinator,
        "cover_lock_connection",
        cover_lock_connection,
    )


@contextmanager
def _recording_local_lock(events: list[str]):
    events.append("local-acquire")
    try:
        yield
    finally:
        events.append("local-release")


def _identity(local_album_id: int = 91) -> CoverMutationIdentity:
    return CoverMutationIdentity(library_id=7, local_album_id=local_album_id)


def _baseline(inventory_revision: int = 20) -> CoverMutationBaseline:
    return CoverMutationBaseline(
        inventory_revision=inventory_revision,
        cover_mutation_revision=3,
        selected_cover_revision="prior-revision",
        selected_cover_path="cover.jpg",
    )


def _artifact(path: Path) -> CoverArtifactIdentity:
    path.write_bytes(b"new-cover")
    return CoverArtifactIdentity(
        private_path=path,
        sha256=hashlib.sha256(b"new-cover").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="promoted-revision",
        prior_cover_existed=False,
        prior_cover_bytes=None,
    )


def _request(tmp_path: Path, **updates) -> CoverMutationRequest:
    values = dict(
        library_id=7,
        track_paths=(str(tmp_path / "track.flac"),),
        album_root=tmp_path,
        selected_origin="user",
        clear_selection=False,
        remote_cover=None,
        job_id=None,
        attempt=None,
        worker_id=None,
        lease_token=None,
        task_id=None,
        checkpoint_revision=None,
    )
    values.update(updates)
    return CoverMutationRequest(**values)


class _Dependencies:
    def __init__(self, tmp_path: Path) -> None:
        self.config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"}
        self.events: list[str] = []
        self.baselines = [_baseline(), _baseline()]
        self.commits: list[object] = []
        self.compensations: list[dict[str, object]] = []
        self.recoveries: list[tuple[object, object]] = []
        self.cleanup_calls: list[object] = []
        self.cancel_results: list[bool] = [False, False]
        self.commit_results: list[object] = [
            CoverMutationOutcome(
                status=CoverMutationStatus.COMMITTED,
                cover_mutation_revision=4,
            )
        ]
        self.recovery_result = CoverMutationOutcome(
            status=CoverMutationStatus.COMMITTED,
            cover_mutation_revision=4,
        )
        self._artifact_path = tmp_path / "cover.jpg"

    def resolve_identity(self, *, library_id, track_paths):
        assert library_id == 7
        assert tuple(track_paths)
        self.events.append("resolve")
        return _identity()

    def load_baseline(self, *, identity):
        assert identity == _identity()
        self.events.append("baseline")
        return self.baselines.pop(0)

    def prepare(self, request, baseline):
        assert request.library_id == 7
        self.events.append(f"prepare-{baseline.inventory_revision}")
        return f"prepared-{baseline.inventory_revision}"

    def cleanup_prepared(self, prepared):
        self.events.append(f"cleanup-{prepared}")
        self.cleanup_calls.append(prepared)

    @contextmanager
    def local_lock(self, album_root):
        assert album_root == self._artifact_path.parent
        self.events.append("lock")
        try:
            yield
        finally:
            self.events.append("unlock")

    def write_artifact(self, prepared, baseline):
        self.events.append(f"write-{prepared}-{baseline.inventory_revision}")
        return _artifact(self._artifact_path)

    def should_cancel(self):
        result = self.cancel_results.pop(0)
        self.events.append(f"cancel-{result}")
        return result

    def commit(self, request):
        self.events.append("commit")
        self.commits.append(request)
        result = self.commit_results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def compensate(self, **kwargs):
        self.events.append("compensate")
        self.compensations.append(kwargs)
        _compensate(kwargs["artifact"])

    def recover(self, request, artifact):
        self.events.append("recover")
        self.recoveries.append((request, artifact))
        return self.recovery_result

    def clock(self):
        return _NOW


def test_cover_mutation_request_accepts_complete_or_absent_durable_fence(
    tmp_path,
) -> None:
    assert _request(tmp_path)
    assert _request(tmp_path, **_DURABLE_FENCE)


@pytest.mark.parametrize(
    "updates",
    [
        pytest.param({field: value}, id=f"only-{field}")
        for field, value in _DURABLE_FENCE.items()
    ]
    + [
        pytest.param(
            {key: value for key, value in _DURABLE_FENCE.items() if key != field},
            id=f"missing-{field}",
        )
        for field in _DURABLE_FENCE
    ],
)
def test_cover_mutation_request_rejects_partial_durable_fence_before_prepare(
    tmp_path,
    updates,
) -> None:
    dependencies = _Dependencies(tmp_path)

    with pytest.raises(ValueError, match="durable cover claim"):
        execute_cover_mutation(
            request=_request(tmp_path, **updates),
            dependencies=dependencies,
        )

    assert dependencies.events == []


def test_cover_advisory_keys_are_stable_signed_int32_values() -> None:
    first = cover_advisory_keys(_identity())

    assert first == cover_advisory_keys(_identity())
    assert first != cover_advisory_keys(_identity(local_album_id=92))
    assert len(first) == 2
    assert all(-(2**31) <= value < 2**31 for value in first)


def test_serialize_cover_mutation_releases_local_before_advisory(monkeypatch) -> None:
    events: list[str] = []
    _install_cover_lock_connection(monkeypatch, _RecordingConnection(events))

    with serialize_cover_mutation(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
        identity=_identity(),
        acquire_local_lock=lambda: _recording_local_lock(events),
    ):
        events.append("body")

    assert events == [
        "advisory-acquire",
        "local-acquire",
        "body",
        "local-release",
        "advisory-release",
    ]


def test_serialize_cover_mutation_releases_in_same_order_on_body_exception(
    monkeypatch,
) -> None:
    events: list[str] = []
    _install_cover_lock_connection(monkeypatch, _RecordingConnection(events))
    body_error = RuntimeError("body failed")

    with pytest.raises(RuntimeError) as exc_info:
        with serialize_cover_mutation(
            config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
            identity=_identity(),
            acquire_local_lock=lambda: _recording_local_lock(events),
        ):
            events.append("body")
            raise body_error

    assert exc_info.value is body_error
    assert events == [
        "advisory-acquire",
        "local-acquire",
        "body",
        "local-release",
        "advisory-release",
    ]


@pytest.mark.parametrize(
    ("unlock_result", "unlock_error"),
    [(False, None), (True, RuntimeError("unlock failed"))],
    ids=("false-result", "query-error"),
)
@pytest.mark.parametrize(
    "body_error",
    [None, RuntimeError("body failed")],
    ids=("successful-body", "failed-body"),
)
def test_serialize_cover_mutation_discards_uncertain_unlock_without_masking_body(
    monkeypatch,
    unlock_result,
    unlock_error,
    body_error,
) -> None:
    events: list[str] = []
    connection = _RecordingConnection(
        events,
        unlock_result=unlock_result,
        unlock_error=unlock_error,
    )
    _install_cover_lock_connection(monkeypatch, connection)

    if body_error is None:
        with serialize_cover_mutation(
            config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
            identity=_identity(),
            acquire_local_lock=lambda: _recording_local_lock(events),
        ):
            pass
    else:
        with pytest.raises(RuntimeError) as exc_info:
            with serialize_cover_mutation(
                config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
                identity=_identity(),
                acquire_local_lock=lambda: _recording_local_lock(events),
            ):
                raise body_error

        assert exc_info.value is body_error

    assert connection.close_calls == 1


def test_serialize_cover_mutation_discards_connection_after_acquire_error(
    monkeypatch,
) -> None:
    acquire_error = RuntimeError("advisory lock acquisition failed")
    connection = _RecordingConnection([], acquire_error=acquire_error)
    _install_cover_lock_connection(monkeypatch, connection)

    with pytest.raises(RuntimeError) as exc_info:
        with serialize_cover_mutation(
            config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test"},
            identity=_identity(),
            acquire_local_lock=lambda: _recording_local_lock([]),
        ):
            pass

    assert exc_info.value is acquire_error
    assert connection.close_calls == 1


def test_execute_cover_mutation_prepares_before_first_lock(monkeypatch, tmp_path) -> None:
    dependencies = _Dependencies(tmp_path)
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.COMMITTED
    assert dependencies.events.index("prepare-20") < dependencies.events.index("lock")


@pytest.mark.parametrize(
    ("selected_path", "selected_revision", "expected_clear", "expected_origin"),
    [
        ("fallback.jpg", "fallback-revision", False, "user"),
        (None, None, True, None),
    ],
)
def test_execute_cover_mutation_resolves_deferred_delete_selection(
    monkeypatch,
    tmp_path,
    selected_path,
    selected_revision,
    expected_clear,
    expected_origin,
) -> None:
    dependencies = _Dependencies(tmp_path)
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"deleted-cover")

    def write_deleted_artifact(_prepared, _baseline):
        prior_bytes = target.read_bytes()
        target.unlink()
        return CoverArtifactIdentity(
            private_path=target,
            sha256=None,
            post_write_exists=False,
            selected_cover_path=selected_path,
            promoted_cover_revision=selected_revision,
            prior_cover_existed=True,
            prior_cover_bytes=prior_bytes,
        )

    dependencies.write_artifact = write_deleted_artifact
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    execute_cover_mutation(
        request=_request(tmp_path, clear_selection=False),
        dependencies=dependencies,
    )

    assert dependencies.commits[0].clear_selection is expected_clear
    assert dependencies.commits[0].selected_origin == expected_origin


def test_execute_cover_mutation_publishes_committed_runtime_before_unlock(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)

    def publish_committed(outcome, artifact) -> None:
        assert outcome.status is CoverMutationStatus.COMMITTED
        assert artifact.promoted_cover_revision == "promoted-revision"
        dependencies.events.append("runtime-publish")

    dependencies.publish_committed = publish_committed
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert (
        dependencies.events.index("commit")
        < dependencies.events.index("runtime-publish")
        < dependencies.events.index("unlock")
    )


def test_execute_cover_mutation_does_not_compensate_post_commit_publish_failure(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    publish_error = RuntimeError("runtime publication failed")

    def fail_publication(_outcome, _artifact) -> None:
        dependencies.events.append("runtime-publish")
        raise publish_error

    dependencies.publish_committed = fail_publication
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is publish_error
    assert dependencies.compensations == []
    assert dependencies.cleanup_calls == []
    assert (tmp_path / "cover.jpg").read_bytes() == b"new-cover"


@pytest.mark.parametrize(
    ("unlock_result", "unlock_error"),
    [(False, None), (True, RuntimeError("unlock failed"))],
    ids=("false-result", "query-error"),
)
def test_execute_cover_mutation_keeps_confirmed_commit_when_unlock_is_uncertain(
    monkeypatch,
    tmp_path,
    unlock_result,
    unlock_error,
) -> None:
    dependencies = _Dependencies(tmp_path)
    connection = _RecordingConnection(
        dependencies.events,
        unlock_result=unlock_result,
        unlock_error=unlock_error,
    )
    _install_cover_lock_connection(monkeypatch, connection)

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome == CoverMutationOutcome(
        status=CoverMutationStatus.COMMITTED,
        cover_mutation_revision=4,
    )
    assert connection.close_calls == 1
    assert len(dependencies.commits) == 1
    assert dependencies.events.count("prepare-20") == 1
    assert len([event for event in dependencies.events if event.startswith("write-")]) == 1
    assert dependencies.compensations == []


def test_execute_cover_mutation_cleans_prepared_when_lock_entry_fails(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    lock_error = RuntimeError("lock entry failed")

    @contextmanager
    def failing_serialization(**_kwargs):
        raise lock_error
        yield

    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        failing_serialization,
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is lock_error
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert not any(event.startswith("write-") for event in dependencies.events)
    assert dependencies.commits == []
    assert dependencies.compensations == []
    assert dependencies.recoveries == []


@pytest.mark.parametrize("locked_operation", ["resolve_identity", "load_baseline"])
def test_execute_cover_mutation_cleans_prepared_when_locked_read_fails(
    monkeypatch,
    tmp_path,
    locked_operation,
) -> None:
    dependencies = _Dependencies(tmp_path)
    original = getattr(dependencies, locked_operation)
    locked_error = RuntimeError(f"locked {locked_operation} failed")
    calls = 0

    def fail_on_locked_call(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise locked_error
        return original(**kwargs)

    setattr(dependencies, locked_operation, fail_on_locked_call)
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is locked_error
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert not any(event.startswith("write-") for event in dependencies.events)
    assert dependencies.commits == []
    assert dependencies.compensations == []
    assert dependencies.recoveries == []


def test_execute_cover_mutation_cleans_prepared_when_write_fails(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    write_error = RuntimeError("write failed")

    def fail_write(_prepared, _baseline):
        raise write_error

    dependencies.write_artifact = fail_write
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is write_error
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert dependencies.compensations == []
    assert dependencies.commits == []
    assert dependencies.recoveries == []


@pytest.mark.parametrize("failing_operation", ["should_cancel", "clock"])
def test_execute_cover_mutation_rolls_back_local_precommit_failure(
    monkeypatch,
    tmp_path,
    failing_operation,
) -> None:
    dependencies = _Dependencies(tmp_path)
    precommit_error = RuntimeError(f"{failing_operation} failed")
    if failing_operation == "should_cancel":
        cancel_calls = 0

        def should_cancel():
            nonlocal cancel_calls
            cancel_calls += 1
            if cancel_calls == 2:
                raise precommit_error
            return False

        dependencies.should_cancel = should_cancel
    else:

        def fail_clock():
            raise precommit_error

        dependencies.clock = fail_clock
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is precommit_error
    assert not (tmp_path / "cover.jpg").exists()
    assert len(dependencies.compensations) == 1
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert dependencies.commits == []
    assert dependencies.recoveries == []


def test_execute_cover_mutation_returns_ambiguous_when_precommit_compensation_is_uncertain(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [False]

    def fail_second_cancel():
        if dependencies.cancel_results:
            return dependencies.cancel_results.pop()
        raise RuntimeError("cancel check failed")

    compensation_calls = 0

    def uncertain_compensation(**_kwargs):
        nonlocal compensation_calls
        compensation_calls += 1
        raise CommitOutcomeUnknown("artifact ownership changed")

    dependencies.should_cancel = fail_second_cancel
    dependencies.compensate = uncertain_compensation
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert compensation_calls == 1
    assert dependencies.cleanup_calls == []
    assert dependencies.commits == []
    assert dependencies.recoveries == []


def test_inventory_race_discards_and_reprepares_then_requires_caller_retry(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.baselines = [
        _baseline(20),
        _baseline(21),
        _baseline(21),
        _baseline(22),
    ]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(
        CoverMutationRetryRequired,
        match="cover mutation baseline changed twice",
    ):
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert dependencies.cleanup_calls == ["prepared-20", "prepared-21"]
    assert dependencies.events.count("resolve") == 4
    assert dependencies.events.count("prepare-20") == 1
    assert dependencies.events.count("prepare-21") == 1
    assert not any(event.startswith("write-") for event in dependencies.events)
    assert "commit" not in dependencies.events
    assert "compensate" not in dependencies.events


@pytest.mark.parametrize(
    "values",
    [
        pytest.param(
            dict(
                private_path=Path("cover.jpg"),
                sha256=_DIGEST,
                post_write_exists=True,
                selected_cover_path="cover.jpg",
                promoted_cover_revision="revision",
                prior_cover_existed=True,
                prior_cover_bytes=b"prior",
            ),
            id="replacement",
        ),
        pytest.param(
            dict(
                private_path=Path("cover.jpg"),
                sha256=_DIGEST,
                post_write_exists=True,
                selected_cover_path="cover.jpg",
                promoted_cover_revision="revision",
                prior_cover_existed=False,
                prior_cover_bytes=None,
            ),
            id="creation",
        ),
        pytest.param(
            dict(
                private_path=Path("cover.jpg"),
                sha256=None,
                post_write_exists=False,
                selected_cover_path=None,
                promoted_cover_revision=None,
                prior_cover_existed=True,
                prior_cover_bytes=b"prior",
            ),
            id="deletion",
        ),
        pytest.param(
            dict(
                private_path=Path("discarded.jpg"),
                sha256=None,
                post_write_exists=False,
                selected_cover_path="fallback.jpg",
                promoted_cover_revision="fallback-revision",
                prior_cover_existed=True,
                prior_cover_bytes=b"discarded",
            ),
            id="deletion-with-fallback-selection",
        ),
        pytest.param(
            dict(
                private_path=None,
                sha256=None,
                post_write_exists=False,
                selected_cover_path=None,
                promoted_cover_revision=None,
                prior_cover_existed=False,
                prior_cover_bytes=None,
            ),
            id="linked-remote",
        ),
    ],
)
def test_cover_artifact_identity_accepts_valid_shapes(values) -> None:
    assert CoverArtifactIdentity(**values)


@pytest.mark.parametrize(
    "updates",
    [
        {"sha256": None},
        {"selected_cover_path": None},
        {"promoted_cover_revision": None},
        {"post_write_exists": False},
        {"private_path": None, "post_write_exists": True},
        {"private_path": None, "sha256": None, "post_write_exists": False},
        {"prior_cover_existed": True, "prior_cover_bytes": None},
        {"prior_cover_existed": False, "prior_cover_bytes": b"prior"},
        {
            "sha256": None,
            "post_write_exists": False,
            "selected_cover_path": None,
            "promoted_cover_revision": None,
            "prior_cover_existed": False,
            "prior_cover_bytes": None,
        },
        {
            "private_path": None,
            "post_write_exists": False,
            "selected_cover_path": None,
        },
        {
            "sha256": None,
            "post_write_exists": False,
            "selected_cover_path": "cover.jpg",
            "promoted_cover_revision": None,
        },
        {
            "sha256": None,
            "post_write_exists": False,
            "selected_cover_path": None,
            "promoted_cover_revision": "revision",
        },
    ],
    ids=(
        "written-file-without-digest",
        "written-file-without-selected-path",
        "written-file-without-promoted-revision",
        "deleted-file-with-digest",
        "linked-remote-marked-present",
        "linked-remote-without-digest",
        "prior-cover-without-bytes",
        "prior-bytes-without-prior-cover",
        "deletion-without-prior-cover",
        "linked-remote-with-local-prior-cover",
        "deletion-with-unpaired-selected-path",
        "deletion-with-unpaired-promoted-revision",
    ),
)
def test_cover_artifact_identity_rejects_mixed_shapes(updates) -> None:
    values = dict(
        private_path=Path("cover.jpg"),
        sha256=_DIGEST,
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )
    values.update(updates)

    with pytest.raises(ValueError):
        CoverArtifactIdentity(**values)


@pytest.mark.parametrize(
    ("selected_cover_path", "promoted_cover_revision"),
    [
        ("cover.jpg", "revision"),
        (None, None),
    ],
    ids=("selected-path", "missing-promoted-revision"),
)
def test_linked_remote_artifact_requires_only_a_promoted_revision(
    selected_cover_path,
    promoted_cover_revision,
) -> None:
    with pytest.raises(ValueError):
        CoverArtifactIdentity(
            private_path=None,
            sha256=_DIGEST,
            post_write_exists=False,
            selected_cover_path=selected_cover_path,
            promoted_cover_revision=promoted_cover_revision,
            prior_cover_existed=False,
            prior_cover_bytes=None,
        )


def test_execute_cover_mutation_cancels_before_write(monkeypatch, tmp_path) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [True]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.CANCELED
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert not any(event.startswith("write-") for event in dependencies.events)
    assert dependencies.compensations == []


def test_execute_cover_mutation_rolls_back_local_cancellation_after_write(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [False, True]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.CANCELED
    assert not (tmp_path / "cover.jpg").exists()
    assert len(dependencies.compensations) == 1
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert "commit" not in dependencies.events


def test_execute_cover_mutation_cancels_linked_remote_after_write(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [False, True]
    dependencies.write_artifact = lambda _prepared, _baseline: CoverArtifactIdentity(
        private_path=None,
        sha256=None,
        post_write_exists=False,
        selected_cover_path=None,
        promoted_cover_revision=None,
        prior_cover_existed=False,
        prior_cover_bytes=None,
    )
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.CANCELED
    assert len(dependencies.compensations) == 1
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert "commit" not in dependencies.events
    assert list(tmp_path.iterdir()) == []


def test_execute_cover_mutation_returns_ambiguous_when_compensation_is_uncertain(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [False, True]

    def uncertain_compensation(**_kwargs):
        raise CommitOutcomeUnknown("artifact ownership changed")

    dependencies.compensate = uncertain_compensation
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert dependencies.cleanup_calls == []


def test_execute_cover_mutation_rolls_back_local_commit_conflict_before_retry(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.baselines = [_baseline(), _baseline(), _baseline(), _baseline()]
    dependencies.cancel_results = [False, False, False, False]
    dependencies.commit_results = [
        CoverMutationConflict("revision_conflict"),
        CoverMutationOutcome(
            status=CoverMutationStatus.COMMITTED,
            cover_mutation_revision=4,
        ),
    ]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.COMMITTED
    assert (tmp_path / "cover.jpg").read_bytes() == b"new-cover"
    assert len(dependencies.compensations) == 1
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert len(dependencies.commits) == 2


@pytest.mark.parametrize(
    (
        "recovered_status",
        "expected_status",
        "expected_compensations",
        "expected_cleanup",
    ),
    [
        (
            CoverMutationStatus.COMMITTED,
            CoverMutationStatus.COMMITTED,
            0,
            [],
        ),
        (
            CoverMutationStatus.CANCELED,
            CoverMutationStatus.CANCELED,
            1,
            ["prepared-20"],
        ),
        (
            CoverMutationStatus.AMBIGUOUS,
            CoverMutationStatus.AMBIGUOUS,
            0,
            [],
        ),
    ],
)
def test_execute_cover_mutation_recovers_unknown_commit_outcome(
    monkeypatch,
    tmp_path,
    recovered_status,
    expected_status,
    expected_compensations,
    expected_cleanup,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.commit_results = [CommitOutcomeUnknown("connection lost")]
    dependencies.recovery_result = CoverMutationOutcome(
        status=recovered_status,
        cover_mutation_revision=(
            4 if recovered_status is CoverMutationStatus.COMMITTED else None
        ),
    )
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is expected_status
    assert len(dependencies.recoveries) == 1
    assert len(dependencies.compensations) == expected_compensations
    assert dependencies.cleanup_calls == expected_cleanup


@pytest.mark.parametrize(
    "prior_bytes",
    [pytest.param(b"prior-cover", id="replacement"), pytest.param(None, id="creation")],
)
def test_execute_cover_mutation_compensates_definite_commit_failure(
    monkeypatch,
    tmp_path,
    prior_bytes,
) -> None:
    dependencies = _Dependencies(tmp_path)
    target = tmp_path / "cover.jpg"
    if prior_bytes is not None:
        target.write_bytes(prior_bytes)

    def write_artifact(_prepared, _baseline):
        target.write_bytes(b"new-cover")
        return CoverArtifactIdentity(
            private_path=target,
            sha256=hashlib.sha256(b"new-cover").hexdigest(),
            post_write_exists=True,
            selected_cover_path="cover.jpg",
            promoted_cover_revision="promoted-revision",
            prior_cover_existed=prior_bytes is not None,
            prior_cover_bytes=prior_bytes,
        )

    commit_error = RuntimeError("definite commit failure")
    dependencies.write_artifact = write_artifact
    dependencies.commit_results = [commit_error]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(RuntimeError) as exc_info:
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert exc_info.value is commit_error
    if prior_bytes is None:
        assert not target.exists()
    else:
        assert target.read_bytes() == prior_bytes
    assert len(dependencies.compensations) == 1
    assert dependencies.cleanup_calls == ["prepared-20"]
    assert dependencies.recoveries == []
    assert (
        dependencies.events.index("lock")
        < dependencies.events.index("compensate")
        < dependencies.events.index("cleanup-prepared-20")
        < dependencies.events.index("unlock")
    )


def test_execute_cover_mutation_returns_ambiguous_when_recovery_fails(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.commit_results = [CommitOutcomeUnknown("connection lost")]

    def fail_recovery(request, artifact):
        dependencies.events.append("recover")
        dependencies.recoveries.append((request, artifact))
        raise RuntimeError("recovery failed")

    dependencies.recover = fail_recovery
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert len(dependencies.recoveries) == 1
    assert dependencies.compensations == []
    assert dependencies.cleanup_calls == []
    assert (tmp_path / "cover.jpg").read_bytes() == b"new-cover"


def test_execute_cover_mutation_rejects_unknown_dependency_outcome(
    monkeypatch,
    tmp_path,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.commit_results = [SimpleNamespace(status="unknown")]
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    with pytest.raises(AssertionError):
        execute_cover_mutation(
            request=_request(tmp_path),
            dependencies=dependencies,
        )

    assert dependencies.compensations == []
    assert dependencies.cleanup_calls == []
    assert (tmp_path / "cover.jpg").read_bytes() == b"new-cover"


def _compensation_repository():
    return SimpleNamespace(
        resolve_identity=lambda **_kwargs: _identity(),
        load_baseline=lambda **_kwargs: _baseline(),
    )


def _compensate(artifact: CoverArtifactIdentity) -> None:
    compensate_if_still_owned(
        repository=_compensation_repository(),
        baseline=_baseline(),
        identity=_identity(),
        library_id=7,
        track_paths=("track.flac",),
        artifact=artifact,
    )


def test_compensation_restores_prior_cover_bytes_and_exact_timestamps(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"new-cover")
    prior_atime_ns = 1_700_000_000_123_456_700
    prior_mtime_ns = 1_700_000_100_765_432_100
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=hashlib.sha256(b"new-cover").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="promoted-revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior-cover",
        prior_cover_atime_ns=prior_atime_ns,
        prior_cover_mtime_ns=prior_mtime_ns,
    )

    _compensate(artifact)

    restored_stat = target.stat()
    assert target.read_bytes() == b"prior-cover"
    assert restored_stat.st_atime_ns == prior_atime_ns
    assert restored_stat.st_mtime_ns == prior_mtime_ns


@pytest.mark.parametrize("failing_operation", ["resolve_identity", "load_baseline"])
def test_compensation_converts_repository_failure_to_unknown_outcome(
    tmp_path,
    failing_operation,
) -> None:
    target = tmp_path / "cover.jpg"
    artifact = _artifact(target)
    repository = _compensation_repository()

    def fail_repository_call(**_kwargs):
        raise RuntimeError(f"{failing_operation} unavailable")

    setattr(repository, failing_operation, fail_repository_call)

    with pytest.raises(CommitOutcomeUnknown):
        compensate_if_still_owned(
            repository=repository,
            baseline=_baseline(),
            identity=_identity(),
            library_id=7,
            track_paths=("track.flac",),
            artifact=artifact,
        )

    assert target.read_bytes() == b"new-cover"


class _MalformedAuthority:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    @property
    def cover_mutation_revision(self):
        raise self.error


class _ValidationFilesystemPath:
    def __init__(self, path: Path, error: BaseException) -> None:
        self.path = path
        self.error = error

    def lstat(self):
        raise self.error


@pytest.mark.parametrize(
    "validation_source",
    ["repository", "ownership", "filesystem"],
)
@pytest.mark.parametrize(
    "validation_error_type",
    [AssertionError, TypeError, ValueError],
    ids=("assertion-error", "type-error", "value-error"),
)
def test_execute_cover_mutation_returns_ambiguous_for_malformed_compensation_state(
    monkeypatch,
    tmp_path,
    validation_source,
    validation_error_type,
) -> None:
    dependencies = _Dependencies(tmp_path)
    dependencies.cancel_results = [False, True]
    repository = _compensation_repository()
    validation_error = validation_error_type("malformed compensation state")

    if validation_source == "repository":

        def fail_identity_resolution(**_kwargs):
            raise validation_error

        repository.resolve_identity = fail_identity_resolution
    elif validation_source == "ownership":
        repository.load_baseline = lambda **_kwargs: _MalformedAuthority(
            validation_error
        )

    def compensate(**kwargs):
        artifact = kwargs["artifact"]
        if validation_source == "filesystem":
            artifact = CoverArtifactIdentity(
                private_path=_ValidationFilesystemPath(
                    artifact.private_path,
                    validation_error,
                ),
                sha256=artifact.sha256,
                post_write_exists=artifact.post_write_exists,
                selected_cover_path=artifact.selected_cover_path,
                promoted_cover_revision=artifact.promoted_cover_revision,
                prior_cover_existed=artifact.prior_cover_existed,
                prior_cover_bytes=artifact.prior_cover_bytes,
            )
        compensate_if_still_owned(
            repository=repository,
            baseline=kwargs["baseline"],
            identity=kwargs["identity"],
            library_id=kwargs["library_id"],
            track_paths=kwargs["track_paths"],
            artifact=artifact,
        )

    dependencies.compensate = compensate
    monkeypatch.setattr(
        cover_mutation_coordinator,
        "serialize_cover_mutation",
        lambda **_kwargs: dependencies.local_lock(tmp_path),
    )

    outcome = execute_cover_mutation(
        request=_request(tmp_path),
        dependencies=dependencies,
    )

    assert outcome.status is CoverMutationStatus.AMBIGUOUS
    assert (tmp_path / "cover.jpg").read_bytes() == b"new-cover"
    assert dependencies.cleanup_calls == []
    assert dependencies.commits == []


class _FailingFilesystemPath:
    def __init__(self, path: Path, failing_operation: str) -> None:
        self.path = path
        self.failing_operation = failing_operation
        self.read_calls = 0
        self.unlink_calls = 0

    def lstat(self):
        return self.path.lstat()

    def is_file(self):
        return self.path.is_file()

    def read_bytes(self):
        self.read_calls += 1
        if self.failing_operation == "read_bytes":
            raise OSError("read failed")
        return self.path.read_bytes()

    def exists(self):
        return self.path.exists()

    def unlink(self, *, missing_ok=False):
        self.unlink_calls += 1
        if self.failing_operation == "unlink":
            raise OSError("unlink failed")
        return self.path.unlink(missing_ok=missing_ok)


@pytest.mark.parametrize("failing_operation", ["read_bytes", "unlink"])
def test_compensation_converts_filesystem_failure_to_unknown_without_changing_bytes(
    tmp_path,
    failing_operation,
) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"replacement")
    failing_path = _FailingFilesystemPath(target, failing_operation)
    artifact = CoverArtifactIdentity(
        private_path=failing_path,
        sha256=hashlib.sha256(b"replacement").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=failing_operation == "read_bytes",
        prior_cover_bytes=b"prior" if failing_operation == "read_bytes" else None,
    )

    with pytest.raises(CommitOutcomeUnknown):
        _compensate(artifact)

    assert target.read_bytes() == b"replacement"
    assert failing_path.read_calls == 1
    assert failing_path.unlink_calls == (1 if failing_operation == "unlink" else 0)


def test_compensation_restores_replaced_cover(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"replacement")
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=hashlib.sha256(b"replacement").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    _compensate(artifact)

    assert target.read_bytes() == b"prior"


def test_compensation_removes_newly_created_cover(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"new-cover")
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=hashlib.sha256(b"new-cover").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=False,
        prior_cover_bytes=None,
    )

    _compensate(artifact)

    assert not target.exists()


def test_compensation_restores_deleted_cover(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=None,
        post_write_exists=False,
        selected_cover_path=None,
        promoted_cover_revision=None,
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    _compensate(artifact)

    assert target.read_bytes() == b"prior"


def test_compensation_for_linked_remote_has_no_local_artifact(tmp_path) -> None:
    artifact = CoverArtifactIdentity(
        private_path=None,
        sha256=None,
        post_write_exists=False,
        selected_cover_path=None,
        promoted_cover_revision=None,
        prior_cover_existed=False,
        prior_cover_bytes=None,
    )

    _compensate(artifact)

    assert list(tmp_path.iterdir()) == []


def test_compensation_rejects_recreated_deleted_path_without_touching_bytes(
    tmp_path,
) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"later-writer")
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=None,
        post_write_exists=False,
        selected_cover_path=None,
        promoted_cover_revision=None,
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    with pytest.raises(CommitOutcomeUnknown):
        _compensate(artifact)

    assert target.read_bytes() == b"later-writer"


def test_compensation_rejects_digest_mismatch_without_touching_bytes(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"later-writer")
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=hashlib.sha256(b"our-write").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    with pytest.raises(CommitOutcomeUnknown):
        _compensate(artifact)

    assert target.read_bytes() == b"later-writer"


def test_compensation_rejects_symlink_without_touching_target(tmp_path) -> None:
    target = tmp_path / "target.jpg"
    target.write_bytes(b"outside-cover")
    link = tmp_path / "cover.jpg"
    link.symlink_to(target)
    artifact = CoverArtifactIdentity(
        private_path=link,
        sha256=hashlib.sha256(b"outside-cover").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    with pytest.raises(CommitOutcomeUnknown):
        _compensate(artifact)

    assert link.is_symlink()
    assert target.read_bytes() == b"outside-cover"


def test_compensation_rejects_non_regular_path_without_mutating_it(tmp_path) -> None:
    target = tmp_path / "cover.jpg"
    target.mkdir()
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=_DIGEST,
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=False,
        prior_cover_bytes=None,
    )

    with pytest.raises(CommitOutcomeUnknown):
        _compensate(artifact)

    assert target.is_dir()


@pytest.mark.parametrize(
    "mismatch",
    [
        "identity",
        "cover_mutation_revision",
        "selected_cover_revision",
        "selected_cover_path",
    ],
)
def test_compensation_rejects_authority_mismatch_without_touching_bytes(
    tmp_path,
    mismatch,
) -> None:
    target = tmp_path / "cover.jpg"
    target.write_bytes(b"replacement")
    current_identity = _identity(92) if mismatch == "identity" else _identity()
    current_baseline = CoverMutationBaseline(
        inventory_revision=20,
        cover_mutation_revision=4 if mismatch == "cover_mutation_revision" else 3,
        selected_cover_revision=(
            "later-revision"
            if mismatch == "selected_cover_revision"
            else "prior-revision"
        ),
        selected_cover_path=(
            "later-cover.jpg" if mismatch == "selected_cover_path" else "cover.jpg"
        ),
    )
    repository = SimpleNamespace(
        resolve_identity=lambda **_kwargs: current_identity,
        load_baseline=lambda **_kwargs: current_baseline,
    )
    artifact = CoverArtifactIdentity(
        private_path=target,
        sha256=hashlib.sha256(b"replacement").hexdigest(),
        post_write_exists=True,
        selected_cover_path="cover.jpg",
        promoted_cover_revision="revision",
        prior_cover_existed=True,
        prior_cover_bytes=b"prior",
    )

    with pytest.raises(CommitOutcomeUnknown):
        compensate_if_still_owned(
            repository=repository,
            baseline=_baseline(),
            identity=_identity(),
            library_id=7,
            track_paths=("track.flac",),
            artifact=artifact,
        )

    assert target.read_bytes() == b"replacement"


def test_linked_remote_artifact_accepts_canonical_remote_digest_without_local_identity():
    artifact = CoverArtifactIdentity(
        private_path=None, sha256=_DIGEST, post_write_exists=False,
        selected_cover_path=None, promoted_cover_revision="remote-revision",
        prior_cover_existed=False, prior_cover_bytes=None,
    )

    assert artifact.sha256 == _DIGEST
    assert artifact.private_path is None
    assert artifact.selected_cover_path is None
