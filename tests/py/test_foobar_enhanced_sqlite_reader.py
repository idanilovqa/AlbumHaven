"""Synthetic coverage for a finalized enhanced-store SQLite artifact.

Fixture creation below runs only under an authorized canonical pytest run.
No personal Foobar database, application database, or live-file safety claim
belongs to these tests. SQL is confined to each test's unique tmp_path.
"""
from __future__ import annotations

from dataclasses import FrozenInstanceError
import os
from pathlib import Path
import sqlite3
from struct import pack

import pytest

from music_app.services import foobar_enhanced_sqlite_reader as reader


GUID = "0C1BD000-43E7-4078-B885-48EE4249DEC3"
TABLE = "metadb_index_0C1BD000_43E7_4078_B885_48EE4249DEC3"
SCHEMA = (
    f"CREATE TABLE {TABLE} (key INTEGER NOT NULL, "
    "filename TEXT NOT NULL UNIQUE PRIMARY KEY)",
    f"CREATE TABLE {TABLE}_data (key INTEGER NOT NULL PRIMARY KEY UNIQUE, "
    "value BLOB)",
    f"CREATE INDEX {TABLE}_key ON {TABLE}(key)",
)


def _payload(local=(), cached=(), *, version=1):
    return pack("<IIIi", version, len(local), len(cached), 0) + b"".join(
        pack("<Q", value) for value in (*local, *cached)
    )


def _snapshot(tmp_path, *, mappings=(), records=(), schema=SCHEMA,
              name="synthetic.sqlite"):
    path = tmp_path / name
    connection = sqlite3.connect(path)
    try:
        for statement in schema:
            connection.execute(statement)
        if mappings:
            connection.executemany(
                f"INSERT INTO {TABLE} (key, filename) VALUES (?, ?)", mappings,
            )
        if records:
            connection.executemany(
                f"INSERT INTO {TABLE}_data (key, value) VALUES (?, ?)", records,
            )
        connection.commit()
    finally:
        connection.close()
    return path


def _consume(stream):
    events = []
    while True:
        try:
            events.append(next(stream))
        except StopIteration as stop:
            return events, stop.value


def _read(path, **kwargs):
    with reader.open_enhanced_sqlite_snapshot(path, **kwargs) as stream:
        return _consume(stream)


def _records(events):
    return [event for event in events if isinstance(event, reader.StoreRecord)]


def _pages(events):
    return [event for event in events if isinstance(event, reader.FilenameAliasPage)]


def _assert_rejected(summary, reason):
    assert isinstance(summary, reader.StoreReadSummary)
    assert summary.status == "rejected"
    assert summary.reason == reason


def test_original_signed_keys_ticks_and_cached_history_remain_separate(tmp_path):
    local = (2**53 + 1, 2**53 + 2, 2**53 + 1)
    cached = (0, 2**64 - 1, 2**53 + 3)
    keys = (-2**63, -1, 0, 2**63 - 1)
    path = _snapshot(
        tmp_path,
        mappings=[(key, f"synthetic-{index}.flac") for index, key in enumerate(keys)],
        records=[(key, _payload(local, cached)) for key in keys],
    )

    events, summary = _read(path)
    records = _records(events)

    assert isinstance(summary, reader.StoreReadSummary)
    assert summary.status == "complete"
    assert summary.reason is None
    assert summary.records == summary.aliases == len(keys)
    assert [record.identity.key for record in records] == list(keys)
    assert {record.identity.store_guid for record in records} == {GUID}
    assert len(_pages(events)) == len(keys)
    for record in records:
        assert record.record.local_filetime_ticks == local
        assert record.record.cached_lastfm_filetime_ticks == cached
        assert record.record.local_provenance == "incomplete_possibly_seeded"
        assert all(type(tick) is int for tick in record.record.local_filetime_ticks)
        assert record.diagnostics == ()


@pytest.mark.parametrize("count, sizes", [(128, [128]), (257, [128, 128, 1])])
def test_alias_fanout_emits_one_record_and_bounded_final_pages(tmp_path, count, sizes):
    aliases = tuple(f"synthetic-{index:04}.flac" for index in range(count))
    path = _snapshot(
        tmp_path,
        mappings=[(42, filename) for filename in reversed(aliases)],
        records=[(42, _payload((123, 123)))],
    )

    events, summary = _read(path)
    records, pages = _records(events), _pages(events)

    assert isinstance(summary, reader.StoreReadSummary)
    assert summary.status == "complete"
    assert summary.records == 1
    assert summary.aliases == count
    assert len(records) == 1
    assert records[0].record.local_filetime_ticks == (123, 123)
    assert [len(page.filenames) for page in pages] == sizes
    assert [page.final for page in pages] == [False] * (len(sizes) - 1) + [True]
    assert {name for page in pages for name in page.filenames} == set(aliases)
    assert all(page.identity == records[0].identity for page in pages)
    assert events[0] is records[0]


def test_record_identity_and_pages_are_immutable(tmp_path):
    path = _snapshot(
        tmp_path, mappings=[(-1, "synthetic.flac")], records=[(-1, _payload())],
    )
    events, _ = _read(path)
    record, page = _records(events)[0], _pages(events)[0]

    assert type(record.diagnostics) is tuple
    assert type(page.filenames) is tuple
    with pytest.raises(FrozenInstanceError):
        record.identity.key = 1
    with pytest.raises(FrozenInstanceError):
        record.data_state = "changed"
    with pytest.raises(FrozenInstanceError):
        page.final = False
    with pytest.raises(FrozenInstanceError):
        record.record.local_filetime_ticks = (99,)


@pytest.mark.parametrize("name", [
    "synthetic % # .sqlite",
    pytest.param(
        "synthetic ?.sqlite",
        marks=pytest.mark.skipif(os.name == "nt", reason="? is not a Windows filename"),
    ),
])
def test_uri_filename_characters_do_not_change_selected_file(tmp_path, name):
    path = _snapshot(
        tmp_path,
        name=name,
        mappings=[(7, "literal%23#.flac")], records=[(7, _payload((91,)))],
    )
    before = path.read_bytes()

    events, summary = _read(path)

    assert isinstance(summary, reader.StoreReadSummary)
    assert summary.status == "complete"
    assert _records(events)[0].record.local_filetime_ticks == (91,)
    assert _pages(events)[0].filenames == ("literal%23#.flac",)
    assert path.read_bytes() == before
    assert set(tmp_path.iterdir()) == {path}


@pytest.mark.parametrize("exit_mode", ["exhausted", "early", "consumer_error"])
def test_reader_owns_read_only_connection_and_closes_on_every_exit(
    tmp_path, monkeypatch, exit_mode,
):
    path = _snapshot(
        tmp_path, mappings=[(1, "synthetic.flac")], records=[(1, _payload((71,)))],
    )
    before = path.read_bytes()
    original_connect = sqlite3.connect
    opened = []

    def connect(*args, **kwargs):
        connection = original_connect(*args, **kwargs)
        opened.append((args, kwargs, connection))
        return connection

    class ConsumerError(Exception):
        pass

    monkeypatch.setattr(reader.sqlite3, "connect", connect)
    try:
        with reader.open_enhanced_sqlite_snapshot(path) as stream:
            assert isinstance(next(stream), reader.StoreRecord)
            assert len(opened) == 1
            args, kwargs, connection = opened[0]
            assert args[0].startswith("file:")
            assert "?mode=ro&immutable=1" in args[0]
            assert kwargs["uri"] is True
            assert connection.execute("PRAGMA query_only").fetchone() == (1,)
            with pytest.raises(sqlite3.DatabaseError):
                connection.execute(
                    f"INSERT INTO {TABLE}_data (key, value) VALUES (?, ?)",
                    (2, _payload()),
                )
            with pytest.raises(sqlite3.DatabaseError):
                connection.execute("CREATE TEMP TABLE forbidden (value INTEGER)")
            with pytest.raises(sqlite3.DatabaseError):
                connection.execute("ATTACH DATABASE ':memory:' AS forbidden")
            with pytest.raises(sqlite3.DatabaseError):
                connection.execute("SELECT load_extension('synthetic-unavailable-extension')")
            if exit_mode == "exhausted":
                _, summary = _consume(stream)
                assert isinstance(summary, reader.StoreReadSummary)
                assert summary.status == "complete"
            elif exit_mode == "consumer_error":
                raise ConsumerError
    except ConsumerError:
        assert exit_mode == "consumer_error"

    with pytest.raises(sqlite3.ProgrammingError):
        opened[0][2].execute("SELECT 1")
    assert path.read_bytes() == before
    assert set(tmp_path.iterdir()) == {path}


def test_unavailable_invalid_and_empty_data_are_not_zero_play_substitutes(tmp_path):
    path = _snapshot(
        tmp_path,
        mappings=[(key, f"synthetic-{key}.flac") for key in (1, 2, 3, 4, 5, 6, 8)],
        records=[
            (2, None), (3, "not a BLOB"), (4, b"\x01"),
            (5, _payload(version=2)), (6, b"x" * 262_145),
            (7, _payload()), (8, _payload(cached=(999,))),
        ],
    )

    events, summary = _read(path)
    records = {event.identity.key: event for event in _records(events)}

    assert summary.status == "complete"
    assert summary.records == 8
    assert summary.aliases == 7
    expected = {
        1: ("unavailable", "missing_data"),
        2: ("null", "null_value"),
        3: ("malformed", "invalid_value_type"),
        4: ("malformed", "truncated_header"),
        5: ("unsupported", "unsupported_version"),
        6: ("oversized", "record_too_large"),
    }
    for key, (state, code) in expected.items():
        assert records[key].data_state == state
        assert records[key].mapping_state == "mapped"
        assert records[key].record is None
        assert [diagnostic.code for diagnostic in records[key].diagnostics] == [code]
    assert records[7].mapping_state == "unresolved"
    assert records[7].data_state == records[8].data_state == "parsed"
    assert records[7].record.local_filetime_ticks == ()
    assert records[7].record.cached_lastfm_filetime_ticks == ()
    assert records[8].record.local_filetime_ticks == ()
    assert records[8].record.cached_lastfm_filetime_ticks == (999,)
    assert all(page.identity.key != 7 for page in _pages(events))
    assert summary.payload_bytes == 1 + 16 + 16 + 24


def test_other_store_with_same_key_never_supplies_local_history(tmp_path):
    other = "metadb_index_0C1BD000_43E7_4078_B885_48EE4249DED0_data"
    path = _snapshot(
        tmp_path, mappings=[(1, "synthetic.flac")],
        schema=SCHEMA + (
            f"CREATE TABLE {other} (key INTEGER PRIMARY KEY, value BLOB)",
            f"INSERT INTO {other} VALUES (1, X'{_payload((777,)).hex()}')",
            "CREATE TABLE standard_playcount (key INTEGER PRIMARY KEY, value BLOB)",
            "INSERT INTO standard_playcount VALUES (1, zeroblob(40))",
        ),
    )

    events, summary = _read(path)

    assert summary.status == "complete"
    assert summary.records == 1
    record = _records(events)[0]
    assert record.identity == reader.StoreIdentity(GUID, 1)
    assert record.data_state == "unavailable"
    assert record.record is None


def test_empty_supported_schema_completes_without_inventing_records(tmp_path):
    events, summary = _read(_snapshot(tmp_path))

    assert events == []
    assert summary.status == "complete"
    assert summary.reason is None
    assert summary.records == summary.aliases == 0
    assert summary.payload_bytes == summary.alias_bytes == 0


def test_absent_extension_is_unavailable_not_an_empty_success(tmp_path):
    other = "metadb_index_0C1BD000_43E7_4078_B885_48EE4249DED0_data"
    path = _snapshot(tmp_path, schema=(
        f"CREATE TABLE {other} (key INTEGER PRIMARY KEY, value BLOB)",
        f"INSERT INTO {other} VALUES (1, X'{_payload((777,)).hex()}')",
        "CREATE TABLE standard_playcount (key INTEGER PRIMARY KEY, value BLOB)",
    ))

    events, summary = _read(path)

    assert events == []
    assert summary.status == "unavailable"
    assert summary.reason == "store_absent"
    assert summary.records == summary.aliases == 0


@pytest.mark.parametrize("schema", [
    SCHEMA[:2],
    (SCHEMA[0].replace("filename TEXT", "filename BLOB"), *SCHEMA[1:]),
    (f"CREATE VIEW {TABLE} AS SELECT 1 AS key, 'fake' AS filename", SCHEMA[1]),
    SCHEMA + (f"CREATE INDEX extra_index ON {TABLE}(filename)",),
    SCHEMA + (
        f"CREATE TRIGGER extra_trigger AFTER INSERT ON {TABLE} BEGIN SELECT 1; END",
    ),
], ids=["missing-index", "changed-type", "view", "extra-index", "trigger"])
def test_schema_variants_are_rejected_before_any_record(tmp_path, schema):
    events, summary = _read(_snapshot(tmp_path, schema=schema))

    assert events == []
    _assert_rejected(summary, "unsupported_schema")


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_snapshot_sidecars_are_rejected_and_never_deleted(tmp_path, suffix):
    path = _snapshot(tmp_path)
    sidecar = Path(str(path) + suffix)
    sidecar.write_bytes(b"synthetic sidecar evidence")
    before = path.read_bytes()

    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "snapshot_not_self_contained")
    assert path.read_bytes() == before
    assert sidecar.read_bytes() == b"synthetic sidecar evidence"


def test_wal_header_is_rejected_even_without_sidecars(tmp_path):
    path = _snapshot(tmp_path)
    content = bytearray(path.read_bytes())
    content[18:20] = b"\x02\x02"
    path.write_bytes(content)

    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "snapshot_not_self_contained")
    assert path.read_bytes() == content


def test_missing_snapshot_is_not_created(tmp_path):
    path = tmp_path / "does-not-exist.sqlite"

    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "snapshot_unavailable")
    assert not path.exists()


@pytest.mark.parametrize("header", [b"", b"not SQLite" * 10])
def test_invalid_header_is_not_misreported_as_an_empty_store(tmp_path, header):
    path = tmp_path / "synthetic.sqlite"
    path.write_bytes(header)

    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "invalid_sqlite_header")


def test_oversized_database_is_rejected_before_connect(tmp_path, monkeypatch):
    path = _snapshot(tmp_path)
    monkeypatch.setattr(reader, "MAX_DATABASE_BYTES", path.stat().st_size - 1)

    def unexpected_connect(*args, **kwargs):
        pytest.fail("An oversized artifact must not be opened by SQLite")

    monkeypatch.setattr(reader.sqlite3, "connect", unexpected_connect)
    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "database_too_large")


@pytest.mark.parametrize("error_type, code, reason", [
    (sqlite3.OperationalError, sqlite3.SQLITE_BUSY, "database_busy"),
    (sqlite3.OperationalError, sqlite3.SQLITE_LOCKED, "database_busy"),
    (sqlite3.DatabaseError, sqlite3.SQLITE_CORRUPT, "database_corrupt"),
    (sqlite3.DatabaseError, sqlite3.SQLITE_NOTADB, "database_corrupt"),
    (sqlite3.OperationalError, sqlite3.SQLITE_ERROR, "sqlite_read_failed"),
])
def test_sqlite_failures_use_fixed_reasons_without_exception_details(
    tmp_path, monkeypatch, error_type, code, reason,
):
    path = _snapshot(tmp_path)
    before = path.read_bytes()
    private_detail = "synthetic-private-path-and-detail-not-for-results"

    def failing_connect(*args, **kwargs):
        error = error_type(private_detail)
        error.sqlite_errorcode = code
        raise error

    monkeypatch.setattr(reader.sqlite3, "connect", failing_connect)
    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, reason)
    assert private_detail not in repr(summary)
    assert path.read_bytes() == before
    assert set(tmp_path.iterdir()) == {path}


def test_sqlite_without_required_limits_fails_closed(tmp_path, monkeypatch):
    path = _snapshot(tmp_path)

    class ConnectionWithoutLimits:
        closed = False

        def close(self):
            self.closed = True

    connection = ConnectionWithoutLimits()
    monkeypatch.setattr(reader.sqlite3, "connect", lambda *args, **kwargs: connection)

    events, summary = _read(path)

    assert events == []
    _assert_rejected(summary, "sqlite_safety_unavailable")
    assert connection.closed is True


def test_record_at_payload_byte_cap_is_admitted(tmp_path):
    count = (262_144 - 16) // 8
    payload = _payload((0,) * count)
    path = _snapshot(tmp_path, records=[(1, payload)])

    events, summary = _read(path)

    assert summary.status == "complete"
    assert summary.payload_bytes == 262_144
    record = _records(events)[0]
    assert record.data_state == "parsed"
    assert len(record.record.local_filetime_ticks) == count
    assert record.record.cached_lastfm_filetime_ticks == ()


@pytest.mark.parametrize("extra", [0, 1])
def test_filename_limit_counts_utf8_bytes_not_characters(tmp_path, extra):
    filename = "é" * (8192 + extra)
    path = _snapshot(tmp_path, mappings=[(1, filename)])

    events, summary = _read(path)

    if extra:
        _assert_rejected(summary, "filename_too_large")
        assert _pages(events) == []
    else:
        assert summary.status == "complete"
        assert summary.alias_bytes == 16_384
        assert _pages(events)[0].filenames == (filename,)


@pytest.mark.parametrize("encoding, codec", [
    ("UTF-8", "utf-8"), ("UTF-16le", "utf-16-le"), ("UTF-16be", "utf-16-be"),
])
def test_filename_uses_declared_database_encoding(tmp_path, encoding, codec):
    filename = "synthetic-音-é.flac"
    path = _snapshot(
        tmp_path,
        schema=(f"PRAGMA encoding='{encoding}'",) + SCHEMA,
        mappings=[(1, filename)],
    )

    events, summary = _read(path)

    assert summary.status == "complete"
    assert _pages(events)[0].filenames == (filename,)
    assert summary.alias_bytes == len(filename.encode(codec))


@pytest.mark.parametrize("filename", ["", "bad\x00name", b"not TEXT"])
def test_invalid_filename_invalidates_the_attempt(tmp_path, filename):
    path = _snapshot(tmp_path, mappings=[(1, filename)])

    events, summary = _read(path)

    _assert_rejected(summary, "invalid_filename")
    assert len(_records(events)) == 1
    assert _pages(events) == []


def test_nul_does_not_hide_an_oversized_filename_tail(tmp_path):
    filename = "x\x00" + "y" * (reader.MAX_FILENAME_BYTES + 1)
    path = _snapshot(tmp_path, mappings=[(1, filename)])

    events, summary = _read(path)

    _assert_rejected(summary, "filename_too_large")
    assert _pages(events) == []
    assert summary.aliases == summary.alias_bytes == 0


def test_invalid_utf8_filename_is_not_replaced_or_silently_dropped(tmp_path):
    path = _snapshot(tmp_path, schema=SCHEMA + (
        f"INSERT INTO {TABLE} VALUES (1, CAST(X'ff' AS TEXT))",
    ))

    events, summary = _read(path)

    _assert_rejected(summary, "invalid_filename_encoding")
    assert _pages(events) == []


@pytest.mark.parametrize("limit", [17, 18])
def test_combined_payload_and_alias_budget_is_exact(tmp_path, monkeypatch, limit):
    path = _snapshot(tmp_path, mappings=[(1, "é")], records=[(1, _payload())])
    monkeypatch.setattr(reader, "MAX_EVIDENCE_BYTES", limit)

    events, summary = _read(path)

    assert len(_records(events)) == 1
    assert summary.payload_bytes == 16
    if limit == 17:
        _assert_rejected(summary, "evidence_bytes_exceeded")
        assert _pages(events) == []
        assert summary.alias_bytes == 0
    else:
        assert summary.status == "complete"
        assert summary.alias_bytes == 2
        assert _pages(events)[0].filenames == ("é",)


@pytest.mark.parametrize("limit", [2, 3])
def test_record_count_limit_does_not_return_partial_success(tmp_path, monkeypatch, limit):
    path = _snapshot(tmp_path, records=[(key, _payload()) for key in range(3)])
    monkeypatch.setattr(reader, "MAX_RECORDS", limit)

    events, summary = _read(path)

    assert len(_records(events)) == limit
    assert summary.records == limit
    if limit == 2:
        _assert_rejected(summary, "record_limit_exceeded")
    else:
        assert summary.status == "complete"


def test_count_policy_covers_retained_admission_cases():
    mapping_rows, data_rows = 153_082, 29_382
    # Their sum is a conservative capacity bound, not a measured distinct-key
    # union or a claim about current counts, encoded bytes, or runtime.
    assert reader.MAX_ALIASES == reader.MAX_RECORDS == 250_000
    assert reader.MAX_ALIASES > mapping_rows
    assert reader.MAX_RECORDS >= mapping_rows + data_rows


@pytest.mark.parametrize("limit", [2, 3])
def test_alias_count_limit_applies_within_one_key(tmp_path, monkeypatch, limit):
    path = _snapshot(tmp_path, mappings=[(1, f"synthetic-{key}") for key in range(3)])
    monkeypatch.setattr(reader, "MAX_ALIASES", limit)

    events, summary = _read(path)

    assert len(_records(events)) == 1
    assert summary.aliases == limit
    if limit == 2:
        _assert_rejected(summary, "alias_limit_exceeded")
        assert _pages(events) == []
    else:
        assert summary.status == "complete"
        assert len(_pages(events)[0].filenames) == 3


def test_late_invalid_mapping_key_invalidates_previously_yielded_record(tmp_path):
    path = _snapshot(
        tmp_path, mappings=[("not an integer", "synthetic.flac")],
        records=[(1, _payload((11,)))],
    )

    events, summary = _read(path)

    assert len(_records(events)) == 1
    assert _records(events)[0].record.local_filetime_ticks == (11,)
    _assert_rejected(summary, "invalid_mapping_key")


@pytest.mark.parametrize("mode, reason", [
    ("cancelled", "cancelled"),
    ("raised", "cancellation_callback_failed"),
    ("not_callable", "invalid_cancellation_callback"),
])
def test_initial_cancellation_is_explicit(tmp_path, mode, reason):
    path = _snapshot(tmp_path)

    def cancelled():
        if mode == "raised":
            raise RuntimeError("synthetic callback error")
        return True

    callback = 1 if mode == "not_callable" else cancelled
    events, summary = _read(path, cancelled=callback)

    assert events == []
    _assert_rejected(summary, reason)


@pytest.mark.parametrize("elapsed", [60.0, 61.0])
def test_delayed_first_consumption_expires_before_artifact_acquisition(
    tmp_path, monkeypatch, elapsed,
):
    now = [100.0]
    monkeypatch.setattr(reader, "monotonic", lambda: now[0])

    def unexpected_artifact_acquisition(path):
        pytest.fail("An expired context must not acquire the artifact")

    monkeypatch.setattr(reader, "_artifact_uri", unexpected_artifact_acquisition)
    with reader.open_enhanced_sqlite_snapshot(tmp_path / "never-acquired.sqlite") as stream:
        now[0] += elapsed
        events, summary = _consume(stream)

    assert events == []
    _assert_rejected(summary, "read_deadline_exceeded")
    assert summary.records == summary.aliases == 0


@pytest.mark.parametrize("mode, reason", [
    ("cancelled", "cancelled"), ("deadline", "read_deadline_exceeded"),
])
def test_late_stop_returns_rejection_not_partial_validation(
    tmp_path, monkeypatch, mode, reason,
):
    path = _snapshot(
        tmp_path, mappings=[(1, "synthetic.flac")], records=[(1, _payload((11,)))],
    )
    stop = [False]
    now = [100.0]
    monkeypatch.setattr(reader, "monotonic", lambda: now[0])

    with reader.open_enhanced_sqlite_snapshot(path, cancelled=lambda: stop[0]) as stream:
        tentative = next(stream)
        assert tentative.record.local_filetime_ticks == (11,)
        if mode == "cancelled":
            stop[0] = True
        else:
            now[0] += reader.MAX_READ_SECONDS
        events, summary = _consume(stream)

    assert events == []
    _assert_rejected(summary, reason)


def test_sqlite_vm_progress_can_cancel_an_active_scan(tmp_path, monkeypatch):
    path = _snapshot(tmp_path, records=[(key, _payload()) for key in range(512)])
    original_connect = sqlite3.connect
    inside_progress = [False]
    progress_calls = [0]

    class ProgressConnection(sqlite3.Connection):
        def set_progress_handler(self, handler, instructions):
            def observed_progress():
                progress_calls[0] += 1
                inside_progress[0] = True
                try:
                    return handler()
                finally:
                    inside_progress[0] = False

            super().set_progress_handler(observed_progress, instructions)

    def connect(*args, **kwargs):
        return original_connect(*args, factory=ProgressConnection, **kwargs)

    monkeypatch.setattr(reader.sqlite3, "connect", connect)
    # Every between-row check returns False. Only a real SQLite VM callback
    # can make cancellation True and interrupt the active statement.
    events, summary = _read(path, cancelled=lambda: inside_progress[0])

    assert progress_calls[0] >= 1
    assert len(_records(events)) < 512
    _assert_rejected(summary, "cancelled")


def test_actual_supported_mapping_rejects_duplicate_filename_rows(tmp_path):
    path = _snapshot(tmp_path, mappings=((1, 'same.flac'),), records=((1, _payload()),))
    connection = sqlite3.connect(path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(f"INSERT INTO {TABLE} (key, filename) VALUES (?, ?)", (1, 'same.flac'))
        connection.rollback()
    finally:
        connection.close()
    events, summary = _read(path)
    assert summary.status == 'complete'
    assert sum(len(page.filenames) for page in _pages(events)) == 1


def test_duplicate_permitting_mapping_is_refused_before_records(tmp_path):
    schema = (SCHEMA[0].replace('filename TEXT NOT NULL UNIQUE PRIMARY KEY',
        'filename TEXT NOT NULL'), *SCHEMA[1:])
    path = _snapshot(tmp_path, schema=schema,
        mappings=((1, 'same.flac'), (1, 'same.flac')), records=((1, _payload()),))
    events, summary = _read(path)
    assert events == []
    _assert_rejected(summary, 'unsupported_schema')
