"""Private indexed reacquisition of an exclusively staged Enhanced artifact.

No account authority is minted here. Keep this owner inside staged upload
lifetime and under the existing worker; all database authority stays in the
real import transaction. No raw file, aliases or vectors are cached by index.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
import json
import sqlite3

from . import foobar_enhanced_sqlite_reader as reader
from .foobar_enhanced_upload import EnhancedUploadArtifact
from .foobar_enhanced_source_evidence import (
    EnhancedIncomingEvidence, encode_enhanced_incoming, codec_phase_bytes,
    incoming_encode_phase_bytes,
)

MAX_INDEX_RECORDS = 100_000
MAX_WINDOW_RECORDS = 100
MAX_RECORD_ENCODED_BYTES = 4_194_304
INDEX_ENTRY_LOGICAL_BYTES = 512
INDEX_BASE_LOGICAL_BYTES = 65_536
READER_PHASE_LOGICAL_BYTES = 16_777_216
MAX_PRIVATE_PHASE_BYTES = 4_194_304


def index_retained_logical_bytes(records):
    if type(records) is not int or not 0 <= records <= MAX_INDEX_RECORDS:
        raise EnhancedRawIndexRejected('invalid_index_size')
    return INDEX_BASE_LOGICAL_BYTES + INDEX_ENTRY_LOGICAL_BYTES * records


class EnhancedRawIndexRejected(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class _Entry:
    key: int
    data_state: str
    raw_reason: str | None
    raw_size: int | None
    raw_sha256: str | None
    alias_sha256: str
    aliases: int


@dataclass(frozen=True, slots=True)
class EnhancedRawWindowSummary:
    upload_sha256: str
    start: int
    end: int
    records: int
    proof_sha256: str


@dataclass(frozen=True, slots=True)
class EnhancedAliasPage:
    record_ordinal: int
    store_key: int
    filenames: tuple[str, ...]
    final: bool


@dataclass(frozen=True, slots=True)
class EnhancedAliasSummary:
    upload_sha256: str
    records: int
    aliases: int
    proof_sha256: str


def _hash_alias(digest, alias):
    encoded = alias.encode('utf-8', 'strict')
    digest.update(len(encoded).to_bytes(8, 'big'))
    digest.update(encoded)


def _fingerprint(path):
    value = path.stat()
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def _open_connection(uri, budget):
    connection = sqlite3.connect(uri, uri=True, timeout=0.0, isolation_level=None,
        detect_types=0, cached_statements=0)
    try:
        if not hasattr(connection, 'setlimit'):
            raise EnhancedRawIndexRejected('sqlite_safety_unavailable')
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, reader._MAX_SQLITE_VALUE_BYTES)
        connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 65_536)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        connection.set_authorizer(reader._authorizer)
        connection.set_progress_handler(budget.progress, 1000)
        reader._one(connection, 'PRAGMA query_only=ON')
        reader._one(connection, 'PRAGMA trusted_schema=OFF')
        if (reader._one(connection, 'PRAGMA query_only') != (1,)
                or reader._one(connection, 'PRAGMA trusted_schema') != (0,)):
            raise EnhancedRawIndexRejected('sqlite_safety_unavailable')
        reader._one(connection, 'BEGIN')
        reader._validate_schema(connection)
        return connection
    except BaseException:
        connection.close()
        raise


def _raw(connection, budget, key, *, private_capacity_bytes=None):
    budget.check()
    row = reader._one(connection, f"SELECT typeof(value), CASE WHEN typeof(value)='blob' "
        f"THEN length(value) END FROM main.{reader._DATA} WHERE key=?", (key,))
    kind, size = (None, None) if row is None else row
    retained_length = size if kind == 'blob' and type(size) is int and 0 <= size <= reader.MAX_RECORD_BYTES else 0
    if (private_capacity_bytes is not None
            and incoming_encode_phase_bytes(retained_raw_length=retained_length,
                alias_count=0, alias_utf8_bytes=0) > private_capacity_bytes):
        raise EnhancedRawIndexRejected('private_phase_capacity_exceeded')
    record = reader._record(connection, budget, key, kind, size)
    raw = None
    if kind == 'blob' and type(size) is int and 0 <= size <= reader.MAX_RECORD_BYTES:
        row = reader._one(connection, f"SELECT value FROM main.{reader._DATA} WHERE key=? "
            "AND typeof(value)='blob' AND length(value)=? AND length(value)<=?",
            (key, size, reader.MAX_RECORD_BYTES))
        if row is None or type(row[0]) is not bytes or len(row[0]) != size:
            raise EnhancedRawIndexRejected('raw_record_changed')
        raw = row[0]
    reason = None if record.data_state == 'parsed' else record.diagnostics[0].code
    return record, raw, size, reason, sha256(raw).hexdigest() if raw is not None else None


class EnhancedRawIndex:
    """Private context-bound index. A window is one-shot; consume its terminal.

    Release each yielded record before requesting another. Caller retention is
    not free: only one expanded record is admitted here, never a100-row tuple.
    """
    def __init__(self, token, *, artifact, connection, entries, fingerprint, encoding, cancelled,
            logical_capacity_bytes):
        if token is not _TOKEN:
            raise EnhancedRawIndexRejected('private_owner_required')
        self._artifact = artifact
        self._connection = connection
        self._entries = entries
        self._fingerprint = fingerprint
        self._encoding = encoding
        self._cancelled = cancelled
        self._capacity = logical_capacity_bytes
        self._active = False
        self._closed = False
        self._matching_cache = None

    @property
    def records(self):
        self._check()
        return len(self._entries)

    @property
    def upload_sha256(self):
        self._check()
        return self._artifact.sha256

    def _check(self):
        if self._closed or self._cancelled() or _fingerprint(self._artifact.path) != self._fingerprint:
            raise EnhancedRawIndexRejected('artifact_unavailable_or_changed')

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            self._connection.close()
        finally:
            self._entries.clear()
            self._matching_cache = None
            self._connection = self._artifact = None

    def alias_pages(self):
        """One bounded alias-only pass for genuine inventory matching.

        No raw timestamp record is decoded or retained. Release each page
        before advancing and require the generator's terminal summary. The
        existing reader phase admits one bounded alias page; caller-owned
        inventory and candidate scalars require separate intake admission.
        This data proof conveys no account, library or native authority.
        """
        self._check()
        if (self._active or index_retained_logical_bytes(len(self._entries))
                + READER_PHASE_LOGICAL_BYTES > self._capacity):
            raise EnhancedRawIndexRejected('invalid_alias_pass')
        return self._alias_pages()

    def _alias_pages(self):
        self._check()
        if self._active:
            raise EnhancedRawIndexRejected('window_already_active')
        budget = reader._Budget(self._cancelled)
        self._connection.set_progress_handler(budget.progress, 1000)
        proof = sha256(b'foobar-enhanced-alias-pass-v1\x00')
        total = 0
        self._active = True
        try:
            for ordinal, entry in enumerate(self._entries):
                self._check()
                identity = reader.StoreIdentity(reader.ENHANCED_PLAYCOUNT_STORE_GUID, entry.key)
                digest = sha256()
                count = 0
                final = False
                stream = reader._aliases(self._connection, budget, identity, self._encoding)
                try:
                    for page in stream:
                        if final or page.identity != identity:
                            raise EnhancedRawIndexRejected('alias_identity_changed')
                        for alias in page.filenames:
                            _hash_alias(digest, alias)
                        count += len(page.filenames)
                        final = page.final
                        self._check()
                        yield EnhancedAliasPage(ordinal, entry.key, page.filenames, final)
                        page = None
                finally:
                    stream.close()
                if (count != entry.aliases or count and not final
                        or digest.hexdigest() != entry.alias_sha256):
                    raise EnhancedRawIndexRejected('alias_record_changed')
                if not count:
                    yield EnhancedAliasPage(ordinal, entry.key, (), True)
                proof.update(str(entry.key).encode('ascii') + b'\x00')
                proof.update(count.to_bytes(8, 'big'))
                proof.update(digest.digest())
                total += count
            budget.check()
            self._check()
            return EnhancedAliasSummary(self._artifact.sha256, len(self._entries), total,
                proof.hexdigest())
        finally:
            self._active = False

    def window(self, start, limit=MAX_WINDOW_RECORDS, *, private_capacity_bytes=MAX_PRIVATE_PHASE_BYTES):
        self._check()
        if (type(start) is not int or not 0 <= start <= len(self._entries)
                or type(limit) is not int or not 1 <= limit <= MAX_WINDOW_RECORDS
                or type(private_capacity_bytes) is not int
                or not 1 <= private_capacity_bytes <= MAX_PRIVATE_PHASE_BYTES
                or index_retained_logical_bytes(len(self._entries)) + READER_PHASE_LOGICAL_BYTES
                    + private_capacity_bytes > self._capacity
                or self._active):
            raise EnhancedRawIndexRejected('invalid_window')
        return self._window(start, min(start + limit, len(self._entries)), private_capacity_bytes)

    def _window(self, start, end, private_capacity_bytes):
        self._check()
        if self._active:
            raise EnhancedRawIndexRejected('window_already_active')
        budget = reader._Budget(self._cancelled)
        self._connection.set_progress_handler(budget.progress, 1000)
        proof = sha256(b'foobar-enhanced-raw-window-v1\x00')
        self._active = True
        try:
            for ordinal in range(start, end):
                self._check()
                entry = self._entries[ordinal]
                record, raw, size, reason, raw_hash = _raw(self._connection, budget, entry.key,
                    private_capacity_bytes=private_capacity_bytes)
                if (record.data_state, reason, size, raw_hash) != (
                        entry.data_state, entry.raw_reason, entry.raw_size, entry.raw_sha256):
                    raise EnhancedRawIndexRejected('raw_record_changed')
                alias_hash = sha256()
                aliases = []
                alias_utf8_bytes = 0
                raw_length = 0 if raw is None else len(raw)
                if incoming_encode_phase_bytes(retained_raw_length=raw_length,
                        alias_count=0, alias_utf8_bytes=0) > private_capacity_bytes:
                    raise EnhancedRawIndexRejected('private_phase_capacity_exceeded')
                # Exact empty-alias envelope length from the genuine codec;
                # each alias adds its canonical UTF-8 JSON string and comma.
                empty = EnhancedIncomingEvidence(entry.key, record.data_state, reason, raw, size,
                    (), self._artifact.sha256, ordinal)
                encoded_charge = len(encode_enhanced_incoming(empty))
                del empty
                if codec_phase_bytes(encoded_charge) > private_capacity_bytes:
                    raise EnhancedRawIndexRejected('private_phase_capacity_exceeded')
                for page in reader._aliases(self._connection, budget, record.identity, self._encoding):
                    for alias in page.filenames:
                        alias_utf8_bytes += len(alias.encode('utf-8', 'strict'))
                        if incoming_encode_phase_bytes(retained_raw_length=raw_length,
                                alias_count=len(aliases)+1, alias_utf8_bytes=alias_utf8_bytes) > private_capacity_bytes:
                            raise EnhancedRawIndexRejected('private_phase_capacity_exceeded')
                        piece = json.dumps(alias, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                        encoded_charge += len(piece) + (1 if aliases else 0)
                        if (encoded_charge > MAX_RECORD_ENCODED_BYTES
                                or codec_phase_bytes(encoded_charge) > private_capacity_bytes):
                            raise EnhancedRawIndexRejected('record_payload_limit_exceeded')
                        _hash_alias(alias_hash, alias)
                        aliases.append(alias)
                        del piece
                    page = None
                if len(aliases) != entry.aliases or alias_hash.hexdigest() != entry.alias_sha256:
                    raise EnhancedRawIndexRejected('alias_record_changed')
                value = EnhancedIncomingEvidence(entry.key, record.data_state, reason, raw, size,
                    tuple(aliases), self._artifact.sha256, ordinal)
                encoded = encode_enhanced_incoming(value)
                if len(encoded) != encoded_charge or len(encoded) > MAX_RECORD_ENCODED_BYTES:
                    raise EnhancedRawIndexRejected('record_payload_limit_exceeded')
                proof.update(len(encoded).to_bytes(8, 'big'))
                proof.update(encoded)
                del encoded, aliases, raw, record
                self._check()
                yield value
                value = None
            budget.check()
            self._check()
            return EnhancedRawWindowSummary(self._artifact.sha256, start, end, end-start, proof.hexdigest())
        finally:
            self._active = False


_TOKEN = object()


@contextmanager
def open_enhanced_raw_index(artifact, *, logical_capacity_bytes, cancelled):
    """Expose an index only after genuine full artifact validation/terminal.

    The argument must be the private staged artifact, not a user path. Its
    server hash and exclusive lifetime remain caller obligations. Stat fences
    detect changes, not authority or a cryptographic immutability guarantee.
    """
    if (type(artifact) is not EnhancedUploadArtifact or not callable(cancelled)
            or type(logical_capacity_bytes) is not int
            or logical_capacity_bytes < INDEX_BASE_LOGICAL_BYTES + READER_PHASE_LOGICAL_BYTES
            or type(artifact.sha256) is not str or len(artifact.sha256) != 64
            or any(c not in '0123456789abcdef' for c in artifact.sha256)):
        raise EnhancedRawIndexRejected('invalid_index_admission')
    fingerprint = _fingerprint(artifact.path)
    if fingerprint[2] != artifact.byte_length:
        raise EnhancedRawIndexRejected('artifact_length_changed')
    uri, encoding = reader._artifact_uri(artifact.path)
    budget = reader._Budget(cancelled)
    connection = None
    owner = None
    entries = []
    pending = None
    aliases = 0
    alias_hash = None
    alias_final = False
    mapped = False

    def finish():
        if pending is not None:
            if (mapped != (aliases > 0) or aliases and not alias_final):
                raise EnhancedRawIndexRejected('incomplete_alias_record')
            key, state, reason, size, raw_hash = pending
            if (index_retained_logical_bytes(len(entries)+1) + READER_PHASE_LOGICAL_BYTES
                    > logical_capacity_bytes):
                raise EnhancedRawIndexRejected('index_capacity_exceeded')
            entries.append(_Entry(key, state, reason, size, raw_hash, alias_hash.hexdigest(), aliases))

    try:
        connection = _open_connection(uri, budget)
        with reader.open_enhanced_sqlite_snapshot(artifact.path, cancelled=cancelled) as stream:
            while True:
                budget.check()
                if _fingerprint(artifact.path) != fingerprint:
                    raise EnhancedRawIndexRejected('artifact_changed')
                try:
                    item = next(stream)
                except StopIteration as stop:
                    terminal = stop.value
                    break
                if type(item) is reader.StoreRecord:
                    finish()
                    if len(entries) >= MAX_INDEX_RECORDS:
                        raise EnhancedRawIndexRejected('source_record_limit_exceeded')
                    if (index_retained_logical_bytes(len(entries)+1) + READER_PHASE_LOGICAL_BYTES
                            > logical_capacity_bytes):
                        raise EnhancedRawIndexRejected('index_capacity_exceeded')
                    checked, raw, size, reason, raw_hash = _raw(connection, budget, item.identity.key)
                    if checked != item:
                        raise EnhancedRawIndexRejected('record_changed')
                    pending = (item.identity.key, item.data_state, reason, size, raw_hash)
                    aliases = 0
                    alias_hash = sha256()
                    alias_final = False
                    mapped = item.mapping_state == 'mapped'
                    del checked, raw
                elif type(item) is reader.FilenameAliasPage:
                    if (pending is None or item.identity.key != pending[0] or alias_final
                            or not 1 <= len(item.filenames) <= reader.ALIAS_PAGE_SIZE):
                        raise EnhancedRawIndexRejected('alias_identity_changed')
                    for alias in item.filenames:
                        _hash_alias(alias_hash, alias)
                    aliases += len(item.filenames)
                    alias_final = item.final
                else:
                    raise EnhancedRawIndexRejected('invalid_reader_event')
                item = None
            finish()
        if (type(terminal) is not reader.StoreReadSummary or terminal.status != 'complete'
                or terminal.records != len(entries) or terminal.aliases != sum(e.aliases for e in entries)
                or _fingerprint(artifact.path) != fingerprint):
            raise EnhancedRawIndexRejected('incomplete_artifact')
        owner = EnhancedRawIndex(_TOKEN, artifact=artifact, connection=connection, entries=entries,
            fingerprint=fingerprint, encoding=encoding, cancelled=cancelled,
            logical_capacity_bytes=logical_capacity_bytes)
        connection = None
        yield owner
    finally:
        if owner is not None:
            owner.close()
        elif connection is not None:
            connection.close()
        entries.clear()
