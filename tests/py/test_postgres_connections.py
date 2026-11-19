from music_app.services import postgres_connections


class _FakeConnection:
    def rollback(self):
        pass


class _FakeCheckout:
    def __init__(self, pool):
        self._pool = pool

    def __enter__(self):
        self._pool.acquired += 1
        return _FakeConnection()

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
    assert [pool.options["max_size"] for pool in _FakePool.created] == [8, 4]
    for pool in _FakePool.created:
        assert pool.options["min_size"] == 0
        assert pool.options["max_waiting"] == 32
        assert pool.options["timeout"] == 30
        assert pool.options["max_idle"] == 120
        assert pool.options["max_lifetime"] == 600
        assert pool.options["kwargs"]["connect_timeout"] == 15
        assert pool.connection_calls == 1
        assert pool.acquired == 1
        assert pool.released == 1


def test_a_lease_nested_inside_another_comes_from_a_deeper_pool_and_the_depth_unwinds(monkeypatch):
    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})
    url = "postgresql://isolated/test"

    with postgres_connections.pooled_connection(url):
        with postgres_connections.pooled_connection(url, workload="browse"):
            with postgres_connections.pooled_connection(url):
                pass
    with postgres_connections.pooled_connection(url):
        pass

    assert list(postgres_connections._pools) == [(url, "default"), (url, "browse", 1), (url, "default", 2)]
    assert [pool.options["max_size"] for pool in _FakePool.created] == [8, 4, 4]
    assert [(pool.acquired, pool.released) for pool in _FakePool.created] == [(2, 2), (1, 1), (1, 1)]


def test_a_lease_released_on_another_thread_unwinds_the_acquiring_threads_depth(monkeypatch):
    import threading

    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})
    monkeypatch.setattr(postgres_connections, "_held", {})
    url = "postgresql://isolated/test"

    shared = postgres_connections.leased_connection(url)
    released = threading.Thread(target=shared.close)
    released.start()
    released.join()

    assert postgres_connections._held == {}
    with postgres_connections.pooled_connection(url):
        pass
    assert list(postgres_connections._pools) == [(url, "default")]
