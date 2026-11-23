"""Unit cases of the persisted Problematic Files index that need no database."""
from types import SimpleNamespace

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
