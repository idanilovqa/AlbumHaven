"""Small shared connection pools for request-scoped account repositories.

Every repository still executes its live queries and owns its transaction.
Reusing a TLS connection must never turn into caching actors, grants or sessions.
"""
from __future__ import annotations

import atexit
from threading import Lock

try:  # Keep schema-independent tooling importable.
    from psycopg.rows import dict_row
    from psycopg_pool import ConnectionPool
except ImportError:  # pragma: no cover
    ConnectionPool = None
    dict_row = None

_pools = {}
_lock = Lock()


def pooled_connection(database_url: str, *, workload: str = "default"):
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
    # The pool commits or rolls back before returning a connection; no retry of
    # an application mutation is introduced here.
    return pool.connection()


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
