"""Compact private Enhanced evidence; not authority, matching or commit proof.

The caller must validate the SAME complete immutable artifact, bind account and
source ownership, and reserve codec_phase_bytes before calling these codecs.
Local entries remain possibly seeded reported evidence, never lifetime counts.
Cached Last.fm entries are a separate lane and never additional local plays.
"""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
import unicodedata

from .foobar_enhanced_record_decoder import (
    ENHANCED_PLAYCOUNT_STORE_GUID, MAX_RECORD_BYTES, MAX_TIMESTAMPS,
    decode_enhanced_playcount_record,
)

INCOMING_VERSION = 'foobar_enhanced_incoming_v1'
EFFECTIVE_VERSION = 'foobar_enhanced_effective_v1'
DISPLAY_VERSION = 'foobar_enhanced_display_v1'
MAX_DISPLAY_BYTES = 1_048_576
MAX_DISPLAY_LABEL_BYTES = 256
MAX_EVIDENCE_BYTES = 4_194_304
MAX_IDENTITY_BYTES = 131_072
MAX_ALIASES = 250_000
# Original SQLite TEXT is <=16KiB in its declared encoding. UTF-16 Unicode
# may expand in UTF-8; this conservative ceiling never truncates source text.
MAX_ALIAS_UTF8_BYTES = 49_152
MAX_ARTIFACT_BYTES = 536_870_912
LOCAL_PROVENANCE = 'incomplete_possibly_seeded'
_MAX_UINT64 = 18_446_744_073_709_551_615


class EnhancedEvidenceInvalid(ValueError):
    def __init__(self):
        super().__init__('Enhanced source evidence is unavailable.')


@dataclass(frozen=True, slots=True)
class EnhancedIncomingEvidence:
    store_key: int
    data_state: str
    raw_reason: str | None
    raw_blob: bytes | None
    raw_size: int | None
    aliases: tuple[str, ...]
    upload_sha256: str
    record_ordinal: int


@dataclass(frozen=True, slots=True)
class EnhancedEffectiveEvidence:
    store_key: int
    state: str
    local_filetime_ticks: tuple[int, ...] | None
    cached_lastfm_filetime_ticks: tuple[int, ...] | None
    local_provenance: str | None


@dataclass(frozen=True, slots=True)
class EnhancedEvidenceMerge:
    incoming_bytes: bytes
    effective_bytes: bytes
    incoming_sha256: str
    effective_sha256: str
    usable: bool
    changed_effective: bool


@dataclass(frozen=True, slots=True)
class EnhancedDisplayEvidence:
    store_key: int
    label_kind: str
    label: str
    truncated: bool


def _fail():
    raise EnhancedEvidenceInvalid()


def _integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        _fail()
    return value


def _decimal(value, low, high):
    if type(value) is not str or not 1 <= len(value) <= 20:
        _fail()
    try:
        number = int(value)
    except ValueError:
        _fail()
    if str(number) != value or not low <= number <= high:
        _fail()
    return number


def _hex(value, length=64):
    if (type(value) is not str or len(value) != length
            or any(c not in '0123456789abcdef' for c in value)):
        _fail()
    return value


def _text_bytes(value):
    if type(value) is not str:
        _fail()
    count = 0
    for char in value:
        point = ord(char)
        if 0xD800 <= point <= 0xDFFF:
            _fail()
        count += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
    return count


def _size(value):
    if value is None:
        return 4
    if type(value) is str:
        count = _text_bytes(value) + 2
        for char in value:
            if char in '\\"\b\f\n\r\t':
                count += 1
            elif ord(char) < 32:
                count += 5
        return count
    if type(value) in (tuple, list):
        count = 2 + max(0, len(value) - 1)
        for item in value:
            count += _size(item)
            if count > MAX_EVIDENCE_BYTES:
                _fail()
        return count
    _fail()


def _dump(value, limit=MAX_EVIDENCE_BYTES):
    expected = _size(value)
    if not 1 <= expected <= limit:
        _fail()
    payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(payload) != expected:
        _fail()
    return payload


def _reject_number(*unused):
    _fail()


def _load(payload, limit=MAX_EVIDENCE_BYTES):
    if type(payload) is not bytes or not 1 <= len(payload) <= limit:
        _fail()
    # All numeric evidence is canonical decimal TEXT. Reject objects and
    # excessive nesting/token count before allocating ordinary JSON objects.
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
            if depth > 2 or arrays > 4:
                _fail()
        elif byte == 93:
            depth -= 1
            if depth < 0:
                _fail()
        elif byte == 44:
            commas += 1
            if commas > MAX_ALIASES + MAX_TIMESTAMPS + 64:
                _fail()
    if quoted or depth:
        _fail()
    try:
        return json.loads(payload.decode('utf-8'), parse_int=_reject_number,
            parse_float=_reject_number, parse_constant=_reject_number)
    except (ValueError, UnicodeError, RecursionError):
        _fail()


def _identity(key):
    _integer(key, -(2**63), 2**63-1)
    return ('store_key', ENHANCED_PLAYCOUNT_STORE_GUID, str(key))


def _read_identity(value):
    if (type(value) is not list or len(value) != 3
            or value[:2] != ['store_key', ENHANCED_PLAYCOUNT_STORE_GUID]):
        _fail()
    return _decimal(value[2], -(2**63), 2**63-1)


def encode_enhanced_identity(store_key):
    return _dump(_identity(store_key), MAX_IDENTITY_BYTES)


def decode_enhanced_identity(payload):
    key = _read_identity(_load(payload, MAX_IDENTITY_BYTES))
    if encode_enhanced_identity(key) != payload:
        _fail()
    return key


def _incoming(value):
    if type(value) is not EnhancedIncomingEvidence:
        _fail()
    _identity(value.store_key)
    if (type(value.data_state) is not str
            or value.data_state not in ('parsed', 'null', 'unavailable', 'malformed', 'unsupported', 'oversized')
            or value.raw_reason is not None and (type(value.raw_reason) is not str or len(value.raw_reason) > 64)):
        _fail()
    _hex(value.upload_sha256)
    _integer(value.record_ordinal, 0, 99_999)
    if type(value.aliases) is not tuple or len(value.aliases) > MAX_ALIASES:
        _fail()
    # Validate each alias and cumulative encoded charge before JSON copying.
    alias_size = 2 + max(0, len(value.aliases)-1)
    seen = set()
    for alias in value.aliases:
        if (type(alias) is not str or not 1 <= len(alias) <= MAX_ALIAS_UTF8_BYTES
                or not 1 <= _text_bytes(alias) <= MAX_ALIAS_UTF8_BYTES or '\x00' in alias):
            _fail()
        if alias in seen:
            _fail()
        seen.add(alias)
        alias_size += _size(alias)
        if alias_size > MAX_EVIDENCE_BYTES:
            _fail()
    if value.raw_blob is None:
        allowed = {
            ('null', 'null_value'): value.raw_size is None,
            ('unavailable', 'missing_data'): value.raw_size is None,
            ('malformed', 'invalid_value_type'): value.raw_size is None,
            ('oversized', 'record_too_large'): type(value.raw_size) is int
                and MAX_RECORD_BYTES < value.raw_size <= MAX_ARTIFACT_BYTES,
        }
        if not allowed.get((value.data_state, value.raw_reason), False):
            _fail()
        return None
    if type(value.raw_blob) is not bytes or len(value.raw_blob) > MAX_RECORD_BYTES:
        _fail()
    if type(value.raw_size) is not int or value.raw_size != len(value.raw_blob):
        _fail()
    decoded = decode_enhanced_playcount_record(value.raw_blob, store_guid=ENHANCED_PLAYCOUNT_STORE_GUID)
    state = 'parsed' if decoded.status == 'parsed' else decoded.diagnostics[0].category
    if state == 'too_large':
        state = 'oversized'
    reason = None if decoded.status == 'parsed' else decoded.diagnostics[0].code
    if value.data_state != state or value.raw_reason != reason:
        _fail()
    return decoded


def encode_enhanced_incoming(value):
    _incoming(value)
    raw = value.raw_blob
    return _dump((INCOMING_VERSION, _identity(value.store_key), value.data_state,
        value.raw_reason, None if value.raw_size is None else str(value.raw_size),
        None if raw is None else sha256(raw).hexdigest(), None if raw is None else raw.hex(),
        value.aliases, value.upload_sha256, str(value.record_ordinal)))


def decode_enhanced_incoming(payload):
    root = _load(payload)
    if type(root) is not list or len(root) != 10 or root[0] != INCOMING_VERSION:
        _fail()
    key = _read_identity(root[1])
    if type(root[7]) is not list:
        _fail()
    raw = None
    if root[6] is not None:
        if type(root[6]) is not str or len(root[6]) > 2 * MAX_RECORD_BYTES or len(root[6]) % 2:
            _fail()
        _hex(root[6], len(root[6]))
        raw = bytes.fromhex(root[6])
        if root[5] != sha256(raw).hexdigest():
            _fail()
    elif root[5] is not None:
        _fail()
    value = EnhancedIncomingEvidence(key, root[2], root[3], raw,
        None if root[4] is None else _decimal(root[4], 0, MAX_ARTIFACT_BYTES),
        tuple(root[7]), root[8], _decimal(root[9], 0, 99_999))
    if encode_enhanced_incoming(value) != payload:
        _fail()
    return value


def _effective(value):
    if type(value) is not EnhancedEffectiveEvidence:
        _fail()
    _identity(value.store_key)
    if value.state == 'unavailable':
        if (value.local_filetime_ticks is not None or value.cached_lastfm_filetime_ticks is not None
                or value.local_provenance is not None):
            _fail()
        return
    if (value.state != 'available' or value.local_provenance != LOCAL_PROVENANCE
            or type(value.local_filetime_ticks) is not tuple
            or type(value.cached_lastfm_filetime_ticks) is not tuple
            or len(value.local_filetime_ticks) + len(value.cached_lastfm_filetime_ticks) > MAX_TIMESTAMPS):
        _fail()
    for lane in (value.local_filetime_ticks, value.cached_lastfm_filetime_ticks):
        for tick in lane:
            _integer(tick, 0, _MAX_UINT64)


def encode_enhanced_effective(value):
    _effective(value)
    return _dump((EFFECTIVE_VERSION, _identity(value.store_key), value.state,
        None if value.local_filetime_ticks is None else tuple(str(t) for t in value.local_filetime_ticks),
        None if value.cached_lastfm_filetime_ticks is None else tuple(str(t) for t in value.cached_lastfm_filetime_ticks),
        value.local_provenance))


def decode_enhanced_effective(payload):
    root = _load(payload)
    if type(root) is not list or len(root) != 6 or root[0] != EFFECTIVE_VERSION:
        _fail()
    key = _read_identity(root[1])
    lanes = []
    for lane in root[3:5]:
        if lane is None:
            lanes.append(None)
        elif type(lane) is list and len(lane) <= MAX_TIMESTAMPS:
            lanes.append(tuple(_decimal(t, 0, _MAX_UINT64) for t in lane))
        else:
            _fail()
    value = EnhancedEffectiveEvidence(key, root[2], lanes[0], lanes[1], root[5])
    if encode_enhanced_effective(value) != payload:
        _fail()
    return value


def merge_enhanced_evidence(incoming_bytes, previous_effective_bytes=None):
    incoming = decode_enhanced_incoming(incoming_bytes)
    previous = None
    if previous_effective_bytes is not None:
        previous = decode_enhanced_effective(previous_effective_bytes)
        if previous.store_key != incoming.store_key:
            _fail()
    decoded = _incoming(incoming)
    if decoded is not None and decoded.status == 'parsed':
        record = decoded.record
        effective = EnhancedEffectiveEvidence(incoming.store_key, 'available',
            record.local_filetime_ticks, record.cached_lastfm_filetime_ticks, LOCAL_PROVENANCE)
        effective_bytes = encode_enhanced_effective(effective)
    elif previous is not None:
        # Preserve original usable or explicit-unavailable bytes exactly.
        effective, effective_bytes = previous, previous_effective_bytes
    else:
        effective = EnhancedEffectiveEvidence(incoming.store_key, 'unavailable', None, None, None)
        effective_bytes = encode_enhanced_effective(effective)
    return EnhancedEvidenceMerge(incoming_bytes, effective_bytes, sha256(incoming_bytes).hexdigest(),
        sha256(effective_bytes).hexdigest(), effective.state == 'available',
        effective_bytes != previous_effective_bytes)


def enhanced_local_vector_digest(value):
    """Bind exact ordered local evidence only, explicitly including unavailable.

    This is not an event-set identity and never combines cached Last.fm.
    """
    _effective(value)
    payload = _dump(('foobar_enhanced_local_vector_v1', _identity(value.store_key),
        value.state, value.local_provenance,
        None if value.local_filetime_ticks is None else tuple(str(t) for t in value.local_filetime_ticks)))
    return sha256(payload).hexdigest()


def codec_phase_bytes(incoming_length, previous_effective_length=0):
    """Conservative logical admission, not RSS or authority; reserve before decode.

    Covers canonical byte/text views, bounded JSON objects/aliases, raw hex and
    decoder vectors, both retained effective states and encoding temporaries.
    Caller-owned upload/index/window and SQL frame charges remain additional.
    """
    _integer(incoming_length, 1, MAX_EVIDENCE_BYTES)
    _integer(previous_effective_length, 0, MAX_EVIDENCE_BYTES)
    return 64 * (incoming_length + previous_effective_length) + 65_536


def incoming_encode_phase_bytes(*, retained_raw_length, alias_count, alias_utf8_bytes):
    """Quote before raw/alias expansion using bounded acquisition metadata.

    Alias bytes must be a proven upper bound on their UTF-8 representation,
    not source UTF-16 byte length. Sixfold escaping is deliberately conservative.
    An oversized original BLOB omitted from raw retention has retained length0.
    """
    _integer(retained_raw_length, 0, MAX_RECORD_BYTES)
    _integer(alias_count, 0, MAX_ALIASES)
    _integer(alias_utf8_bytes, 0, MAX_EVIDENCE_BYTES)
    if alias_utf8_bytes < alias_count or bool(alias_count) != bool(alias_utf8_bytes):
        _fail()
    upper = 2 * retained_raw_length + 6 * alias_utf8_bytes + 3 * alias_count + 1024
    if upper > MAX_EVIDENCE_BYTES:
        _fail()
    return codec_phase_bytes(upper)


def effective_encode_phase_bytes(local_count, cached_lastfm_count):
    _integer(local_count, 0, MAX_TIMESTAMPS)
    _integer(cached_lastfm_count, 0, MAX_TIMESTAMPS-local_count)
    # Twenty decimal digits, two quotes and a separator per uint64, plus frame.
    return codec_phase_bytes(512 + 23 * (local_count + cached_lastfm_count))


def _safe_filename(alias):
    # Deliberately do not interpret URLs or disclose their query/fragment. A
    # rejected filename remains original private evidence, never rewritten raw.
    if '://' in alias or '?' in alias or '#' in alias:
        return None
    leaf = alias.replace('\\', '/').rsplit('/', 1)[-1]
    if not leaf or leaf in ('.', '..') or ':' in leaf:
        return None
    cleaned = ''.join(c for c in leaf if not unicodedata.category(c).startswith('C')
        and unicodedata.category(c) not in ('Zl', 'Zp')).strip()
    if not cleaned or cleaned in ('.', '..'):
        return None
    parts = []
    length = 0
    for char in cleaned:
        size = _text_bytes(char)
        if length + size > MAX_DISPLAY_LABEL_BYTES:
            break
        parts.append(char)
        length += size
    label = ''.join(parts).rstrip()
    return (label, len(label) != len(cleaned)) if label else None


def build_enhanced_display(incoming):
    _incoming(incoming)
    for alias in incoming.aliases:
        found = _safe_filename(alias)
        if found is not None:
            return EnhancedDisplayEvidence(incoming.store_key, 'source_filename', *found)
    return EnhancedDisplayEvidence(incoming.store_key, 'source_record',
        'Foobar record ' + str(incoming.store_key), False)


def _display(value):
    if type(value) is not EnhancedDisplayEvidence:
        _fail()
    _identity(value.store_key)
    if type(value.truncated) is not bool or type(value.label) is not str:
        _fail()
    if value.label_kind == 'source_record':
        if value.label != 'Foobar record ' + str(value.store_key) or value.truncated:
            _fail()
    elif value.label_kind == 'source_filename':
        if (not 1 <= _text_bytes(value.label) <= MAX_DISPLAY_LABEL_BYTES
                or value.label != value.label.strip() or value.label in ('.', '..')
                or any(c in value.label for c in '/\\?:#')
                or any(unicodedata.category(c).startswith('C') or unicodedata.category(c) in ('Zl','Zp')
                    for c in value.label)):
            _fail()
    else:
        _fail()


def encode_enhanced_display(value):
    _display(value)
    return _dump((DISPLAY_VERSION, _identity(value.store_key), value.label_kind,
        value.label, 'truncated' if value.truncated else 'complete', None, None, None), MAX_DISPLAY_BYTES)


def decode_enhanced_display(payload):
    root = _load(payload, MAX_DISPLAY_BYTES)
    if (type(root) is not list or len(root) != 8 or root[0] != DISPLAY_VERSION
            or root[4] not in ('complete','truncated') or root[5:] != [None,None,None]):
        _fail()
    value = EnhancedDisplayEvidence(_read_identity(root[1]), root[2], root[3], root[4] == 'truncated')
    if encode_enhanced_display(value) != payload:
        _fail()
    return value


def check_enhanced_display(payload, incoming):
    if encode_enhanced_display(build_enhanced_display(incoming)) != payload:
        _fail()
