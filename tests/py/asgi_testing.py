from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import traceback
from pathlib import Path
from collections.abc import Iterable
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs
from urllib.parse import urlencode
from urllib.parse import urlsplit

from tests.py.runtime_testing import configure_test_app_paths


EVENT_LOOP_STALL_LIMIT_SECONDS = 0.25
_HEARTBEAT_SECONDS = 0.01
_SAMPLE_SECONDS = 0.02


class EventLoopStall(AssertionError):
    """A request blocked the event loop, so every other request would have waited."""


def _importing(frame) -> bool:
    """Whether the stack is inside import machinery (a first import of a module)."""
    while frame is not None:
        if "importlib" in frame.f_code.co_filename:
            return True
        frame = frame.f_back
    return False


class _StackSampler:
    """One process-wide thread samples the loop thread's stack for every active
    watchdog. A thread per request would make concurrent requests start and
    contend with their own observers, so a burst of requests on the loop would
    be measured as a stall the watchdogs themselves caused."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active = threading.Condition(self._lock)
        self._watchdogs: set[EventLoopWatchdog] = set()
        self._thread: threading.Thread | None = None

    def add(self, watchdog: EventLoopWatchdog) -> None:
        with self._lock:
            self._watchdogs.add(watchdog)
            self._active.notify()
            start = self._thread is None
            if start:
                self._thread = threading.Thread(target=self._run, name="asgi-event-loop-watchdog", daemon=True)
        if start:
            self._thread.start()

    def remove(self, watchdog: EventLoopWatchdog) -> None:
        """Returns once no sampling pass can still record for `watchdog`."""
        with self._lock:
            self._watchdogs.discard(watchdog)

    def _run(self) -> None:
        while True:
            with self._lock:
                while not self._watchdogs:
                    self._active.wait()
            time.sleep(_SAMPLE_SECONDS)
            with self._lock:
                stacks: dict[int, tuple[str, bool] | None] = {}
                for watchdog in self._watchdogs:
                    watchdog._sample(stacks)


class EventLoopWatchdog:
    """Fails a request during which the event loop is blocked for over 250 ms.

    A heartbeat task records how late the loop runs it. A shared sampler thread
    reads the loop thread's stack through `sys._current_frames()` while the heartbeat
    is overdue, so the failure names the blocking call. A stall every sample of
    which is inside import machinery is a test process's first import of a
    module, not request work, and is not counted. A stall the sampler could not
    sample means the sampler thread did not run either: either the loop thread
    held the GIL (a long C call, which spends process CPU time and is counted)
    or the operating system did not schedule the process (machine load, which
    spends almost none and is not counted). A test that needs to wait must
    `await asyncio.sleep(...)`, never block the loop.
    """

    def __init__(self) -> None:
        self._loop_thread = threading.get_ident()
        self._last_beat = time.monotonic()
        self._last_beat_cpu = time.process_time()
        self._worst_stall = 0.0
        self._stack = ""
        # The stacks sampled during each stall, keyed by the beat it started at,
        # each marked when it was inside import machinery.
        self._samples: dict[float, list[tuple[str, bool]]] = {}
        self._samples_lock = threading.Lock()
        self._heartbeat: asyncio.Task | None = None

    async def __aenter__(self) -> EventLoopWatchdog:
        self._last_beat = time.monotonic()
        self._last_beat_cpu = time.process_time()
        self._heartbeat = asyncio.get_running_loop().create_task(self._beat())
        _SAMPLER.add(self)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        _SAMPLER.remove(self)
        self._observe()
        self._heartbeat.cancel()
        await asyncio.gather(self._heartbeat, return_exceptions=True)
        if exc_type is None and self._worst_stall > EVENT_LOOP_STALL_LIMIT_SECONDS:
            raise EventLoopStall(
                f"the request blocked the event loop for {self._worst_stall * 1000:.0f} ms "
                f"(limit {EVENT_LOOP_STALL_LIMIT_SECONDS * 1000:.0f} ms); loop thread stack while blocked:\n"
                f"{self._stack or '<not sampled>'}"
            )
        return False

    def _observe(self) -> None:
        now = time.monotonic()
        now_cpu = time.process_time()
        stall = now - self._last_beat - _HEARTBEAT_SECONDS
        with self._samples_lock:
            samples = self._samples.pop(self._last_beat, [])
        if stall > EVENT_LOOP_STALL_LIMIT_SECONDS:
            if samples and all(importing for _stack, importing in samples):
                stall = 0.0
            elif not samples and now_cpu - self._last_beat_cpu < EVENT_LOOP_STALL_LIMIT_SECONDS:
                stall = 0.0
        if stall > self._worst_stall:
            self._worst_stall = stall
            self._stack = next((stack for stack, importing in reversed(samples) if not importing), "")
        self._last_beat = now
        self._last_beat_cpu = now_cpu

    async def _beat(self) -> None:
        while True:
            self._observe()
            await asyncio.sleep(_HEARTBEAT_SECONDS)

    def _sample(self, stacks: dict[int, tuple[str, bool] | None]) -> None:
        """Records the loop thread's stack if the heartbeat is overdue; `stacks`
        shares one formatted stack per thread across a sampling pass."""
        beat = self._last_beat
        if time.monotonic() - beat < EVENT_LOOP_STALL_LIMIT_SECONDS / 2:
            return
        if self._loop_thread not in stacks:
            frame = sys._current_frames().get(self._loop_thread)
            stacks[self._loop_thread] = (
                None if frame is None else ("".join(traceback.format_stack(frame)), _importing(frame))
            )
        sample = stacks[self._loop_thread]
        if sample is not None:
            with self._samples_lock:
                self._samples.setdefault(beat, []).append(sample)


_SAMPLER = _StackSampler()


class _BootstrapOwnerResolver:
    def resolve(self, _raw_token):
        from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship

        return CurrentActor(
            state=ActorState.ACTIVE,
            account_id=1,
            session_id=1,
            username_display="Rendref",
            is_bootstrap_owner=True,
            current_library_id=1,
            library_relationships=(LibraryRelationship(1, "owner", True),),
        )


class InMemoryCoverReferences:
    """Test double of `CoverReferenceStore` for route units without Postgres.

    References are deterministic, so a test can name a cover before or after the app does.
    """

    def __init__(self):
        self.named: dict[tuple[int, str], tuple[str, str]] = {}

    @staticmethod
    def reference(path) -> str:
        import base64
        import hashlib

        return base64.urlsafe_b64encode(hashlib.sha256(str(path).encode("utf-8")).digest()).decode("ascii")[:22]

    def references_for(self, library_id, wanted):
        for path, kind in wanted.items():
            current = self.named.get((library_id, path))
            if current is None or (current[1] == "candidate" and kind == "cover"):
                self.named[(library_id, path)] = (self.reference(path), kind)
        return {path: self.named[(library_id, path)][0] for path in wanted}

    def resolve(self, library_id, reference, *, refresh=False):
        return next(
            ((path, kind) for (library, path), (named, kind) in self.named.items()
             if library == library_id and named == reference),
            None,
        )

    def paths_for(self, library_id, references):
        return {reference: hit[0] for reference in set(references) if (hit := self.resolve(library_id, reference))}

    def is_named_cover(self, library_id, path):
        return self.named.get((library_id, str(path)), ("", ""))[1] == "cover"


def cover_reference_url(asgi_app, path, library_id: int = 1) -> str:
    """Name `path` as a cover of the test library and return its `/cover/<reference>` route."""
    configure_test_bootstrap_actor(asgi_app)
    store = asgi_app.state.cover_reference_store
    return f"/cover/{store.references_for(library_id, {str(path): 'cover'})[str(path)]}"


def configure_test_bootstrap_actor(asgi_app) -> None:
    """Authenticate legacy route-unit requests through the production boundary."""

    if not hasattr(asgi_app.state, "current_actor_resolver"):
        asgi_app.state.current_actor_resolver = _BootstrapOwnerResolver()
        # The fixture's default owner also owns its media host. Configure this
        # only when installing the default resolver, not on every request: tests
        # may deliberately clear the host or supply another actor afterward.
        if getattr(asgi_app.state, "media_host_library_id", None) is None:
            asgi_app.state.media_host_library_id = 1
    if getattr(asgi_app.state, "cover_reference_store", None) is None:
        asgi_app.state.cover_reference_store = InMemoryCoverReferences()
    if not hasattr(asgi_app.state, "auth_policy_config"):
        asgi_app.state.auth_policy_config = {
            "hmac": {
                "secret": "test-only-policy-origin-key-32-bytes-minimum",
                "key_version": 1,
            }
        }


def create_test_asgi_app(tmp_path: Path, monkeypatch):
    configure_test_app_paths(tmp_path, monkeypatch)

    from music_app import create_asgi_app

    asgi_app = create_asgi_app()
    asgi_app.state.config["TESTING"] = True
    configure_test_bootstrap_actor(asgi_app)
    asgi_app.state.media_host_library_id = 1
    return asgi_app


def runtime_app_from_asgi_app(asgi_app):
    return SimpleNamespace(
        config=asgi_app.state.config,
        library_state=asgi_app.state.library_state,
        logger=asgi_app.state.logger,
    )


class TestQueryArgs:
    def __init__(self, values: dict[str, list[str]]):
        self._values = values

    def get(self, key: str, default=None):
        values = self._values.get(key)
        if not values:
            return default
        return values[0]

    def getlist(self, key: str) -> list[str]:
        return list(self._values.get(key, []))


def query_args_from_url(url: str) -> TestQueryArgs:
    return TestQueryArgs(parse_qs(urlsplit(url).query, keep_blank_values=True))


def _route_path(route: object) -> str:
    for attr_name in ("path", "path_format"):
        path = getattr(route, attr_name, None)
        if isinstance(path, str) and path:
            return path
    return ""


def _join_route_paths(prefix: str, path: str) -> str:
    normalized_prefix = str(prefix or "").strip()
    normalized_path = str(path or "").strip()
    if not normalized_prefix:
        return normalized_path or "/"
    if not normalized_path or normalized_path == "/":
        return normalized_prefix
    if normalized_path.startswith(normalized_prefix + "/"):
        return normalized_path
    return normalized_prefix.rstrip("/") + "/" + normalized_path.lstrip("/")


def _iter_route_nodes(root: object) -> Iterable[tuple[object, str]]:
    visited: set[int] = set()

    def walk(node: object, prefix: str = ""):
        node_id = id(node)
        if node_id in visited:
            return
        visited.add(node_id)

        path = _route_path(node)
        joined_path = _join_route_paths(prefix, path) if path else prefix
        yield node, joined_path

        child_containers = (
            getattr(node, "routes", None),
            getattr(getattr(node, "router", None), "routes", None),
            getattr(getattr(node, "app", None), "routes", None),
            getattr(getattr(getattr(node, "app", None), "router", None), "routes", None),
        )
        child_prefix = joined_path if path else prefix
        for child_routes in child_containers:
            if not isinstance(child_routes, Iterable) or isinstance(child_routes, (str, bytes, bytearray)):
                continue
            for child in child_routes:
                yield from walk(child, child_prefix)

    yield from walk(root)


def collect_route_paths(app) -> list[str]:
    paths: list[str] = []
    seen_paths: set[str] = set()
    for _route, path in _iter_route_nodes(app):
        if path and path not in seen_paths:
            seen_paths.add(path)
            paths.append(path)
    return paths


def collect_route_methods(app) -> dict[str, set[str]]:
    route_methods: dict[str, set[str]] = {}
    for route, path in _iter_route_nodes(app):
        methods = getattr(route, "methods", None)
        if path and methods:
            route_methods[path] = {str(method) for method in methods}
    return route_methods


async def run_asgi_request_async(
    app,
    method: str,
    path: str,
    *,
    query: dict[str, object] | None = None,
    headers: dict[str, str] | None = None,
    json_body: Any = None,
    body: bytes = b"",
    client_host: str = "testclient",
    server_host: str = "testserver",
) -> tuple[int, dict[str, str], bytes]:
    if hasattr(getattr(app, "state", None), "runtime_asset_version"):
        configure_test_bootstrap_actor(app)
    query_string = urlencode(query or {}, doseq=True).encode("ascii")
    request_body = body
    request_headers = [(b"host", server_host.encode("ascii"))]
    for key, value in (headers or {}).items():
        request_headers.append((key.lower().encode("latin1"), value.encode("latin1")))
    if hasattr(getattr(app, "state", None), "runtime_asset_version"):
        from music_app.services.auth_session_csrf import issue_session_csrf

        session = "s" * 43
        csrf = issue_session_csrf(session, app.state.auth_policy_config)
        present = {key for key, _value in request_headers}
        if b"cookie" not in present:
            request_headers.append(
                (
                    b"cookie",
                    (
                        f"__Host-album_haven_session={session}; "
                        f"__Host-album_haven_csrf={csrf}"
                    ).encode("ascii"),
                )
            )
        if method.upper() not in {"GET", "HEAD", "OPTIONS"} and b"origin" not in present:
            request_headers.append((b"origin", f"http://{server_host}".encode("ascii")))
        if method.upper() not in {"GET", "HEAD", "OPTIONS"} and b"x-album-haven-csrf" not in present:
            request_headers.append((b"x-album-haven-csrf", csrf.encode("ascii")))
    if json_body is not None:
        request_body = json.dumps(json_body).encode("utf-8")
        request_headers.append((b"content-type", b"application/json"))
        request_headers.append((b"content-length", str(len(request_body)).encode("ascii")))
    elif body:
        request_headers.append((b"content-length", str(len(request_body)).encode("ascii")))

    messages: list[dict[str, object]] = []
    request_sent = False

    async def receive() -> dict[str, object]:
        nonlocal request_sent
        if request_sent:
            return {"type": "http.disconnect"}
        request_sent = True
        return {"type": "http.request", "body": request_body, "more_body": False}

    async def send(message: dict[str, object]) -> None:
        messages.append(message)

    async with EventLoopWatchdog():
        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": method,
                "scheme": "http",
                "path": path,
                "raw_path": path.encode("ascii"),
                "query_string": query_string,
                "headers": request_headers,
                "client": (client_host, 50000),
                "server": (server_host, 80),
            },
            receive,
            send,
        )

    start = next(message for message in messages if message["type"] == "http.response.start")
    response_body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    response_headers = {
        key.decode("latin1").lower(): value.decode("latin1")
        for key, value in start.get("headers", [])
    }
    return int(start["status"]), response_headers, response_body


def run_asgi_request(
    app,
    method: str,
    path: str,
    **kwargs,
) -> tuple[int, dict[str, str], bytes]:
    return asyncio.run(run_asgi_request_async(app, method, path, **kwargs))


def decode_json(body: bytes) -> Any:
    return json.loads(body.decode("utf-8"))
