"""Exact current local timestamp evidence, not lifetime plays or playback events.

Only local source entries are projected. Cached Last.fm never enters this owner.
Ordinal is one vector revision's position, not a durable event identifier.
"""
from dataclasses import dataclass
import hashlib
import json

from . import foobar_enhanced_source_evidence as evidence
from .foobar_enhanced_record_decoder import MAX_TIMESTAMPS
from .foobar_enhanced_timestamp_normalization import _timestamp

MAX_ENTRY_BYTES = 512
MAX_HEADER_BYTES = 2048
UNKNOWN_TIME = -9223372036854775808
PROVENANCE = 'incomplete_possibly_seeded'
ENTRY_VERSION = 'foobar_local_entry_v1'
HEADER_VERSION = 'foobar_enhanced_history_v1'
_MAX = 9223372036854775807


class EnhancedProjectionInvalid(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EnhancedLocalEntry:
    ordinal: int
    raw_filetime_ticks: str
    unix_100ns: str
    state: str
    code: str | None
    iso_utc: str | None
    local_provenance: str = PROVENANCE

    @property
    def sort_key(self):
        return int(self.unix_100ns) if self.state == 'resolved' else UNKNOWN_TIME

    @property
    def raw_filetime_le(self):
        return int(self.raw_filetime_ticks).to_bytes(8,'little')


@dataclass(frozen=True, slots=True)
class EnhancedHistoryHeader:
    source_revision: int
    effective_evidence_sha256: str
    display_sha256: str
    store_key: str
    local_entry_count: int | None
    local_vector_sha256: str | None
    local_provenance: str | None
    label_kind: str
    label: str
    label_truncated: bool


def _hex(value):
    return type(value) is str and len(value)==64 and all(c in '0123456789abcdef' for c in value)


def _signed(value,minimum,maximum):
    if type(value) is not str or not 1<=len(value)<=21:
        raise EnhancedProjectionInvalid()
    try:
        number=int(value)
    except ValueError:
        raise EnhancedProjectionInvalid() from None
    if str(number)!=value or not minimum<=number<=maximum:
        raise EnhancedProjectionInvalid()
    return number


def _dump(value,limit):
    payload=json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    if not 1<=len(payload)<=limit:
        raise EnhancedProjectionInvalid()
    return payload


def _load(payload,limit):
    if type(payload) is not bytes or not 1<=len(payload)<=limit:
        raise EnhancedProjectionInvalid()
    try:
        return json.loads(payload.decode('ascii'))
    except (ValueError,UnicodeError,RecursionError):
        raise EnhancedProjectionInvalid() from None


def _entry(ticks,ordinal):
    if (type(ticks) is not int or not 0<=ticks<2**64 or type(ordinal) is not int
            or not 0<=ordinal<MAX_TIMESTAMPS):
        raise EnhancedProjectionInvalid()
    item=_timestamp(ticks,'local_filetime_ticks',ordinal)
    return EnhancedLocalEntry(ordinal,item.raw_filetime_ticks,item.unix_100ns,
        item.state,item.code,item.iso_utc)


def encode_local_entry(entry):
    if type(entry) is not EnhancedLocalEntry:
        raise EnhancedProjectionInvalid()
    raw=_signed(entry.raw_filetime_ticks,0,2**64-1)
    if entry!=_entry(raw,entry.ordinal):
        raise EnhancedProjectionInvalid()
    return _dump((ENTRY_VERSION,entry.ordinal,entry.raw_filetime_ticks,entry.unix_100ns,
        entry.state,entry.code,entry.iso_utc,entry.local_provenance),MAX_ENTRY_BYTES)


def decode_local_entry(payload):
    values=_load(payload,MAX_ENTRY_BYTES)
    if type(values) is not list or len(values)!=8 or values[0]!=ENTRY_VERSION:
        raise EnhancedProjectionInvalid()
    result=EnhancedLocalEntry(*values[1:])
    if encode_local_entry(result)!=payload:
        raise EnhancedProjectionInvalid()
    return result


def iter_local_entry_projections(effective_bytes):
    """One decoded compact vector and one projection retained; no normalized list."""
    effective=evidence.decode_enhanced_effective(effective_bytes)
    if effective.state=='unavailable':
        return
    for ordinal,ticks in enumerate(effective.local_filetime_ticks):
        yield _entry(ticks,ordinal)


def build_enhanced_history_header(*,effective_bytes,display_bytes,source_revision):
    if (type(source_revision) is not int or not 1<=source_revision<=_MAX
            or type(display_bytes) is not bytes or not 1<=len(display_bytes)<=evidence.MAX_DISPLAY_BYTES):
        raise EnhancedProjectionInvalid()
    effective=evidence.decode_enhanced_effective(effective_bytes)
    display=evidence.decode_enhanced_display(display_bytes)
    if display.store_key!=effective.store_key:
        raise EnhancedProjectionInvalid()
    available=effective.state=='available'
    return EnhancedHistoryHeader(source_revision,hashlib.sha256(effective_bytes).hexdigest(),
        hashlib.sha256(display_bytes).hexdigest(),str(effective.store_key),
        len(effective.local_filetime_ticks) if available else None,
        evidence.enhanced_local_vector_digest(effective) if available else None,
        PROVENANCE if available else None,display.label_kind,display.label,display.truncated)


def encode_enhanced_history_header(header):
    if (type(header) is not EnhancedHistoryHeader or type(header.source_revision) is not int
            or not 1<=header.source_revision<=_MAX or not _hex(header.effective_evidence_sha256)
            or not _hex(header.display_sha256)):
        raise EnhancedProjectionInvalid()
    _signed(header.store_key,-2**63,2**63-1)
    display=evidence.EnhancedDisplayEvidence(int(header.store_key),header.label_kind,
        header.label,header.label_truncated)
    evidence.encode_enhanced_display(display)
    if header.local_entry_count is None:
        if header.local_vector_sha256 is not None or header.local_provenance is not None:
            raise EnhancedProjectionInvalid()
    elif (type(header.local_entry_count) is not int or not 0<=header.local_entry_count<=MAX_TIMESTAMPS
            or not _hex(header.local_vector_sha256) or header.local_provenance!=PROVENANCE):
        raise EnhancedProjectionInvalid()
    return _dump((HEADER_VERSION,header.source_revision,header.effective_evidence_sha256,
        header.display_sha256,header.store_key,header.local_entry_count,
        header.local_vector_sha256,header.local_provenance,header.label_kind,header.label,
        header.label_truncated),MAX_HEADER_BYTES)


def decode_enhanced_history_header(payload):
    values=_load(payload,MAX_HEADER_BYTES)
    if type(values) is not list or len(values)!=11 or values[0]!=HEADER_VERSION:
        raise EnhancedProjectionInvalid()
    result=EnhancedHistoryHeader(*values[1:])
    if encode_enhanced_history_header(result)!=payload:
        raise EnhancedProjectionInvalid()
    return result


def projection_size_summary(*,effective_bytes,display_bytes,source_revision):
    """Exact encoded header and total current child charge, never an estimate."""
    header=build_enhanced_history_header(effective_bytes=effective_bytes,
        display_bytes=display_bytes,source_revision=source_revision)
    header_size=len(encode_enhanced_history_header(header))
    child_bytes=0
    count=0
    for entry in iter_local_entry_projections(effective_bytes):
        child_bytes+=len(encode_local_entry(entry))
        count+=1
    if count!=(header.local_entry_count or 0):
        raise EnhancedProjectionInvalid()
    return header_size,child_bytes,count


def projection_phase_bytes(effective_length,display_length):
    if any(type(value) is not int or not 1<=value<=evidence.MAX_EVIDENCE_BYTES
           for value in (effective_length,display_length)):
        raise EnhancedProjectionInvalid()
    # Reuse the genuine codec's conservative byte/text/JSON/tuple quote; do not
    # undercut its decoder admission. Add bounded 128-row SQL frame/results and
    # conversion/hash control while the effective vector remains retained.
    # This is logical admission, not a measured heap multiplier or RSS proof.
    return evidence.codec_phase_bytes(effective_length,display_length)+8*262144+1048576
