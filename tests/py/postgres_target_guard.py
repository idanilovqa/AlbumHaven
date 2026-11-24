"""The pytest session's guard against Postgres connections that could reach a real server."""

from __future__ import annotations

import os

_DEFAULT_PORT = "5432"
# Set only by the CI workflows, as "<host>:5432": the job's own Postgres service.
_CI_SERVICE_ENV = "ALBUM_HAVEN_CI_POSTGRES_SERVICE"


def _ci_service() -> str:
    if os.environ.get("GITHUB_ACTIONS", "").strip().lower() != "true":
        return ""
    return os.environ.get(_CI_SERVICE_ENV, "").strip().lower()


def target_refusal(conninfo: str = "", **kwargs) -> str | None:
    """Why a connection to this target is refused, or None when it may reach the driver.

    Every target names its host and port. Port 5432 can be production's server on a developer machine,
    so it is reached only as the CI job's own service, never by a database's name."""
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    target_options = {key: kwargs[key] for key in ("host", "hostaddr", "port") if kwargs.get(key) is not None}
    params = conninfo_to_dict(make_conninfo(conninfo, **target_options))
    host = str(params.get("host") or params.get("hostaddr") or "").strip().lower()
    port = str(params.get("port") or "").strip()
    if not host or not port:
        return "pytest refused a Postgres connection without an explicit host and port"
    if port == _DEFAULT_PORT and _ci_service() != f"{host}:{port}":
        return (
            "pytest refused a Postgres connection on port 5432 outside the CI job's own service; "
            "use a throwaway cluster on another port"
        )
    return None


def install() -> None:
    """Every psycopg connection, direct or through a pool, is judged before the driver sees it."""
    try:
        import psycopg
    except ImportError:
        return
    driver_connect = psycopg.Connection.connect.__func__
    if getattr(driver_connect, "_album_haven_target_guard", False):
        return

    def connect(cls, conninfo: str = "", **kwargs):
        refusal = target_refusal(conninfo, **kwargs)
        if refusal:
            raise psycopg.OperationalError(refusal)
        return driver_connect(cls, conninfo, **kwargs)

    connect._album_haven_target_guard = True
    psycopg.Connection.connect = classmethod(connect)
    psycopg.connect = psycopg.Connection.connect
