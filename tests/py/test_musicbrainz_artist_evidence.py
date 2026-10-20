"""Strict artist acquisition with bounded in-memory HTTP responses, never network."""
from copy import deepcopy
from io import BytesIO
import json
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
import pytest
from music_app.services import musicbrainz_http as http

MBID = "abcdef00-0000-4000-8000-000000000001"
OTHER = "00000000-0000-4000-8000-000000000002"
URL = "https://musicbrainz.org/ws/2/artist/" + MBID + "?fmt=json"
UA = "AlbumHaven-contract/1 (test@example.test)"
POLICY = "musicbrainz-artist-v1"


class Response:
    def __init__(self, body, code=200):
        self.body, self.code, self.closed, self.reads = body, code, False, []
        self.msg = "fixture"; self.headers = {}
    def read(self, amount=None):
        self.reads.append(amount)
        assert type(amount) is int and amount <= 262145, "Unbounded success response read"
        return self.body[:amount]
    def close(self):
        self.closed = True
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.close()


@pytest.fixture
def wire(monkeypatch):
    clock = {"now": 10000.0}; calls, sleeps, handlers = [], [], []
    responses = []
    monkeypatch.setattr(http, "_URL_CACHE", {})
    monkeypatch.setattr(http, "_STRICT_EVIDENCE_URL_CACHE", {})
    monkeypatch.setattr(http, "_STRICT_ARTIST_URL_CACHE", {})
    monkeypatch.setattr(http, "_NEXT_ALLOWED_AT_MONOTONIC", 0.0)
    monkeypatch.setattr(http, "_BLOCKED_UNTIL", 0.0)
    monkeypatch.setattr(http, "_BLOCK_REASON", "")
    monkeypatch.setattr(http.time, "time", lambda: clock["now"])
    monkeypatch.setattr(http.time, "monotonic", lambda: clock["now"])
    def sleep(seconds):
        sleeps.append(seconds); clock["now"] += seconds
    monkeypatch.setattr(http.time, "sleep", sleep)
    def forbidden(*a, **k):
        pytest.fail("Artist evidence attempted permissive/global HTTP")
    monkeypatch.setattr(http.urllib.request, "urlopen", forbidden)
    monkeypatch.setattr(http.urllib.request, "install_opener", forbidden)
    class Opener:
        def open(self, request, *, timeout):
            calls.append((request, timeout))
            assert responses, "Unexpected additional HTTP attempt"
            response = responses.pop(0)
            if isinstance(response, BaseException):
                raise response
            if 300 <= response.code < 400:
                processor = next((h for h in handlers if isinstance(h, http._StrictEvidenceHTTPErrorProcessor)), None)
                assert processor is not None, "Strict no-redirect owner not installed"
                return processor.http_response(request, response)
            return response
    def build(*values):
        handlers[:] = values
        return Opener()
    monkeypatch.setattr(http.urllib.request, "build_opener", build)
    return SimpleNamespace(calls=calls, sleeps=sleeps, responses=responses, handlers=handlers, clock=clock)


def body(value=None):
    return json.dumps(value or {"id": MBID, "country": "GB"}, ensure_ascii=False).encode()


def test_exact_fixed_url_headers_policy_success_and_deep_copied_private_cache(wire):
    response = Response(body({"id": MBID, "country": "GB", "nested": {"v": [1]}}))
    wire.responses.append(response)
    payload, metadata = http.get_artist_json(MBID, UA)
    assert payload["id"] == MBID and metadata["evidence_policy"] == POLICY and metadata["status"] == "network"
    request, timeout = wire.calls[0]
    assert request.full_url == URL and timeout == 15.0
    assert {key.lower(): value for key, value in request.header_items()} == {
        "user-agent": UA, "accept": "application/json"}
    assert response.reads == [262145] and response.closed
    payload["nested"]["v"].append(2)
    cached, metadata = http.get_artist_json(MBID, UA)
    assert cached["nested"] == {"v": [1]}
    assert metadata["status"] == "cache" and metadata["evidence_policy"] == POLICY
    assert len(wire.calls) == 1 and http._URL_CACHE == {} and http._STRICT_EVIDENCE_URL_CACHE == {}


@pytest.mark.parametrize("identity", [None, 1, MBID.upper(), " " + MBID, MBID + " ",
    URL, "https://musicbrainz.org:443/ws/2/artist/" + MBID + "?fmt=json",
    MBID + "?inc=area", MBID + "#fragment", "musicbrainz-artist:" + MBID,
    "https://evil.test/" + MBID, MBID.replace("-", "")])
def test_only_canonical_bare_uuid_is_accepted_without_io(wire, identity):
    payload, metadata = http.get_artist_json(identity, UA)
    assert payload is None and metadata.get("status") not in ("network", "cache")
    assert wire.calls == []


@pytest.mark.parametrize("raw", [
    b'{"id":"' + MBID.encode() + b'","id":"' + MBID.encode() + b'","country":"GB"}',
    b'{"id":"' + MBID.encode() + b'","country":"GB","country":"DE"}',
    b'{"id":"' + MBID.encode() + b'","nested":{"a":1,"a":2}}',
    b'{"id":"' + MBID.encode() + b'","country":"\\ud800"}',
    b'{"id":"' + MBID.encode() + b'","country":"\xff"}',
    b'{"id":"' + MBID.encode() + b'","country":NaN}',
    b'{"id":"' + OTHER.encode() + b'","country":"GB"}',
    b'{"country":"GB"}', b'[]', b'null', b'{"broken":',
])
def test_invalid_scalar_json_duplicate_keys_or_wrong_identity_never_qualify(wire, raw):
    wire.responses.extend(Response(raw) for _ in range(3))
    payload, metadata = http.get_artist_json(MBID, UA)
    assert payload is None and metadata.get("status") not in ("network", "cache")
    assert len(wire.calls) <= 3


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_all_redirects_are_terminal_without_following_or_draining_response(wire, code):
    response = Response(b"x" * 300000, code); wire.responses.append(response)
    payload, metadata = http.get_artist_json(MBID, UA)
    assert payload is None and metadata["status"] == "redirect_rejected"
    assert len(wire.calls) == 1 and response.reads == [] and response.closed


@pytest.mark.parametrize("size,accepted", [(262144, True), (262145, False)])
def test_success_body_ceiling_uses_one_sentinel_byte(wire, size, accepted):
    raw = body(); response = Response(raw + b" " * (size - len(raw)))
    wire.responses.append(response)
    payload, meta = http.get_artist_json(MBID, UA)
    assert (payload is not None) is accepted
    assert response.reads == [262145] and len(wire.calls) == 1
    if not accepted:
        assert meta["status"] == "response_too_large"


@pytest.mark.parametrize("namespace", ["_URL_CACHE", "_STRICT_EVIDENCE_URL_CACHE", "_STRICT_ARTIST_URL_CACHE"])
@pytest.mark.parametrize("policy", [None, "musicbrainz-release-group-v1"])
def test_permissive_release_group_or_wrong_policy_cache_cannot_supply_artist_evidence(wire, namespace, policy):
    getattr(http, namespace)[http._cache_key(URL, "application/json")] = {
        "updated_at": wire.clock["now"], "ok": True, "payload": {"id": MBID, "country": "poison"},
        **({"evidence_policy": policy} if policy else {})}
    wire.responses.append(Response(body()))
    payload, meta = http.get_artist_json(MBID, UA)
    assert payload["country"] == "GB" and meta["status"] == "network" and len(wire.calls) == 1


def test_three_attempt_shared_backoff_pacing_and_no_unbounded_retry(wire):
    wire.responses.extend([URLError("temporary"), URLError("temporary"), Response(body())])
    payload, meta = http.get_artist_json(MBID, UA)
    assert payload["id"] == MBID and meta["attempt"] == 3 and len(wire.calls) == 3
    assert 0.75 in wire.sleeps and 1.5 in wire.sleeps
    assert sum(wire.sleeps) >= 2.25


def test_cancel_during_pacing_is_checked_before_any_http_attempt(wire, monkeypatch):
    cancelled = False
    http._NEXT_ALLOWED_AT_MONOTONIC = wire.clock["now"] + 1.05
    def sleep(seconds):
        nonlocal cancelled
        wire.clock["now"] += seconds; cancelled = True
    monkeypatch.setattr(http.time, "sleep", sleep)
    payload, meta = http.get_artist_json(MBID, UA, should_cancel=lambda: cancelled)
    assert payload is None and wire.calls == []
    assert meta["status"] in ("canceled", "cancelled")


def test_cancel_between_attempts_stops_before_retry(wire, monkeypatch):
    cancelled = False
    wire.responses.append(URLError("temporary"))
    def sleep(seconds):
        nonlocal cancelled
        wire.clock["now"] += seconds; cancelled = True
    monkeypatch.setattr(http.time, "sleep", sleep)
    payload, meta = http.get_artist_json(MBID, UA, should_cancel=lambda: cancelled)
    assert payload is None and len(wire.calls) == 1
    assert meta["status"] in ("canceled", "cancelled")


def test_negative_cache_is_not_successful_omission_and_strict_release_group_api_stays_closed(wire):
    http._STRICT_ARTIST_URL_CACHE[http._cache_key(URL, "application/json")] = {
        "updated_at": wire.clock["now"], "ok": False, "payload": None, "evidence_policy": POLICY}
    payload, meta = http.get_artist_json(MBID, UA)
    assert payload is None and meta["status"] == "cached_miss" and wire.calls == []
    payload, meta = http.get_json(URL, UA, strict_evidence=True)
    assert payload is None and meta["status"] == "invalid_evidence_request" and wire.calls == []


def test_error_body_has_finite_16384_byte_read_and_block_stops_more_attempts(wire):
    class ErrorBody(BytesIO):
        sizes = []
        def read(self, n=-1):
            self.sizes.append(n)
            assert n == 16384
            return super().read(n)
    stream = ErrorBody(b"x" * 30000)
    wire.responses.append(HTTPError(URL, 429, "rate limited", {}, stream))
    payload, meta = http.get_artist_json(MBID, UA)
    assert payload is None and meta["status"] == "blocked"
    assert len(wire.calls) == 1 and stream.sizes == [16384]
