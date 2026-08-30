from __future__ import annotations

import json
import socket
import ssl
import urllib.error
from types import SimpleNamespace

from music_app.services import cover_provider_http


class FakeLogger:
    def __init__(self) -> None:
        self.verbose_calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def verbose(self, *args, **kwargs) -> None:
        self.verbose_calls.append((args, kwargs))


def test_http_get_bytes_uses_ssl_context(monkeypatch):
    captured: dict[str, object] = {}

    class FakeResponse:
        status = 200
        url = "https://example.com/test"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"payload"

    def fake_urlopen(request, timeout, context):
        captured["request"] = request
        captured["timeout"] = timeout
        captured["context"] = context
        return FakeResponse()

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(cover_provider_http, "_http_ssl_context", lambda: "ssl-context")

    payload = cover_provider_http._http_get_bytes(
        "https://example.com/test",
        "AlbumHavenTests/1.0",
        service="remote",
        context="test",
        logger=FakeLogger(),
    )

    assert payload == b"payload"
    assert captured["timeout"] == 15
    assert captured["context"] == "ssl-context"


def test_http_get_bytes_sends_user_agent_accept_extra_headers_and_timeout(monkeypatch):
    captured: dict[str, object] = {}

    class FakeResponse:
        status = 200
        url = "https://cdn.example/final-cover.jpg"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"cover-bytes"

    def fake_urlopen(request, timeout, context):
        captured["request"] = request
        captured["timeout"] = timeout
        captured["context"] = context
        return FakeResponse()

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(cover_provider_http, "_http_ssl_context", lambda: "ssl-context")

    payload = cover_provider_http._http_get_bytes(
        "https://cdn.example/cover.jpg",
        "AlbumHavenTests/1.0",
        accept="image/jpeg",
        service="remote",
        context="cover-fetch",
        logger=FakeLogger(),
        extra_headers={
            "X-Test-Header": "enabled",
            "X-Blank-Header": "",
        },
    )

    request = captured["request"]
    assert payload == b"cover-bytes"
    assert request.full_url == "https://cdn.example/cover.jpg"
    assert request.get_header("User-agent") == "AlbumHavenTests/1.0"
    assert request.get_header("Accept") == "image/jpeg"
    assert request.get_header("X-test-header") == "enabled"
    assert request.get_header("X-blank-header") is None
    assert captured["timeout"] == 15
    assert captured["context"] == "ssl-context"


def test_http_get_bytes_marks_and_logs_discogs_429(monkeypatch):
    events: list[dict[str, object]] = []
    rate_limited: list[bool] = []

    class FakeHeaders:
        def get(self, key):
            return {
                "X-Discogs-Ratelimit-Remaining": "0",
                "X-Discogs-Ratelimit": "60",
            }.get(key)

    error = urllib.error.HTTPError("url", 429, "Too Many Requests", FakeHeaders(), None)
    error.read = lambda: b'{"message": "rate limit"}'

    def fake_urlopen_with_body(request, timeout, context):
        raise error

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", fake_urlopen_with_body)
    monkeypatch.setattr(cover_provider_http, "_http_ssl_context", lambda: "ssl-context")

    payload = cover_provider_http._http_get_bytes(
        "https://api.discogs.com/releases/1?key=secret&token=hidden",
        "AlbumHavenTests/1.0",
        service="discogs",
        context="release",
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        mark_discogs_rate_limited=lambda: rate_limited.append(True),
    )

    assert payload is None
    assert rate_limited == [True]
    assert events == [
        {
            "action": "Discogs HTTP error",
            "level": "info",
            "context": "release",
            "status": 429,
            "url": "https://api.discogs.com/releases/1",
            "body": '{"message": "rate limit"}',
            "rate_limit_remaining": "0",
            "rate_limit_total": "60",
        }
    ]


def test_http_get_bytes_logs_discogs_url_timeout(monkeypatch):
    events: list[dict[str, object]] = []

    def fake_urlopen(request, timeout, context):
        raise urllib.error.URLError(socket.timeout("timed out"))

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(cover_provider_http, "_http_ssl_context", lambda: "ssl-context")

    payload = cover_provider_http._http_get_bytes(
        "https://api.discogs.com/releases/1?secret=hidden",
        "AlbumHavenTests/1.0",
        service="discogs",
        context="release",
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    assert payload is None
    assert events == [
        {
            "action": "Discogs URL error",
            "level": "info",
            "context": "release",
            "url": "https://api.discogs.com/releases/1",
            "reason": "timed out",
            "timeout": True,
        }
    ]


def test_http_get_json_returns_none_for_musicbrainz_decode_failure_and_non_dict_payload(monkeypatch):
    calls: list[dict[str, object]] = []
    events: list[dict[str, object]] = []
    payloads = iter([
        (["not", "a", "mapping"], {"attempt": 1, "status": "ok"}),
        (None, {"attempt": 2, "status": "decode_failed", "blocked_reason": "invalid_json"}),
    ])

    def fake_musicbrainz_get_json(url, user_agent, *, context, extra_headers, timeout):
        calls.append({
            "url": url,
            "user_agent": user_agent,
            "context": context,
            "extra_headers": extra_headers,
            "timeout": timeout,
        })
        return next(payloads)

    non_dict_payload = cover_provider_http._http_get_json(
        "https://musicbrainz.example/ws/2/release",
        "AlbumHavenTests/1.0",
        service="musicbrainz",
        context="release-search",
        extra_headers={"X-MB-Test": "enabled"},
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        musicbrainz_json_getter=fake_musicbrainz_get_json,
    )
    decode_failure_payload = cover_provider_http._http_get_json(
        "https://musicbrainz.example/ws/2/release",
        "AlbumHavenTests/1.0",
        service="musicbrainz",
        context="release-search",
        extra_headers={"X-MB-Test": "enabled"},
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
        musicbrainz_json_getter=fake_musicbrainz_get_json,
    )

    assert non_dict_payload is None
    assert decode_failure_payload is None
    assert calls == [
        {
            "url": "https://musicbrainz.example/ws/2/release",
            "user_agent": "AlbumHavenTests/1.0",
            "context": "release-search",
            "extra_headers": {"X-MB-Test": "enabled"},
            "timeout": 15.0,
        },
        {
            "url": "https://musicbrainz.example/ws/2/release",
            "user_agent": "AlbumHavenTests/1.0",
            "context": "release-search",
            "extra_headers": {"X-MB-Test": "enabled"},
            "timeout": 15.0,
        },
    ]
    assert events == [
        {
            "action": "MusicBrainz JSON request returned no payload",
            "level": "info",
            "context": "release-search",
            "attempt": 1,
            "url": "https://musicbrainz.example/ws/2/release",
            "status": "ok",
            "cache_hit": False,
            "blocked_reason": "",
            "retry_after_seconds": 0.0,
        },
        {
            "action": "MusicBrainz JSON request returned no payload",
            "level": "info",
            "context": "release-search",
            "attempt": 2,
            "url": "https://musicbrainz.example/ws/2/release",
            "status": "decode_failed",
            "cache_hit": False,
            "blocked_reason": "invalid_json",
            "retry_after_seconds": 0.0,
        },
    ]


def test_http_get_json_passes_cancellation_predicate_to_musicbrainz_client():
    captured: list[object] = []

    def fake_musicbrainz_get_json(
        _url,
        _user_agent,
        *,
        context,
        extra_headers,
        timeout,
        should_cancel,
    ):
        del context, extra_headers, timeout
        captured.append(should_cancel)
        return None, {"attempt": 0, "status": "canceled"}

    should_cancel = lambda: True
    payload = cover_provider_http._http_get_json(
        "https://musicbrainz.example/ws/2/release",
        "AlbumHavenTests/1.0",
        service="musicbrainz",
        musicbrainz_json_getter=fake_musicbrainz_get_json,
        should_cancel=should_cancel,
    )

    assert payload is None
    assert captured == [should_cancel]


def test_http_get_json_retries_discogs_no_payload_and_logs_sanitized_url():
    events: list[dict[str, object]] = []
    urls: list[str] = []

    payload = cover_provider_http._http_get_json(
        "https://api.discogs.com/database/search?key=secret&token=hidden",
        "AlbumHavenTests/1.0",
        service="discogs",
        context="search",
        logger=FakeLogger(),
        http_get_bytes=lambda url, **kwargs: urls.append(url) or None,
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    assert payload is None
    assert urls == [
        "https://api.discogs.com/database/search?key=secret&token=hidden",
        "https://api.discogs.com/database/search?key=secret&token=hidden",
    ]
    assert events == [
        {
            "action": "Discogs JSON request returned no payload",
            "level": "info",
            "context": "search",
            "attempt": 1,
            "url": "https://api.discogs.com/database/search",
        },
        {
            "action": "Discogs JSON request returned no payload",
            "level": "info",
            "context": "search",
            "attempt": 2,
            "url": "https://api.discogs.com/database/search",
        },
    ]


def test_http_get_json_logs_deezer_decode_failure_and_no_payload():
    events: list[dict[str, object]] = []
    payloads = iter([b"not-json", None])

    decode_payload = cover_provider_http._http_get_json(
        "https://api.deezer.com/search/album?q=test",
        "AlbumHavenTests/1.0",
        service="deezer",
        context="search",
        logger=FakeLogger(),
        http_get_bytes=lambda url, **kwargs: next(payloads),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )
    missing_payload = cover_provider_http._http_get_json(
        "https://api.deezer.com/search/album?q=test",
        "AlbumHavenTests/1.0",
        service="deezer",
        context="search",
        logger=FakeLogger(),
        http_get_bytes=lambda url, **kwargs: next(payloads),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    assert decode_payload is None
    assert missing_payload is None
    assert [event["action"] for event in events] == [
        "Deezer JSON decode failed",
        "Deezer JSON request returned no payload",
    ]
    assert events[0]["error_type"] == "JSONDecodeError"
    assert events[1]["attempt"] == 1


def test_http_get_text_with_url_returns_final_redirected_url(monkeypatch):
    class FakeResponse:
        status = 200
        url = "https://example.com/final"

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"<html>ok</html>"

    monkeypatch.setattr(cover_provider_http.urllib.request, "urlopen", lambda request, timeout, context: FakeResponse())
    monkeypatch.setattr(cover_provider_http, "_http_ssl_context", lambda: "ssl-context")

    text, final_url = cover_provider_http._http_get_text_with_url(
        "https://example.com/original",
        "AlbumHavenTests/1.0",
        logger=FakeLogger(),
    )

    assert text == "<html>ok</html>"
    assert final_url == "https://example.com/final"


def test_http_get_json_via_curl_executes_when_curl_available(monkeypatch):
    calls: dict[str, object] = {}

    def fake_run(args, capture_output, text, check, timeout, creationflags):
        calls["args"] = args
        calls["capture_output"] = capture_output
        calls["text"] = text
        calls["check"] = check
        calls["timeout"] = timeout
        calls["creationflags"] = creationflags
        return SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True}), stderr="")

    monkeypatch.setattr(cover_provider_http.shutil, "which", lambda command: "curl.exe" if command == "curl" else "")
    monkeypatch.setattr(cover_provider_http.subprocess, "run", fake_run)

    payload = cover_provider_http._http_get_json_via_curl(
        "https://example.com/test.json",
        user_agent="AlbumHavenTests/1.0",
        context="unit-test",
        logger=FakeLogger(),
        app_event_logger=lambda *args, **kwargs: None,
    )

    assert payload == {"ok": True}
    assert calls["args"][0] == "curl.exe"
    assert "https://example.com/test.json" in calls["args"]
    assert calls["creationflags"] == cover_provider_http._NO_WINDOW_CREATION_FLAGS


def test_http_get_json_via_subprocess_suppresses_windows_helper_window(monkeypatch):
    calls: dict[str, object] = {}

    def fake_run(args, **kwargs):
        calls["args"] = args
        calls["kwargs"] = kwargs
        return SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True}), stderr="")

    monkeypatch.setattr(cover_provider_http.subprocess, "run", fake_run)

    payload = cover_provider_http._http_get_json_via_subprocess(
        "https://example.com/test.json",
        user_agent="AlbumHavenTests/1.0",
        context="unit-test",
        logger=FakeLogger(),
        app_event_logger=lambda *args, **kwargs: None,
    )

    assert payload == {"ok": True}
    assert calls["args"][0] == cover_provider_http.sys.executable
    assert calls["kwargs"]["creationflags"] == cover_provider_http._NO_WINDOW_CREATION_FLAGS


def test_http_get_json_via_curl_logs_unavailable_exit_and_decode_failures(monkeypatch):
    events: list[dict[str, object]] = []

    monkeypatch.setattr(cover_provider_http.shutil, "which", lambda command: "")
    missing = cover_provider_http._http_get_json_via_curl(
        "https://example.com/test.json",
        user_agent="AlbumHavenTests/1.0",
        context="unit-test",
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    monkeypatch.setattr(cover_provider_http.shutil, "which", lambda command: "curl.exe")
    monkeypatch.setattr(
        cover_provider_http.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=7, stdout="", stderr="network failed"),
    )
    exit_failed = cover_provider_http._http_get_json_via_curl(
        "https://example.com/test.json",
        user_agent="AlbumHavenTests/1.0",
        context="unit-test",
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    monkeypatch.setattr(
        cover_provider_http.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout="not-json", stderr=""),
    )
    decode_failed = cover_provider_http._http_get_json_via_curl(
        "https://example.com/test.json",
        user_agent="AlbumHavenTests/1.0",
        context="unit-test",
        logger=FakeLogger(),
        app_event_logger=lambda config, logger, action, **fields: events.append({"action": action, **fields}),
    )

    assert missing is None
    assert exit_failed is None
    assert decode_failed is None
    assert [(event["action"], event["reason"]) for event in events] == [
        ("MusicBrainz curl fallback unavailable", "curl_not_found"),
        ("MusicBrainz curl fallback failed", "exit_7"),
        ("MusicBrainz curl fallback failed", "json_decode_failed"),
    ]
