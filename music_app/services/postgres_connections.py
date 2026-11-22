"""Small shared connection pools for request-scoped account repositories.

Every repository still executes its live queries and owns its transaction.
Reusing a TLS connection must never turn into caching actors, grants or sessions.
"""
from __future__ import annotations

import atexit
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from threading import Condition, Lock, get_ident
from time import perf_counter
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

    def require_connection(self, pool, timeout_seconds: float) -> None:
        """Return once the pool has a live connection; raise if it cannot open one."""
        with self._changed:
            if self._has_live_connection():
                return
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


# Leases each thread holds right now, by thread id. A lease taken while the thread already holds one
# comes from a pool one level deeper, so nested repository calls never wait on a connection their own
# request is holding: waits only ever go deeper, so pool exhaustion cannot deadlock. A lease released
# on another thread (a shared connection handed between workers) still unwinds its own thread's count.
_held: dict[int, int] = {}
# The default workload carries every request-path repository; the others keep their small pools.
_DEFAULT_WORKLOAD_MAX_SIZE = 8
_MAX_SIZE = 4
# Gallery and search reads keep one connection open: a fresh backend spends 0.4-2.7 s planning the
# search query, so a search after an idle spell would otherwise pay that again (owner, 11-19). The pool
# starts cold and keeps that connection only after one succeeded, so an unreachable database never
# leaves a reconnect loop behind (shutdown waits on it).
_WARM_WORKLOADS = frozenset({"browse"})
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
    depth = _held.get(get_ident(), 0)
    pool_key = (database_url, normalized_workload) if depth == 0 else (database_url, normalized_workload, depth)
    with _lock:
        pool = _pools.get(pool_key)
        if pool is None:
            connect_state = _connect_states[pool_key] = _ConnectState()
            pool = ConnectionPool(
                conninfo=database_url,
                connection_class=_state_recording_connection_class(connect_state),
                min_size=0,
                max_size=_DEFAULT_WORKLOAD_MAX_SIZE if depth == 0 and normalized_workload in _LARGE_WORKLOADS else _MAX_SIZE,
                max_waiting=32,
                timeout=30, max_idle=120,
                max_lifetime=0 if normalized_workload == _SESSION_WORKLOAD else 600,
                check=_restore_session_defaults,
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


def _restore_session_defaults(connection) -> None:
    for name, default in _SESSION_DEFAULTS:
        if getattr(connection, name) != default:
            setattr(connection, name, default)


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
            connect_state.require_connection(pool, timeout_seconds or pool.timeout)
        with checkout as connection:
            acquired_at = perf_counter()
            acquired = True
            holder = get_ident()
            _held[holder] = _held.get(holder, 0) + 1
            if keep_warm and pool.min_size == 0:
                pool.resize(1, pool.max_size)
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


class _LeasedConnection:
    """A pool lease used like a `psycopg.connect()` connection.

    `with` commits on success and rolls back on error, then returns the
    connection to the pool; `close()` rolls back what was not committed and
    returns it. Everything else is the leased connection itself."""

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
        if lease is not None:
            lease.__exit__(exc_type, exc, traceback)


def leased_connection(database_url: str, *, workload: str = "default") -> _LeasedConnection:
    """A shared-pool connection for repositories written against `psycopg.connect()`."""
    return _LeasedConnection(database_url, workload)


def session_connection(database_url: str) -> _LeasedConnection:
    """A lease for session state such as a session advisory lock; its connection is never reused."""
    return _LeasedConnection(database_url, _SESSION_WORKLOAD)


def prewarm_connection_pool(database_url: str) -> None:
    for workload in ("default", "browse"):
        with pooled_connection(database_url, workload=workload):
            pass


def close_pools() -> None:
    with _lock:
        pools = list(_pools.values())
        _pools.clear()
    for pool in pools:
        pool.close()


atexit.register(close_pools)
