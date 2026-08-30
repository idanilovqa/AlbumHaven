from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs

import pytest

from music_app.services import lastfm
from music_app.services.lastfm import LastfmError, LastfmSession


@pytest.fixture
def fixture_owned_lastfm_provider():
    responses: list[tuple[int, bytes]] = []
    requests: list[dict[str, list[str]]] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - stdlib handler API
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            requests.append(parse_qs(body.decode("utf-8")))
            status, response = responses.pop(0)
            self.send_response(status)
            self.send_header("Content-Type", "application/xml")
            self.end_headers()
            self.wfile.write(response)

        def log_message(self, _format, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider = {
        "api_root": f"http://127.0.0.1:{server.server_port}/2.0/",
        "api_key": "fixture-api-key",
        "api_secret": "fixture-api-secret",
        "responses": responses,
        "requests": requests,
    }
    try:
        yield provider
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _config(api_root: str) -> dict[str, object]:
    return {
        "LASTFM_API_KEY": "fake-key",
        "LASTFM_API_SECRET": "fake-secret",
        "LASTFM_API_ROOT": api_root,
    }


def _payload() -> dict[str, object]:
    return {"artist": "Artist", "track": "Song", "timestamp": 12345}


@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_scrobble_uses_provider_outcome_and_rejects_status_ok_ignored(
    monkeypatch, fixture_owned_lastfm_provider, allow_lastfm_loopback_transport
):
    response = b"""<lfm status="ok"><scrobbles accepted="0" ignored="1"><scrobble>
        <ignoredmessage code="2">Track was filtered</ignoredmessage>
    </scrobble></scrobbles></lfm>"""
    fixture_owned_lastfm_provider["responses"].append((200, response))
    monkeypatch.setattr(
        lastfm,
        "get_saved_lastfm_session",
        lambda _config: LastfmSession("listener", "fake-session", "now"),
    )
    result = lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert result.sent is True
    assert result.succeeded is False
    assert result.outcome == "ignored"
    assert result.accepted == 0
    assert result.ignored == 1
    assert result.ignored_code == 2
    assert fixture_owned_lastfm_provider["requests"][0]["method"] == ["track.scrobble"]


@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_scrobble_accepts_only_positive_provider_accepted_count(
    monkeypatch, fixture_owned_lastfm_provider, allow_lastfm_loopback_transport
):
    response = b'<lfm status="ok"><scrobbles accepted="1" ignored="0" /></lfm>'
    fixture_owned_lastfm_provider["responses"].append((200, response))
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: LastfmSession("listener", "fake-session", "now"))
    result = lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert result.succeeded is True
    assert result.accepted == 1


@pytest.mark.parametrize(
    ("code", "retryable", "reauthentication_required", "error_kind"),
    [
        (11, True, False, "provider_error"),
        (16, True, False, "provider_error"),
        (29, True, False, "provider_error"),
        (9, False, True, "provider_error"),
        (4, False, False, "invalid_credentials"),
    ],
)
@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_provider_error_codes_are_preserved_and_classified(
    monkeypatch,
    fixture_owned_lastfm_provider,
    allow_lastfm_loopback_transport,
    code,
    retryable,
    reauthentication_required,
    error_kind,
):
    response = f'<lfm status="failed"><error code="{code}">Provider failure</error></lfm>'.encode()
    fixture_owned_lastfm_provider["responses"].append((200, response))
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: LastfmSession("listener", "fake-session", "now"))
    with pytest.raises(LastfmError) as caught:
        lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert caught.value.code == code
    assert caught.value.retryable is retryable
    assert caught.value.reauthentication_required is reauthentication_required
    assert caught.value.error_kind == error_kind


@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_malformed_xml_is_wrapped_as_retryable_provider_error(
    monkeypatch, fixture_owned_lastfm_provider, allow_lastfm_loopback_transport
):
    fixture_owned_lastfm_provider["responses"].append((200, b"<lfm"))
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: LastfmSession("listener", "fake-session", "now"))
    with pytest.raises(LastfmError) as caught:
        lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert caught.value.retryable is True
    assert caught.value.error_kind == "malformed_response"
    assert "Malformed XML" in str(caught.value)


@pytest.mark.parametrize(
    ("status", "body", "retryable"),
    [
        (400, b"", False),
        (401, b"not xml", False),
        (429, b"", True),
        (501, b"", False),
        (502, b"not xml", True),
        (503, b"", True),
        (504, b"not xml", True),
    ],
)
@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_http_error_without_provider_code_uses_bounded_status_retry_policy(
    monkeypatch,
    fixture_owned_lastfm_provider,
    allow_lastfm_loopback_transport,
    status,
    body,
    retryable,
):
    fixture_owned_lastfm_provider["responses"].append((status, body))
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: LastfmSession("listener", "fake-session", "now"))

    with pytest.raises(LastfmError) as caught:
        lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert caught.value.retryable is retryable
    if body:
        assert caught.value.error_kind == "malformed_response"
        assert "Malformed XML response from Last.fm" in str(caught.value)
    else:
        assert f"HTTP {status}" in str(caught.value)


@pytest.mark.lastfm_loopback_transport(provider_fixture="fixture_owned_lastfm_provider")
def test_http_error_preserves_well_formed_provider_code_classification(
    monkeypatch, fixture_owned_lastfm_provider, allow_lastfm_loopback_transport
):
    fixture_owned_lastfm_provider["responses"].append(
        (503, b'<lfm status="failed"><error code="4">Invalid credentials</error></lfm>')
    )
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: LastfmSession("listener", "fake-session", "now"))

    with pytest.raises(LastfmError) as caught:
        lastfm.scrobble_track(_config(allow_lastfm_loopback_transport), _payload())

    assert caught.value.code == 4
    assert caught.value.retryable is False
    assert caught.value.error_kind == "invalid_credentials"


def test_disconnected_scrobble_is_an_explicit_no_send(monkeypatch):
    monkeypatch.setattr(lastfm, "get_saved_lastfm_session", lambda _config: None)

    result = lastfm.scrobble_track(_config("http://127.0.0.1:1/"), _payload())

    assert result.sent is False
    assert result.succeeded is False
    assert result.outcome == "not_connected"
