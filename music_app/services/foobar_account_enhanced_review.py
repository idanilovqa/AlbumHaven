"""Account-owned review of a caller-owned finalized Enhanced SQLite upload.

Read-only evidence review, not import preparation, persistence or event history.
The worker owns the private artifact and its lifetime. Never pass a live source.
"""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from uuid import UUID

from .foobar_account_authority import current_foobar_account_transaction
from .foobar_account_source_postgres import SourceUnavailable, SourceStale, _query
from .foobar_enhanced_record_decoder import (
    ENHANCED_PLAYCOUNT_STORE_GUID, EnhancedRecordDecodeResult, MAX_TIMESTAMPS,
)
from .foobar_enhanced_sqlite_reader import (
    open_enhanced_sqlite_snapshot, StoreRecord, FilenameAliasPage, StoreReadSummary,
)
from .foobar_enhanced_timestamp_normalization import (
    iter_enhanced_record_timestamp_chunks, EnhancedTimestampChunk,
    EnhancedTimestampStreamSummary, MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES,
    enhanced_timestamp_total_emitted_logical_charge,
)

VERSION = 'foobar_enhanced_review_v1'
PAGE_SIZE = 20
MAX_SOURCE_RECORDS = 100000
# Logical admission, not RSS proof: reader page up to128*16384 encoded alias
# bytes, Unicode expansion/transient encoding, SQLite value, decoded uint64
# tuples, one normalized chunk, fixed DTO/DB/hash scratch. No file-sized buffer.
REVIEW_PHASE_BYTES = 16 * 1024 * 1024
DECODED_RECORD_LOGICAL_BYTES = 512 + MAX_TIMESTAMPS * 64
NORMALIZED_CHUNK_LOGICAL_BYTES = MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES
_MAX = 9223372036854775807
_LOCK_SQL = """with f as materialized(select convert_from(%b::bytea,'UTF8')::jsonb j)
select s.revision,s.current_generation,s.retired_through
from integration.foobar_import_streams_v2 s
where s.account_id=(select (j->>0)::bigint from f)
and s.source_ref=(select (j->>1)::uuid from f) for share of s"""


class EnhancedReviewInvalid(ValueError):
    pass


class EnhancedReviewRejected(SourceUnavailable):
    def __init__(self, reason):
        self.reason = reason
        super().__init__()


@dataclass(frozen=True, slots=True)
class EnhancedReviewCommand:
    source_ref: str
    generation: int
    expected_revision: int
    request_ref: str
    offset: int = 0
    previous_upload_sha256: str | None = None


@dataclass(frozen=True, slots=True)
class EnhancedRecordReview:
    ordinal: int
    store_key: str
    data_state: str
    mapping_state: str
    aliases: int
    local_entries: int | None
    cached_lastfm_entries: int | None
    unresolved_local: int | None
    unresolved_cached_lastfm: int | None
    local_provenance: str | None
    diagnostics: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class EnhancedReviewResult:
    contract_version: str
    command: EnhancedReviewCommand
    upload_sha256: str
    evidence_sha256: str
    records: int
    aliases: int
    parsed_records: int
    unavailable_records: int
    local_entries: int
    cached_lastfm_entries: int
    unresolved_local: int
    unresolved_cached_lastfm: int
    payload_bytes: int
    alias_bytes: int
    items: tuple[EnhancedRecordReview, ...]
    next_offset: int | None


def _uuid(value):
    try:
        return type(value) is str and len(value) == 36 and str(UUID(value)) == value
    except ValueError:
        return False


def _hex(value):
    return type(value) is str and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def validate_enhanced_review_command(command):
    if (type(command) is not EnhancedReviewCommand or not _uuid(command.source_ref)
            or not _uuid(command.request_ref) or type(command.generation) is not int
            or not 1 <= command.generation <= 2147483647
            or type(command.expected_revision) is not int or not 0 <= command.expected_revision <= _MAX
            or type(command.offset) is not int or not 0 <= command.offset < MAX_SOURCE_RECORDS
            or command.offset % PAGE_SIZE
            or (command.offset == 0 and command.previous_upload_sha256 is not None)
            or (command.offset > 0 and not _hex(command.previous_upload_sha256))):
        raise EnhancedReviewInvalid()


def _guard(database_url, context, command, constraints):
    with current_foobar_account_transaction(database_url, context, constraints=constraints) as (connection, live, now):
        frame = json.dumps((live.actor.account_id, command.source_ref), separators=(',', ':')).encode('ascii')
        rows = _query(connection, _LOCK_SQL, frame, maximum=1)
        if not rows:
            raise SourceStale()
        if (len(rows) != 1 or type(rows[0]) is not dict
                or set(rows[0]) != {'revision', 'current_generation', 'retired_through'}
                or any(type(value) is not int for value in rows[0].values())):
            raise SourceUnavailable()
        row = rows[0]
        if (not 0 <= row['revision'] <= _MAX
                or not 0 <= row['retired_through'] < row['current_generation'] <= 2147483647):
            raise SourceUnavailable()
        if (row['revision'] != command.expected_revision
                or row['current_generation'] != command.generation):
            raise SourceStale()
        return live.actor.account_id, live.actor.session_id


def _digest(digest, value):
    encoded = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
    digest.update(len(encoded).to_bytes(8, 'big'))
    digest.update(encoded)


def _check_cancel(cancelled):
    if cancelled():
        raise EnhancedReviewRejected('cancelled')


def _timestamps(record, digest, cancelled):
    decoded = EnhancedRecordDecodeResult('foobar_enhanced_playcount_record_v1', 'parsed', record, ())
    expected_charge = enhanced_timestamp_total_emitted_logical_charge(decoded)
    stream = iter_enhanced_record_timestamp_chunks(decoded)
    counts = [0, 0]
    unresolved = [0, 0]
    chunks = 0
    summary = None
    try:
        while True:
            _check_cancel(cancelled)
            try:
                part = next(stream)
            except StopIteration:
                break
            if summary is not None:
                raise SourceUnavailable()
            if type(part) is EnhancedTimestampStreamSummary:
                summary = part
            elif type(part) is EnhancedTimestampChunk:
                lane = {'local_filetime_ticks': 0, 'cached_lastfm_filetime_ticks': 1}.get(part.source_field)
                if (lane is None or not 1 <= len(part.timestamps) <= 128
                        or part.start_index != counts[lane]
                        or (lane == 0 and counts[1])):
                    raise SourceUnavailable()
                chunks += 1
                for item in part.timestamps:
                    if item.source_field != part.source_field or item.source_index != counts[lane]:
                        raise SourceUnavailable()
                    counts[lane] += 1
                    unresolved[lane] += item.state != 'resolved'
                    _digest(digest, ('timestamp', item.source_field, item.source_index,
                        item.raw_filetime_ticks, item.unix_100ns, item.state, item.code,
                        item.iso_utc, item.precision, item.timezone_provenance, item.conversion))
                # Do not retain the previous expanded chunk while requesting next.
                item = None
            else:
                raise SourceUnavailable()
            part = None
        if (summary is None or summary.local_timestamp_count != counts[0]
                or summary.cached_lastfm_timestamp_count != counts[1]
                or summary.chunk_count != chunks
                or summary.total_emitted_logical_charge_bytes != expected_charge
                or counts != [len(record.local_filetime_ticks), len(record.cached_lastfm_filetime_ticks)]):
            raise SourceUnavailable()
        return counts, unresolved
    finally:
        stream.close()


def review_enhanced_artifact(database_url, context, command, *, path, upload_sha256,
        logical_capacity_bytes, cancelled, constraints=None):
    """Full validation before publication; later pages require identical upload.

    Caller supplies a server-computed upload SHA and exclusive private Path, not
    client assertions of integrity. Each explicit page rescans the artifact.
    No transaction spans filesystem work. Fresh account/source checks bracket it.
    """
    validate_enhanced_review_command(command)
    if (not isinstance(path, Path) or not _hex(upload_sha256) or not callable(cancelled)
            or type(logical_capacity_bytes) is not int or logical_capacity_bytes < REVIEW_PHASE_BYTES):
        raise EnhancedReviewInvalid()
    if command.offset and command.previous_upload_sha256 != upload_sha256:
        raise SourceStale()
    identity = _guard(database_url, context, command, constraints)
    digest = hashlib.sha256(b'foobar-enhanced-review-evidence-v1\x00')
    _digest(digest, (identity, command.source_ref, command.generation, command.expected_revision, upload_sha256))
    rows = []
    records = aliases = parsed = local = cached = unresolved_local = unresolved_cached = 0
    pending = None
    record_aliases = 0
    alias_final = False

    def finish_record():
        if pending is None:
            return
        if (pending.mapping_state == 'mapped') != (record_aliases > 0) or (record_aliases and not alias_final):
            raise SourceUnavailable()
        if command.offset <= records - 1 < command.offset + PAGE_SIZE:
            rows.append(EnhancedRecordReview(records - 1, str(pending.identity.key),
                pending.data_state, pending.mapping_state, record_aliases,
                counts[0] if counts else None, counts[1] if counts else None,
                unresolved[0] if unresolved else None, unresolved[1] if unresolved else None,
                pending.record.local_provenance if pending.record else None,
                tuple((item.category, item.code) for item in pending.diagnostics)))

    try:
        with open_enhanced_sqlite_snapshot(path, cancelled=cancelled) as stream:
            while True:
                _check_cancel(cancelled)
                try:
                    value = next(stream)
                except StopIteration as stop:
                    terminal = stop.value
                    break
                if type(value) is StoreRecord:
                    finish_record()
                    if records >= MAX_SOURCE_RECORDS:
                        raise EnhancedReviewRejected('source_record_limit_exceeded')
                    if (value.identity.store_guid != ENHANCED_PLAYCOUNT_STORE_GUID
                            or type(value.identity.key) is not int or not -2**63 <= value.identity.key < 2**63):
                        raise SourceUnavailable()
                    records += 1
                    pending, record_aliases, alias_final = value, 0, False
                    _digest(digest, ('record', value.identity.store_guid, str(value.identity.key),
                        value.data_state, value.mapping_state,
                        tuple((item.category, item.code) for item in value.diagnostics)))
                    counts = unresolved = None
                    if value.data_state == 'parsed':
                        if value.record is None:
                            raise SourceUnavailable()
                        counts, unresolved = _timestamps(value.record, digest, cancelled)
                        parsed += 1
                        local += counts[0]
                        cached += counts[1]
                        unresolved_local += unresolved[0]
                        unresolved_cached += unresolved[1]
                    elif value.record is not None:
                        raise SourceUnavailable()
                elif type(value) is FilenameAliasPage:
                    if (pending is None or value.identity != pending.identity or alias_final
                            or not 1 <= len(value.filenames) <= 128):
                        raise SourceUnavailable()
                    for filename in value.filenames:
                        _digest(digest, ('alias', filename))
                    aliases += len(value.filenames)
                    record_aliases += len(value.filenames)
                    alias_final = value.final
                else:
                    raise SourceUnavailable()
                value = None
            finish_record()
        if type(terminal) is not StoreReadSummary or terminal.status != 'complete':
            raise EnhancedReviewRejected(terminal.reason if type(terminal) is StoreReadSummary else 'incomplete_reader')
        if terminal.records != records or terminal.aliases != aliases:
            raise SourceUnavailable()
        if command.offset and command.offset >= records:
            raise EnhancedReviewInvalid()
        _check_cancel(cancelled)
        if _guard(database_url, context, command, constraints) != identity:
            raise SourceStale()
        return EnhancedReviewResult(VERSION, command, upload_sha256, digest.hexdigest(), records,
            aliases, parsed, records - parsed, local, cached, unresolved_local, unresolved_cached,
            terminal.payload_bytes, terminal.alias_bytes, tuple(rows),
            command.offset + PAGE_SIZE if command.offset + PAGE_SIZE < records else None)
    except (EnhancedReviewInvalid, EnhancedReviewRejected, SourceStale, SourceUnavailable):
        raise
    except Exception:
        raise SourceUnavailable() from None


def validate_enhanced_review_context(database_url, context, command, *, constraints=None):
    """Short genuine account/source check before accepting expensive raw intake.

    This does not mint authority for later use. Full review independently repeats
    the same check before and after artifact scanning using the current session.
    """
    validate_enhanced_review_command(command)
    _guard(database_url, context, command, constraints)
