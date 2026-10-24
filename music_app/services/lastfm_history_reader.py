"""Bounded, public Last.fm history observations, never scrobble submissions.

The server supplies the actual authenticated account's LastfmSession. The
session key is not sent to this public API. Page numbers and hashes are local
observation evidence, not provider event IDs or a snapshot guarantee. A durable
generation owner must compare metadata/order between pages before promotion.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from http.client import HTTPException
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
import xml.etree.ElementTree as ET

from music_app.services.lastfm import LastfmError, LastfmSession


HISTORY_PAGE_LIMIT = 200
HISTORY_MAX_PAGES = 100
HISTORY_MAX_RESPONSE_BYTES = 1_048_576
HISTORY_TIMEOUT_SECONDS = 12.0
_MAX_TIMESTAMP = 253402300798  # Leave one second for the inclusive upper overlap.
_API_ROOT = "https://ws.audioscrobbler.com/2.0/"
_RETRYABLE_CODES = frozenset({11, 16, 29})
_RETRYABLE_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


@dataclass(frozen=True)
class HistoryTrack:
    timestamp: int
    artist: str
    track: str
    album: str


@dataclass(frozen=True)
class HistoryPage:
    username: str
    page: int
    per_page: int
    total_pages: int
    total: int
    tracks: tuple[HistoryTrack, ...]
    digest: str
    raw_xml: str
    observed_count: int
    nowplaying_count: int
    observed_newest: int | None
    observed_oldest: int | None


class HistoryRangeTooLarge(LastfmError):
    """Validated bounded page evidence, never permission to truncate history."""
    def __init__(self, evidence):
        super().__init__('Last.fm history window exceeds the bounded page budget.',error_kind='provider_error')
        self.evidence=evidence
        self.raw_xml=evidence.raw_xml
        self.digest=evidence.digest
        self.total_pages=evidence.total_pages
        self.total=evidence.total
        self.page=evidence.page


def _invalid(message: str) -> LastfmError:
    return LastfmError(message, error_kind="provider_error")


def _validate_request(*, username: str, range_start: int, range_end: int, page: int, limit: int, allow_dense: bool = False) -> None:
    if (type(username) is not str or not username or len(username) > 255
            or username != username.strip() or any(ord(char) < 32 for char in username)):
        raise _invalid("Last.fm history requires an exact authenticated username.")
    if (type(range_start) is not int or type(range_end) is not int
            or not 0 <= range_start <= range_end <= _MAX_TIMESTAMP):
        raise _invalid("Last.fm history requires a finite fixed timestamp range.")
    if type(allow_dense) is not bool or type(page) is not int or not 1 <= page <= (1000000000 if allow_dense else HISTORY_MAX_PAGES):
        raise _invalid("Last.fm history page is outside the bounded generation.")
    if allow_dense and range_start != range_end:
        raise _invalid("Dense history continuation requires one timestamp second.")
    if type(limit) is not int or limit != HISTORY_PAGE_LIMIT:
        raise _invalid("Last.fm history page size must be exactly 200.")


def _uint(value: str | None, *, label: str, maximum: int) -> int:
    # Canonical decimal only: reject signs, whitespace, floats, leading zeros,
    # Unicode numerals and arbitrary-size conversions before calling int().
    if (type(value) is not str or not value or len(value) > len(str(maximum))
            or any(char not in "0123456789" for char in value)
            or (len(value) > 1 and value[0] == "0")):
        raise _invalid(f"Last.fm history has invalid {label}.")
    number = int(value)
    if number > maximum:
        raise _invalid(f"Last.fm history has out-of-range {label}.")
    return number


def _leaf(node: ET.Element, tag: str, *, required: bool = True) -> str:
    matches = node.findall(tag)
    if len(matches) != 1:
        raise _invalid(f"Last.fm history requires exactly one {tag} field.")
    leaf = matches[0]
    value = leaf.text or ""
    if (len(leaf) or len(value) > 1024 or (leaf.tail or "").strip()
            or any(ord(char) < 32 for char in value)
            or (required and not value.strip())):
        raise _invalid(f"Last.fm history has malformed {tag} text.")
    return value


def _xml_root(body: bytes) -> tuple[ET.Element, str]:
    if type(body) is not bytes or not body or len(body) > HISTORY_MAX_RESPONSE_BYTES:
        raise _invalid("Last.fm history response is empty or exceeds the byte limit.")
    try:
        raw_xml = body.decode("utf-8")
    except UnicodeDecodeError:
        raise _invalid("Last.fm history response is not UTF-8 XML.") from None
    # Do not permit DTDs/entities, including internal entity expansion. UTF-8
    # decoding and the NUL rejection prevent UTF-16/32 declaration bypasses.
    if "\x00" in raw_xml or "<!DOCTYPE" in raw_xml.upper() or "<!ENTITY" in raw_xml.upper():
        raise _invalid("Last.fm history response contains an unsupported XML declaration.")
    try:
        root = ET.fromstring(body)
    except (ET.ParseError, LookupError, ValueError):
        raise _invalid("Last.fm history response is malformed XML.") from None
    if root.tag != "lfm" or (root.text or "").strip() or (root.tail or "").strip():
        raise _invalid("Last.fm history response has an invalid XML envelope.")
    if root.get("status") == "failed":
        errors = root.findall("error")
        if len(root) != 1 or len(errors) != 1 or len(errors[0]):
            raise _invalid("Last.fm history response has a malformed error envelope.")
        code = _uint(errors[0].get("code"), label="error code", maximum=999)
        # Provider text is untrusted and may reflect request data. Never include
        # it, a URL, an API key or an HTTP exception's representation in errors.
        raise LastfmError(
            f"Last.fm history request failed (provider code {code}).",
            code=code, retryable=code in _RETRYABLE_CODES,
            reauthentication_required=code == 9, error_kind="provider_error",
        )
    if root.get("status") != "ok":
        raise _invalid("Last.fm history response has no valid success status.")
    return root, raw_xml


def parse_history_page(
    body: bytes, *, username: str, range_start: int, range_end: int,
    page: int, limit: int = HISTORY_PAGE_LIMIT, allow_dense: bool = False,
) -> HistoryPage:
    """Parse one actual XML response, keeping duplicates and exact source text.

    Requests overlap each end by one second because provider documentation says
    after/before without establishing inclusive edge behavior. Full-page order
    and count checks happen before local inclusive-range filtering. ``total``
    and ``observed_count`` describe that expanded wire range, not kept tracks.
    """
    _validate_request(username=username, range_start=range_start, range_end=range_end, page=page, limit=limit, allow_dense=allow_dense)
    root, raw_xml = _xml_root(body)
    containers = root.findall("recenttracks")
    if len(root) != 1 or len(containers) != 1:
        raise _invalid("Last.fm history requires exactly one recenttracks envelope.")
    container = containers[0]
    if ((container.text or "").strip() or (container.tail or "").strip()
            or container.get("user") != username):
        raise _invalid("Last.fm history response does not match the authenticated username.")
    reply_page = _uint(container.get("page"), label="page", maximum=1000000000 if allow_dense else HISTORY_MAX_PAGES)
    per_page = _uint(container.get("perPage"), label="page size", maximum=HISTORY_PAGE_LIMIT)
    total_pages = _uint(container.get("totalPages"), label="page total", maximum=1000000000)
    total = _uint(container.get("total"), label="track total", maximum=HISTORY_PAGE_LIMIT * 1000000000)
    if reply_page != page or per_page != limit:
        raise _invalid("Last.fm history response page metadata does not match the request.")
    expected_pages = (total + limit - 1) // limit
    if ((total and (total_pages != expected_pages or page > total_pages))
            or (not total and (total_pages not in (0, 1) or page != 1))):
        raise _invalid("Last.fm history response has inconsistent pagination totals.")
    observed: list[HistoryTrack] = []
    nowplaying_count = 0
    if len(container) > limit + 1:
        raise _invalid("Last.fm history response contains too many track elements.")
    previous_timestamp: int | None = None
    for item in container:
        if item.tag != "track" or (item.text or "").strip() or (item.tail or "").strip():
            raise _invalid("Last.fm history response contains an invalid track element.")
        nowplaying = item.get("nowplaying")
        if nowplaying == "true":
            nowplaying_count += 1
            if nowplaying_count > 1:
                raise _invalid("Last.fm history response contains multiple now-playing entries.")
            continue
        if nowplaying not in (None, "false"):
            raise _invalid("Last.fm history response has an invalid now-playing flag.")
        artist = _leaf(item, "artist")
        title = _leaf(item, "name")
        album = _leaf(item, "album", required=False)
        _leaf(item, "date")
        timestamp = _uint(item.find("date").get("uts"), label="track timestamp", maximum=_MAX_TIMESTAMP + 1)
        if not max(0, range_start - 1) <= timestamp <= range_end + 1:
            raise _invalid("Last.fm history response has a track outside the requested wire range.")
        if previous_timestamp is not None and timestamp > previous_timestamp:
            raise _invalid("Last.fm history response is not in descending timestamp order.")
        previous_timestamp = timestamp
        observed.append(HistoryTrack(timestamp=timestamp, artist=artist, track=title, album=album))
    expected_count = min(limit, max(0, total - (page - 1) * limit))
    if len(observed) != expected_count:
        raise _invalid("Last.fm history response track count does not match its pagination metadata.")
    evidence = HistoryPage(
        username=username, page=page, per_page=per_page, total_pages=total_pages,
        total=total, tracks=tuple(item for item in observed if range_start <= item.timestamp <= range_end),
        digest=hashlib.sha256(body).hexdigest(), raw_xml=raw_xml,
        observed_count=len(observed), nowplaying_count=nowplaying_count,
        observed_newest=observed[0].timestamp if observed else None,
        observed_oldest=observed[-1].timestamp if observed else None,
    )
    if not allow_dense and (total_pages > HISTORY_MAX_PAGES or total > HISTORY_PAGE_LIMIT * HISTORY_MAX_PAGES):
        raise HistoryRangeTooLarge(evidence)
    return evidence


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise _invalid("Last.fm history redirects are not permitted.")


def read_history_page(
    config: dict[str, Any], *, session: LastfmSession,
    range_start: int, range_end: int, page: int, allow_dense: bool = False,
) -> HistoryPage:
    """Read one bounded page only; a durable server owner advances generations."""
    if not isinstance(session, LastfmSession):
        raise _invalid("Last.fm history requires the server-owned authenticated session.")
    _validate_request(username=session.username, range_start=range_start, range_end=range_end,
                      page=page, limit=HISTORY_PAGE_LIMIT, allow_dense=allow_dense)
    api_key = str(config.get("LASTFM_API_KEY") or "").strip()
    api_root = str(config.get("LASTFM_API_ROOT") or "").strip()
    if not api_key or api_root != _API_ROOT:
        raise _invalid("Last.fm history requires a configured key and the official HTTPS API endpoint.")
    query = urlencode({
        "method": "user.getRecentTracks", "api_key": api_key, "user": session.username,
        "from": max(0, range_start - 1), "to": range_end + 1,
        "page": page, "limit": HISTORY_PAGE_LIMIT, "extended": 0,
    })
    request = Request(_API_ROOT + "?" + query, headers={"Accept": "application/xml"}, method="GET")
    try:
        with build_opener(_RejectRedirects()).open(request, timeout=HISTORY_TIMEOUT_SECONDS) as response:
            body = response.read(HISTORY_MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        try:
            error_body = exc.read(HISTORY_MAX_RESPONSE_BYTES + 1)
            _xml_root(error_body)
        except LastfmError as parsed_error:
            if parsed_error.code is not None:
                raise parsed_error from None
        except (URLError, TimeoutError, OSError, HTTPException):
            raise LastfmError("Network error reading Last.fm history.", retryable=True,
                              error_kind="network_error") from None
        finally:
            exc.close()
        raise LastfmError(
            f"Last.fm history request failed (HTTP {int(exc.code)}).",
            retryable=int(exc.code) in _RETRYABLE_STATUSES, error_kind="provider_error",
        ) from None
    except (URLError, TimeoutError, OSError, HTTPException):
        raise LastfmError("Network error reading Last.fm history.", retryable=True,
                          error_kind="network_error") from None
    return parse_history_page(body, username=session.username, range_start=range_start,
                              range_end=range_end, page=page, allow_dense=allow_dense)
