"""Pure, bounded decoding of one explicitly selected enhanced v1 record.

This is raw source evidence, not a SQLite reader or import authority. Local
timestamps may include seeded/repaired first/last boundaries; their number is
not a lifetime play count. Cached Last.fm timestamps are NEVER local evidence.
The byte layout is pinned to foo_enhanced_playcount commit
b679f8725ca2ced5fdc1263cc8b3f4251676c280, src/PlayedTimes.{h,cpp}.
"""
from __future__ import annotations

from dataclasses import dataclass
from struct import Struct


ENHANCED_PLAYCOUNT_STORE_GUID = "0C1BD000-43E7-4078-B885-48EE4249DEC3"
FILETIME_UNIX_EPOCH_OFFSET = 116_444_736_000_000_000
# Application admission policy, aligned with the existing snapshot parser's
# 262,144-byte per-record budget. Neither this nor the timestamp limit is a
# universal upstream format maximum or a maximum inferred from personal data.
MAX_RECORD_BYTES = 262_144
MAX_TIMESTAMPS = (MAX_RECORD_BYTES - 16) // 8
_CONTRACT_VERSION = "foobar_enhanced_playcount_record_v1"
_HEADER = Struct("<IIIi")
_TIMESTAMP = Struct("<Q")


@dataclass(frozen=True, slots=True)
class RecordDiagnostic:
    category: str
    code: str


@dataclass(frozen=True, slots=True)
class EnhancedRecord:
    record_version: int
    local_filetime_ticks: tuple[int, ...]
    cached_lastfm_filetime_ticks: tuple[int, ...]
    local_provenance: str = "incomplete_possibly_seeded"


@dataclass(frozen=True, slots=True)
class EnhancedRecordDecodeResult:
    contract_version: str
    status: str
    record: EnhancedRecord | None
    diagnostics: tuple[RecordDiagnostic, ...]


def _rejected(category: str, code: str) -> EnhancedRecordDecodeResult:
    return EnhancedRecordDecodeResult(
        _CONTRACT_VERSION, "rejected", None, (RecordDiagnostic(category, code),),
    )


def decode_enhanced_playcount_record(
    payload: bytes, *, store_guid: str,
) -> EnhancedRecordDecodeResult:
    """Decode exact v1 bytes from a caller-verified track store, or reject.

    The required store selector prevents format guessing. The caller must
    verify where the bytes came from; this function cannot authenticate that
    claim. Do not supply standard foo_playcount, artist-index or legacy data.
    Validation is atomic: no timestamp tuple is allocated until header,
    policy bounds and exact length pass. Rejection returns no partial record.
    Success preserves unsigned integer precision, order and duplicate values
    in two distinct arrays; it does not establish timestamp/event provenance.
    """
    if type(payload) is not bytes:
        return _rejected("malformed", "invalid_payload_type")
    if type(store_guid) is not str or store_guid != ENHANCED_PLAYCOUNT_STORE_GUID:
        return _rejected("unsupported", "unsupported_store")
    if len(payload) > MAX_RECORD_BYTES:
        return _rejected("too_large", "record_too_large")
    if len(payload) < _HEADER.size:
        return _rejected("malformed", "truncated_header")
    version, local_count, lastfm_count, reserved = _HEADER.unpack_from(payload)
    if version != 1:
        return _rejected("unsupported", "unsupported_version")
    if reserved != 0:
        return _rejected("unsupported", "unsupported_reserved")
    # Check subtraction-safe count bounds before length multiplication or
    # any timestamp iteration. Python ints also avoid fixed-width overflow.
    if local_count > MAX_TIMESTAMPS or lastfm_count > MAX_TIMESTAMPS - local_count:
        return _rejected("too_large", "too_many_timestamps")
    expected_size = _HEADER.size + _TIMESTAMP.size * (local_count + lastfm_count)
    if len(payload) != expected_size:
        return _rejected("malformed", "invalid_record_length")

    local_end = _HEADER.size + _TIMESTAMP.size * local_count
    local_ticks = tuple(
        _TIMESTAMP.unpack_from(payload, offset)[0]
        for offset in range(_HEADER.size, local_end, _TIMESTAMP.size)
    )
    lastfm_ticks = tuple(
        _TIMESTAMP.unpack_from(payload, offset)[0]
        for offset in range(local_end, expected_size, _TIMESTAMP.size)
    )
    return EnhancedRecordDecodeResult(
        _CONTRACT_VERSION, "parsed",
        EnhancedRecord(version, local_ticks, lastfm_ticks), (),
    )


def filetime_to_unix_100ns(ticks: int) -> int:
    """Return exact signed 100-ns ticks since Unix epoch, not float seconds.

    Raw zero, out-of-calendar-range and sentinel-like uint64 values are not
    filtered or upgraded to genuine events. Calendar validity and provenance
    remain a caller concern. Pre-1970 values produce negative integers.
    """
    if type(ticks) is not int:
        raise TypeError("FILETIME ticks must be an integer")
    if not 0 <= ticks <= 0xFFFFFFFFFFFFFFFF:
        raise ValueError("FILETIME ticks must fit unsigned 64 bits")
    return ticks - FILETIME_UNIX_EPOCH_OFFSET
