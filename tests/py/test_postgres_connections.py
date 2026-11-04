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
