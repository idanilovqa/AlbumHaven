"""Local tests never connect to the installed Postgres server.

On a developer machine port 5432 can be production's server, and libpq falls back to it (with the
saved pgpass logins) whenever a URL or the environment names no port. A local test therefore
connects only to a throwaway cluster on a port it names. GitHub Actions runners own their server.
"""
from __future__ import annotations

import functools
import inspect
import os

INSTALLED_SERVER_PORT = "5432"
# A port nothing serves: the pytest session hands it to child processes such as psql.
UNSERVED_PORT = "1"
_REFUSAL = (
    "local tests never connect to the installed Postgres server: name a throwaway cluster's port, "
    "or run on GitHub Actions"
)


def is_github_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def _refuse_installed_server(conninfo: str, kwargs: dict[str, object]) -> None:
    if is_github_actions():
        return
    from psycopg import OperationalError
    from psycopg.conninfo import conninfo_to_dict

    parameters = conninfo_to_dict(conninfo or "")
    parameters.update({key: kwargs[key] for key in ("port", "service") if kwargs.get(key)})
    # A service file can name any host and port, so it names no throwaway cluster.
    if parameters.get("service") or os.environ.get("PGSERVICE"):
        raise OperationalError(_REFUSAL)
    ports = str(parameters.get("port") or os.environ.get("PGPORT") or INSTALLED_SERVER_PORT).split(",")
    if not all(_names_throwaway_port(port) for port in ports):
        raise OperationalError(_REFUSAL)


def _names_throwaway_port(port: str) -> bool:
    try:
        number = str(int(port))  # libpq reads 05432 and +5432 as 5432
    except ValueError:
        return False
    return number not in {INSTALLED_SERVER_PORT, UNSERVED_PORT}


def guard_connect(connection_class: type) -> None:
    """Make `connection_class.connect` refuse the installed server before it opens anything."""
    original = inspect.getattr_static(connection_class, "connect").__func__
    if getattr(original, "refuses_installed_server", False):
        return
    if inspect.iscoroutinefunction(original):
        @functools.wraps(original)
        async def connect(cls, conninfo: str = "", *args, **kwargs):
            _refuse_installed_server(conninfo, kwargs)
            return await original(cls, conninfo, *args, **kwargs)
    else:
        @functools.wraps(original)
        def connect(cls, conninfo: str = "", *args, **kwargs):
            _refuse_installed_server(conninfo, kwargs)
            return original(cls, conninfo, *args, **kwargs)
    connect.refuses_installed_server = True
    connection_class.connect = classmethod(connect)


def install() -> None:
    """Call before a module binds `psycopg.connect`. GitHub Actions is left untouched."""
    if is_github_actions():
        return
    try:
        import psycopg
    except ImportError:  # nothing can connect
        return
    guard_connect(psycopg.Connection)
    guard_connect(psycopg.AsyncConnection)
    psycopg.connect = psycopg.Connection.connect  # the module alias binds the original at import
