"""Failure-path ownership for the production Phase 7 E2E launcher."""
from __future__ import annotations

import importlib
from pathlib import Path
import sys

import pytest


@pytest.mark.parametrize("failure_point", ["acquire", "interrupted_acquire", "control_bind", "configure"])
def test_phase7_startup_failure_cleans_only_owned_database_and_closes_bound_servers(
    tmp_path, monkeypatch, failure_point
):
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    temp_root = tmp_path / "phase7"
    temp_root.mkdir()
    events = []
    servers = []
    acquired = False
    failure = KeyboardInterrupt("startup interrupted") if failure_point == "interrupted_acquire" else RuntimeError("startup failed")

    class Lock:
        def acquire(self):
            nonlocal acquired
            events.append("acquire")
            if failure_point in {"acquire", "interrupted_acquire"}:
                raise failure
            acquired = True

        def release(self):
            events.append("release")

    smtp_factory = launcher._SMTPServer
    control_factory = launcher._ControlServer

    def construct(factory, address, state):
        if factory is control_factory and failure_point == "control_bind":
            raise failure
        server = factory(address, state)
        servers.append(server)
        return server

    def configure(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr(sys, "argv", ["phase7AuthApp.py", "--port", "0", "--smtp-port", "0", "--control-port", "0"])
    monkeypatch.setattr(launcher, "resolve_isolated_database_urls", lambda: ("isolated-setup", "isolated-runtime"))
    monkeypatch.setattr(launcher.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(launcher, "IsolatedDatabaseOwnershipLock", Lock)
    monkeypatch.setattr(launcher, "_SMTPServer", lambda address, state: construct(smtp_factory, address, state))
    monkeypatch.setattr(launcher, "_ControlServer", lambda address, state: construct(control_factory, address, state))
    monkeypatch.setattr(launcher, "_configure_environment", configure)
    monkeypatch.setattr(launcher, "reset_application_tables", lambda _url: events.append("reset"))
    try:
        with pytest.raises(type(failure), match=str(failure)) as caught:
            launcher.main()
        assert caught.value is failure
        assert events.count("reset") == int(acquired), "an unowned database must never be reset"
        assert all(server.socket.fileno() == -1 for server in servers), "bound but unstarted capture servers must close"
        assert not temp_root.exists()
    finally:
        for server in servers:
            server.server_close()
@pytest.mark.parametrize("original_failure", [False, True])
@pytest.mark.parametrize("failure_point", ["secondary", "capture_shutdown", "capture_close"])
def test_phase7_retains_database_fixture_and_ownership_when_secondary_shutdown_is_unproven(
    tmp_path, monkeypatch, capsys, original_failure, failure_point
):
    from types import SimpleNamespace
    import music_app

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    temp_root = tmp_path / "phase7"
    temp_root.mkdir()
    events = []
    primary_error = RuntimeError("original application failure")

    class Lock:
        def acquire(self): events.append("acquire")
        def release(self): events.append("release")

    class Thread:
        def __init__(self, **_kwargs): pass
        def start(self): pass
        def join(self, timeout): events.append(("join", timeout))
        def is_alive(self): return failure_point == "secondary"

    class CaptureServer:
        def __init__(self, *_args): pass
        def shutdown(self):
            events.append("capture-shutdown")
            if failure_point == "capture_shutdown":
                raise RuntimeError("capture shutdown failed")
        def server_close(self):
            events.append("capture-closed")
            if failure_point == "capture_close":
                raise RuntimeError("capture close failed")

    def run(*_args, **_kwargs):
        if original_failure:
            raise primary_error

    monkeypatch.setattr(sys, "argv", ["phase7AuthApp.py", "--port", "0", "--smtp-port", "0", "--control-port", "0", "--worker-port", "0"])
    monkeypatch.setattr(launcher, "resolve_isolated_database_urls", lambda: ("isolated-setup", "isolated-runtime"))
    monkeypatch.setattr(launcher.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(launcher, "IsolatedDatabaseOwnershipLock", Lock)
    for name in ["_SMTPServer", "_ControlServer"]:
        monkeypatch.setattr(launcher, name, CaptureServer)
    for name in ["_configure_environment", "prepare_isolated_database", "_bootstrap_owner", "persist_settings_playback_inventory", "_start_thread"]:
        monkeypatch.setattr(launcher, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "threading", SimpleNamespace(Thread=Thread, Lock=lambda: None, Event=lambda: SimpleNamespace(set=lambda: None)))
    monkeypatch.setattr(music_app, "create_asgi_app", lambda: object())
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(
        Config=lambda *_args, **_kwargs: object(),
        Server=lambda *_args: SimpleNamespace(should_exit=False, run=lambda: None),
        run=run,
    ))
    monkeypatch.setattr(launcher, "reset_application_tables", lambda _url: events.append("reset"))
    with pytest.raises(RuntimeError) as caught:
        launcher.main()
    if original_failure:
        assert caught.value is primary_error
        if failure_point != "secondary":
            assert any(failure_point.replace("_", " ") in str(error) for error in primary_error.cleanup_failures)
            assert failure_point.replace("_", " ") in capsys.readouterr().err
    else:
        assert "shutdown" in str(caught.value).lower()
    assert "reset" not in events
    assert "release" not in events, "the live owner's identity lock must remain until that process exits"
    assert temp_root.exists(), "a surviving writer may still be using its fixture"
    assert events.count("capture-closed") == 2
    assert ("join", 10) in events
