"""Case 64: the Loose Tracks store's start-up owner builds without any read, retries a failed build on its own
timer, and touches no database while the store is ready."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services import loose_track_store


class _Repository:
    def __init__(self, reads):
        self._inventory_repository = object()
        self._reads = reads

    def _owned_connection_context(self):
        raise AssertionError("only prepare() touches the database, and it is stubbed here")

    def build_library_loose_tracks_payload(self, **_kwargs):
        self._reads.append(True)


def _owner(monkeypatch, outcomes, reads, repositories):
    """An owner whose prepare() returns (or raises) each outcome in turn, and whose stop event records waits."""
    prepared, waits = [], []
    outcomes = iter(outcomes)

    def prepare(inventory, _connect):
        prepared.append(inventory)
        outcome = next(outcomes)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    def repository():
        repositories.append(True)
        return _Repository(reads)

    monkeypatch.setattr(loose_track_store, "prepare", prepare)
    owner = loose_track_store.LooseTrackStoreOwner({}, repository_factory=repository)
    # wait() returns False: the timer ran out and the owner was not stopped.
    owner._stop = SimpleNamespace(wait=lambda seconds=None: waits.append(seconds) or False, set=lambda: None)
    return owner, prepared, waits


def test_a_fresh_store_is_prepared_at_start_without_any_read(monkeypatch):
    reads, repositories = [], []
    owner, prepared, _waits = _owner(monkeypatch, [None], reads, repositories)

    owner._run()

    assert len(prepared) == 1, "start-up preparation runs once, in the background owner"
    assert reads == [], "no read is needed for the store to become ready"


def test_a_ready_store_makes_no_database_call_while_idle(monkeypatch):
    """With the store ready, the owner keeps no timer that opens a connection: an idle hour makes 0 calls."""
    reads, repositories = [], []
    owner, prepared, waits = _owner(monkeypatch, [None], reads, repositories)

    owner._run()

    assert len(prepared) == 1 and len(repositories) == 1, "only the start-up pass touches the database"
    assert all(wait is None for wait in waits), "with nothing failed the owner only waits on its stop event"


def test_a_failed_build_is_retried_after_its_backoff_with_no_read(monkeypatch):
    reads, repositories = [], []
    owner, prepared, waits = _owner(monkeypatch, [RuntimeError("build failed"), None], reads, repositories)

    owner._run()

    assert waits[0] == loose_track_store.FAILED_BUILD_RETRY_SECONDS, "the retry time comes from its own prepare()"
    assert len(prepared) == 2, "the build is retried once its backoff has passed"
    assert reads == []


def test_a_failed_build_from_before_a_restart_is_retried_at_its_stored_time(monkeypatch):
    """prepare() returns how long a failed, not yet due build still waits; the owner waits exactly that."""
    reads, repositories = [], []
    owner, prepared, waits = _owner(monkeypatch, [120.0, None], reads, repositories)

    owner._run()

    assert waits[0] == 120.0 and len(prepared) == 2
    assert reads == []


def test_a_store_batch_refuses_to_load_candidates_without_its_callers_connection():
    """The loader leases its own connection when none is given: a store batch must never reach that."""
    import pytest

    loaded = []
    inventory = SimpleNamespace(load_non_album_candidates=lambda **options: loaded.append(options) or [])

    with pytest.raises(TypeError, match="connection"):
        loose_track_store._load_candidates(inventory, None, [1])
    assert loaded == [], "no candidates load without the caller's connection"


def test_a_second_preparation_in_the_process_returns_at_once_without_any_database_call():
    """The queued drain shares one prewarm worker with rules and duplicate identities: it never waits for a build."""
    def connect():
        raise AssertionError("a busy preparation opens no connection")

    assert loose_track_store._PREPARE_LOCK.acquire(blocking=False)
    try:
        assert loose_track_store.prepare(object(), connect) == loose_track_store._BUSY_RECHECK_SECONDS
    finally:
        loose_track_store._PREPARE_LOCK.release()


def test_a_build_another_process_holds_is_not_taken_for_an_interrupted_one(monkeypatch):
    statements = []

    class _Owner:
        def execute(self, statement, *_args):
            statements.append(statement)
            return SimpleNamespace(fetchone=lambda: {"held": False})

    class _Connect:
        def __enter__(self):
            return _Owner()

        def __exit__(self, *_exc):
            return False

    monkeypatch.setattr(loose_track_store, "_build_rows", lambda *_args, **_kwargs: pytest.fail("built twice"))

    assert loose_track_store.build(object(), _Connect) is None
    assert statements == [loose_track_store._BUILD_LOCK_SQL]
