"""Exact calendar normalization of decoded Enhanced v1 timestamp evidence.

Resolution establishes a numeric UTC instant, never an independently observed
play. Local history remains incomplete and possibly seeded. Cached Last.fm
values stay in their own lane and cannot become Foobar-local history.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .foobar_enhanced_record_decoder import (
    EnhancedRecord, EnhancedRecordDecodeResult, MAX_TIMESTAMPS,
    filetime_to_unix_100ns,
)


_UINT64_MAX = 0xFFFFFFFFFFFFFFFF
# Last 100-ns tick of 9999-12-31 UTC, the supported display calendar boundary.
_MAX_CALENDAR_FILETIME = 2_650_467_743_999_999_999
_UNIX_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class TimestampNormalizationError(ValueError):
    """Invalid decoder evidence; no source values appear in the exception."""

    code = "invalid_enhanced_timestamp_input"

    def __init__(self):
        super().__init__("Invalid Enhanced timestamp evidence.")


@dataclass(frozen=True, slots=True)
class TimestampEvidence:
    source_field: str
    source_index: int
    raw_filetime_ticks: str
    unix_100ns: str
    state: str
    code: str | None
    iso_utc: str | None
    precision: str = "100ns"
    timezone_provenance: str = "filetime_utc"
    conversion: str = "filetime_1601_to_unix_1970_exact"


@dataclass(frozen=True, slots=True)
class EnhancedTimestampEvidence:
    contract_version: str
    record_version: int
    local_provenance: str
    local_timestamps: tuple[TimestampEvidence, ...]
    cached_lastfm_timestamps: tuple[TimestampEvidence, ...]


def _valid(decoded: object) -> bool:
    if type(decoded) is not EnhancedRecordDecodeResult:
        return False
    if (type(decoded.contract_version) is not str
            or decoded.contract_version != "foobar_enhanced_playcount_record_v1"
            or type(decoded.status) is not str or decoded.status != "parsed"
            or type(decoded.diagnostics) is not tuple or decoded.diagnostics):
        return False
    record = decoded.record
    if type(record) is not EnhancedRecord:
        return False
    if (type(record.record_version) is not int or record.record_version != 1
            or type(record.local_provenance) is not str
            or record.local_provenance != "incomplete_possibly_seeded"):
        return False
    local = record.local_filetime_ticks
    cached = record.cached_lastfm_filetime_ticks
    if type(local) is not tuple or type(cached) is not tuple:
        return False
    if len(local) > MAX_TIMESTAMPS or len(cached) > MAX_TIMESTAMPS - len(local):
        return False
    return all(type(ticks) is int and 0 <= ticks <= _UINT64_MAX
               for lane in (local, cached) for ticks in lane)


def _timestamp(ticks: int, field: str, index: int) -> TimestampEvidence:
    unix_ticks = filetime_to_unix_100ns(ticks)
    code = None
    if ticks == 0:
        # Retain zero; do not guess whether it represents missing source data.
        code = "zero_or_unavailable"
    elif ticks == _UINT64_MAX:
        code = "sentinel_like"
    elif ticks > _MAX_CALENDAR_FILETIME:
        code = "outside_supported_calendar"
    iso = None
    if code is None:
        seconds, fraction = divmod(unix_ticks, 10_000_000)
        instant = _UNIX_EPOCH + timedelta(seconds=seconds)
        # Explicit seven-digit fraction retains 100 ns, unlike datetime's
        # microsecond field. Integer divmod is floor-based before 1970 too.
        iso = (f"{instant.year:04d}-{instant.month:02d}-{instant.day:02d}T"
               f"{instant.hour:02d}:{instant.minute:02d}:{instant.second:02d}."
               f"{fraction:07d}Z")
    return TimestampEvidence(
        field, index, str(ticks), str(unix_ticks),
        "resolved" if code is None else "unresolved", code, iso,
    )


def normalize_enhanced_record_timestamps(
    decoded: EnhancedRecordDecodeResult,
) -> EnhancedTimestampEvidence:
    """Normalize accepted decoder evidence atomically, preserving both lanes.

    Decimal strings are deliberate: JSON/JavaScript Number cannot represent
    arbitrary 100-ns values exactly. Raw and converted ticks survive unresolved
    calendar states. The caller must retain the source record identity beside
    this result. Source indexes identify array positions, not deduplicated plays.
    This function neither supplies lifetime totals nor constructs HistoryInput.
    """
    try:
        valid = _valid(decoded)
    except AttributeError:
        valid = False
    if not valid:
        raise TimestampNormalizationError()
    record = decoded.record
    return EnhancedTimestampEvidence(
        "foobar_enhanced_timestamp_evidence_v1", 1, record.local_provenance,
        tuple(_timestamp(ticks, "local_filetime_ticks", index)
              for index, ticks in enumerate(record.local_filetime_ticks)),
        tuple(_timestamp(ticks, "cached_lastfm_filetime_ticks", index)
              for index, ticks in enumerate(record.cached_lastfm_filetime_ticks)),
    )


# Additive streaming API. The original normalization API above is unchanged.
from collections.abc import Iterator


MAX_TIMESTAMP_CHUNK_ENTRIES = 128
# Logical admission charges for this adapter's expanded evidence, NOT physical
# Python allocation sizes, RSS measurements, transport quotas or new authority.
TIMESTAMP_ENTRY_LOGICAL_CHARGE_BYTES = 512
TIMESTAMP_CHUNK_LOGICAL_CHARGE_BYTES = 512
TIMESTAMP_SUMMARY_LOGICAL_CHARGE_BYTES = 512
MAX_TIMESTAMP_CHUNK_LOGICAL_CHARGE_BYTES = (
    MAX_TIMESTAMP_CHUNK_ENTRIES * TIMESTAMP_ENTRY_LOGICAL_CHARGE_BYTES
    + TIMESTAMP_CHUNK_LOGICAL_CHARGE_BYTES
)
MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES = max(
    MAX_TIMESTAMP_CHUNK_LOGICAL_CHARGE_BYTES,
    TIMESTAMP_SUMMARY_LOGICAL_CHARGE_BYTES,
)


@dataclass(frozen=True, slots=True)
class EnhancedTimestampChunk:
    contract_version: str
    record_version: int
    local_provenance: str
    source_field: str
    start_index: int
    timestamps: tuple[TimestampEvidence, ...]


@dataclass(frozen=True, slots=True)
class EnhancedTimestampStreamSummary:
    """Terminal conversion evidence, not complete history or source authority."""

    contract_version: str
    record_version: int
    local_provenance: str
    local_timestamp_count: int
    cached_lastfm_timestamp_count: int
    chunk_count: int
    total_emitted_logical_charge_bytes: int


def _validated_enhanced_stream_record(
    decoded: EnhancedRecordDecodeResult,
) -> EnhancedRecord:
    # Reuse the existing strict validator, including a full scan of both lanes,
    # before constructing any expanded TimestampEvidence or yielding anything.
    try:
        valid = _valid(decoded)
    except AttributeError:
        valid = False
    if not valid:
        raise TimestampNormalizationError()
    return decoded.record


def _enhanced_timestamp_total_emitted_charge(record: EnhancedRecord) -> int:
    local_count = len(record.local_filetime_ticks)
    cached_count = len(record.cached_lastfm_filetime_ticks)
    chunk_count = sum(
        (count + MAX_TIMESTAMP_CHUNK_ENTRIES - 1) // MAX_TIMESTAMP_CHUNK_ENTRIES
        for count in (local_count, cached_count)
    )
    return (
        (local_count + cached_count) * TIMESTAMP_ENTRY_LOGICAL_CHARGE_BYTES
        + chunk_count * TIMESTAMP_CHUNK_LOGICAL_CHARGE_BYTES
        + TIMESTAMP_SUMMARY_LOGICAL_CHARGE_BYTES
    )


def enhanced_timestamp_total_emitted_logical_charge(
    decoded: EnhancedRecordDecodeResult,
) -> int:
    """Validate and quote total emitted logical charge without expanding input.

    Charge both lanes, unresolved values, duplicates and the terminal summary.
    This is full conversion work/output charge, NOT simultaneous retention.
    A caller can check it against an existing applicable output/work quota, but
    must not relabel it resident memory. For one-at-a-time retention, use
    MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES, separately from existing
    decoded-record and reader accounting. Neither value enforces/raises a quota.
    Source identity and caller-owned wrapping are outside these normalization-
    only charges and remain subject to existing separate accounting rules.
    """
    return _enhanced_timestamp_total_emitted_charge(
        _validated_enhanced_stream_record(decoded),
    )


def iter_enhanced_record_timestamp_chunks(
    decoded: EnhancedRecordDecodeResult,
) -> Iterator[EnhancedTimestampChunk | EnhancedTimestampStreamSummary]:
    """Yield <=128-entry single-lane chunks, then exactly one terminal summary.

    Validation happens on first advancement, before ANY yield, and scans both
    complete raw lanes. Local chunks precede cached Last.fm chunks. Empty lanes
    emit no chunks; even two empty lanes emit a summary with zero entry counts.
    Source indexes remain absolute within their original lane, never chunk-local.

    Only receipt of the terminal summary establishes full numeric conversion of
    this one accepted record. Stopping/closing early, an exception, or counting
    data chunks alone does not. Conversion is not evidence of complete history,
    lifetime plays, genuine event membership, source authority or persistence.

    No previous expanded chunk is retained in this generator's local variables.
    To retain at most 128 expanded entries end-to-end, the consumer MUST finish
    and release a chunk and all entry references before requesting the next;
    do not materialize this iterator or accumulate chunk/entry references.
    The accepted decoded integer tuples remain resident. No physical/RSS bound
    is asserted, and ordinary caller variables can retain earlier yields.
    """
    record = _validated_enhanced_stream_record(decoded)
    total_emitted_charge = _enhanced_timestamp_total_emitted_charge(record)
    chunk_count = 0
    for field, ticks in (
        ("local_filetime_ticks", record.local_filetime_ticks),
        ("cached_lastfm_filetime_ticks", record.cached_lastfm_filetime_ticks),
    ):
        for start in range(0, len(ticks), MAX_TIMESTAMP_CHUNK_ENTRIES):
            # Build only this chunk. Indexing avoids copying/slicing the raw lane;
            # yielding the constructor directly avoids a retained prior chunk.
            yield EnhancedTimestampChunk(
                "foobar_enhanced_timestamp_chunks_v1", record.record_version,
                record.local_provenance, field, start,
                tuple(
                    _timestamp(ticks[index], field, index)
                    for index in range(
                        start, min(start + MAX_TIMESTAMP_CHUNK_ENTRIES, len(ticks)),
                    )
                ),
            )
            chunk_count += 1
    yield EnhancedTimestampStreamSummary(
        "foobar_enhanced_timestamp_summary_v1", record.record_version,
        record.local_provenance, len(record.local_filetime_ticks),
        len(record.cached_lastfm_filetime_ticks), chunk_count, total_emitted_charge,
    )
