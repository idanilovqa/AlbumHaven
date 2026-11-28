import threading
import time

import psycopg
import pytest
from psycopg.pq import TransactionStatus
from psycopg.rows import dict_row, tuple_row
from psycopg_pool import PoolTimeout

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

    assert list(postgres_connections._pools) == [
        ("postgresql://isolated/test", "browse"),
        ("postgresql://isolated/test", "default"),
        ("postgresql://isolated/test", "cover-references"),
        ("postgresql://isolated/test", "cover_inventory"),
    ]
    assert [pool.options["max_size"] for pool in _FakePool.created] == [4, 8, 4, 4]
    # Pools start cold; the request-path pools keep two connections once one succeeded.
    assert [pool.options["min_size"] for pool in _FakePool.created] == [0, 0, 0, 0]
    assert [pool.min_size for pool in _FakePool.created] == [2, 2, 2, 2]
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


class _DriverConnection:
    """What the real pool needs from a psycopg connection."""

    def __init__(self):
        self.closed = False
        self.pgconn = self
        self.autocommit = False
        self.isolation_level = self.read_only = self.deferrable = None
        self.row_factory = dict_row
        self.prepare_threshold = 5
        self.cursor_factory = psycopg.Cursor
        self.server_cursor_factory = psycopg.ServerCursor

    @property
    def transaction_status(self):
        return TransactionStatus.UNKNOWN if self.closed else TransactionStatus.IDLE

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def rollback(self):
        pass

    def execute(self, *statement):
        if self.closed:
            raise psycopg.OperationalError("the connection is closed")
        self.executed = statement
        return self

    def close(self):
        self.closed = True


class _Driver:
    def __init__(self):
        self.refusing = False
        self.delay = 0.0
        self.attempts = 0
        self.refused = threading.Event()
        self.connections = []

    def connect(self, *_args, **_kwargs):
        self.attempts += 1
        time.sleep(self.delay)
        if self.refusing:
            self.refused.set()
            raise psycopg.OperationalError("connection refused")
        connection = _DriverConnection()
        self.connections.append(connection)
        return connection


@pytest.fixture
def driver(monkeypatch):
    """The real pool, workers and recording class; only the driver's connect is replaced."""
    driver = _Driver()
    monkeypatch.setattr(psycopg.Connection, "connect", classmethod(lambda _cls, *a, **k: driver.connect(*a, **k)))
    monkeypatch.setattr(postgres_connections, "_pools", {})
    monkeypatch.setattr(postgres_connections, "_connect_states", {})
    monkeypatch.setattr(postgres_connections, "_held", {})
    # No warm minimum unless a test asks for one, so "the pool's connection" is a single object.
    monkeypatch.setattr(postgres_connections, "POOL_MIN_CONNECTIONS", 0)
    yield driver
    postgres_connections.close_pools()


_URL = "postgresql://album_haven_app@127.0.0.1/pool_contract"


def _checkout(timeout=None):
    with postgres_connections.pooled_connection(_URL, checkout_timeout_seconds=timeout) as connection:
        return connection


def _fail_one_growth_attempt(driver):
    """With the only connection leased, another caller makes the pool grow and the driver refuse."""
    driver.refusing = True

    def wanting_another():
        with pytest.raises(PoolTimeout):
            _checkout(0.2)

    other = threading.Thread(target=wanting_another)
    other.start()
    assert driver.refused.wait(5)
    other.join(5)


def test_a_failed_growth_attempt_never_refuses_a_healthy_idle_connection(driver):
    with postgres_connections.pooled_connection(_URL) as only:
        _fail_one_growth_attempt(driver)

    assert [_checkout() for _ in range(100)] == [only] * 100


def test_a_busy_pool_with_failed_growth_waits_for_the_returned_connection(driver):
    served = []
    with postgres_connections.pooled_connection(_URL) as only:
        _fail_one_growth_attempt(driver)
        waiter = threading.Thread(target=lambda: served.append(_checkout(5)))
        waiter.start()
        time.sleep(0.1)
    waiter.join(5)

    assert served == [only]


def test_a_failed_growth_attempt_is_forgotten_once_the_healthy_connection_expires(driver):
    with postgres_connections.pooled_connection(_URL) as only:
        _fail_one_growth_attempt(driver)
    driver.refusing = False
    only.close()  # as max_idle and max_lifetime do

    # The pool discards the closed connection on its next check and opens another.
    postgres_connections._pools[(_URL, "default")].check()
    assert _checkout(5) is not only


def test_an_unreachable_database_fails_the_first_and_every_later_checkout_at_once(driver):
    driver.refusing = True
    started = time.perf_counter()

    for _ in range(100):
        with pytest.raises(psycopg.OperationalError, match="Postgres is unreachable"):
            _checkout()

    assert time.perf_counter() - started < 1
    assert driver.attempts <= 3, "refused checkouts must not each open a connection"


def test_losing_the_last_connection_to_an_outage_fails_checkouts_at_once(driver):
    with postgres_connections.pooled_connection(_URL) as only:
        driver.refusing = True
        only.close()  # the server went away mid-lease
    assert driver.refused.wait(5)
    started = time.perf_counter()

    with pytest.raises(psycopg.OperationalError, match="Postgres is unreachable"):
        _checkout()

    assert time.perf_counter() - started < 0.5


def test_a_slow_healthy_first_connection_is_waited_for(driver):
    driver.delay = 5.5

    assert _checkout() is driver.connections[0]


def test_creating_a_lease_never_waits_only_entering_it_does(driver):
    lease = postgres_connections.pooled_connection(_URL)  # may happen on the event loop

    assert driver.attempts == 0
    with lease as connection:
        assert connection is driver.connections[0]


@pytest.mark.parametrize("requests_during_outage", [True, False])
def test_checkouts_recover_within_seconds_of_the_database_returning(driver, requests_during_outage):
    driver.refusing = True
    outage_ends = time.perf_counter() + 8
    with pytest.raises(psycopg.OperationalError):
        _checkout()
    while time.perf_counter() < outage_ends:
        if requests_during_outage:
            with pytest.raises(psycopg.OperationalError):
                _checkout()
        time.sleep(0.05)

    driver.refusing = False
    if not requests_during_outage:
        assert _checkout(5) in driver.connections, "the first request after a quiet outage is served"
        return
    recovered_by = time.perf_counter() + 4
    while True:
        try:
            assert _checkout(1) in driver.connections
            break
        except psycopg.OperationalError:
            assert time.perf_counter() < recovered_by, "still refusing after the database returned"
            time.sleep(0.05)


def test_a_full_queue_of_timed_out_waiters_cannot_block_reconnection(driver):
    with postgres_connections.pooled_connection(_URL) as only:
        driver.refusing = True

        def wanting_another():
            with pytest.raises(psycopg.OperationalError):
                _checkout(0.2)

        waiters = [threading.Thread(target=wanting_another) for _ in range(32)]
        for waiter in waiters:
            waiter.start()
        for waiter in waiters:
            waiter.join(5)
        only.close()
    time.sleep(8)  # longer than the pool keeps retrying by itself

    driver.refusing = False
    recovered_by = time.perf_counter() + 4
    while True:
        try:
            assert _checkout(1) is not only
            break
        except psycopg.OperationalError:
            assert time.perf_counter() < recovered_by, "the stale queue kept the pool from reconnecting"
            time.sleep(0.05)


@pytest.mark.parametrize(
    "setting, changed",
    [
        ("autocommit", True),
        ("isolation_level", psycopg.IsolationLevel.SERIALIZABLE),
        ("read_only", True),
        ("deferrable", True),
        ("row_factory", tuple_row),
        ("prepare_threshold", None),
        ("cursor_factory", psycopg.ClientCursor),
        ("server_cursor_factory", psycopg.ClientCursor),
    ],
)
def test_a_borrowers_session_setting_never_reaches_the_next_borrower(driver, setting, changed):
    # 0.11.45: the Last.fm retry's autocommit stayed on the connection, so later writes lost atomicity.
    with postgres_connections.pooled_connection(_URL) as first:
        default = getattr(first, setting)
        setattr(first, setting, changed)

    with postgres_connections.pooled_connection(_URL) as following:
        assert following is first
        assert getattr(following, setting) == default


def test_a_waiting_borrower_is_handed_the_connection_with_default_settings(driver):
    served = []

    def wait_for_it():
        with postgres_connections.pooled_connection(_URL) as connection:
            served.append(connection.autocommit)

    with postgres_connections.pooled_connection(_URL) as first:
        driver.delay = 1  # growth is slower than the first borrower's return
        waiter = threading.Thread(target=wait_for_it)
        waiter.start()
        time.sleep(0.1)
        first.autocommit = True
    waiter.join(5)

    assert served == [False]


def test_a_session_lease_is_never_reused_and_never_takes_a_request_connection(driver):
    with postgres_connections.session_connection(_URL) as holder:
        pass  # a session lock it failed to release ends with the connection

    assert holder.closed
    with postgres_connections.session_connection(_URL) as following:
        assert following is not holder
    assert list(postgres_connections._pools) == [(_URL, "session")]
    assert postgres_connections._pools[(_URL, "session")].max_size == 8, "room for concurrent saves"


def test_the_tag_edit_lock_holds_a_session_lease():
    from music_app.services.tag_edit_intents_postgres import PostgresTagEditIntentRepository

    repository = PostgresTagEditIntentRepository({"ALBUM_HAVEN_APP_DATABASE_URL": _URL})

    assert repository._lock_connect is postgres_connections.session_connection


@pytest.mark.parametrize("released_by", ["close", "with"])
@pytest.mark.parametrize(
    "late_use",
    [
        lambda released: released.execute("select 1"),
        lambda released: setattr(released, "autocommit", True),
        lambda released: released.__enter__(),
        lambda released: released.cursor,
    ],
    ids=["execute", "set-autocommit", "with-again", "read-attribute"],
)
def test_a_released_lease_cannot_drive_the_next_borrowers_connection(driver, released_by, late_use):
    released = postgres_connections.leased_connection(_URL)
    if released_by == "close":
        released.close()
    else:
        with released:
            pass

    with postgres_connections.pooled_connection(_URL) as following:
        with pytest.raises(psycopg.OperationalError, match="the connection is closed"):
            late_use(released)
        assert following.autocommit is False
        assert not hasattr(following, "executed")


def test_a_released_lease_reports_closed_and_closes_again_quietly(driver):
    released = postgres_connections.leased_connection(_URL)
    assert released.closed is False
    with released:
        released.close()

    released.close()

    assert released.closed is True


def test_a_checkout_spends_one_timeout_on_connecting_and_leasing_together(driver, monkeypatch):
    waits = []
    lease_from_pool = postgres_connections.ConnectionPool.connection

    def record_wait(pool, timeout=None):
        waits.append(timeout)
        return lease_from_pool(pool, timeout=timeout)

    monkeypatch.setattr(postgres_connections.ConnectionPool, "connection", record_wait)
    driver.delay = 1.0

    _checkout(3.0)

    assert waits[-1] <= 2.1, "connecting took about 1 s of the 3 s"


def test_a_cover_runs_shared_connection_never_leases_again_after_the_run(driver):
    from music_app.services.scan_cache_persistence import _SharedConnection

    leased = []
    shared = _SharedConnection(_URL, lambda: leased.append(True) or postgres_connections.leased_connection(_URL))
    shared.close()

    with pytest.raises(RuntimeError, match="closed"):
        with shared.transaction():
            pass
    assert leased == []


def _open_connections(driver):
    return [connection for connection in driver.connections if not connection.closed]


def _wait_until(condition, timeout=5.0):
    deadline = time.perf_counter() + timeout
    while not condition():
        assert time.perf_counter() < deadline, "timed out"
        time.sleep(0.02)


def test_a_request_pool_keeps_its_warm_minimum_open_past_the_idle_timeout(driver, monkeypatch):
    # 11-25: the first request after a restart or an idle spell connected and planned cold (0.4-3.5 s).
    monkeypatch.setattr(postgres_connections, "_MAX_IDLE_SECONDS", 0.1)
    monkeypatch.setattr(postgres_connections, "POOL_MIN_CONNECTIONS", 2)

    for workload in ("default", "browse", "cover-references", "cover_inventory"):
        with postgres_connections.pooled_connection(_URL, workload=workload):
            pass
    pools = {workload: postgres_connections._pools[(_URL, workload)] for workload in (
        "default", "browse", "cover-references", "cover_inventory")}
    _wait_until(lambda: len(_open_connections(driver)) == 8)
    time.sleep(0.6)  # several idle periods

    assert {workload: pool.get_stats()["pool_size"] for workload, pool in pools.items()} == dict.fromkeys(pools, 2)
    assert len(_open_connections(driver)) == 8


def test_a_broken_idle_connection_is_replaced_and_warmed_before_it_is_lent(driver, monkeypatch):
    monkeypatch.setattr(postgres_connections, "POOL_MIN_CONNECTIONS", 2)
    monkeypatch.setattr(postgres_connections, "_IDLE_CHECK_SECONDS", 0.0)
    warmed = []
    postgres_connections.prewarm_connection_pool(
        _URL, warmers={"browse": lambda connect: warmed.append(connect(_URL).execute("select warm"))}
    )
    browse = postgres_connections._pools[(_URL, "browse")]
    broken = list(browse._pool)
    assert len(broken) >= 2
    for connection in broken:
        connection.close()  # the server restarted under the idle pool

    with postgres_connections.pooled_connection(_URL, workload="browse") as served:
        assert served not in broken and not served.closed
    _wait_until(lambda: len(browse._pool) >= 2)
    replacements = list(browse._pool)
    assert not set(map(id, replacements)) & set(map(id, broken))
    assert set(map(id, replacements)) <= set(map(id, warmed)), "each replacement is warmed before it is lent"


def test_startup_warm_up_runs_each_workloads_statements_on_every_warm_connection_before_the_first_request(
    driver, monkeypatch
):
    monkeypatch.setattr(postgres_connections, "POOL_MIN_CONNECTIONS", 2)
    executed = []

    def warmer(name):
        def warm(connect):
            with connect(_URL) as connection:
                # The test driver's execute returns its connection.
                executed.append((name, connection.execute(f"select {name}"), connection.read_only))
        return warm

    warmers = {workload: warmer(workload) for workload in ("default", "browse", "cover-references", "cover_inventory")}
    postgres_connections.prewarm_connection_pool(_URL, warmers=warmers)

    for workload in warmers:
        pool = postgres_connections._pools[(_URL, workload)]
        idle = list(pool._pool)
        assert len(idle) >= 2, (workload, pool.get_stats())
        warmed = [connection for name, connection, _read_only in executed if name == workload]
        assert {id(connection) for connection in idle} <= {id(connection) for connection in warmed}
        assert all(connection.read_only is None for connection in idle), "warm-up settings never reach a request"
    assert all(read_only is True for _name, _connection, read_only in executed), "warm-up never writes"
    with postgres_connections.pooled_connection(_URL, workload="browse") as first_request:
        assert first_request in [connection for name, connection, _read_only in executed if name == "browse"]


def test_a_failing_warm_statement_never_fails_the_prewarm_or_leaves_a_transaction_open(driver):
    def failing(connect):
        with connect(_URL):
            raise psycopg.errors.UndefinedTable("relation does not exist")

    postgres_connections.prewarm_connection_pool(_URL, warmers={"browse": failing})

    with postgres_connections.pooled_connection(_URL, workload="browse") as connection:
        assert connection.pgconn.transaction_status == TransactionStatus.IDLE
