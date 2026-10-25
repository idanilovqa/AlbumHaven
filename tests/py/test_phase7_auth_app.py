"""Failure-path ownership for the production Phase 7 E2E launcher."""
from __future__ import annotations

import importlib
from pathlib import Path
import sys

import pytest


def test_application_servers_clean_partial_secondary_start_when_primary_start_fails(
    monkeypatch,
):
    from types import SimpleNamespace

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    import music_app

    servers = []
    threads = []

    class Server:
        def __init__(self, config):
            self.config = config
            self.should_exit = False
            servers.append(self)

        def run(self):
            return None

    class Thread:
        def __init__(self, *, target, name, daemon):
            self.target = target
            self.name = name
            self.daemon = daemon
            self.started = False
            self.joined = False
            threads.append(self)

        def start(self):
            if self.name == "album-haven-phase7-primary":
                raise RuntimeError("primary thread start failed")
            self.started = True

        def join(self, timeout=None):
            del timeout
            self.joined = True

        def is_alive(self):
            return self.started and not self.joined

    monkeypatch.setattr(music_app, "create_asgi_app", lambda: object())
    monkeypatch.setattr(launcher.threading, "Thread", Thread)
    monkeypatch.setitem(
        sys.modules,
        "uvicorn",
        SimpleNamespace(
            Config=lambda app, **kwargs: SimpleNamespace(app=app, **kwargs),
            Server=Server,
        ),
    )
    owner = launcher._ApplicationServers(primary_port=5101, secondary_port=5102)

    with pytest.raises(RuntimeError, match="primary thread start failed"):
        owner.start()

    assert servers[1].should_exit is True
    assert threads[1].joined is True
    assert owner._entries == []


def _start_reset_lifecycle_harness(
    tmp_path, monkeypatch, *, stubborn_port=None, require_quiescence=True,
):
    from http.client import HTTPConnection
    import threading
    import time
    from types import SimpleNamespace

    import music_app

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    temp_root = tmp_path / "phase7"
    temp_root.mkdir()
    events, control_servers, app_servers, errors = [], [], [], []
    release_apps = threading.Event()
    initial_servers = []

    class Lock:
        def __init__(self, *, database_url):
            assert database_url == "isolated-setup"

        def acquire(self): events.append("acquire")
        def release(self): events.append("release")

    class CaptureServer:
        def __init__(self, *_args): pass
        def serve_forever(self): pass
        def begin_shutdown(self): pass
        def shutdown(self): pass
        def server_close(self): pass
        def drain_requests(self, _timeout): return True

    control_factory = launcher._ControlServer

    def build_control(address, state):
        server = control_factory(address, state)
        control_servers.append(server)
        return server

    class Worker:
        def __init__(self, number): self.number = number
        def start(self): events.append(f"worker-start-{self.number}")
        def stop(self): events.append(f"worker-stop-{self.number}")

    workers = []

    def build_worker(_url):
        worker = Worker(len(workers) + 1)
        workers.append(worker)
        return worker

    class Config:
        def __init__(self, app, *, host, port, **_kwargs):
            self.app = app
            self.host = host
            self.port = port

    class Server:
        def __init__(self, config):
            self.config = config
            self.should_exit = False
            self.started = threading.Event()
            self.stopped = threading.Event()
            app_servers.append(self)

        def run(self):
            events.append(f"app-start-{self.config.port}")
            self.started.set()
            while not release_apps.is_set():
                if self.should_exit and self.config.port != stubborn_port:
                    break
                time.sleep(0.005)
            events.append(f"app-stop-{self.config.port}")
            self.stopped.set()

    def legacy_run(app, *, host, port, **kwargs):
        Server(Config(app, host=host, port=port, **kwargs)).run()

    app_number = 0

    def create_app():
        nonlocal app_number
        app_number += 1
        events.append(f"app-create-{app_number}")
        return object()

    def reset_tables(_url):
        if require_quiescence:
            assert initial_servers and all(server.stopped.is_set() for server in initial_servers), (
                "database truncate started before every ASGI lifespan stopped"
            )
        events.append("truncate")

    monkeypatch.setattr(sys, "argv", [
        "phase7AuthApp.py", "--port", "5101", "--smtp-port", "0",
        "--control-port", "0", "--worker-port", "5102",
    ])
    monkeypatch.setattr(launcher, "resolve_isolated_database_urls", lambda: ("isolated-setup", "isolated-runtime"))
    monkeypatch.setattr(launcher.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(launcher, "IsolatedDatabaseOwnershipLock", Lock)
    monkeypatch.setattr(launcher, "_SMTPServer", CaptureServer)
    monkeypatch.setattr(launcher, "_ControlServer", build_control)
    for name in ("_configure_environment", "prepare_isolated_database", "_bootstrap_owner"):
        monkeypatch.setattr(launcher, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "persist_settings_playback_inventory", lambda *_args, **_kwargs: events.append("inventory"))
    monkeypatch.setattr(launcher, "seed_bootstrap_owner_and_library", lambda _url: events.append("seed"))
    monkeypatch.setattr(launcher, "reset_application_tables", reset_tables)
    monkeypatch.setattr(launcher, "build_isolated_jobs_worker", build_worker, raising=False)
    monkeypatch.setattr(launcher, "APPLICATION_SHUTDOWN_TIMEOUT_SECONDS", 0.05, raising=False)
    monkeypatch.setattr(music_app, "create_asgi_app", create_app)
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(Config=Config, Server=Server, run=legacy_run))

    def launch():
        try:
            launcher.main()
        except BaseException as error:
            errors.append(error)

    owner = threading.Thread(target=launch)
    owner.start()
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        running = [server for server in app_servers if server.started.is_set()]
        if control_servers and {server.config.port for server in running} == {5101, 5102}:
            initial_servers.extend(running)
            break
        time.sleep(0.005)
    assert len(initial_servers) == 2, "both application lifespans must start before reset"

    def reset():
        connection = HTTPConnection(*control_servers[0].server_address, timeout=3)
        try:
            connection.request("POST", "/reset", body=b"")
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def stop():
        release_apps.set()
        for server in app_servers:
            server.should_exit = True
        owner.join(timeout=5)
        assert not owner.is_alive()
        for server in control_servers:
            server.server_close()

    return SimpleNamespace(
        app_servers=app_servers,
        errors=errors,
        events=events,
        initial_servers=initial_servers,
        reset=reset,
        stop=stop,
        workers=workers,
    )


def test_phase7_reset_stops_all_app_lifespans_before_truncate_and_restarts_them(
    tmp_path, monkeypatch,
):
    harness = _start_reset_lifecycle_harness(tmp_path, monkeypatch)
    try:
        status, body = harness.reset()
        assert (status, body) == (200, b'{"ok": true}')
        assert all(server.stopped.is_set() for server in harness.initial_servers)
        assert len(harness.app_servers) == 4, "reset must create fresh primary and secondary apps"
        assert {server.config.port for server in harness.app_servers[2:]} == {5101, 5102}
        truncate = harness.events.index("truncate")
        assert max(harness.events.index(f"app-stop-{port}") for port in (5101, 5102)) < truncate
        assert truncate < harness.events.index("seed")
        assert truncate < harness.events.index("inventory", truncate)
        assert all(
            harness.events.index(f"app-start-{port}", truncate) > truncate
            for port in (5101, 5102)
        )
        assert harness.events.index("worker-stop-1") < truncate < harness.events.index("worker-start-2")
    finally:
        harness.stop()


def test_phase7_reset_refuses_truncate_when_any_app_lifespan_does_not_stop(
    tmp_path, monkeypatch,
):
    harness = _start_reset_lifecycle_harness(
        tmp_path, monkeypatch, stubborn_port=5102, require_quiescence=False,
    )
    try:
        status, body = harness.reset()
        assert status == 500
        assert b"shutdown" in body.lower()
        assert "truncate" not in harness.events
        assert "seed" not in harness.events
        assert len(harness.workers) == 1, "failed reset must not replace the durable worker"
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def _stub_durable_worker(monkeypatch):
    from types import SimpleNamespace

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    monkeypatch.setattr(launcher, "build_isolated_jobs_worker",
        lambda _url: SimpleNamespace(start=lambda: None, stop=lambda: None), raising=False)


@pytest.mark.parametrize("stop_fails", [False, True])
def test_phase7_durable_worker_quiesces_for_reset_and_before_database_cleanup(
    tmp_path, monkeypatch, stop_fails,
):
    import threading
    import time
    from types import SimpleNamespace
    import music_app

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[1] / "e2e" / "support"))
    launcher = importlib.import_module("phase7AuthApp")
    temp_root = tmp_path / "phase7"
    temp_root.mkdir()
    events, states = [], []

    class Lock:
        def __init__(self, **_kwargs): pass
        def acquire(self): events.append("acquire")
        def release(self): events.append("release")

    class CaptureServer:
        def __init__(self, _address, state): states.append(state)
        def begin_shutdown(self): pass
        def shutdown(self): pass
        def server_close(self): pass
        def drain_requests(self, _timeout):
            events.append("capture-drained")
            return True

    class Worker:
        def __init__(self, number): self.number = number
        def start(self): events.append(f"start-{self.number}")
        def stop(self):
            events.append(f"stop-{self.number}")
            if stop_fails:
                raise RuntimeError("worker shutdown unproven")

    workers = []
    def build_worker(url):
        assert url == "isolated-runtime"
        worker = Worker(len(workers) + 1)
        workers.append(worker)
        return worker

    app_servers = []

    class Config:
        def __init__(self, app, **_kwargs):
            self.app = app

    class Server:
        def __init__(self, config):
            self.config = config
            self.number = len(app_servers) + 1
            self.should_exit = False
            app_servers.append(self)

        def run(self):
            events.append("app-run")
            if stop_fails:
                return
            if self.number == 1:
                def request_reset():
                    states[0].reset_fixture()
                    events.append("reset-complete")
                    app_servers[1].should_exit = True

                threading.Thread(target=request_reset).start()
            while not self.should_exit:
                time.sleep(0.005)

    monkeypatch.setattr(sys, "argv", ["phase7AuthApp.py", "--port", "0", "--smtp-port", "0", "--control-port", "0"])
    monkeypatch.setattr(launcher, "resolve_isolated_database_urls", lambda: ("isolated-setup", "isolated-runtime"))
    monkeypatch.setattr(launcher.tempfile, "mkdtemp", lambda **_kwargs: str(temp_root))
    monkeypatch.setattr(launcher, "IsolatedDatabaseOwnershipLock", Lock)
    for name in ("_SMTPServer", "_ControlServer"):
        monkeypatch.setattr(launcher, name, CaptureServer)
    for name in ("_configure_environment", "prepare_isolated_database", "_bootstrap_owner", "persist_settings_playback_inventory", "_start_thread"):
        monkeypatch.setattr(launcher, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher, "build_isolated_jobs_worker", build_worker, raising=False)
    monkeypatch.setattr(launcher, "seed_bootstrap_owner_and_library", lambda _url: events.append("seed"))
    monkeypatch.setattr(launcher, "reset_application_tables", lambda _url: events.append("reset"))
    monkeypatch.setattr(music_app, "create_asgi_app", lambda: object())
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(Config=Config, Server=Server))

    if stop_fails:
        with pytest.raises(RuntimeError, match="shutdown"):
            launcher.main()
        assert "reset" not in events and "release" not in events
        assert temp_root.exists()
    else:
        launcher.main()
        first_run, second_run = (
            index for index, event in enumerate(events) if event == "app-run"
        )
        assert events.index("stop-1") < events.index("reset") < events.index("seed")
        assert events.index("seed") < second_run
        assert events.index("start-2") < events.index("reset-complete")
        assert events.index("reset-complete") < events.index("stop-2")
        assert first_run < events.index("stop-1")
        assert events[-2:] == ["reset", "release"]
        assert events.count("capture-drained") == 2
        assert not temp_root.exists()


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
        def __init__(self, *, database_url):
            assert database_url == "isolated-setup"

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
        def __init__(self, *, database_url):
            assert database_url == "isolated-setup"

        def acquire(self): events.append("acquire")
        def release(self): events.append("release")

    class Thread:
        created = 0

        def __init__(self, *, target, **_kwargs):
            self.target = target
            self.number = Thread.created
            self.ran = False
            Thread.created += 1

        def start(self): pass
        def join(self, timeout):
            events.append(("join", timeout))
            if timeout is None and self.number == 0 and not self.ran:
                self.ran = True
                self.target()
        def is_alive(self): return failure_point == "secondary" and self.number == 1

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

    class Worker:
        def start(self):
            events.append("worker-start")

        def stop(self):
            events.append("worker-stop")

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
    monkeypatch.setattr(launcher, "build_isolated_jobs_worker", lambda _url: Worker())
    monkeypatch.setattr(launcher, "threading", SimpleNamespace(Thread=Thread, Lock=lambda: None, Event=lambda: SimpleNamespace(set=lambda: None)))
    monkeypatch.setattr(music_app, "create_asgi_app", lambda: object())
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(
        Config=lambda *_args, **_kwargs: object(),
        Server=lambda *_args: SimpleNamespace(should_exit=False, run=run),
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
    assert "worker-stop" in events, "capture cleanup failures must not leave the durable worker running"

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
        def __init__(self, *, database_url):
            assert database_url == "isolated-setup"

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

    class Config:
        def __init__(self, app, **_kwargs):
            self.app = app

    class Server:
        def __init__(self, config):
            self.config = config
            self.should_exit = False

        def run(self):
            run()

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
    monkeypatch.setitem(sys.modules, "uvicorn", SimpleNamespace(Config=Config, Server=Server))
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
