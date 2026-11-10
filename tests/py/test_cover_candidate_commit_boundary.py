"""Repository/cache lock-order recordings; these do not execute PostgreSQL."""
from contextlib import contextmanager

import pytest

from tests.py.cover_unit_safety import cover_unit_transports  # noqa: F401
from music_app.services import album_cover_candidate_snapshots_postgres as snapshots
from music_app.services import cover_provider_outcomes_postgres as outcomes
from music_app.services.cover_mutation import guarded_cover_transaction


@pytest.mark.parametrize("operation", ["publish", "finish", "improvement", "seen", "outcomes"])
@pytest.mark.parametrize("stale", [False, True])
def test_candidate_and_outcome_sql_precedes_short_runtime_commit_guard(operation, stale):
    events = []
    held = False

    class Connection:
        def __enter__(self):
            assert not held
            events.append("connection-enter")
            return self

        def __exit__(self, *args):
            assert not held
            events.append("connection-exit")

        @contextmanager
        def transaction(self):
            assert not held
            events.append("transaction-enter")
            try:
                yield
            except BaseException:
                assert not held
                events.append("rollback")
                raise
            else:
                assert held
                events.append("commit")

        def execute(self, sql, params=None):
            assert not held, "SQL must never start inside the runtime cache lock"
            events.append("sql")
            return self

        def fetchone(self):
            return {"accepted": True}

    def guard(commit):
        nonlocal held
        events.append("cache-enter")
        held = True
        try:
            if stale:
                raise RuntimeError("generation changed")
            commit()
        finally:
            held = False
            events.append("cache-exit")

    def connect(url):
        assert not held
        return Connection()

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused.invalid/recording"}
    repository = snapshots.AlbumCoverCandidateSnapshotRepository(config, connect=connect, commit_guard=guard)
    def act():
        if operation == "publish":
            return repository.publish_generation(
                album_id=72, search_generation="generation", search_kind="automatic",
                search_started_at="2026-11-08T12:00:00Z", candidates=[{"id": "candidate"}],
                best_candidate_id="candidate", automatic_improvement=False)
        if operation == "finish":
            return repository.finish_generation(album_id=72, search_generation="generation", status="completed")
        if operation == "improvement":
            return repository.mark_automatic_improvement(album_id=72, search_generation="generation", candidate_id="candidate")
        if operation == "seen":
            return repository.mark_seen(album_id=72)
        return outcomes.persist_cover_provider_outcomes(
            config, album_id=72, album_key="album", outcomes={"fixture": {"category": "no_candidate"}},
            connect=connect, commit_guard=guard)

    if stale:
        with pytest.raises(RuntimeError, match="generation changed"):
            act()
        assert events == ["connection-enter", "transaction-enter", "sql", "cache-enter", "cache-exit", "rollback", "connection-exit"]
    else:
        act()
        assert events == ["connection-enter", "transaction-enter", "sql", "cache-enter", "commit", "cache-exit", "connection-exit"]


@pytest.mark.parametrize("calls", [0, 1, 2])
def test_short_guard_must_exit_transaction_exactly_once(calls):
    exits = []
    @contextmanager
    def transaction():
        try:
            yield
        except BaseException:
            exits.append("rollback")
            raise
        else:
            exits.append("commit")
    def guard(commit):
        for _ in range(calls):
            commit()
    def act():
        with guarded_cover_transaction(transaction(), guard):
            pass
    if calls == 1:
        act()
    else:
        with pytest.raises(RuntimeError):
            act()
    assert exits == (["rollback"] if calls == 0 else ["commit"])
