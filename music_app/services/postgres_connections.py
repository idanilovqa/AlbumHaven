"""Small shared connection pools for request-scoped account repositories.

Every repository still executes its live queries and owns its transaction.
Reusing a TLS connection must never turn into caching actors, grants or sessions.
"""
from __future__ import annotations

import atexit
from collections.abc import Callable, Mapping
from contextlib import contextmanager
from threading import Lock
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
    pool_key = (database_url, normalized_workload)
    with _lock:
        pool = _pools.get(pool_key)
        if pool is None:
            pool = ConnectionPool(
                conninfo=database_url,
                min_size=0, max_size=4, max_waiting=32,
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
            _observe_pool_lease(
                lease_observer,
                "released",
                workload=workload,
                elapsed_ms=(perf_counter() - acquired_at) * 1000,
                pool=pool,
            )


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
