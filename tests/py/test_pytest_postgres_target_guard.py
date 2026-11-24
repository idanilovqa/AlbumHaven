"""The pytest session refuses every Postgres connection whose target is not explicit.

An empty conninfo or a URL without a host and port falls back to libpq's
defaults (localhost:5432), which can be a real server on a developer machine.
Isolated test databases always name their host and port.
"""

from __future__ import annotations

import pytest

psycopg = pytest.importorskip("psycopg")


def _refused(connect, *args, **kwargs) -> str:
    with pytest.raises(psycopg.OperationalError) as refused:
        connect(*args, **kwargs)
    return str(refused.value)


@pytest.mark.parametrize("conninfo", ["", "   ", "dbname=app", "postgresql://album_haven_app@localhost/app",
                                      "postgresql:///app", "host=127.0.0.1 dbname=app"])
def test_a_connection_without_an_explicit_host_and_port_is_refused_before_any_attempt(conninfo):
    assert "explicit host and port" in _refused(psycopg.connect, conninfo)
    assert "explicit host and port" in _refused(psycopg.Connection.connect, conninfo)


def test_keyword_targets_count_as_explicit_only_with_both_host_and_port():
    assert "explicit host and port" in _refused(psycopg.connect, host="localhost", dbname="app")
    assert "explicit host and port" in _refused(psycopg.connect, port=5432, dbname="app")


def test_an_explicit_unreachable_target_still_reaches_the_driver():
    message = _refused(psycopg.connect, "postgresql://nobody@127.0.0.1:1/pytest_unreachable", connect_timeout=1)
    assert "explicit host and port" not in message
