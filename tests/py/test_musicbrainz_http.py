from __future__ import annotations

import urllib.error

import music_app.services.musicbrainz_http as musicbrainz_http
from music_app.services.musicbrainz_http import _block_reason_from_exception, default_user_agent


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
