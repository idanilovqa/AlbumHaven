"""Genuine index/codec, controlled reader and connection boundary; no SQLite IO."""
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
import struct

import pytest
from music_app.services import foobar_enhanced_raw_windows as windows
from music_app.services import foobar_enhanced_record_decoder as decoder
from music_app.services import foobar_enhanced_source_evidence as codec
from music_app.services.foobar_enhanced_upload import EnhancedUploadArtifact


class Connection:
    def __init__(self):
        self.closed = 0
        self.handlers = []

    def close(self):
        self.closed += 1

    def set_progress_handler(self, handler, frequency):
        self.handlers.append((handler, frequency))


class Boundary:
    """No forged public owner: real opener consumes actual typed reader events."""
    def __init__(self, monkeypatch, count=2):
        self.connection = Connection()
        self.events = []
        self.cancelled = False
        self.fingerprint = (1, 2, 4096, 4, 5)
        self.raw = {key: struct.pack('<IIIiQ', 1, 1, 0, 0, key+9) for key in range(count)}
        self.aliases = {key: (f'folder/song-{key}.flac',) for key in self.raw}
        self.terminal = True
        self.summary_records = count
        self.artifact = EnhancedUploadArtifact(Path('/synthetic/exclusively-staged.sqlite'), 'b'*64, 4096)
        monkeypatch.setattr(windows, '_fingerprint', lambda path: self.fingerprint)
        monkeypatch.setattr(windows.reader, '_artifact_uri', lambda path: ('synthetic-uri', 'utf-8'))
        monkeypatch.setattr(windows, '_open_connection', lambda uri, budget: self.connection)
        monkeypatch.setattr(windows.reader, 'open_enhanced_sqlite_snapshot', self.stream)
        monkeypatch.setattr(windows, '_raw', self.read_raw)
        monkeypatch.setattr(windows.reader, '_aliases', self.read_aliases)

    def record(self, key):
        decoded = decoder.decode_enhanced_playcount_record(self.raw[key], store_guid=decoder.ENHANCED_PLAYCOUNT_STORE_GUID)
        return windows.reader.StoreRecord(windows.reader.StoreIdentity(decoder.ENHANCED_PLAYCOUNT_STORE_GUID, key),
            'parsed', 'mapped' if self.aliases[key] else 'unmapped', decoded.record, ())

    def read_raw(self, connection, budget, key, **kwargs):
        budget.check()
        self.events.append(('raw', key, kwargs))
        raw = self.raw[key]
        return self.record(key), raw, len(raw), None, sha256(raw).hexdigest()

    def read_aliases(self, connection, budget, identity, encoding):
        self.events.append(('aliases', identity.key))
        values = self.aliases[identity.key]
        if values:
            yield windows.reader.FilenameAliasPage(identity, values, True)

    @contextmanager
    def stream(self, path, cancelled):
        self.events.append(('full_reader',))
        def rows():
            for key in self.raw:
                record = self.record(key)
                yield record
                if self.aliases[key]:
                    yield windows.reader.FilenameAliasPage(record.identity, self.aliases[key], True)
            self.events.append(('terminal',))
            if self.terminal:
                return windows.reader.StoreReadSummary('synthetic-reader-summary', 'complete', None,
                    self.summary_records, sum(map(len, self.aliases.values())), sum(map(len, self.raw.values())), 0)
        yield rows()

    def open(self, capacity=80_000_000):
        return windows.open_enhanced_raw_index(self.artifact, cancelled=lambda: self.cancelled,
            logical_capacity_bytes=capacity)


def consume(iterator):
    # Retain only scalar ordinals and independently calculated proof, not records.
    ordinals = []
    proof = sha256(b'foobar-enhanced-raw-window-v1\x00')
    while True:
        try:
            value = next(iterator)
        except StopIteration as stop:
            return ordinals, proof.hexdigest(), stop.value
        encoded = codec.encode_enhanced_incoming(value)
        proof.update(len(encoded).to_bytes(8, 'big'))
        proof.update(encoded)
        ordinals.append(value.record_ordinal)
        del value, encoded


def test_exposes_only_after_full_terminal_and_windows_do_not_rescan(monkeypatch):
    boundary = Boundary(monkeypatch, 3)
    with boundary.open() as owner:
        assert boundary.events[-1] == ('terminal',)
        assert owner.records == 3 and owner.upload_sha256 == 'b'*64
        first, proof, terminal = consume(owner.window(0, limit=2))
        assert first == [0, 1]
        assert terminal == windows.EnhancedRawWindowSummary('b'*64, 0, 2, 2, proof)
        second, proof, terminal = consume(owner.window(2, limit=2))
        assert second == [2] and terminal.end == 3 and terminal.proof_sha256 == proof
        assert boundary.events.count(('full_reader',)) == 1
        assert sum(e[0] == 'raw' for e in boundary.events) == 6
    assert boundary.connection.closed == 1
    with pytest.raises(windows.EnhancedRawIndexRejected):
        owner.window(0)


@pytest.mark.parametrize('failure', ['missing_terminal', 'wrong_total'])
def test_failed_terminal_never_exposes_owner_and_closes_connection(monkeypatch, failure):
    boundary = Boundary(monkeypatch)
    if failure == 'missing_terminal':
        boundary.terminal = False
    else:
        boundary.summary_records = 3
    exposed = False
    with pytest.raises(windows.EnhancedRawIndexRejected, match='incomplete_artifact'):
        with boundary.open():
            exposed = True
    assert not exposed and boundary.connection.closed == 1


def test_index_growth_rejects_before_second_payload_read(monkeypatch):
    boundary = Boundary(monkeypatch)
    capacity = windows.index_retained_logical_bytes(1) + windows.READER_PHASE_LOGICAL_BYTES
    with pytest.raises(windows.EnhancedRawIndexRejected, match='index_capacity_exceeded'):
        with boundary.open(capacity):
            pytest.fail('index must not be exposed')
    assert [e[1] for e in boundary.events if e[0] == 'raw'] == [0]
    assert boundary.connection.closed == 1


@pytest.mark.parametrize('change', ['raw', 'alias', 'fingerprint'])
def test_window_rechecks_exact_raw_alias_and_artifact_proofs(monkeypatch, change):
    boundary = Boundary(monkeypatch)
    with boundary.open() as owner:
        if change == 'raw':
            boundary.raw[0] = struct.pack('<IIIiQ', 1, 1, 0, 0, 100)
        elif change == 'alias':
            boundary.aliases[0] = ('other.flac',)
        else:
            boundary.fingerprint = (1, 2, 4096, 4, 6)
        with pytest.raises(windows.EnhancedRawIndexRejected):
            consume(owner.window(0))


def test_cancel_close_and_overlapping_windows_do_not_release_a_second_owner(monkeypatch):
    boundary = Boundary(monkeypatch)
    with boundary.open() as owner:
        active = owner.window(0)
        first = next(active)
        assert first.record_ordinal == 0
        del first
        with pytest.raises(windows.EnhancedRawIndexRejected, match='invalid_window'):
            owner.window(0)
        active.close()
        boundary.cancelled = True
        with pytest.raises(windows.EnhancedRawIndexRejected):
            owner.window(0)
        boundary.cancelled = False
        deferred = owner.window(0)
        owner.close()
        with pytest.raises(windows.EnhancedRawIndexRejected):
            next(deferred)
    assert boundary.connection.closed == 1


def test_exact_hundred_record_window_has_terminal_and_remainder(monkeypatch):
    boundary = Boundary(monkeypatch, 101)
    with boundary.open() as owner:
        ordinals, proof, terminal = consume(owner.window(0))
        assert ordinals == list(range(100)) and terminal.records == 100 and terminal.proof_sha256 == proof
        assert consume(owner.window(100))[0] == [100]
        with pytest.raises(windows.EnhancedRawIndexRejected):
            owner.window(0, limit=101)
        assert consume(owner.window(101))[0] == []


def test_real_raw_metadata_quote_precedes_decoder_and_blob_fetch(monkeypatch):
    queries = []
    def one(connection, sql, args):
        queries.append(sql)
        return ('blob', windows.reader.MAX_RECORD_BYTES)
    monkeypatch.setattr(windows.reader, '_one', one)
    monkeypatch.setattr(windows.reader, '_record', lambda *args: pytest.fail('decoder fetched before admission'))
    with pytest.raises(windows.EnhancedRawIndexRejected, match='private_phase_capacity_exceeded'):
        windows._raw(Connection(), windows.reader._Budget(lambda: False), 1,
            private_capacity_bytes=windows.MAX_PRIVATE_PHASE_BYTES)
    assert len(queries) == 1 and 'typeof(value)' in queries[0] and 'SELECT value FROM' not in queries[0]


def test_alias_quote_rejects_expansion_before_final_encoding(monkeypatch):
    boundary = Boundary(monkeypatch, 1)
    boundary.aliases[0] = ('x'*49152,)
    with boundary.open() as owner:
        with pytest.raises(windows.EnhancedRawIndexRejected, match='private_phase_capacity_exceeded'):
            consume(owner.window(0))


@pytest.mark.parametrize('records,expected', [(1,21037568), (1000,21549056), (100000,72237056)])
def test_actual_scalar_index_reader_private_budget_cases(records, expected):
    assert windows.index_retained_logical_bytes(records) + windows.READER_PHASE_LOGICAL_BYTES + windows.MAX_PRIVATE_PHASE_BYTES == expected
    assert windows.index_retained_logical_bytes(records) == 65536 + 512*records


@pytest.mark.parametrize('records', [True, -1, 100001, 1.0])
def test_index_count_bounds_are_not_coerced(records):
    with pytest.raises(windows.EnhancedRawIndexRejected):
        windows.index_retained_logical_bytes(records)


def test_real_raw_driver_returns_exact_bytes_hash_and_guarded_fetch(monkeypatch):
    raw = struct.pack('<IIIiQ', 1, 1, 0, 0, 42)
    identity = windows.reader.StoreIdentity(decoder.ENHANCED_PLAYCOUNT_STORE_GUID, -5)
    decoded = decoder.decode_enhanced_playcount_record(raw, store_guid=identity.store_guid)
    record = windows.reader.StoreRecord(identity, 'parsed', 'unmapped', decoded.record, ())
    calls = []
    def one(connection, sql, args):
        calls.append((sql, args))
        return ('blob', len(raw)) if 'typeof(value), CASE' in sql else (raw,)
    def read_record(connection, budget, key, kind, size):
        assert (key, kind, size) == (-5, 'blob', len(raw))
        calls.append(('record', key))
        return record
    monkeypatch.setattr(windows.reader, '_one', one)
    monkeypatch.setattr(windows.reader, '_record', read_record)
    result = windows._raw(Connection(), windows.reader._Budget(lambda: False), -5,
        private_capacity_bytes=windows.MAX_PRIVATE_PHASE_BYTES)
    assert result == (record, raw, len(raw), None, sha256(raw).hexdigest())
    assert calls[1] == ('record', -5)
    assert 'length(value)=?' in calls[2][0] and calls[2][1] == (-5, len(raw), 262144)


def test_late_cancel_after_last_yield_prevents_success_terminal(monkeypatch):
    boundary = Boundary(monkeypatch, 1)
    with boundary.open() as owner:
        iterator = owner.window(0)
        value = next(iterator)
        assert value.record_ordinal == 0
        del value
        boundary.cancelled = True
        # Genuine reader budget raises its controlled stop, never a successful terminal.
        with pytest.raises((windows.reader._Stopped, windows.EnhancedRawIndexRejected)):
            next(iterator)
