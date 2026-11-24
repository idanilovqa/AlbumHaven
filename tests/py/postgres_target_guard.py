"""The pytest session's guard against Postgres connections that could reach a real server."""

from __future__ import annotations


def target_refusal(conninfo: str = "", **kwargs) -> str | None:
    """Why a connection to this target is refused, or None when it may reach the driver."""
    from psycopg.conninfo import conninfo_to_dict, make_conninfo

    target_options = {key: kwargs[key] for key in ("host", "hostaddr", "port") if kwargs.get(key) is not None}
    params = conninfo_to_dict(make_conninfo(conninfo, **target_options))
    if not str(params.get("host") or params.get("hostaddr") or "").strip() or not str(params.get("port") or "").strip():
        return "pytest refused a Postgres connection without an explicit host and port"
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
