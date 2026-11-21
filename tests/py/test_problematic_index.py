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
