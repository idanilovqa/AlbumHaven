import pytest

from music_app.services import postgres_connections


class _FakeConnection:
    autocommit = False

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
        self.min_size = options["min_size"]
        self.max_size = options["max_size"]
        self.connection_calls = 0
        self.acquired = 0
        self.released = 0
        self.created.append(self)

    def connection(self):
        self.connection_calls += 1
        return _FakeCheckout(self)

    def get_stats(self):
        return {}

    def resize(self, min_size, max_size=None):
        self.min_size = min_size
        self.max_size = max_size


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
    # Pools start cold; only gallery and search reads keep a connection once one succeeded.
    assert [pool.options["min_size"] for pool in _FakePool.created] == [0, 0]
    assert [pool.min_size for pool in _FakePool.created] == [0, 1]
    for pool in _FakePool.created:
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


def test_a_leased_connection_applies_settings_to_the_connection_it_wraps(monkeypatch):
    # scan_cache persistence reads revisions in autocommit before its write transaction; a setting kept
    # on the wrapper would leave that read inside an open transaction and nest the save in a savepoint.
    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})
    monkeypatch.setattr(postgres_connections, "_held", {})

    with postgres_connections.leased_connection("postgresql://isolated/test") as connection:
        connection.autocommit = True
        assert connection._connection.autocommit is True
        assert connection.autocommit is True
        assert "autocommit" not in vars(connection)


def test_a_browse_pool_whose_connection_fails_stays_cold(monkeypatch):
    class _FailingCheckout:
        def __enter__(self):
            raise OSError("database unreachable")

        def __exit__(self, *_args):
            return False

    _FakePool.created = []
    monkeypatch.setattr(postgres_connections, "ConnectionPool", _FakePool)
    monkeypatch.setattr(postgres_connections, "_pools", {})
    monkeypatch.setattr(_FakePool, "connection", lambda self: _FailingCheckout())

    try:
        with postgres_connections.pooled_connection("postgresql://isolated/test", workload="browse"):
            pass
    except OSError:
        pass

    # A warm minimum on an unreachable database would leave a reconnect loop that shutdown waits on.
    assert [pool.min_size for pool in _FakePool.created] == [0]


def test_after_a_failed_connection_checkouts_fail_at_once_until_the_next_probe(monkeypatch):
    # A real pool against a closed port. Its background attempts keep failing, but a checkout used to
    # wait out the whole pool timeout (30 s) every time (freeze-guard case 30).
    import time

    import psycopg

    def refuse(cls, *_args, **_kwargs):
        raise psycopg.OperationalError("connection refused")

    # The driver refuses at once, as a missing database or failed authentication does; the pool,
    # its background attempts and its recording connection class are the real ones.
    monkeypatch.setattr(psycopg.Connection, "connect", classmethod(refuse))
    monkeypatch.setattr(postgres_connections, "_pools", {})
    monkeypatch.setattr(postgres_connections, "_connect_states", {})
    url = "postgresql://album_haven_app@127.0.0.1/unreachable"
    try:
        with pytest.raises(Exception):
            with postgres_connections.pooled_connection(url, checkout_timeout_seconds=1):
                pass
        started = time.perf_counter()
        for _ in range(20):
            with pytest.raises(psycopg.OperationalError, match="Postgres is unreachable"):
                with postgres_connections.pooled_connection(url):
                    pass
        assert time.perf_counter() - started < 0.5
    finally:
        postgres_connections.close_pools()
