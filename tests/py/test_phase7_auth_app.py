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
        def begin_shutdown(self): pass
        def drain_requests(self, timeout): return True
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

@pytest.mark.parametrize("outcome", ["drained", "scheduled", "timeout", "primary_failure"])
def test_phase7_drains_control_requests_before_database_release(tmp_path, monkeypatch, outcome):
    """A real accepted HTTP request remains an owner until its handler returns."""
    from http.client import HTTPConnection
    import threading
    from types import SimpleNamespace
    import music_app

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    temp_root = tmp_path / "phase7"
    temp_root.mkdir()
    events, servers, errors, requests, deferred_starts, owned_threads = [], [], [], [], [], []
    handler_entered, release_handler = threading.Event(), threading.Event()
    scheduled, captures_closed, finished = threading.Event(), threading.Event(), threading.Event()
    primary_error = RuntimeError("original application failure")
    real_thread = threading.Thread
    smtp_factory, control_factory = launcher._SMTPServer, launcher._ControlServer

    class Lock:
        def acquire(self): events.append("acquire")
        def release(self): events.append("release")

    def construct(factory, address, state):
        server = factory(address, state)
        servers.append(server)
        close = server.server_close
        def close_capture():
            close()
            events.append("capture-closed")
            if events.count("capture-closed") == 2:
                captures_closed.set()
        server.server_close = close_capture
        return server

    def make_thread(*args, **kwargs):
        thread = real_thread(*args, **kwargs)
        owned_threads.append(thread)
        target = kwargs.get("target")
        if outcome == "scheduled" and getattr(target, "__name__", None) == "process_request_thread":
            deferred_starts.append(thread.start)
            thread.start = scheduled.set
        return thread

    def blocked_reset():
        events.append("handler-entered")
        handler_entered.set()
        if not release_handler.wait(timeout=4):
            raise TimeoutError("Owned test handler was not released")
        events.append("handler-finished")

    def request_reset(server):
        connection = HTTPConnection(*server.server_address, timeout=5)
        try:
            connection.request("POST", "/reset", body=b"")
            response = connection.getresponse()
            requests.append((response.status, response.read()))
        finally:
            connection.close()

    request_threads = []
    def run(*_args, **_kwargs):
        control = servers[1]
        control.capture_state.reset_fixture = blocked_reset
        client = real_thread(target=request_reset, args=(control,))
        request_threads.append(client)
        client.start()
        assert (scheduled if outcome == "scheduled" else handler_entered).wait(2)
        if outcome == "primary_failure":
            raise primary_error

    monkeypatch.setattr(sys, "argv", ["phase7AuthApp.py", "--port", "0", "--smtp-port", "0", "--control-port", "0"])
    monkeypatch.setattr(launcher, "resolve_isolated_database_urls", lambda: ("isolated-setup", "isolated-runtime"))
    monkeypatch.setattr(launcher.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(launcher, "IsolatedDatabaseOwnershipLock", Lock)
    monkeypatch.setattr(launcher, "_SMTPServer", lambda address, state: construct(smtp_factory, address, state))
    monkeypatch.setattr(launcher, "_ControlServer", lambda address, state: construct(control_factory, address, state))
    for name in ["_configure_environment", "prepare_isolated_database", "_bootstrap_owner", "persist_settings_playback_inventory"]:
        monkeypatch.setattr(launcher, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "CAPTURE_HANDLER_DRAIN_TIMEOUT_SECONDS", 0.05 if outcome in {"timeout", "primary_failure"} else 2, raising=False)
    monkeypatch.setattr(launcher.threading, "Thread", make_thread)
    monkeypatch.setattr(music_app, "create_asgi_app", lambda: object())
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(run=run))
    monkeypatch.setattr(launcher, "reset_application_tables", lambda _url: events.append("cleanup-reset"))

    def launch():
        try:
            launcher.main()
        except BaseException as error:
            errors.append(error)
        finally:
            finished.set()

    owner = real_thread(target=launch)
    owner.start()
    try:
        assert captures_closed.wait(3), "both accept loops/listening sockets must stop"
        if outcome in {"drained", "scheduled"}:
            assert not finished.wait(0.05), "main must wait for the accepted request before database cleanup"
            assert "cleanup-reset" not in events and "release" not in events
            if outcome == "scheduled":
                assert not handler_entered.is_set()
                deferred_starts.pop()()
                assert handler_entered.wait(1)
            release_handler.set()
            assert finished.wait(3)
            assert not errors
            assert events.index("handler-finished") < events.index("cleanup-reset") < events.index("release")
            assert not temp_root.exists()
        else:
            assert finished.wait(2), "an unproven handler must not cause an unbounded server_close join"
            assert "cleanup-reset" not in events and "release" not in events
            assert temp_root.exists()
            if outcome == "timeout":
                assert errors and "shutdown" in str(errors[0]).lower()
            else:
                assert errors == [primary_error]
            if outcome == "primary_failure":
                assert errors[0].cleanup_failures, "preserve drain failure alongside the original app failure"
    finally:
        for start in deferred_starts:
            start()
        release_handler.set()
        for client in request_threads:
            client.join(timeout=5)
            assert not client.is_alive()
        owner.join(timeout=5)
        assert not owner.is_alive()
        for server in servers:
            server.server_close()
        assert all(server.socket.fileno() == -1 for server in servers)
        for thread in owned_threads:
            if thread.ident is not None:
                thread.join(timeout=2)
                assert not thread.is_alive()
    assert requests and requests[0][0] == 200