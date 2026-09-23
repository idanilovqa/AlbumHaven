from __future__ import annotations

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module, util
import threading
import subprocess
import time
import urllib.request

import pytest


MODULE = "music_app.services.auth_breached_passwords"
PASSWORD = "correct horse battery staple!"
SHA1 = hashlib.sha1(PASSWORD.encode("utf-8"), usedforsecurity=False).hexdigest().upper()
PREFIX, SUFFIX = SHA1[:5], SHA1[5:]
USER_AGENT = "Album-Haven-Password-Screen/1.0"


def test_breached_password_checker_contract_is_present():
    assert util.find_spec(MODULE) is not None, (
        "missing Phase 7 breached-password checker: "
        "music_app/services/auth_breached_passwords.py"
    )


@pytest.fixture
def breached_passwords():
    if util.find_spec(MODULE) is None:
        pytest.skip("presence test covers the RED contract")
    return import_module(MODULE)


class FakeResponse:
    def __init__(self, body: bytes, *, status=200, final_url=None):
        self.body = body
        self.status = status
        self.final_url = final_url
        self.read_limits: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, limit: int = -1) -> bytes:
        self.read_limits.append(limit)
        return self.body if limit < 0 else self.body[:limit]

    def getcode(self):
        return self.status

    def geturl(self):
        return self.final_url


class RecordingOpener:
    def __init__(self, body: bytes = b"", *, status=200, final_url=None):
        self.response = FakeResponse(body, status=status, final_url=final_url)
        self.calls = []
        self.failure: Exception | None = None

    def __call__(self, request, *, timeout):
        self.calls.append((request, timeout))
        if self.failure is not None:
            raise self.failure
        if self.response.final_url is None:
            self.response.final_url = request.full_url
        return self.response


def _checker(module, opener, *, timeout=3.0):
    return module.HibpRangePasswordChecker(opener=opener, timeout_seconds=timeout)


@pytest.mark.parametrize("count", ["1", "981273"])
def test_checker_uses_sha1_prefix_k_anonymity_and_required_headers(
    breached_passwords, count
):
    opener = RecordingOpener(f"{SUFFIX}:{count}\r\n{'A' * 35}:0\r\n".encode("ascii"))

    assert _checker(breached_passwords, opener)(PASSWORD) is True

    request, timeout = opener.calls[0]
    assert request.full_url == f"https://api.pwnedpasswords.com/range/{PREFIX}"
    headers = {key.casefold(): value for key, value in request.header_items()}
    assert headers["add-padding"].casefold() == "true"
    assert headers["user-agent"] == USER_AGENT
    assert timeout == 3.0
    assert PASSWORD not in request.full_url
    assert SHA1 not in request.full_url


def test_checker_returns_false_for_a_strict_valid_nonmatch(breached_passwords):
    opener = RecordingOpener(f"{'A' * 35}:12\n{'B' * 35}:0\n".encode("ascii"))

    assert _checker(breached_passwords, opener)(PASSWORD) is False


def test_default_transport_rejects_redirect_before_disclosing_prefix(breached_passwords, monkeypatch):
    paths = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            if self.path.startswith("/range/"):
                self.send_response(302)
                self.send_header("Location", f"/unapproved/{PREFIX}")
                self.end_headers()
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(f"{'A' * 35}:0\n".encode("ascii"))

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    worker.start()
    try:
        # The global fixture blocks urlopen before this module's default argument
        # is bound. Import a private copy with a real, proxy-free loopback opener.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        expected_url = f"http://127.0.0.1:{server.server_port}/range/{PREFIX}"

        def owned_urlopen(request, **kwargs):
            assert request.full_url == expected_url
            return opener.open(request, **kwargs)

        monkeypatch.setattr(urllib.request, "urlopen", owned_urlopen)
        spec = util.spec_from_file_location("_owned_hibp_transport", breached_passwords.__file__)
        transport = util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        checker = transport.HibpRangePasswordChecker(
            range_url_template=f"http://127.0.0.1:{server.server_port}/range/{{}}",
            timeout_seconds=1,
        )
        with pytest.raises(transport.BreachedPasswordCheckError):
            checker(PASSWORD)
        assert paths == [f"/range/{PREFIX}"]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        assert not worker.is_alive()


def test_checker_accepts_large_valid_padded_official_response(breached_passwords):
    body = "".join(f"{index:035X}:0\n" for index in range(2_100)).encode("ascii")
    assert len(body) > 65_536
    opener = RecordingOpener(body)

    assert _checker(breached_passwords, opener)(PASSWORD) is False


def test_checker_still_rejects_response_beyond_defensive_limit(breached_passwords):
    body = b"A" * (breached_passwords._MAX_RESPONSE_BYTES + 1)

    with pytest.raises(
        breached_passwords.BreachedPasswordCheckError,
        match="screening unavailable",
    ):
        _checker(breached_passwords, RecordingOpener(body))(PASSWORD)


def test_suffix_comparisons_do_not_short_circuit_after_match(
    breached_passwords, monkeypatch
):
    comparisons = []
    original = breached_passwords.hmac.compare_digest

    def recording_compare(left, right):
        comparisons.append((left, right))
        return original(left, right)

    monkeypatch.setattr(breached_passwords.hmac, "compare_digest", recording_compare)
    opener = RecordingOpener(
        f"{SUFFIX}:2\n{'A' * 35}:9\n{'B' * 35}:0\n".encode("ascii")
    )

    assert _checker(breached_passwords, opener)(PASSWORD) is True
    assert len(comparisons) == 3


@pytest.mark.parametrize("timeout", [0, -1, 5.01, True, "3"])
def test_checker_rejects_unbounded_or_invalid_timeout(breached_passwords, timeout):
    with pytest.raises(ValueError, match="configuration"):
        _checker(breached_passwords, RecordingOpener(), timeout=timeout)


def test_range_url_override_allows_only_official_service_or_loopback(
    breached_passwords,
):
    breached_passwords.HibpRangePasswordChecker(
        range_url_template="https://api.pwnedpasswords.com/range/{}"
    )
    breached_passwords.HibpRangePasswordChecker(
        range_url_template="http://127.0.0.1:6182/range/{}"
    )
    with pytest.raises(ValueError, match="HTTPS outside loopback"):
        breached_passwords.HibpRangePasswordChecker(
            range_url_template="http://password-screen.example/range/{}"
        )
    with pytest.raises(ValueError, match="official service or loopback"):
        breached_passwords.HibpRangePasswordChecker(
            range_url_template="https://password-screen.example/range/{}"
        )
    for invalid in (
        "https://password-screen.example/range/static",
        "https://user:secret@password-screen.example/range/{}",
        "https://password-screen.example/range/{}?leak=true",
    ):
        with pytest.raises(ValueError, match="template is invalid"):
            breached_passwords.HibpRangePasswordChecker(
                range_url_template=invalid
            )


@pytest.mark.parametrize(
    "body",
    [
        b"not-a-suffix:1\n",
        f"{SUFFIX}:not-a-count\n".encode("ascii"),
        f"{SUFFIX}:-1\n".encode("ascii"),
        f"{SUFFIX}:1:2\n".encode("ascii"),
        f"{SUFFIX.lower()}:1\n".encode("ascii"),
        f"{SUFFIX}:1\n{SUFFIX}:2\n".encode("ascii"),
        b"\xff:1\n",
        b"",
    ],
)
def test_malformed_or_ambiguous_range_response_fails_closed(
    breached_passwords, body
):
    with pytest.raises(
        breached_passwords.BreachedPasswordCheckError,
        match="screening unavailable",
    ):
        _checker(breached_passwords, RecordingOpener(body))(PASSWORD)


def test_network_failure_is_generic_and_does_not_expose_password(breached_passwords):
    opener = RecordingOpener()
    opener.failure = OSError(f"network failed for {PASSWORD}")

    with pytest.raises(breached_passwords.BreachedPasswordCheckError) as caught:
        _checker(breached_passwords, opener)(PASSWORD)

    assert PASSWORD not in str(caught.value)


@pytest.mark.parametrize(
    ("status", "final_url"),
    [
        (503, f"https://api.pwnedpasswords.com/range/{PREFIX}"),
        (200, f"http://api.pwnedpasswords.com/range/{PREFIX}"),
        (200, f"https://attacker.example/range/{PREFIX}"),
        (200, f"https://api.pwnedpasswords.com/range/{PREFIX}/extra"),
    ],
)
def test_non_200_or_redirected_response_fails_closed(
    breached_passwords, status, final_url
):
    opener = RecordingOpener(
        f"{SUFFIX}:1\n".encode("ascii"),
        status=status,
        final_url=final_url,
    )

    with pytest.raises(
        breached_passwords.BreachedPasswordCheckError,
        match="screening unavailable",
    ):
        _checker(breached_passwords, opener)(PASSWORD)


@pytest.mark.parametrize("password", [None, b"secret", ""])
def test_invalid_password_input_fails_before_network(breached_passwords, password):
    opener = RecordingOpener()

    with pytest.raises(ValueError, match="password"):
        _checker(breached_passwords, opener)(password)

    assert opener.calls == []


@pytest.mark.parametrize("framing", [
    "truncated-length", "truncated-chunked", "length", "chunked", "close",
])
def test_default_transport_rejects_truncated_framing_and_accepts_complete_bodies(
    breached_passwords, monkeypatch, framing
):
    children = []
    paths = []
    real_popen = subprocess.Popen

    def record_child(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", record_child)
    prefix_body = f"{'A' * 35}:0\r\n".encode("ascii")
    complete_body = prefix_body + f"{SUFFIX}:1\r\n".encode("ascii")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            paths.append(self.path)
            mode = "length" if self.path.startswith("/complete/") else framing
            self.send_response(200)
            self.send_header("Connection", "close")
            if "length" in mode:
                self.send_header("Content-Length", str(len(complete_body)))
            elif "chunked" in mode:
                self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            if mode == "truncated-length":
                # A syntactically valid nonmatching line must not disguise an
                # incomplete transport body whose omitted suffix is breached.
                self.wfile.write(prefix_body)
            elif "chunked" in mode:
                body = prefix_body if mode.startswith("truncated") else complete_body
                self.wfile.write(f"{len(body):x}\r\n".encode("ascii") + body + b"\r\n")
                if mode == "chunked":
                    self.wfile.write(b"0\r\n\r\n")
            else:
                self.wfile.write(complete_body)
            self.wfile.flush()
            self.close_connection = True

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    worker.start()
    try:
        spec = util.spec_from_file_location("_framing_hibp_transport", breached_passwords.__file__)
        transport = util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        checker = transport.HibpRangePasswordChecker(
            range_url_template=f"http://127.0.0.1:{server.server_port}/framing/{{}}",
            timeout_seconds=2,
        )
        if framing.startswith("truncated"):
            with pytest.raises(transport.BreachedPasswordCheckError, match="screening unavailable"):
                checker(PASSWORD)
        else:
            assert checker(PASSWORD) is True
        assert children and all(child.poll() is not None for child in children)
        next_checker = transport.HibpRangePasswordChecker(
            range_url_template=f"http://127.0.0.1:{server.server_port}/complete/{{}}",
            timeout_seconds=2,
        )
        assert next_checker(PASSWORD) is True
        assert paths == [f"/framing/{PREFIX}", f"/complete/{PREFIX}"]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        assert not worker.is_alive()
        assert all(child.poll() is not None for child in children)
        assert all(child.stdout is None or child.stdout.closed for child in children)


@pytest.mark.parametrize("slow_phase", ["headers", "body"])
def test_default_transport_deadline_reaps_slow_stream_and_allows_next_check(
    breached_passwords, monkeypatch, slow_phase
):
    requested = threading.Event()
    stop = threading.Event()
    paths = []
    children = []
    real_popen = subprocess.Popen

    def record_child(*args, **kwargs):
        child = real_popen(*args, **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(subprocess, "Popen", record_child)

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            requested.set()
            payload = f"{SUFFIX}:1\n".encode("ascii")
            if self.path.startswith("/fast/"):
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            try:
                if slow_phase == "headers":
                    self.wfile.write(b"HTTP/1.0 200 OK\r\nX-Slow: ")
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "10000")
                    self.end_headers()
                # Each byte arrives well inside the socket timeout, but the
                # stream as a whole outlives the permitted transport budget.
                for _ in range(40):
                    self.wfile.write(b"A")
                    self.wfile.flush()
                    if stop.wait(0.1):
                        break
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = False
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    worker.start()
    try:
        # Load the production default transport without the suite's network
        # replacement. Only an owned loopback server is contacted.
        spec = util.spec_from_file_location("_deadline_hibp_transport", breached_passwords.__file__)
        transport = util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        checker = transport.HibpRangePasswordChecker(
            range_url_template=f"http://127.0.0.1:{server.server_port}/slow/{{}}",
            timeout_seconds=0.8,
        )
        started = time.monotonic()
        with pytest.raises(transport.BreachedPasswordCheckError, match="screening unavailable"):
            checker(PASSWORD)
        elapsed = time.monotonic() - started
        assert requested.is_set(), "the regression must exercise the slow response"
        assert elapsed < 2.5, f"socket trickle exceeded the total deadline: {elapsed}"
        assert children and all(child.poll() is not None for child in children)
        assert all(child.stdout is None or child.stdout.closed for child in children)
        fast_checker = transport.HibpRangePasswordChecker(
            range_url_template=f"http://127.0.0.1:{server.server_port}/fast/{{}}",
            timeout_seconds=2,
        )
        assert fast_checker(PASSWORD) is True
        assert paths == [f"/slow/{PREFIX}", f"/fast/{PREFIX}"]
        assert all(child.poll() is not None for child in children)
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        assert not worker.is_alive()
