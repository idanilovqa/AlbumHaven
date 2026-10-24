"""UNRUN: genuine XML parser/HTTP reader with synthetic in-memory responses.

No real provider/credential/DB access is performed by these authored tests.
Product imports and collection require separate admission before execution.
"""
import hashlib
from http.client import IncompleteRead
from io import BytesIO
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
import xml.etree.ElementTree as ET

import pytest

from music_app.services.lastfm import LastfmError, LastfmSession
from music_app.services import lastfm_history_reader as history


START, END = 1760000000, 1760001000
USER = "ExactProviderUser"
SESSION = LastfmSession(USER, "synthetic-session-never-transmitted", "2026-10-23T00:00:00+00:00")
CONFIG = {"LASTFM_API_ROOT": "https://ws.audioscrobbler.com/2.0/", "LASTFM_API_KEY": "synthetic-public-api-key"}


def xml_page(*, timestamps=(END, START), page=1, total=None, total_pages=None, nowplaying=False):
    root = ET.Element("lfm", status="ok")
    total = len(timestamps) if total is None else total
    total_pages = (total + 199) // 200 if total_pages is None else total_pages
    recent = ET.SubElement(root, "recenttracks", user=USER, page=str(page), perPage="200",
                           totalPages=str(total_pages), total=str(total))
    if nowplaying:
        live = ET.SubElement(recent, "track", nowplaying="true")
        ET.SubElement(live, "artist").text = "Current Artist"
        ET.SubElement(live, "name").text = "Current Track"
    for stamp in timestamps:
        item = ET.SubElement(recent, "track")
        ET.SubElement(item, "artist", mbid="").text = "Artist"
        ET.SubElement(item, "name").text = "Track"
        ET.SubElement(item, "album", mbid="").text = "Album"
        ET.SubElement(item, "date", uts=str(stamp)).text = "9 October 2025, 08:53"
    return root


def body(root):
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def parse(root, **kwargs):
    args = {"username": USER, "range_start": START, "range_end": END, "page": 1, **kwargs}
    return history.parse_history_page(body(root), **args)


def test_exact_xml_digest_and_same_second_multiplicity_are_preserved():
    root = xml_page(timestamps=(END, END, START))
    page = parse(root)
    assert tuple(item.timestamp for item in page.tracks) == (END, END, START)
    assert page.tracks[0] == page.tracks[1]
    assert page.digest == hashlib.sha256(body(root)).hexdigest()
    assert page.raw_xml.encode("utf-8") == body(root)
    assert page.observed_count == 3 and page.nowplaying_count == 0
    assert (page.observed_newest, page.observed_oldest) == (END, START)
    assert page.username == USER and page.page == 1 and page.per_page == 200
    assert not hasattr(page.tracks[0], "event_id")


def test_one_second_overlap_is_filtered_only_after_full_page_observation():
    page = parse(xml_page(timestamps=(END + 1, END, START, START - 1)))
    assert tuple(item.timestamp for item in page.tracks) == (END, START)
    assert page.observed_count == page.total == 4
    assert (page.observed_newest, page.observed_oldest) == (END + 1, START - 1)


def test_empty_album_and_exact_provider_text_are_not_normalized():
    root = xml_page(timestamps=(START,))
    track = root.find("recenttracks/track")
    track.find("album").text = None
    track.find("artist").text = " Artist & Artist "
    track.find("name").text = "Title \u00e9"
    parsed = parse(root).tracks[0]
    assert (parsed.artist, parsed.track, parsed.album) == (" Artist & Artist ", "Title \u00e9", "")


def test_only_explicit_true_nowplaying_is_skipped_and_raw_source_is_retained():
    root = xml_page(nowplaying=True)
    page = parse(root)
    assert len(page.tracks) == page.observed_count == 2 and page.nowplaying_count == 1
    assert 'nowplaying="true"' in page.raw_xml
    root.find("recenttracks/track").set("nowplaying", "false")
    with pytest.raises(LastfmError):
        parse(root)  # No date must not silently become now-playing evidence.


@pytest.mark.parametrize("total_pages", [0, 1])
def test_empty_history_accepts_bounded_empty_metadata(total_pages):
    page = parse(xml_page(timestamps=(), total_pages=total_pages, nowplaying=True))
    assert page.tracks == () and page.total == page.observed_count == 0
    assert page.observed_newest is None and page.observed_oldest is None
    assert page.nowplaying_count == 1


@pytest.mark.parametrize("attribute,value", [
    ("user", USER.lower()), ("user", "OtherUser"), ("user", " " + USER),
    ("page", "2"), ("page", "01"), ("page", " 1 "), ("page", "-1"),
    ("perPage", "199"), ("perPage", "201"), ("perPage", "0200"),
    ("totalPages", "0"), ("totalPages", "2"), ("totalPages", "101"),
    ("total", "0"), ("total", "1"), ("total", "20001"), ("total", "1.0"),
])
def test_metadata_must_be_exact_bounded_and_internally_consistent(attribute, value):
    root = xml_page()
    root.find("recenttracks").set(attribute, value)
    with pytest.raises(LastfmError) as error:
        parse(root)
    assert error.value.error_kind == "provider_error"


@pytest.mark.parametrize("attribute", ["user", "page", "perPage", "totalPages", "total"])
def test_missing_pagination_or_identity_metadata_is_not_assumed(attribute):
    root = xml_page()
    del root.find("recenttracks").attrib[attribute]
    with pytest.raises(LastfmError):
        parse(root)


@pytest.mark.parametrize("timestamps", [(START, END), (END + 2,), (START - 2,)])
def test_out_of_order_or_outside_expanded_range_is_rejected(timestamps):
    with pytest.raises(LastfmError):
        parse(xml_page(timestamps=timestamps))


@pytest.mark.parametrize("tag", ["artist", "name", "album", "date"])
@pytest.mark.parametrize("mutation", ["missing", "duplicate", "nested", "tail"])
def test_identity_fields_must_be_single_flat_leaves(tag, mutation):
    root = xml_page()
    item = root.find("recenttracks/track")
    leaf = item.find(tag)
    if mutation == "missing":
        item.remove(leaf)
    elif mutation == "duplicate":
        ET.SubElement(item, tag).text = "Duplicate"
    elif mutation == "nested":
        ET.SubElement(leaf, "nested").text = "Hidden"
    else:
        leaf.tail = "unparsed text"
    with pytest.raises(LastfmError):
        parse(root)


@pytest.mark.parametrize("value", ["", "-1", "001760000000", " 1760000000", "1760000000.0", "\uff11", "9" * 10000])
def test_timestamp_is_canonical_bounded_integer_seconds(value):
    root = xml_page()
    root.find("recenttracks/track/date").set("uts", value)
    with pytest.raises(LastfmError):
        parse(root)


@pytest.mark.parametrize("mutation", ["wrong_root", "missing_status", "unknown_status", "duplicate_envelope", "unknown_child", "mixed_text", "unknown_nowplaying", "double_nowplaying"])
def test_malformed_envelopes_do_not_produce_history(mutation):
    root = xml_page()
    recent = root.find("recenttracks")
    if mutation == "wrong_root":
        root.tag = "response"
    elif mutation == "missing_status":
        del root.attrib["status"]
    elif mutation == "unknown_status":
        root.set("status", "maybe")
    elif mutation == "duplicate_envelope":
        ET.SubElement(root, "recenttracks")
    elif mutation == "unknown_child":
        ET.SubElement(recent, "unexpected")
    elif mutation == "mixed_text":
        recent.text = "ambiguous"
    elif mutation == "unknown_nowplaying":
        recent[0].set("nowplaying", "1")
    else:
        recent[0].set("nowplaying", "true")
        recent[1].set("nowplaying", "true")
    with pytest.raises(LastfmError):
        parse(root)


@pytest.mark.parametrize("bad_body", [
    b"", b"<lfm", b"\xff\xfe", b"a" * (history.HISTORY_MAX_RESPONSE_BYTES + 1),
    b'<?xml version="1.0" encoding="unknown-encoding"?><lfm status="ok"/>',
    b'<!DOCTYPE lfm [<!ENTITY entity "injected">]><lfm status="ok">&entity;</lfm>',
    '<!DOCTYPE lfm [<!ENTITY entity "injected">]><lfm status="ok">&entity;</lfm>'.encode("utf-16"),
    b'<lfm status="failed"><error code="29">a</error><error code="29">b</error></lfm>',
])
def test_malformed_or_oversized_bytes_and_entities_fail_closed(bad_body):
    with pytest.raises(LastfmError):
        history.parse_history_page(bad_body, username=USER, range_start=START, range_end=END, page=1)


@pytest.mark.parametrize("code,retryable,reauth", [(29, True, False), (11, True, False), (16, True, False), (9, False, True), (10, False, False)])
def test_provider_error_flags_do_not_echo_untrusted_error_text(code, retryable, reauth):
    xml = f'<lfm status="failed"><error code="{code}">synthetic-secret-must-not-leak</error></lfm>'.encode()
    with pytest.raises(LastfmError) as error:
        history.parse_history_page(xml, username=USER, range_start=START, range_end=END, page=1)
    assert (error.value.code, error.value.retryable, error.value.reauthentication_required) == (code, retryable, reauth)
    assert "synthetic-secret" not in str(error.value)


def test_final_page_count_is_validated_without_dropping_a_same_second_repeat():
    page = parse(xml_page(timestamps=(START, START), page=2, total=202, total_pages=2), page=2)
    assert len(page.tracks) == 2 and page.tracks[0] == page.tracks[1]
    with pytest.raises(LastfmError):
        parse(xml_page(timestamps=(START,), page=2, total=202, total_pages=2), page=2)


class FakeResponse:
    def __init__(self, content):
        self.content, self.read_sizes, self.closed = content, [], False

    def read(self, size):
        self.read_sizes.append(size)
        return self.content[:size]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True


def test_reader_uses_fixed_bounds_public_get_timeout_byte_limit_and_exact_session_user(monkeypatch):
    response = FakeResponse(body(xml_page()))
    trace = []

    class Opener:
        def open(self, request, *, timeout):
            trace.append((request, timeout))
            return response

    def opener(handler):
        assert isinstance(handler, history._RejectRedirects)
        return Opener()

    monkeypatch.setattr(history, "build_opener", opener)
    result = history.read_history_page(CONFIG, session=SESSION, range_start=START, range_end=END, page=1)
    request, timeout = trace[0]
    query = parse_qs(urlsplit(request.full_url).query)
    assert query == {"method": ["user.getRecentTracks"], "api_key": [CONFIG["LASTFM_API_KEY"]],
                     "user": [USER], "from": [str(START - 1)], "to": [str(END + 1)],
                     "page": ["1"], "limit": ["200"], "extended": ["0"]}
    assert request.get_method() == "GET" and request.data is None
    assert SESSION.session_key not in request.full_url and "sk" not in query and "api_sig" not in query
    assert timeout == history.HISTORY_TIMEOUT_SECONDS
    assert response.read_sizes == [history.HISTORY_MAX_RESPONSE_BYTES + 1] and response.closed
    assert result.username == USER and len(trace) == 1


@pytest.mark.parametrize("kwargs", [
    {"page": 0}, {"page": 101}, {"page": True}, {"range_start": True},
    {"range_start": -1}, {"range_end": START - 1}, {"range_end": float(END)},
    {"range_end": 253402300799}, {"session": None},
])
def test_invalid_reader_scope_never_opens_network(monkeypatch, kwargs):
    monkeypatch.setattr(history, "build_opener", lambda *_: pytest.fail("No network on invalid scope"))
    inputs = {"session": SESSION, "range_start": START, "range_end": END, "page": 1, **kwargs}
    with pytest.raises(LastfmError):
        history.read_history_page(CONFIG, **inputs)


@pytest.mark.parametrize("root", ["http://ws.audioscrobbler.com/2.0/", "https://other.invalid/2.0/", "https://ws.audioscrobbler.com/2.0/?method=track.scrobble", ""])
def test_nonofficial_or_insecure_endpoints_never_receive_key(monkeypatch, root):
    monkeypatch.setattr(history, "build_opener", lambda *_: pytest.fail("No network on invalid endpoint"))
    with pytest.raises(LastfmError):
        history.read_history_page({**CONFIG, "LASTFM_API_ROOT": root}, session=SESSION, range_start=START, range_end=END, page=1)


def test_redirect_rejects_target_and_closes_response_before_forwarding_anything():
    response = BytesIO(b"redirect")
    with pytest.raises(LastfmError) as error:
        history._RejectRedirects().redirect_request(None, response, 302, "Found", {}, "https://other.invalid/")
    assert response.closed and "other.invalid" not in str(error.value)


@pytest.mark.parametrize("failure", [URLError("synthetic-secret-url"), TimeoutError("synthetic-secret-url"), OSError("synthetic-secret-url"), IncompleteRead(b"synthetic-secret-partial")])
def test_network_failures_are_retryable_without_exposing_transport_text(monkeypatch, failure):
    class Opener:
        def open(self, *_args, **_kwargs):
            raise failure
    monkeypatch.setattr(history, "build_opener", lambda *_: Opener())
    with pytest.raises(LastfmError) as error:
        history.read_history_page(CONFIG, session=SESSION, range_start=START, range_end=END, page=1)
    assert error.value.retryable and error.value.error_kind == "network_error"
    assert "synthetic-secret" not in str(error.value)


def test_http_error_response_is_bounded_closed_and_provider_code_is_retained(monkeypatch):
    source = BytesIO(b'<lfm status="failed"><error code="29">synthetic-secret</error></lfm>')
    failure = HTTPError("https://invalid/?synthetic-secret", 429, "synthetic-secret", {}, source)
    sizes = []
    original_read = failure.read

    def bounded_read(size):
        sizes.append(size)
        return original_read(size)

    failure.read = bounded_read

    class Opener:
        def open(self, *_args, **_kwargs):
            raise failure
    monkeypatch.setattr(history, "build_opener", lambda *_: Opener())
    with pytest.raises(LastfmError) as error:
        history.read_history_page(CONFIG, session=SESSION, range_start=START, range_end=END, page=1)
    assert error.value.code == 29 and error.value.retryable
    assert "synthetic-secret" not in str(error.value)
    assert sizes == [history.HISTORY_MAX_RESPONSE_BYTES + 1] and source.closed


def test_oversized_success_response_is_rejected_after_bounded_read(monkeypatch):
    response = FakeResponse(b"a" * (history.HISTORY_MAX_RESPONSE_BYTES + 2))
    class Opener:
        def open(self, *_args, **_kwargs):
            return response
    monkeypatch.setattr(history, "build_opener", lambda *_: Opener())
    with pytest.raises(LastfmError):
        history.read_history_page(CONFIG, session=SESSION, range_start=START, range_end=END, page=1)
    assert response.read_sizes == [history.HISTORY_MAX_RESPONSE_BYTES + 1] and response.closed
