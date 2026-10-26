import pytest

from music_app.services import postgres_connections


class _FakeCheckout:
    def __init__(self, pool):
        self._pool = pool

    def __enter__(self):
        self._pool.acquired += 1
        return object()

    def __exit__(self, _exc_type, _exc, _traceback):
        self._pool.released += 1


class _FakePool:
    created = []

    def __init__(self, **options):
        self.options = options
        self.connection_calls = 0
        self.acquired = 0
        self.released = 0
        self.created.append(self)

    def connection(self):
        self.connection_calls += 1
        return _FakeCheckout(self)

    def get_stats(self):
        return {}


def test_connection_pool_prewarm_is_bounded_to_one_released_lease_per_workload(monkeypatch):
    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})

    postgres_connections.prewarm_connection_pool("postgresql://isolated/test")

    assert set(postgres_connections._pools) == {
        ("postgresql://isolated/test", "default"),
        ("postgresql://isolated/test", "browse"),
    }
    assert len(_FakePool.created) == 2
    for pool in _FakePool.created:
        assert pool.options["min_size"] == 0
        assert pool.options["max_size"] == 4
        assert pool.options["max_waiting"] == 32
        assert pool.options["timeout"] == 30
        assert pool.options["max_idle"] == 120
        assert pool.options["max_lifetime"] == 600
        assert pool.options["kwargs"]["connect_timeout"] == 15
        assert pool.connection_calls == 1
        assert pool.acquired == 1
        assert pool.released == 1


@pytest.mark.parametrize("failure_point", ["connection", "enter"])
def test_cover_lock_connection_translates_pool_checkout_timeout(
    monkeypatch,
    failure_point,
) -> None:
    timeout = postgres_connections.PoolTimeout("checkout timed out")

    class TimeoutCheckout:
        def __enter__(self):
            raise timeout

        def __exit__(self, *_args):
            return False

    class TimeoutPool(_FakePool):
        def connection(self):
            if failure_point == "connection":
                raise timeout
            return TimeoutCheckout()

    monkeypatch.setattr(postgres_connections, "ConnectionPool", TimeoutPool)
    monkeypatch.setattr(postgres_connections, "_pools", {})

    with pytest.raises(RuntimeError, match="connection pool exhausted") as exc_info:
        with postgres_connections.cover_lock_connection("postgresql://isolated/test"):
            pass

    assert exc_info.value.__cause__ is timeout


def test_cover_lock_connection_preserves_pool_timeout_from_mutation_body(
    monkeypatch,
) -> None:
    body_timeout = postgres_connections.PoolTimeout("mutation body timed out")
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})

    with pytest.raises(postgres_connections.PoolTimeout) as exc_info:
        with postgres_connections.cover_lock_connection("postgresql://isolated/test"):
            raise body_timeout

    assert exc_info.value is body_timeout


def test_cover_lock_pool_is_separate_from_cover_lock_workload_pool(monkeypatch) -> None:
    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})
    database_url = "postgresql://isolated/test"

    with postgres_connections.pooled_connection(database_url, workload="cover-lock"):
        pass
    workload_pool = _FakePool.created[0]
    with postgres_connections.cover_lock_connection(database_url):
        pass

    assert len(_FakePool.created) == 2
    assert len(postgres_connections._pools) == 2
    cover_lock_pool = _FakePool.created[1]
    assert cover_lock_pool is not workload_pool
    assert cover_lock_pool.options["min_size"] == 0
    assert cover_lock_pool.options["max_size"] == 4
    assert cover_lock_pool.options["max_waiting"] == 32
    assert cover_lock_pool.options["timeout"] == 30
    assert cover_lock_pool.options["max_idle"] == 120
    assert cover_lock_pool.options["max_lifetime"] == 600
    assert cover_lock_pool.options["kwargs"] == {"autocommit": True}
