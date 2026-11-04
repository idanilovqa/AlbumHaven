from __future__ import annotations

import urllib.error
from contextlib import nullcontext
from io import BytesIO
from types import SimpleNamespace

import pytest

import music_app.services.musicbrainz_http as musicbrainz_http
from music_app.services.musicbrainz_http import _block_reason_from_exception, default_user_agent


class _JsonResponse:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self._payload


def _reset_transport_state(monkeypatch):
    monkeypatch.setattr(musicbrainz_http, "_URL_CACHE", {})
    monkeypatch.setattr(musicbrainz_http, "_BLOCKED_UNTIL", 0.0)
    monkeypatch.setattr(musicbrainz_http, "_BLOCK_REASON", "")
    monkeypatch.setattr(musicbrainz_http, "_wait_for_slot", lambda: None)
    monkeypatch.setattr(musicbrainz_http.time, "sleep", lambda _seconds: None)


@pytest.fixture
def clock(monkeypatch):
    now = [100.0]
    sleeps = []

    def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds

    fake = SimpleNamespace(time=lambda: now[0], monotonic=lambda: now[0],
                           perf_counter=lambda: now[0], sleep=sleep)
    from music_app.services import cover_provider_deadline
    monkeypatch.setattr(musicbrainz_http, "time", fake)
    monkeypatch.setattr(cover_provider_deadline, "time", fake)
    monkeypatch.setattr(musicbrainz_http, "_URL_CACHE", {})
    monkeypatch.setattr(musicbrainz_http, "_BLOCKED_UNTIL", 0.0)
    monkeypatch.setattr(musicbrainz_http, "_NEXT_ALLOWED_AT_MONOTONIC", 0.0)
    return now, sleeps


@pytest.mark.parametrize("automatic", [True, False])
@pytest.mark.parametrize("wait_at", ["lock", "slot", "retry"])
def test_request_timeout_accounts_for_elapsed_automatic_budget(monkeypatch, clock, automatic, wait_at):
    from music_app.services.cover_provider_deadline import automatic_cover_budget
    now, _sleeps = clock
    timeouts = []

    class DelayedLock:
        def __enter__(self):
            now[0] += 2.0

        def __exit__(self, *_args):
            pass

    if wait_at == "lock":
        monkeypatch.setattr(musicbrainz_http, "_REQUEST_LOCK", DelayedLock())
    if wait_at == "slot":
        monkeypatch.setattr(musicbrainz_http, "_NEXT_ALLOWED_AT_MONOTONIC", 102.0)
    monkeypatch.setattr(musicbrainz_http, "_mark_request_complete", lambda: None)

    def request(_request, *, timeout):
        timeouts.append(timeout)
        if wait_at == "retry" and len(timeouts) == 1:
            now[0] += 1.0
            raise urllib.error.URLError("transient test transport failure")
        return BytesIO(b'{"ok": true}')

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", request)
    with automatic_cover_budget(5.0) if automatic else nullcontext():
        payload, _meta = musicbrainz_http.get_json("https://example.test/release", "Test", timeout=5.0)
    assert payload == {"ok": True}
    expected = ([5.0, 3.25] if wait_at == "retry" else [3.0]) if automatic else ([5.0, 5.0] if wait_at == "retry" else [5.0])
    assert timeouts == pytest.approx(expected)


@pytest.mark.parametrize("wait_at", ["slot", "retry"])
@pytest.mark.parametrize("failure", ["network", "http503", "other"])
def test_automatic_wait_observes_cancellation(monkeypatch, clock, wait_at, failure):
    from music_app.services.cover_provider_deadline import automatic_cover_budget
    now, sleeps = clock
    calls = []
    if wait_at == "slot":
        monkeypatch.setattr(musicbrainz_http, "_NEXT_ALLOWED_AT_MONOTONIC", 102.0)

    def request(*_args, **_kwargs):
        calls.append(True)
        if failure == "http503":
            raise urllib.error.HTTPError("https://example.test", 503, "Unavailable", {}, BytesIO())
        if failure == "other":
            raise ValueError("invalid transport payload")
        raise urllib.error.URLError("transient test transport failure")

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", request)
    with automatic_cover_budget(5.0):
        payload, meta = musicbrainz_http.get_json(
            "https://example.test/release", "Test", should_cancel=lambda: now[0] >= 100.05,
        )
    assert payload is None
    assert meta["status"] == "canceled"
    assert len(calls) == (1 if wait_at == "retry" else 0)
    assert sum(sleeps) == pytest.approx(0.05)
    assert musicbrainz_http._URL_CACHE == {}


@pytest.mark.parametrize("wait_at", ["slot", "retry"])
def test_automatic_wait_expires_without_negative_caching(monkeypatch, clock, wait_at):
    from music_app.services.cover_provider_deadline import AutomaticCoverDeadlineExceeded, automatic_cover_budget
    now, sleeps = clock
    calls = []
    if wait_at == "slot":
        monkeypatch.setattr(musicbrainz_http, "_NEXT_ALLOWED_AT_MONOTONIC", 102.0)

    def request(*_args, **_kwargs):
        calls.append(True)
        raise urllib.error.URLError("transient test transport failure")

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", request)
    with automatic_cover_budget(0.1), pytest.raises(AutomaticCoverDeadlineExceeded):
        musicbrainz_http.get_json("https://example.test/release", "Test")
    assert len(calls) == (1 if wait_at == "retry" else 0)
    assert sum(sleeps) == pytest.approx(0.1)
    assert now[0] == pytest.approx(100.1)
    assert musicbrainz_http._URL_CACHE == {}


def test_default_user_agent_uses_app_identity_and_contact():
    assert default_user_agent("Album Haven", "0.8.4", "hello@example.com") == "AlbumHaven/0.8.4 (Album Haven; hello@example.com)"


@pytest.mark.parametrize("automatic", [True, False])
@pytest.mark.parametrize("failure", ["network", "http503", "other"])
def test_final_transport_failure_after_deadline_is_not_negative_cached(monkeypatch, clock, automatic, failure):
    from music_app.services.cover_provider_deadline import AutomaticCoverDeadlineExceeded, automatic_cover_budget
    now, _sleeps = clock
    calls = []
    monkeypatch.setattr(musicbrainz_http, "_mark_request_complete", lambda: None)

    def request(*_args, **_kwargs):
        calls.append(True)
        if len(calls) == musicbrainz_http._MAX_ATTEMPTS:
            now[0] += 10.0
        if failure == "http503":
            raise urllib.error.HTTPError("https://example.test", 503, "Unavailable", {}, BytesIO())
        if failure == "other":
            raise ValueError("invalid transport payload")
        raise urllib.error.URLError("transient test transport failure")

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", request)
    with automatic_cover_budget(5.0) if automatic else nullcontext():
        with pytest.raises(AutomaticCoverDeadlineExceeded) if automatic else nullcontext():
            musicbrainz_http.get_json("https://example.test/release", "Test")
    assert len(calls) == musicbrainz_http._MAX_ATTEMPTS
    assert bool(musicbrainz_http._URL_CACHE) is (not automatic)


def test_block_reason_detects_tls_handshake_style_failures():
    assert _block_reason_from_exception("SSL/TLS connection failed") == "tls_handshake_blocked"
    assert _block_reason_from_exception("EOF occurred in violation of protocol") == "tls_handshake_blocked"


def test_block_reason_ignores_generic_connection_errors():
    assert _block_reason_from_exception("timed out") == ""


def test_get_json_stops_before_retry_when_lookup_is_canceled(monkeypatch):
    request_count = 0
    canceled = False

    def fail_first_request(*_args, **_kwargs):
        nonlocal request_count, canceled
        request_count += 1
        canceled = True
        raise urllib.error.URLError("fixture request released after save cancellation")

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", fail_first_request)
    monkeypatch.setattr(musicbrainz_http, "_wait_for_slot", lambda: None)
    monkeypatch.setattr(
        musicbrainz_http.time,
        "sleep",
        lambda _seconds: (_ for _ in ()).throw(AssertionError("canceled request must not back off or retry")),
    )
    monkeypatch.setattr(musicbrainz_http, "_URL_CACHE", {})
    monkeypatch.setattr(musicbrainz_http, "_BLOCKED_UNTIL", 0.0)
    monkeypatch.setattr(musicbrainz_http, "_BLOCK_REASON", "")

    payload, metadata = musicbrainz_http.get_json(
        "http://127.0.0.1:4175/musicbrainz/release/",
        "AlbumHaven/Test",
        should_cancel=lambda: canceled,
    )

    assert payload is None
    assert metadata == {"status": "canceled", "cache_hit": False, "attempt": 1}
    assert request_count == 1
    assert musicbrainz_http._URL_CACHE == {}


def test_get_json_preserves_direct_lookup_404_and_does_not_cache_it(monkeypatch):
    _reset_transport_state(monkeypatch)
    request_count = 0

    def return_404(request, *_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, BytesIO(b"{}"))

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", return_404)

    first = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/fixture-id", "AlbumHaven/Test", cache_failures=False,
    )
    second = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/fixture-id", "AlbumHaven/Test", cache_failures=False,
    )

    assert first == (None, {"status": "http_404", "http_status": 404, "cache_hit": False, "attempt": 1})
    assert second == first
    assert request_count == 2
    assert musicbrainz_http._URL_CACHE == {}


def test_shared_transport_default_still_negative_caches_failures(monkeypatch):
    _reset_transport_state(monkeypatch)
    request_count = 0

    def return_404(request, *_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, BytesIO(b"{}"))

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", return_404)

    first = musicbrainz_http.get_json("https://mirror.test/ws/2/release/fixture-id", "AlbumHaven/Test")
    second = musicbrainz_http.get_json("https://mirror.test/ws/2/release/fixture-id", "AlbumHaven/Test")
    uncached = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/release/fixture-id", "AlbumHaven/Test", cache_failures=False,
    )

    assert first[1]["status"] == "http_404"
    assert second == (None, {"status": "cached_miss", "cache_hit": True})
    assert uncached[1]["status"] == "http_404"
    assert request_count == 2


def test_get_json_caches_only_a_valid_success(monkeypatch):
    _reset_transport_state(monkeypatch)
    request_count = 0

    def return_artist(*_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        return _JsonResponse(b'{"id":"fixture-artist"}')

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", return_artist)

    first = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/fixture-artist", "AlbumHaven/Test")
    second = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/fixture-artist", "AlbumHaven/Test")

    assert first == ({"id": "fixture-artist"}, {"status": "network", "http_status": 200, "cache_hit": False, "attempt": 1})
    assert second == ({"id": "fixture-artist"}, {"status": "cache", "http_status": 200, "cache_hit": True})
    assert request_count == 1


def test_get_json_preserves_retryable_status_without_negative_cache(monkeypatch):
    _reset_transport_state(monkeypatch)
    request_count = 0

    def fail(request, *_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        status = 429 if request_count == 1 else 503
        raise urllib.error.HTTPError(request.full_url, status, "Unavailable", {}, BytesIO(b"{}"))

    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", fail)

    rate_limited = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/a", "AlbumHaven/Test", cache_failures=False,
    )
    monkeypatch.setattr(musicbrainz_http, "_BLOCKED_UNTIL", 0.0)
    unavailable = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/b", "AlbumHaven/Test", cache_failures=False,
    )

    assert rate_limited[1]["http_status"] == 429
    assert rate_limited[1]["status"] == "http_429"
    assert unavailable[1]["http_status"] == 503
    assert unavailable[1]["status"] == "http_503"
    assert musicbrainz_http._URL_CACHE == {}


def test_get_json_classifies_timeout_and_invalid_json_without_caching(monkeypatch):
    _reset_transport_state(monkeypatch)
    responses = iter((TimeoutError("fixture timeout"), _JsonResponse(b"not-json")))

    def respond(*_args, **_kwargs):
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(musicbrainz_http, "_MAX_ATTEMPTS", 1)
    monkeypatch.setattr(musicbrainz_http.urllib.request, "urlopen", respond)

    timeout = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/timeout", "AlbumHaven/Test", cache_failures=False,
    )
    invalid = musicbrainz_http.get_json(
        "https://mirror.test/ws/2/artist/invalid", "AlbumHaven/Test", cache_failures=False,
    )

    assert timeout == (None, {"status": "timeout", "cache_hit": False, "attempt": 1})
    assert invalid == (None, {"status": "invalid_response", "cache_hit": False, "attempt": 1})
    assert musicbrainz_http._URL_CACHE == {}
