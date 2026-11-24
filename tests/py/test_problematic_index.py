"""Unit cases of the persisted Problematic Files index that need no database."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import problematic_index


def _failing_repository(database_url):
    def connect():
        raise PermissionError("permission denied for table problematic_index_items")

    return SimpleNamespace(
        _config={problematic_index.ENABLED_KEY: "1"},
        _use_shared_connection_pool=True,
        _database_url=database_url,
        _connect_to_database=connect,
    )


def test_a_failed_maintenance_pass_backs_off_instead_of_restarting_on_every_poll(monkeypatch):
    """sandbox2 (11-19): a backfill without DELETE on its table restarted on each 2 s poll,
    re-evaluating ~2,700 albums every time."""
    repository = _failing_repository("postgresql://fixture/backoff")
    submitted = []
    monkeypatch.setattr(problematic_index._EXECUTOR, "submit", lambda function, *args: submitted.append(args))
    clock = [1000.0]
    monkeypatch.setattr(problematic_index.time, "monotonic", lambda: clock[0])

    problematic_index._maintain(repository)  # the failing pass
    problematic_index.queue_maintenance(repository)
    clock[0] += problematic_index.RETRY_AFTER_FAILURE_SECONDS - 1
    problematic_index.queue_maintenance(repository)
    assert submitted == [], "No new pass while the back-off lasts."

    clock[0] += 2
    problematic_index.queue_maintenance(repository)
    assert len(submitted) == 1, "A pass is queued again once the back-off has passed."
    problematic_index._QUEUED.discard(repository._database_url)
    problematic_index._RETRY_NOT_BEFORE.pop(repository._database_url, None)


def test_an_inline_refresh_drains_albums_and_loose_groups_on_leases_of_their_own(monkeypatch):
    """Case 55: a read that finds marked albums and marked loose groups drains each on its own lease. On one
    lease (not autocommit) the loose-group drain ran inside the transaction the album drain left open, its SET
    TRANSACTION ISOLATION LEVEL failed, and Problematic Files stayed "indexing" after a stray joined an album or
    an artist was renamed."""
    from contextlib import contextmanager

    leases, drained = [], []

    class Lease:
        def __init__(self):
            self.committed = False

        def __enter__(self):
            leases.append(self)
            return self

        def __exit__(self, exc_type, *_exc):
            self.committed = exc_type is None
            return False

    class Browse:
        def execute(self, sql, params=None):
            if "problematic_index_dirty_albums" in sql:
                return SimpleNamespace(fetchall=lambda: [{"album_id": 7, "marked_xid": "1"}])
            return SimpleNamespace(fetchall=lambda: [{"item_key": "loose", "root_id": 1, "folder": "f",
                                                      "marked_xid": "1"}])

    @contextmanager
    def browse_lease():
        yield Browse()

    repository = SimpleNamespace(
        _config={problematic_index.ENABLED_KEY: "1"},
        _use_shared_connection_pool=True,
        _database_url="postgresql://fixture/refresh-leases",
        _browse_connection_context=browse_lease,
        _connect_to_database=Lease,
    )
    monkeypatch.setattr(problematic_index, "_library_id", lambda _connection: 1)
    monkeypatch.setattr(problematic_index, "_state", lambda _connection, _library_id: "ready")
    monkeypatch.setattr(problematic_index, "_drain",
                        lambda _repository, connection, *_a, **_k: drained.append(("albums", connection)))
    monkeypatch.setattr(problematic_index, "_drain_groups",
                        lambda _repository, connection, *_a, **_k: drained.append(("groups", connection)))

    assert problematic_index.refresh(repository) is True

    assert [kind for kind, _connection in drained] == ["albums", "groups"]
    assert drained[0][1] is not drained[1][1], "the two drains never share one lease's implicit transaction"
    assert all(lease.committed for lease in leases), "each drain's lease is committed when it ends"
    problematic_index._READY.discard(repository._database_url)


class _WorkerConnection:
    """The worker's own connection: records its statements and whether it was closed."""

    def __init__(self, acquired):
        self.acquired, self.statements, self.closed = acquired, [], False

    def __enter__(self):
        return self

    def __exit__(self, *_failure):
        self.closed = True
        return False

    def execute(self, sql, _params=None):
        self.statements.append(sql)
        return SimpleNamespace(fetchone=lambda: {"locked": self.acquired} if "advisory" in sql else None)


@pytest.mark.parametrize("acquired", [True, False])
@pytest.mark.parametrize("pass_fails", [False, True])
@pytest.mark.parametrize("caller", ["maintenance", "deploy step"])
def test_the_evaluation_lock_lives_on_the_workers_own_connection_and_is_released_on_every_path(
    monkeypatch, acquired, pass_fails, caller,
):
    """BI-15 (6.5, hosted run 45209596512): the evaluation lock is a session advisory lock, so the function
    that takes it opens the connection nobody borrows next itself; a helper taking it on whatever connection
    a caller passes cannot prove that. Maintenance and the deploy step unlock whether their pass ends or
    raises, and close the connection."""
    connections = []

    def worker_connection(_repository):
        connections.append(_WorkerConnection(acquired))
        return connections[-1]

    def bring_up_to_date(*_args, **_kwargs):
        if pass_fails:
            raise RuntimeError("evaluation pass failed")
        return 0, 0

    monkeypatch.setattr(problematic_index, "_worker_connection", worker_connection)
    monkeypatch.setattr(problematic_index, "_library_id", lambda _connection: 1)
    monkeypatch.setattr(problematic_index, "_bring_up_to_date", bring_up_to_date)
    repository = SimpleNamespace(_database_url=f"postgresql://fixture/evaluation-lock-{caller}",
                                 build_problematic_file_detail_payload=lambda _key: None)

    if caller == "maintenance":
        problematic_index._maintain(repository)  # a failed pass is logged and retried later
        problematic_index._RETRY_NOT_BEFORE.pop(repository._database_url, None)
    elif not acquired:
        with pytest.raises(problematic_index.PreparationError, match="Another process"):
            problematic_index.prepare_for_serving(repository)
    elif pass_fails:
        with pytest.raises(RuntimeError, match="evaluation pass failed"):
            problematic_index.prepare_for_serving(repository)
    else:
        problematic_index.prepare_for_serving(repository)

    assert len(connections) == 1 and connections[0].closed
    unlocks = [sql for sql in connections[0].statements if "pg_advisory_unlock" in sql]
    assert unlocks == (["select pg_advisory_unlock(%s, %s::integer)"] if acquired else [])


def test_every_session_lock_is_taken_in_the_function_that_opens_the_workers_own_connection(tmp_path):
    """BI-15 (6.5, hosted run 45209596512): the freeze guard rejects a session advisory lock taken by a helper
    on a caller's connection, since nothing there proves that connection is one nobody borrows next."""
    import importlib.util
    import sys

    path = Path(__file__).resolve().parents[2] / "scripts" / "ci" / "bounded_interaction_discovery.py"
    spec = importlib.util.spec_from_file_location("bounded_interaction_discovery", path)
    discovery = sys.modules.get(spec.name) or importlib.util.module_from_spec(spec)
    if spec.name not in sys.modules:
        sys.modules[spec.name] = discovery
        spec.loader.exec_module(discovery)
    module = tmp_path / "music_app" / "services" / "problematic_index.py"
    module.parent.mkdir(parents=True)
    module.write_text(Path(problematic_index.__file__).read_text(encoding="utf-8"), encoding="utf-8")

    hazards = [hazard for hazard in discovery.analyze_python_repository(tmp_path)["hazards"]
               if hazard["rule"] == "BI-15" and "session-state" in hazard["operation"]]

    assert [(hazard["function"], hazard["line"]) for hazard in hazards] == []
