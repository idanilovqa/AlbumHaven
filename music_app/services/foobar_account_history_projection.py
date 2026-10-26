"""Bounded account display projection of one source-owned Foobar observation.

This is not an event ledger, source precedence rule, matching operation, or
authority check. The owner retains raw/effective evidence and binds this value
to its account, source, observation, revision and transaction. No Last.fm lane
or unsupported local event array participates in this projection.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
import re

from . import foobar_snapshot_parser as parser
from . import foobar_source_display as display
from . import foobar_source_evidence as evidence


VERSION = "foobar_account_history_projection_v1"
MAX_PROJECTION_BYTES = 8192
MIN_SORT_KEY = -(2**63)
MAX_SORT_KEY = 2**63 - 1
LABEL_LIMITS = (48, 96, 48)  # artist, title, album; UTF-8 bytes, not characters.
MAX_DATE_LABEL_BYTES = 128
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_TIMESTAMP = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T"
    r"([0-9]{2}):([0-9]{2}):([0-9]{2})"
    r"(?:\.([0-9]{1,6}))?(Z|[+-][0-9]{2}:[0-9]{2})\Z"
)
_FAMILY_FIELDS = (
    ("standard", "play_count", "first_played", "last_played"),
    ("enhanced", "play_count_enhanced", "first_played_enhanced", "last_played_enhanced"),
)


class AccountHistoryProjectionError(ValueError):
    """A closed failure, containing no source values or private paths."""

    code = "foobar_history_projection_unavailable"
    status_code = 503

    def __init__(self):
        super().__init__("Foobar history projection is unavailable.")


@dataclass(frozen=True, slots=True)
class BoundedLabel:
    state: str
    text: str | None
    truncated: bool


@dataclass(frozen=True, slots=True)
class BoundaryEvidence:
    state: str
    label: str | None
    truncated: bool
    source_sha256: str | None
    resolution: str
    unix_microseconds: int | None
    fraction_digits: int | None


@dataclass(frozen=True, slots=True)
class FamilyProjection:
    family: str
    count_state: str
    total: int | None
    status: str
    reason: str | None
    first: BoundaryEvidence
    last: BoundaryEvidence
    first_marker_weight: int
    aggregate_remainder: int | None
    first_sort_key: int | None
    remainder_sort_key: int
    grouped_sort_key: int


@dataclass(frozen=True, slots=True)
class AccountHistoryProjection:
    version: str
    source_revision: int
    effective_evidence_sha256: str
    display_sha256: str
    artist: BoundedLabel
    title: BoundedLabel
    album: BoundedLabel
    standard: FamilyProjection
    enhanced: FamilyProjection


def _fail():
    raise AccountHistoryProjectionError()


def _digest(value):
    if (type(value) is not str or len(value) != 64
            or any(c not in "0123456789abcdef" for c in value)):
        _fail()


def _text(value, limit):
    if type(value) is not str or len(value) > limit:
        _fail()
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        _fail()
    if len(encoded) > limit or any(c in value for c in ("\x00", "\r", "\t", "\n")):
        _fail()


def _prefix(value, limit):
    # Source validation has already rejected surrogates and bounded the cell.
    # Allocate only the admitted prefix, not a full-cell UTF-8 copy.
    size = end = 0
    for character in value:
        point = ord(character)
        width = 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
        if size + width > limit:
            break
        size += width
        end += 1
    return value[:end], end != len(value)


def _resolve_timestamp(raw):
    """Return exact (UTC epoch microseconds, fractional digits), or unresolved.

    This deliberately does not use datetime.fromisoformat's broader grammar.
    Whitespace, naive dates, lowercase separators, fractional precision above
    six, leap seconds, unknown -00:00 and offsets beyond 14:00 are unresolved.
    """
    if len(raw) > 32:
        return None
    match = _TIMESTAMP.fullmatch(raw)
    if match is None:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    if zone == "-00:00":
        return None
    offset_minutes = 0
    if zone != "Z":
        offset_hour, offset_minute = int(zone[1:3]), int(zone[4:6])
        if offset_minute > 59 or offset_hour > 14 or (offset_hour == 14 and offset_minute != 0):
            return None
        offset_minutes = (offset_hour * 60 + offset_minute) * (1 if zone[0] == "+" else -1)
    digits = 0 if fraction is None else len(fraction)
    microsecond = 0 if fraction is None else int(fraction.ljust(6, "0"))
    try:
        instant = datetime(int(year), int(month), int(day), int(hour), int(minute), int(second),
                           microsecond, tzinfo=timezone(timedelta(minutes=offset_minutes)))
        utc = instant.astimezone(timezone.utc)
        delta = utc - _EPOCH
    except (ValueError, OverflowError):
        return None
    # No timestamp(), float, milliseconds, rounding, or JavaScript Number.
    key = (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds
    if not MIN_SORT_KEY < key <= MAX_SORT_KEY:
        return None
    return key, digits


def _boundary(field):
    state, raw, value, code, origin = field
    if state == "absent":
        return BoundaryEvidence(state, None, False, None, "not_supplied", None, None)
    label, truncated = _prefix(raw, MAX_DATE_LABEL_BYTES)
    digest = sha256(raw.encode("utf-8")).hexdigest()
    resolved = _resolve_timestamp(raw) if state == "valid" else None
    return BoundaryEvidence(
        state, label, truncated, digest,
        "resolved" if resolved is not None else "unresolved" if state == "valid" else "not_supplied",
        None if resolved is None else resolved[0],
        None if resolved is None else resolved[1],
    )


def _label(field, limit):
    state, raw, value, code, origin = field
    if state == "absent":
        return BoundedLabel(state, None, False)
    text, truncated = _prefix(raw, limit)
    return BoundedLabel(state, text, truncated)


def _last_key(last):
    return MIN_SORT_KEY if last.unix_microseconds is None else last.unix_microseconds


def _resolution_interval(boundary):
    """Declared source precision, not an assertion of clock accuracy."""
    if boundary.unix_microseconds is None:
        return None
    quantum = 10 ** (6 - boundary.fraction_digits)
    return boundary.unix_microseconds, boundary.unix_microseconds + quantum - 1


def _family(family, count_state, total, first, last):
    reason = None
    status = "ready"
    first_interval, last_interval = _resolution_interval(first), _resolution_interval(last)
    if count_state != "valid":
        status = "needs_reconciliation" if count_state == "invalid" else "unavailable"
        reason = "invalid_count" if count_state == "invalid" else "count_unavailable"
    elif total == 0 and (first.state == "valid" or last.state == "valid"):
        status, reason = "needs_reconciliation", "zero_count_with_boundaries"
    elif (first_interval is not None and last_interval is not None
          and first_interval[0] > last_interval[1]):
        status, reason = "needs_reconciliation", "boundary_order_conflict"
    elif total == 1 and first.state == "valid" and last.state == "valid":
        both_resolved = first_interval is not None and last_interval is not None
        compatible = (not (first_interval[1] < last_interval[0] or last_interval[1] < first_interval[0])
                      if both_resolved else first.source_sha256 == last.source_sha256)
        if not compatible:
            status, reason = "needs_reconciliation", "single_count_boundary_conflict"
    marker = 1 if status == "ready" and total > 0 and first.state == "valid" else 0
    remainder = total - marker if status == "ready" else None
    first_key = (MIN_SORT_KEY if first.unix_microseconds is None else first.unix_microseconds) if marker else None
    last_key = _last_key(last)
    return FamilyProjection(family, count_state, total, status, reason, first, last,
                            marker, remainder, first_key, last_key, last_key)


def _valid_label(label, limit):
    if (type(label) is not BoundedLabel or type(label.state) is not str
            or type(label.truncated) is not bool):
        _fail()
    if label.state == "absent":
        if label.text is not None or label.truncated:
            _fail()
    elif label.state in ("empty", "valid"):
        _text(label.text, limit)
        if ((label.state == "empty" and (label.text != "" or label.truncated))
                or (label.state == "valid" and not label.text)):
            _fail()
    else:
        _fail()


def _valid_boundary(boundary):
    if (type(boundary) is not BoundaryEvidence or type(boundary.state) is not str
            or type(boundary.resolution) is not str or type(boundary.truncated) is not bool):
        _fail()
    if boundary.state == "absent":
        if (boundary.label is not None or boundary.truncated or boundary.source_sha256 is not None
                or boundary.resolution != "not_supplied" or boundary.unix_microseconds is not None
                or boundary.fraction_digits is not None):
            _fail()
        return
    if boundary.state not in ("empty", "unavailable", "valid"):
        _fail()
    _text(boundary.label, MAX_DATE_LABEL_BYTES)
    _digest(boundary.source_sha256)
    if not boundary.truncated:
        if sha256(boundary.label.encode("utf-8")).hexdigest() != boundary.source_sha256:
            _fail()
        classified = parser._observation("first_played", 0, (boundary.label,))
        if classified.state != boundary.state:
            _fail()
    if boundary.state != "valid":
        if (boundary.resolution != "not_supplied" or boundary.unix_microseconds is not None
                or boundary.fraction_digits is not None):
            _fail()
        return
    if not boundary.label:
        _fail()
    resolved = None if boundary.truncated else _resolve_timestamp(boundary.label)
    if boundary.resolution == "resolved":
        if (resolved is None or type(boundary.unix_microseconds) is not int
                or type(boundary.fraction_digits) is not int
                or resolved != (boundary.unix_microseconds, boundary.fraction_digits)):
            _fail()
    elif boundary.resolution == "unresolved":
        if (resolved is not None or boundary.unix_microseconds is not None
                or boundary.fraction_digits is not None):
            _fail()
    else:
        _fail()


def _valid_family(value, family):
    if (type(value) is not FamilyProjection or type(value.family) is not str
            or value.family != family or type(value.count_state) is not str
            or type(value.status) is not str
            or (value.reason is not None and type(value.reason) is not str)):
        _fail()
    if value.count_state not in ("absent", "empty", "unavailable", "invalid", "valid"):
        _fail()
    if value.count_state == "valid":
        if type(value.total) is not int or not 0 <= value.total <= MAX_SORT_KEY:
            _fail()
    elif value.total is not None:
        _fail()
    _valid_boundary(value.first)
    _valid_boundary(value.last)
    if (type(value.first_marker_weight) is not int
            or type(value.remainder_sort_key) is not int or type(value.grouped_sort_key) is not int
            or (value.first_sort_key is not None and type(value.first_sort_key) is not int)
            or (value.aggregate_remainder is not None and type(value.aggregate_remainder) is not int)):
        _fail()
    if value != _family(value.family, value.count_state, value.total, value.first, value.last):
        _fail()


def _validate(projection):
    try:
        if (type(projection) is not AccountHistoryProjection or type(projection.version) is not str
                or projection.version != VERSION):
            _fail()
        if type(projection.source_revision) is not int or not 1 <= projection.source_revision <= MAX_SORT_KEY:
            _fail()
        _digest(projection.effective_evidence_sha256)
        _digest(projection.display_sha256)
        for label, limit in zip((projection.artist, projection.title, projection.album), LABEL_LIMITS):
            _valid_label(label, limit)
        _valid_family(projection.standard, "standard")
        _valid_family(projection.enhanced, "enhanced")
    except AttributeError:
        raise AccountHistoryProjectionError() from None


def projection_phase_bytes(effective_evidence_size: int, display_size: int) -> int:
    """Conservative serial caller admission, excluding already-retained owners.

    Reserve before build/check. Incoming bytes, old source/projection, driver
    rows and all simultaneously retained page results remain caller-owned.
    This covers canonical evidence decode/re-encode, display association,
    classifier scratch, full-cell hash scratch and bounded projection views.
    """
    if (type(effective_evidence_size) is not int or type(display_size) is not int
            or not 1 <= effective_evidence_size <= evidence.MAX_EVIDENCE_BYTES
            or not 1 <= display_size <= display.MAX_BYTES):
        _fail()
    return (evidence.decode_phase_bytes(effective_evidence_size)
            + 5 * display_size + 2 * parser.MAX_CELL_UTF8_BYTES + 8 * MAX_PROJECTION_BYTES)


def projection_decode_phase_bytes(payload_size: int) -> int:
    """Retained payload plus bounded decode/destination/encode views, serially."""
    if type(payload_size) is not int or not 1 <= payload_size <= MAX_PROJECTION_BYTES:
        _fail()
    return 8 * MAX_PROJECTION_BYTES


def build_account_history_projection(
    *, effective_evidence_bytes: bytes, display_bytes: bytes, source_revision: int,
) -> AccountHistoryProjection:
    """Validate the exact codecs, then retain both families without precedence.

    The owner supplies the current effective evidence, NOT the unmerged incoming
    observation. Both incoming/raw and effective originals remain in its store.
    A lower or corrected count rebuilds this whole value; nothing is appended.
    """
    if (type(effective_evidence_bytes) is not bytes or type(display_bytes) is not bytes
            or type(source_revision) is not int or not 1 <= source_revision <= MAX_SORT_KEY):
        _fail()
    projection_phase_bytes(len(effective_evidence_bytes), len(display_bytes))
    try:
        fields = evidence.decode_evidence(effective_evidence_bytes)
        display.check_display(display_bytes, fields)
    except evidence.SourceEvidenceError:
        raise AccountHistoryProjectionError() from None
    families = []
    for family, count_name, first_name, last_name in _FAMILY_FIELDS:
        count = fields[parser.FIELD_NAMES.index(count_name)]
        families.append(_family(
            family, count[0], count[2] if count[0] == "valid" else None,
            _boundary(fields[parser.FIELD_NAMES.index(first_name)]),
            _boundary(fields[parser.FIELD_NAMES.index(last_name)]),
        ))
    labels = tuple(_label(fields[parser.FIELD_NAMES.index(name)], limit)
                   for name, limit in zip(("artist", "title", "album"), LABEL_LIMITS))
    result = AccountHistoryProjection(
        VERSION, source_revision, sha256(effective_evidence_bytes).hexdigest(),
        sha256(display_bytes).hexdigest(), *labels, *families,
    )
    _validate(result)
    return result


def _decimal(value):
    return None if value is None else str(value)


def _boundary_array(value):
    return [value.state, value.label, value.truncated, value.source_sha256,
            value.resolution, _decimal(value.unix_microseconds), value.fraction_digits]


def _family_array(value):
    return [value.family, value.count_state, _decimal(value.total), value.status, value.reason,
            _boundary_array(value.first), _boundary_array(value.last), value.first_marker_weight,
            _decimal(value.aggregate_remainder), _decimal(value.first_sort_key),
            str(value.remainder_sort_key), str(value.grouped_sort_key)]


def encode_account_history_projection(projection: AccountHistoryProjection) -> bytes:
    """Canonical compact array codec; potentially large integers are strings."""
    _validate(projection)
    root = [projection.version, str(projection.source_revision), projection.effective_evidence_sha256,
            projection.display_sha256,
            [[label.state, label.text, label.truncated]
             for label in (projection.artist, projection.title, projection.album)],
            [_family_array(projection.standard), _family_array(projection.enhanced)]]
    result = json.dumps(root, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if not 1 <= len(result) <= MAX_PROJECTION_BYTES:
        _fail()
    return result


def _small_integer(text):
    if len(text) != 1 or text not in "0123456":
        _fail()
    return int(text)


def _forbidden_number(text):
    _fail()


def _read_decimal(value, *, nullable=False):
    if value is None and nullable:
        return None
    if type(value) is not str or not 1 <= len(value) <= 20:
        _fail()
    digits = value[1:] if value.startswith("-") else value
    if (not digits or not all("0" <= c <= "9" for c in digits)
            or (len(digits) > 1 and digits[0] == "0") or value == "-0"):
        _fail()
    result = int(value)
    if not MIN_SORT_KEY <= result <= MAX_SORT_KEY:
        _fail()
    return result


def _array(value, size):
    if type(value) is not list or len(value) != size:
        _fail()


def _read_boundary(value):
    _array(value, 7)
    return BoundaryEvidence(*value[:5], _read_decimal(value[5], nullable=True), value[6])


def _read_family(value):
    _array(value, 12)
    return FamilyProjection(
        value[0], value[1], _read_decimal(value[2], nullable=True), value[3], value[4],
        _read_boundary(value[5]), _read_boundary(value[6]), value[7],
        _read_decimal(value[8], nullable=True), _read_decimal(value[9], nullable=True),
        _read_decimal(value[10]), _read_decimal(value[11]),
    )


def _load(payload):
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_PROJECTION_BYTES:
        _fail()
    # Reject objects/deep/wide containers before allocating the JSON tree.
    depth = arrays = commas = 0
    quoted = escaped = False
    for byte in payload:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (123, 125):
            _fail()
        elif byte == 91:
            depth += 1
            arrays += 1
            if depth > 4 or arrays > 12:
                _fail()
        elif byte == 93:
            depth -= 1
            if depth < 0:
                _fail()
        elif byte == 44:
            commas += 1
            if commas > 70:
                _fail()
    if quoted or depth != 0:
        _fail()
    try:
        return json.loads(payload.decode("utf-8"), parse_int=_small_integer,
                          parse_float=_forbidden_number, parse_constant=_forbidden_number)
    except (ValueError, UnicodeError, RecursionError):
        raise AccountHistoryProjectionError() from None


def decode_account_history_projection(payload: bytes) -> AccountHistoryProjection:
    """Bounded canonical decode, not account/source ownership authorization."""
    root = _load(payload)
    _array(root, 6)
    _array(root[4], 3)
    _array(root[5], 2)
    labels = []
    for value in root[4]:
        _array(value, 3)
        labels.append(BoundedLabel(*value))
    result = AccountHistoryProjection(
        root[0], _read_decimal(root[1]), root[2], root[3], *labels,
        _read_family(root[5][0]), _read_family(root[5][1]),
    )
    if encode_account_history_projection(result) != payload:
        _fail()
    return result


def check_account_history_projection(
    payload: bytes, *, effective_evidence_bytes: bytes, display_bytes: bytes, source_revision: int,
) -> AccountHistoryProjection:
    """Check complete source association, not just caller-supplied hash strings."""
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_PROJECTION_BYTES:
        _fail()
    expected = build_account_history_projection(
        effective_evidence_bytes=effective_evidence_bytes,
        display_bytes=display_bytes, source_revision=source_revision,
    )
    if encode_account_history_projection(expected) != payload:
        _fail()
    return expected


def _public_boundary(value):
    return {"state": value.state, "label": value.label, "truncated": value.truncated,
            "resolution": value.resolution, "unix_microseconds": _decimal(value.unix_microseconds),
            "fraction_digits": value.fraction_digits}


def public_family_projection(projection: AccountHistoryProjection, *, family: str) -> dict:
    """Render-safe scalar shape; consumers must still escape untrusted labels.

    A marker is boundary evidence, never a measured-play timestamp. A remainder
    is ALWAYS one aggregate, including weight one. No badge is required for one.
    Zero/unknown/reconciliation may be shown as non-listen diagnostic rows. A
    zero remainder after a marker is omitted, not a second occurrence.
    """
    _validate(projection)
    if type(family) is not str or family not in ("standard", "enhanced"):
        _fail()
    selected = projection.standard if family == "standard" else projection.enhanced
    return {
        "source_kind": "foobar_local", "family": family,
        "source_revision": str(projection.source_revision),
        "artist": {"state": projection.artist.state, "text": projection.artist.text,
                   "truncated": projection.artist.truncated},
        "title": {"state": projection.title.state, "text": projection.title.text,
                  "truncated": projection.title.truncated},
        "album": {"state": projection.album.state, "text": projection.album.text,
                  "truncated": projection.album.truncated},
        "count_state": selected.count_state, "total": _decimal(selected.total),
        "status": selected.status, "reason": selected.reason,
        "first": _public_boundary(selected.first), "last": _public_boundary(selected.last),
        "timestamp_coverage": ("boundary_evidence" if selected.first.state == "valid"
                               or selected.last.state == "valid" else "no_timestamps"),
        "first_marker_weight": selected.first_marker_weight,
        "aggregate_remainder": _decimal(selected.aggregate_remainder),
        "first_sort_key": _decimal(selected.first_sort_key),
        "remainder_sort_key": str(selected.remainder_sort_key),
        "grouped_sort_key": str(selected.grouped_sort_key),
        "show_grouped_count": selected.status == "ready" and selected.total > 1,
        "show_remainder_count": selected.aggregate_remainder is not None and selected.aggregate_remainder > 1,
    }
