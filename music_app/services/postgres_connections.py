"""Small shared connection pools for request-scoped account repositories.

Every repository still executes its live queries and owns its transaction.
Reusing a TLS connection must never turn into caching actors, grants or sessions.
"""
from __future__ import annotations

import atexit
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from threading import Lock, get_ident
from time import perf_counter

try:  # Keep schema-independent tooling importable.
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool, PoolTimeout
except ImportError:  # pragma: no cover
    ConnectionPool = None
    PoolTimeout = TimeoutError
    dict_row = None

_pools = {}
_lock = Lock()
# Leases each thread holds right now, by thread id. A lease taken while the thread already holds one
# comes from a pool one level deeper, so nested repository calls never wait on a connection their own
# request is holding: waits only ever go deeper, so pool exhaustion cannot deadlock. A lease released
# on another thread (a shared connection handed between workers) still unwinds its own thread's count.
_held: dict[int, int] = {}
# The default workload carries every request-path repository; the others keep their small pools.
_DEFAULT_WORKLOAD_MAX_SIZE = 8
_MAX_SIZE = 4


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
            pool = ConnectionPool(
                conninfo=database_url,
                min_size=0, max_size=_DEFAULT_WORKLOAD_MAX_SIZE if depth == 0 and normalized_workload == "default" else _MAX_SIZE, max_waiting=32,
                timeout=30, max_idle=120, max_lifetime=600,
                kwargs={"row_factory": dict_row, "connect_timeout": 15},
                open=True,
            )
            _pools[pool_key] = pool
    checkout_started = perf_counter()
    try:
        checkout = (
            pool.connection(timeout=max(0.001, float(checkout_timeout_seconds)))
            if checkout_timeout_seconds is not None
            else pool.connection()
        )
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
        workload=normalized_workload,
        lease_observer=lease_observer,
    )


@contextmanager
def _lease_connection(
    checkout,
    *,
    pool,
    workload: str,
    lease_observer: Callable[[Mapping[str, object]], None] | None,
):
    wait_started = perf_counter()
    acquired = False
    acquired_at = 0.0
    try:
        with checkout as connection:
            acquired_at = perf_counter()
            acquired = True
            holder = get_ident()
            _held[holder] = _held.get(holder, 0) + 1
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
