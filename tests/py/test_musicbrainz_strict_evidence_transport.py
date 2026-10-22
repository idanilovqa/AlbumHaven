"""Strict evidence contracts through the actual urllib handler graph.

The lowest HTTP/HTTPS open seam supplies in-memory responses. The real owner,
JSON decoding, cache paths and urllib error/redirect processors remain in use.
No provider, socket, database, application bootstrap or environment is needed.
This suite is authored for normal pytest collection; it has not been run here.
"""
from email.message import Message
from io import BytesIO
import json
from types import SimpleNamespace
import urllib.error

import pytest

from music_app.services import musicbrainz_http as transport
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from music_app.services.remote_album_provider import fetch_release_group_evidence


GROUP = "c9fdb94c-4975-4ed6-a96f-ef6d80bb7738"
OTHER = "8e68819d-71be-4e7d-b41d-f1df81b01d3f"
URL = f"https://musicbrainz.org/ws/2/release-group/{GROUP}?inc=artist-credits&fmt=json"
OTHER_URL = f"https://musicbrainz.org/ws/2/release-group/{OTHER}?inc=artist-credits&fmt=json"
AGENT = "AlbumHaven-test/1.0"


def provider_payload():
    return {"id": GROUP, "title": "Example Album", "first-release-date": "2012",
            "primary-type": "Album", "artist-credit": [
                {"name": "Example Artist", "joinphrase": "", "artist": {"id": OTHER}}]}


class WireResponse(BytesIO):
    def __init__(self, body=b"{}", *, status=200, headers=None, on_read=None):
        super().__init__(body)
        self.code = status
        self.status = status
        self.msg = "Fixture response"
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value
        self.url = URL
        self.read_sizes = []
        self.bytes_read = 0
        self.on_read = on_read

    def info(self):
        return self.headers

    def geturl(self):
        return self.url

    def getcode(self):
        return self.code

    def read(self, size=-1):
        self.read_sizes.append(size)
        result = super().read(size)
        self.bytes_read += len(result)
        if self.on_read is not None:
            self.on_read()
        return result


@pytest.fixture
def wire(monkeypatch):
    state = SimpleNamespace(responses=[], requests=[], pacing=[], sleeps=[])
    monkeypatch.setattr(transport, "_URL_CACHE", {})
    monkeypatch.setattr(transport, "_STRICT_EVIDENCE_URL_CACHE", {})
    monkeypatch.setattr(transport, "_NEXT_ALLOWED_AT_MONOTONIC", 0.0)
    monkeypatch.setattr(transport, "_BLOCKED_UNTIL", 0.0)
    monkeypatch.setattr(transport, "_BLOCK_REASON", "")
    monkeypatch.setattr(transport, "_wait_for_slot", lambda: state.pacing.append("slot"))
    mark_complete = transport._mark_request_complete

    def complete():
        state.pacing.append("complete")
        mark_complete()

    monkeypatch.setattr(transport, "_mark_request_complete", complete)
    monkeypatch.setattr(transport.time, "sleep", state.sleeps.append)
    monkeypatch.setattr(transport.urllib.request, "_opener", None)
    monkeypatch.setattr(transport.urllib.request, "getproxies", lambda: {})

    def open_response(handler, request):
        assert transport._REQUEST_LOCK.locked(), "The shared pacing owner must hold its request lock"
        state.requests.append((request.full_url, dict(request.header_items()), request.timeout))
        assert state.responses, "Unexpected wire request; no external network fallback is allowed"
        response = state.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        response.url = request.full_url
        return response

    # Keep the real opener and processors, replacing only their network boundary.
    monkeypatch.setattr(transport.urllib.request.HTTPSHandler, "https_open", open_response)
    monkeypatch.setattr(transport.urllib.request.HTTPHandler, "http_open", open_response)
    return state


def strict_get(url=URL, **options):
    return transport.get_json(url, AGENT, strict_evidence=True, **options)


@pytest.mark.parametrize("status", [300, 301, 302, 303, 304, 305, 306, 307, 308, 399])
@pytest.mark.parametrize("location", [URL, OTHER_URL, "https://example.invalid/lookup", "http://musicbrainz.org/lookup"])
def test_all_redirect_responses_rejected_before_follow_or_body_drain(wire, status, location):
    response = WireResponse(b"x" * (transport._STRICT_ERROR_MAX_BYTES * 2), status=status,
                            headers={"Location": location})
    wire.responses.append(response)
    result, meta = strict_get()
    assert result is None and meta == {"status": "redirect_rejected", "cache_hit": False, "attempt": 1}
    assert [request[0] for request in wire.requests] == [URL]
    assert response.read_sizes == [] and response.closed
    assert wire.pacing == ["slot", "complete"] and wire.sleeps == []
    assert transport._NEXT_ALLOWED_AT_MONOTONIC > 0
    assert strict_get() == (None, {"status": "cached_miss", "cache_hit": True})
    assert len(wire.requests) == 1


@pytest.mark.parametrize("headers", [{}, {"Content-Length": "1"}])
def test_success_overrun_reads_only_limit_plus_sentinel_and_never_retries(wire, headers):
    response = WireResponse(b" " * (transport._STRICT_SUCCESS_MAX_BYTES * 2), headers=headers)
    wire.responses.append(response)
    result, meta = strict_get()
    assert result is None and meta["status"] == "response_too_large"
    assert response.read_sizes == [transport._STRICT_SUCCESS_MAX_BYTES + 1]
    assert response.bytes_read == transport._STRICT_SUCCESS_MAX_BYTES + 1
    assert response.closed and wire.sleeps == [] and len(wire.requests) == 1
    assert not transport._URL_CACHE
    entry = transport._STRICT_EVIDENCE_URL_CACHE[transport._cache_key(URL, "application/json")]
    assert entry["ok"] is False and entry["payload"] is None


@pytest.mark.parametrize("size", [2, transport._STRICT_SUCCESS_MAX_BYTES])
def test_bounded_json_through_exact_limit_has_strict_provenance(wire, size):
    response = WireResponse(b"{}" + b" " * (size - 2))
    wire.responses.append(response)
    result, meta = strict_get()
    assert result == {}
    assert meta == {"status": "network", "cache_hit": False, "attempt": 1,
                    "evidence_policy": transport.STRICT_EVIDENCE_POLICY}
    assert response.read_sizes == [transport._STRICT_SUCCESS_MAX_BYTES + 1]
    assert response.bytes_read == size and response.closed
    assert wire.requests[0][2] == 15.0
    assert transport.urllib.request._opener is None  # Strict mode never installs a global opener.
    assert strict_get() == ({}, {"status": "cache", "cache_hit": True,
                               "evidence_policy": transport.STRICT_EVIDENCE_POLICY})
    assert len(wire.requests) == 1


@pytest.mark.parametrize("status,expected", [(400, "http_400"), (404, "http_404"),
                                             (403, "blocked"), (429, "blocked")])
def test_http_errors_use_bounded_body_and_close_response(wire, status, expected):
    response = WireResponse(b"x" * (transport._STRICT_ERROR_MAX_BYTES * 2), status=status)
    wire.responses.append(response)
    result, meta = strict_get()
    assert result is None and meta["status"] == expected
    assert response.read_sizes == [transport._STRICT_ERROR_MAX_BYTES]
    assert response.bytes_read == transport._STRICT_ERROR_MAX_BYTES and response.closed
    assert wire.pacing == ["slot", "complete"] and wire.sleeps == []
    if status in (403, 429):
        assert meta["blocked_reason"] == f"http_{status}"
        assert strict_get(OTHER_URL)[1]["status"] == "blocked"
        assert transport.get_json(OTHER_URL, AGENT)[1]["status"] == "blocked"
        assert len(wire.requests) == 1  # Strict and ordinary callers share the cooldown.


def test_error_body_block_detection_still_uses_the_bounded_prefix(wire):
    response = WireResponse(b"temporarily blocked " + b"x" * transport._STRICT_ERROR_MAX_BYTES, status=500)
    wire.responses.append(response)
    result, meta = strict_get()
    assert result is None and meta["status"] == "blocked"
    assert meta["blocked_reason"] == "http_blocked"
    assert response.bytes_read == transport._STRICT_ERROR_MAX_BYTES


def test_http_503_retries_remain_paced_bounded_and_backed_off(wire):
    responses = [WireResponse(b"x" * (transport._STRICT_ERROR_MAX_BYTES * 2), status=503)
                 for _ in range(transport._MAX_ATTEMPTS)]
    wire.responses.extend(responses)
    result, meta = strict_get()
    assert result is None and meta == {"status": "http_503", "cache_hit": False, "attempt": 3}
    assert wire.sleeps == [0.75, 1.5]
    assert wire.pacing == ["slot", "complete"] * 3
    assert len(wire.requests) == 3
    assert all(response.read_sizes == [transport._STRICT_ERROR_MAX_BYTES] and response.closed
               for response in responses)


def test_503_then_success_still_qualifies_only_after_bounded_success(wire):
    error = WireResponse(b"temporary failure", status=503)
    success = WireResponse(json.dumps(provider_payload()).encode())
    wire.responses.extend([error, success])
    result, meta = strict_get()
    assert result == provider_payload() and meta["status"] == "network" and meta["attempt"] == 2
    assert meta["evidence_policy"] == transport.STRICT_EVIDENCE_POLICY
    assert wire.sleeps == [0.75] and wire.pacing == ["slot", "complete"] * 2
    assert error.closed and success.closed


def test_connection_errors_keep_existing_bounded_attempts_and_backoff(wire):
    wire.responses.extend([urllib.error.URLError("fixture connection failure") for _ in range(3)])
    result, meta = strict_get()
    assert result is None and meta == {"status": "connection_error", "cache_hit": False, "attempt": 3}
    assert wire.sleeps == [0.75, 1.5] and wire.pacing == ["slot", "complete"] * 3


def test_tls_block_remains_shared_with_default_callers(wire):
    wire.responses.append(urllib.error.URLError("handshake failure"))
    result, meta = strict_get()
    assert result is None and meta["status"] == "blocked"
    assert meta["blocked_reason"] == "tls_handshake_blocked"
    assert transport.get_json(OTHER_URL, AGENT)[1]["status"] == "blocked"
    assert len(wire.requests) == 1 and wire.sleeps == []


def test_existing_block_prevents_strict_network_and_uses_separate_miss_cache(wire):
    transport._set_block("fixture_block")
    result, meta = strict_get()
    assert result is None and meta["status"] == "blocked" and wire.requests == []
    assert not transport._URL_CACHE
    assert transport._STRICT_EVIDENCE_URL_CACHE


def test_cancel_before_lookup_or_after_pacing_has_no_network(wire, monkeypatch):
    assert strict_get(should_cancel=lambda: True)[1]["status"] == "canceled"
    cancelled = [False]
    monkeypatch.setattr(transport, "_wait_for_slot", lambda: cancelled.__setitem__(0, True))
    assert strict_get(should_cancel=lambda: cancelled[0])[1]["status"] == "canceled"
    assert wire.requests == [] and not transport._STRICT_EVIDENCE_URL_CACHE


@pytest.mark.parametrize("status", [200, 503, 429])
def test_cancel_after_response_read_is_not_cached_retried_or_blocked(wire, status):
    cancelled = [False]
    response = WireResponse(b"{}", status=status,
                            on_read=lambda: cancelled.__setitem__(0, True))
    wire.responses.append(response)
    result, meta = strict_get(should_cancel=lambda: cancelled[0])
    assert result is None and meta["status"] == "canceled"
    assert response.closed and len(wire.requests) == 1 and wire.sleeps == []
    assert not transport._STRICT_EVIDENCE_URL_CACHE and not transport._URL_CACHE
    assert transport._blocked_state()[0] is False


def test_legacy_cache_success_cannot_satisfy_strict_evidence(wire):
    legacy = WireResponse(b'{"source":"ordinary"}')
    strict = WireResponse(b'{"source":"strict"}')
    wire.responses.extend([legacy, strict])
    assert transport.get_json(URL, AGENT) == ({"source": "ordinary"},
        {"status": "network", "cache_hit": False, "attempt": 1})
    result, meta = strict_get()
    assert result == {"source": "strict"} and meta["status"] == "network"
    assert meta["evidence_policy"] == transport.STRICT_EVIDENCE_POLICY
    assert legacy.read_sizes == [-1] and strict.read_sizes == [transport._STRICT_SUCCESS_MAX_BYTES + 1]
    assert len(wire.requests) == 2
    assert transport.get_json(URL, AGENT) == ({"source": "ordinary"}, {"status": "cache", "cache_hit": True})


def test_legacy_miss_does_not_suppress_new_strict_acquisition(wire):
    transport._set_cached_value(URL, "application/json", None)
    wire.responses.append(WireResponse())
    assert strict_get()[1]["status"] == "network" and len(wire.requests) == 1


def test_strict_cache_cannot_populate_default_cache(wire):
    wire.responses.extend([WireResponse(b'{"source":"strict"}'), WireResponse(b'{"source":"ordinary"}')])
    assert strict_get()[0] == {"source": "strict"}
    result, meta = transport.get_json(URL, AGENT)
    assert result == {"source": "ordinary"} and meta["status"] == "network"
    assert "evidence_policy" not in meta and len(wire.requests) == 2


@pytest.mark.parametrize("policy", [None, "legacy", "musicbrainz-release-group-v0"])
def test_strict_cache_requires_current_provenance(wire, policy):
    wire.responses.extend([WireResponse(b'{"old":true}'), WireResponse(b'{"new":true}')])
    assert strict_get()[0] == {"old": True}
    key = transport._cache_key(URL, "application/json")
    transport._STRICT_EVIDENCE_URL_CACHE[key]["evidence_policy"] = policy
    result, meta = strict_get()
    assert result == {"new": True} and meta["status"] == "network" and len(wire.requests) == 2


def test_strict_cached_nested_facts_are_detached_on_write_and_read(wire):
    wire.responses.append(WireResponse(json.dumps(provider_payload()).encode()))
    result, _ = strict_get()
    result["artist-credit"][0]["name"] = "Mutated network result"
    cached, meta = strict_get()
    assert meta["status"] == "cache" and cached == provider_payload()
    cached["artist-credit"][0]["artist"]["id"] = GROUP
    assert strict_get()[0] == provider_payload() and len(wire.requests) == 1


@pytest.mark.parametrize("url", [
    "https://example.invalid/lookup", URL.replace("https:", "http:"),
    URL.replace("musicbrainz.org", "musicbrainz.org.example.invalid"),
    URL.replace("musicbrainz.org", "user@musicbrainz.org"),
    URL.replace("musicbrainz.org", "musicbrainz.org:443"),
    URL.replace("release-group", "release"), URL + "&tags=1", URL + "#fragment",
    URL.replace(GROUP, GROUP.upper()), URL.replace(GROUP, "../artist"),
])
def test_strict_mode_refuses_noncanonical_endpoint_before_network(wire, url):
    result, meta = strict_get(url)
    assert result is None and meta["status"] == "invalid_evidence_request"
    assert wire.requests == [] and not transport._STRICT_EVIDENCE_URL_CACHE


@pytest.mark.parametrize("options", [{"accept": "text/plain"}, {"extra_headers": {"Authorization": "fixture"}},
                                      {"extra_headers": {"Accept-Encoding": "gzip"}}])
def test_strict_mode_refuses_custom_accept_or_extra_headers(wire, options):
    assert strict_get(**options)[1]["status"] == "invalid_evidence_request"
    assert wire.requests == []


def test_default_mode_preserves_redirect_behavior_and_custom_headers(wire):
    redirect = WireResponse(b"redirect body", status=302, headers={"Location": OTHER_URL})
    final = WireResponse(b'{"legacy":true}')
    wire.responses.extend([redirect, final])
    result, meta = transport.get_json(URL, AGENT, accept="application/example+json",
                                     extra_headers={"X-Fixture": "yes"}, timeout=7.0)
    assert result == {"legacy": True} and meta == {"status": "network", "cache_hit": False, "attempt": 1}
    assert [request[0] for request in wire.requests] == [URL, OTHER_URL]
    assert wire.requests[0][1]["X-fixture"] == "yes" and wire.requests[0][2] == 7.0
    assert redirect.read_sizes == [-1] and final.read_sizes == [-1]
    assert not transport._STRICT_EVIDENCE_URL_CACHE


def test_default_mode_preserves_error_body_and_miss_cache_contract(wire):
    response = WireResponse(b"x" * (transport._STRICT_ERROR_MAX_BYTES * 2), status=404)
    wire.responses.append(response)
    assert transport.get_json(URL, AGENT) == (None,
        {"status": "http_404", "cache_hit": False, "attempt": 1})
    assert response.read_sizes == [-1]
    assert transport.get_json(URL, AGENT) == (None, {"status": "cached_miss", "cache_hit": True})
    assert len(wire.requests) == 1 and not transport._STRICT_EVIDENCE_URL_CACHE


def test_adapter_uses_real_strict_transport_and_only_verified_cache(wire):
    transport._set_cached_value(URL, "application/json", {"id": GROUP, "title": "Unverified"})
    response = WireResponse(json.dumps(provider_payload()).encode())
    wire.responses.append(response)
    result = fetch_release_group_evidence(GROUP, user_agent=AGENT)
    assert result.title == "Example Album" and result.release_group_id == GROUP
    assert response.read_sizes == [transport._STRICT_SUCCESS_MAX_BYTES + 1]
    assert fetch_release_group_evidence(GROUP, user_agent=AGENT) == result
    assert len(wire.requests) == 1


def test_adapter_rejects_redirect_even_when_body_claims_requested_identity(wire):
    response = WireResponse(json.dumps(provider_payload()).encode(), status=302,
                            headers={"Location": OTHER_URL})
    wire.responses.append(response)
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_unavailable"):
        fetch_release_group_evidence(GROUP, user_agent=AGENT)
    assert len(wire.requests) == 1 and response.read_sizes == []


def test_adapter_rejects_oversized_otherwise_valid_provider_body(wire):
    body = json.dumps(provider_payload()).encode() + b" " * transport._STRICT_SUCCESS_MAX_BYTES
    response = WireResponse(body)
    wire.responses.append(response)
    with pytest.raises(RemoteAlbumEvidenceError, match="provider_unavailable"):
        fetch_release_group_evidence(GROUP, user_agent=AGENT)
    assert len(wire.requests) == 1 and response.bytes_read == transport._STRICT_SUCCESS_MAX_BYTES + 1
