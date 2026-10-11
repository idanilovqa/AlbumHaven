from __future__ import annotations

import urllib.error
from io import BytesIO

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


def test_default_user_agent_uses_app_identity_and_contact():
    assert default_user_agent("Album Haven", "0.8.4", "hello@example.com") == "AlbumHaven/0.8.4 (Album Haven; hello@example.com)"


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

    first = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/fixture-id", "AlbumHaven/Test")
    second = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/fixture-id", "AlbumHaven/Test")

    assert first == (None, {"status": "http_404", "http_status": 404, "cache_hit": False, "attempt": 1})
    assert second == first
    assert request_count == 2
    assert musicbrainz_http._URL_CACHE == {}


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

    rate_limited = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/a", "AlbumHaven/Test")
    monkeypatch.setattr(musicbrainz_http, "_BLOCKED_UNTIL", 0.0)
    unavailable = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/b", "AlbumHaven/Test")

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

    timeout = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/timeout", "AlbumHaven/Test")
    invalid = musicbrainz_http.get_json("https://mirror.test/ws/2/artist/invalid", "AlbumHaven/Test")

    assert timeout == (None, {"status": "timeout", "cache_hit": False, "attempt": 1})
    assert invalid == (None, {"status": "invalid_response", "cache_hit": False, "attempt": 1})
    assert musicbrainz_http._URL_CACHE == {}
