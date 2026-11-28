"""Small shared connection pools for request-scoped account repositories.

Every repository still executes its live queries and owns its transaction.
Reusing a TLS connection must never turn into caching actors, grants or sessions.
"""
from __future__ import annotations

import atexit
import contextvars
import logging
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from threading import Condition, Lock, get_ident
from time import monotonic, perf_counter, sleep
from weakref import WeakSet

try:  # Keep schema-independent tooling importable.
    from psycopg import Connection, Cursor, OperationalError, ServerCursor
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool, PoolTimeout
except ImportError:  # pragma: no cover
    Connection = None
    ConnectionPool = None
    Cursor = ServerCursor = None
    OperationalError = RuntimeError
    PoolTimeout = TimeoutError
    dict_row = None

_LOGGER = logging.getLogger(__name__)
_pools = {}
_lock = Lock()
# The pool connects in the background and retries a failed attempt, so against an unreachable
# database a checkout would wait out its whole timeout (freeze-guard backlog case 30). Only a pool
# with no live connection is unreachable: it fails checkouts at once with its own connection error.
# A pool that has a connection, idle or leased, serves or queues as usual whatever growth attempts
# do. The pool gives up a failed attempt after a few seconds rather than backing off for minutes,
# and every refused checkout asks it to connect again (a no-op while it is already trying). A
# failure nobody has met for that long says nothing about now: the next checkout waits for a fresh
# attempt, so the first request after a quiet outage is served.
_RECONNECT_GIVE_UP_SECONDS = 5.0
_connect_states: dict[object, "_ConnectState"] = {}


class _ConnectState:
    """A pool's live connections and, while it has none, why it could not open one."""

    def __init__(self):
        self._changed = Condition()
        self._connections = WeakSet()
        self._error = None
        self._error_seen_at = 0.0

    def _has_live_connection(self) -> bool:
        return any(not connection.closed for connection in self._connections)

    def connected(self, connection) -> None:
        with self._changed:
            self._connections.add(connection)
            self._error = None
            self._changed.notify_all()

    def failed(self, error: Exception) -> None:
        with self._changed:
            if not self._has_live_connection():
                if self._error is None:  # the pool's own retries do not count as meeting it
                    self._error_seen_at = perf_counter()
                self._error = error
                self._changed.notify_all()

    def require_connection(self, pool, timeout_seconds: float) -> bool:
        """Return once the pool has a live connection, and whether that meant waiting; raise if it
        cannot open one."""
        with self._changed:
            if self._has_live_connection():
                return False
            now = perf_counter()
            if now - self._error_seen_at > _RECONNECT_GIVE_UP_SECONDS:
                self._error = None
            self._error_seen_at = now
            error = self._error
        # Not through the pool's queue: timed-out waiters stay in it, and a full queue stops growth.
        pool.check()
        with self._changed:
            if error is None:
                if not self._changed.wait_for(lambda: self._error or self._has_live_connection(), timeout_seconds):
                    raise PoolTimeout(f"couldn't get a connection after {timeout_seconds:.2f} sec")
                error = self._error
        if error is not None:
            raise OperationalError(f"Postgres is unreachable: {error}") from error
        return True


# Leases each thread holds right now, by thread id. A lease taken while the thread already holds one
# comes from a pool one level deeper, so nested repository calls never wait on a connection their own
# request is holding: waits only ever go deeper, so pool exhaustion cannot deadlock. A lease released
# on another thread (a shared connection handed between workers) still unwinds its own thread's count.
_held: dict[int, int] = {}
# The default workload carries every request-path repository; the others keep their small pools.
_DEFAULT_WORKLOAD_MAX_SIZE = 8
_MAX_SIZE = 4
# The request-path pools keep this many connections open (11-25): opening one costs 75-210 ms and a fresh
# backend spends 0.4-2.7 s planning the search query, so the first request after a start or an idle spell
# paid both. Each pool starts cold and keeps its minimum only after a connection succeeded, so an
# unreachable database never leaves a reconnect loop behind (shutdown waits on it).
POOL_MIN_CONNECTIONS = 2
# Gallery and search; Cover Look Up and the other request repositories; every response naming covers; and
# Cover Look Up's local images. Background, save and session work stays cold.
_WARM_WORKLOADS = ("browse", "default", "cover-references", "cover_inventory")
# Connections above the minimum close after this long unused.
_MAX_IDLE_SECONDS = 120
# A connection last lent this long ago is checked with one empty round trip before it is lent again, so one
# the server dropped while it sat idle is replaced instead of failing its request.
_IDLE_CHECK_SECONDS = 30.0
# Each workload's first-request statements, run on every connection its warm pool opens: by the start-up
# warm-up, and by the pool itself when it replaces an expired or broken one with no request waiting.
_connection_warmers: dict[tuple[str, str], Callable[[Callable[..., object]], None]] = {}
# What a borrower can change on the connection object. The pool's own reset only rolls back, so each
# checkout restores these (none needs a round trip): one caller's autocommit must never turn the next
# caller's transaction into separate commits.
_SESSION_DEFAULTS = (
    ("autocommit", False),
    ("isolation_level", None),
    ("read_only", None),
    ("deferrable", None),
    ("row_factory", dict_row),
    ("cursor_factory", Cursor),
    ("server_cursor_factory", ServerCursor),
    ("prepare_threshold", 5),
)
# State the server keeps for the session (an advisory lock, LISTEN) cannot be restored that way. Its
# holders lease from this workload, whose connections expire on return: closing one ends whatever its
# holder left behind, and the pool opens the replacement in the background.
_SESSION_WORKLOAD = "session"
# An edit holds its session lease through the media writes, so session leases need the request
# pool's headroom or a fifth concurrent save would wait for the first.
_LARGE_WORKLOADS = frozenset({"default", _SESSION_WORKLOAD})
# A user's save leases its default-workload connections from a pool of its own (6.5, 11-23, row B3), so
# publications and browse reads holding every request connection never make a save wait or fail.
_SAVE_WORKLOAD = "save"
_SAVE_WORKLOAD_MAX_SIZE = 2
_user_save = contextvars.ContextVar("album_haven_user_save", default=False)


@contextmanager
def user_save_connections():
    """While active (in this context and the thread-pool calls it makes), default-workload leases come
    from the save workload."""
    token = _user_save.set(True)
    try:
        yield
    finally:
        _user_save.reset(token)


def _observe_pool_lease(
    observer: Callable[[Mapping[str, object]], None] | None,
    event: str,
    *,
    workload: str,
    elapsed_ms: float,
    pool,
) -> None:
    if observer is None:
        return
    try:
        payload = {
            "event": event,
            "workload": workload,
            "held_ms" if event == "released" else "wait_ms": elapsed_ms,
            **pool.get_stats(),
        }
        observer(payload)
    except Exception:
        return


def pooled_connection(
    database_url: str,
    *,
    workload: str = "default",
    lease_observer: Callable[[Mapping[str, object]], None] | None = None,
    checkout_timeout_seconds: float | None = None,
):
    if not isinstance(database_url, str) or not database_url.strip():
        raise RuntimeError("Postgres configuration is required.")
    normalized_workload = str(workload or "").strip()
    if not normalized_workload:
        raise RuntimeError("Postgres pool workload is required.")
    if ConnectionPool is None:
        raise RuntimeError("psycopg pool support is required; install the application requirements.")
    if normalized_workload == "default" and _user_save.get():
        normalized_workload = _SAVE_WORKLOAD
    depth = _held.get(get_ident(), 0)
    pool_key = (database_url, normalized_workload) if depth == 0 else (database_url, normalized_workload, depth)
    with _lock:
        pool = _pools.get(pool_key)
        if pool is None:
            connect_state = _connect_states[pool_key] = _ConnectState()
            warmer_key = (database_url, normalized_workload) if depth == 0 else None
            pool = ConnectionPool(
                conninfo=database_url,
                connection_class=_state_recording_connection_class(connect_state),
                min_size=0,
                max_size=_pool_max_size(normalized_workload, depth),
                max_waiting=32,
                timeout=30, max_idle=_MAX_IDLE_SECONDS,
                max_lifetime=0 if normalized_workload == _SESSION_WORKLOAD else 600,
                configure=lambda connection: _configure_new_connection(connection, pool_key, warmer_key),
                check=_prepare_loan,
                reconnect_timeout=_RECONNECT_GIVE_UP_SECONDS,
                kwargs={"row_factory": dict_row, "connect_timeout": 15},
                open=True,
            )
            _pools[pool_key] = pool
    checkout_started = perf_counter()
    timeout_seconds = max(0.001, float(checkout_timeout_seconds)) if checkout_timeout_seconds is not None else None
    try:
        checkout = pool.connection(timeout=timeout_seconds) if timeout_seconds is not None else pool.connection()
    except PoolTimeout:
        _observe_pool_lease(
            lease_observer,
            "timeout",
            workload=normalized_workload,
            elapsed_ms=(perf_counter() - checkout_started) * 1000,
            pool=pool,
        )
        raise
    return _lease_connection(
        checkout,
        pool=pool,
        # Only a pool that connects through the recording class can report its connections.
        connect_state=_connect_states.get(pool_key) if hasattr(pool, "connection_class") else None,
        timeout_seconds=timeout_seconds,
        workload=normalized_workload,
        lease_observer=lease_observer,
        keep_warm=depth == 0 and normalized_workload in _WARM_WORKLOADS,
    )


def _pool_max_size(workload: str, depth: int) -> int:
    if depth == 0 and workload == _SAVE_WORKLOAD:
        return _SAVE_WORKLOAD_MAX_SIZE
    return _DEFAULT_WORKLOAD_MAX_SIZE if depth == 0 and workload in _LARGE_WORKLOADS else _MAX_SIZE


def _restore_session_defaults(connection) -> None:
    for name, default in _SESSION_DEFAULTS:
        if getattr(connection, name) != default:
            setattr(connection, name, default)


def _prepare_loan(connection) -> None:
    now = monotonic()
    if now - getattr(connection, "_album_haven_lent_at", now) >= _IDLE_CHECK_SECONDS:
        ConnectionPool.check_connection(connection)  # raising makes the pool discard and replace it
    connection._album_haven_lent_at = now
    _restore_session_defaults(connection)


def _configure_new_connection(connection, pool_key, warmer_key) -> None:
    warm = _connection_warmers.get(warmer_key)
    pool = _pools.get(pool_key)
    # A request waiting for this connection gets it at once and plans its own statements.
    if warm is not None and pool is not None and not pool.get_stats().get("requests_waiting"):
        _warm_connection(connection, warm)


def _state_recording_connection_class(connect_state: _ConnectState):
    if Connection is None:  # pragma: no cover
        return None

    class _StateRecordingConnection(Connection):
        @classmethod
        def connect(cls, *args, **kwargs):
            try:
                connection = super().connect(*args, **kwargs)
            except Exception as error:
                connect_state.failed(error)
                raise
            connect_state.connected(connection)
            return connection

    return _StateRecordingConnection


@contextmanager
def _lease_connection(
    checkout,
    *,
    pool,
    connect_state: _ConnectState | None,
    timeout_seconds: float | None,
    workload: str,
    lease_observer: Callable[[Mapping[str, object]], None] | None,
    keep_warm: bool = False,
):
    wait_started = perf_counter()
    acquired = False
    acquired_at = 0.0
    try:
        if connect_state is not None:
            timeout = timeout_seconds or pool.timeout
            if connect_state.require_connection(pool, timeout):
                # Connecting and leasing share one timeout: lease with what connecting left of it.
                checkout = pool.connection(timeout=max(0.001, timeout - (perf_counter() - wait_started)))
        with checkout as connection:
            acquired_at = perf_counter()
            acquired = True
            holder = get_ident()
            _held[holder] = _held.get(holder, 0) + 1
            if keep_warm and pool.min_size < POOL_MIN_CONNECTIONS:
                pool.resize(POOL_MIN_CONNECTIONS, pool.max_size)
            _observe_pool_lease(
                lease_observer,
                "acquired",
                workload=workload,
                elapsed_ms=(acquired_at - wait_started) * 1000,
                pool=pool,
            )
            yield connection
    except PoolTimeout:
        if not acquired:
            _observe_pool_lease(
                lease_observer,
                "timeout",
                workload=workload,
                elapsed_ms=(perf_counter() - wait_started) * 1000,
                pool=pool,
            )
        raise
    finally:
        if acquired:
            if _held[holder] > 1:
                _held[holder] -= 1
            else:
                del _held[holder]
            _observe_pool_lease(
                lease_observer,
                "released",
                workload=workload,
                elapsed_ms=(perf_counter() - acquired_at) * 1000,
                pool=pool,
            )


class _ReleasedConnection:
    """What a released lease holds in place of the connection its next borrower may be using."""

    closed = True

    def __getattr__(self, name: str):
        raise OperationalError("the connection is closed")

    def __setattr__(self, name: str, value) -> None:
        raise OperationalError("the connection is closed")


_RELEASED = _ReleasedConnection()


class _LeasedConnection:
    """A pool lease used like a `psycopg.connect()` connection.

    `with` commits on success and rolls back on error, then returns the
    connection to the pool; `close()` rolls back what was not committed and
    returns it. Everything else is the leased connection itself, until it is
    returned: from then on the lease is a closed connection."""

    def __init__(self, database_url: str, workload: str):
        self._lease = pooled_connection(database_url, workload=workload)
        self._connection = self._lease.__enter__()

    def __getattr__(self, name: str):
        return getattr(self._connection, name)

    def __setattr__(self, name: str, value) -> None:
        # Settings such as `autocommit` belong to the leased connection, not to this wrapper.
        if name in ("_lease", "_connection"):
            object.__setattr__(self, name, value)
        else:
            setattr(self._connection, name, value)

    def __enter__(self):
        if self._lease is None:
            raise OperationalError("the connection is closed")
        return self

    def __exit__(self, exc_type, exc, traceback):
        self._release(exc_type, exc, traceback)

    def close(self) -> None:
        try:
            if self._lease is not None:
                self._connection.rollback()
        finally:
            self._release(None, None, None)

    def _release(self, exc_type, exc, traceback) -> None:
        lease, self._lease = self._lease, None
        # Before the pool can hand the connection on, not after.
        self._connection = _RELEASED
        if lease is not None:
            lease.__exit__(exc_type, exc, traceback)


def leased_connection(database_url: str, *, workload: str = "default") -> _LeasedConnection:
    """A shared-pool connection for repositories written against `psycopg.connect()`."""
    return _LeasedConnection(database_url, workload)


def session_connection(database_url: str) -> _LeasedConnection:
    """A lease for session state such as a session advisory lock; its connection is never reused."""
    return _LeasedConnection(database_url, _SESSION_WORKLOAD)


class _BorrowedConnection:
    """A warm-up's connection, used like a `psycopg.connect()` one: leaving `with` or closing only rolls back."""

    def __init__(self, connection):
        object.__setattr__(self, "_connection", connection)

    def __getattr__(self, name: str):
        return getattr(self._connection, name)

    def __setattr__(self, name: str, value) -> None:
        setattr(self._connection, name, value)

    def __enter__(self):
        return self

    def __exit__(self, *_exc_info):
        self._connection.rollback()

    def close(self) -> None:
        self._connection.rollback()


def _warm_connection(connection, warm: Callable[[Callable[..., object]], None]) -> None:
    """Run `warm` on this connection in read-only transactions, then leave it as a request expects it."""
    try:
        connection.read_only = True
        warm(lambda *_args, **_kwargs: _BorrowedConnection(connection))
        connection._album_haven_warmed = True
    except Exception:
        _LOGGER.warning("Postgres connection warm-up failed", exc_info=True)
    finally:
        connection.rollback()
        _restore_session_defaults(connection)


def prewarm_connection_pool(
    database_url: str,
    warmers: Mapping[str, Callable[[Callable[..., object]], None]] | None = None,
) -> None:
    """Open every request-path pool to its warm minimum and run each workload's first-request statements on
    every connection it keeps, so the first request after a start neither connects nor plans cold. A warmer
    is called with a `connect(database_url)` to hand the repositories it reads through."""
    for workload, warm in (warmers or {}).items():
        _connection_warmers[(database_url, workload)] = warm
    for workload in _WARM_WORKLOADS:
        with pooled_connection(database_url, workload=workload):
            pass  # proves the database reachable and keeps the minimum
        warm = _connection_warmers.get((database_url, workload))
        if warm is None:
            continue
        pool = _pools[(database_url, workload)]
        # A borrower waiting on the minimum's last connection would make the pool open one more.
        deadline = monotonic() + pool.timeout
        while pool.get_stats().get("pool_available", 0) < pool.min_size and monotonic() < deadline:
            sleep(0.01)
        borrowed = []  # held together, so each is a different connection
        try:
            for _ in range(pool.min_size):
                borrowed.append(pool.getconn())
            for connection in borrowed:
                if not getattr(connection, "_album_haven_warmed", False):  # the pool warmed it as it opened
                    _warm_connection(connection, warm)
        finally:
            for connection in borrowed:
                pool.putconn(connection)


def close_pools() -> None:
    with _lock:
        pools = list(_pools.values())
        _pools.clear()
        _connection_warmers.clear()
    for pool in pools:
        pool.close()


atexit.register(close_pools)
