"""The pytest session refuses every Postgres connection whose target is not explicit.

An empty conninfo or a URL without a host and port falls back to libpq's
defaults (localhost:5432), which can be a real server on a developer machine.
Isolated test databases always name their host and port.
"""

from __future__ import annotations

import pytest

from tests.py.postgres_target_guard import target_refusal

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


# On a developer machine localhost:5432 can be production's server, so the default port is refused
# whatever the database's name; only the CI job's own service, named by the workflow, may be reached there.
_CI_SERVICE_URL = "postgresql://album_haven_migrator_hg_45351713748_1_2@127.0.0.1:5432/album_haven_ci_hg_45351713748_1_2"


@pytest.fixture
def outside_ci(monkeypatch):
    monkeypatch.delenv("ALBUM_HAVEN_CI_POSTGRES_SERVICE", raising=False)
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)


@pytest.fixture
def ci_service(monkeypatch):
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    monkeypatch.setenv("ALBUM_HAVEN_CI_POSTGRES_SERVICE", "127.0.0.1:5432")


@pytest.mark.parametrize("conninfo", [
    "postgresql://album_haven_app@localhost:5432/pytest_x",
    "postgresql://album_haven_app@127.0.0.1:5432/album_haven_core",
    "host=localhost port=5432 dbname=album_haven_fake_e2e",
    _CI_SERVICE_URL,
])
def test_the_default_port_is_refused_outside_ci_whatever_the_database(outside_ci, conninfo):
    assert "port 5432" in _refused(psycopg.connect, conninfo)


def test_the_ci_service_is_reachable_on_the_default_port_only_with_the_workflow_marker(ci_service):
    assert target_refusal(_CI_SERVICE_URL) is None
    # The marker names one host: another one on 5432 is still refused.
    assert "port 5432" in (target_refusal("postgresql://album_haven_app@db.example:5432/album_haven_core") or "")


def test_the_workflow_marker_alone_does_not_open_the_default_port_outside_github_actions(monkeypatch):
    monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
    monkeypatch.setenv("ALBUM_HAVEN_CI_POSTGRES_SERVICE", "127.0.0.1:5432")
    assert "port 5432" in (target_refusal(_CI_SERVICE_URL) or "")


def test_a_url_without_a_port_is_refused_even_in_ci(ci_service):
    assert "explicit host and port" in _refused(psycopg.connect, _CI_SERVICE_URL.replace(":5432/", "/"))
    assert "explicit host and port" in _refused(psycopg.connect, "postgresql://album_haven_app@localhost/pytest_x")


def test_a_throwaway_cluster_on_another_port_is_accepted(outside_ci):
    assert target_refusal("postgresql://album_haven_migrator_h6@127.0.0.1:55420/album_haven_ci_h6") is None
