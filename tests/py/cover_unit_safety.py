"""Fail-closed transports for the explicitly isolated cover unit suites."""
import os
import socket
import subprocess

import pytest

from music_app.services import scan_cache_persistence


@pytest.fixture(autouse=True)
def cover_unit_transports(monkeypatch):
    attempts = []

    def reject_transport(*args, **kwargs):
        attempts.append(True)
        pytest.fail("Cover unit tests must inject transport doubles; network and database access are forbidden")

    monkeypatch.setattr(subprocess, "Popen", reject_transport)
    for name in ("system", "popen", "posix_spawn", "posix_spawnp",
                 "spawnl", "spawnle", "spawnlp", "spawnlpe",
                 "spawnv", "spawnve", "spawnvp", "spawnvpe",
                 "execl", "execle", "execlp", "execlpe",
                 "execv", "execve", "execvp", "execvpe"):
        if hasattr(os, name):
            monkeypatch.setattr(os, name, reject_transport)
    monkeypatch.setattr(socket, "getaddrinfo", reject_transport)
    monkeypatch.setattr(socket, "create_connection", reject_transport)
    monkeypatch.setattr(socket.socket, "connect", reject_transport)
    monkeypatch.setattr(socket.socket, "connect_ex", reject_transport)
    driver = scan_cache_persistence.psycopg
    if driver is not None:
        monkeypatch.setattr(driver, "connect", reject_transport)
        monkeypatch.setattr(driver.Connection, "connect", reject_transport)
        monkeypatch.setattr(driver.AsyncConnection, "connect", reject_transport)
    yield
    assert not attempts, "A cover unit test attempted a forbidden transport, even if its caller caught the error"
