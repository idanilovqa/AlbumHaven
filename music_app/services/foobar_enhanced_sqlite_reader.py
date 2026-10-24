"""Bounded read-only enhanced-track evidence from a finalized SQLite artifact.

The caller owns an authorized, immutable, self-contained intake artifact and
must keep it unchanged for the entire context. NEVER pass a live Foobar file.
This module does not acquire/copy a snapshot, retain raw files, match tracks,
write imports, or turn SQLite into application persistence. Cached Last.fm
values remain separate from local evidence, never additional local plays.
"""
from __future__ import annotations

from collections.abc import Callable, Generator, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
import sqlite3
from time import monotonic

from .foobar_enhanced_record_decoder import (
    ENHANCED_PLAYCOUNT_STORE_GUID, MAX_RECORD_BYTES, EnhancedRecord,
    RecordDiagnostic, decode_enhanced_playcount_record,
)


# Application admission limits, not upstream format or measured speed claims.
MAX_DATABASE_BYTES = 536_870_912
MAX_RECORDS = 250_000
MAX_ALIASES = 250_000
MAX_EVIDENCE_BYTES = 67_108_864
MAX_FILENAME_BYTES = 16_384
ALIAS_PAGE_SIZE = 128
MAX_READ_SECONDS = 60.0
_MAX_SQLITE_VALUE_BYTES = 1_048_576
_CONTRACT_VERSION = "foobar_enhanced_sqlite_snapshot_v1"
_MAPPING = "metadb_index_0C1BD000_43E7_4078_B885_48EE4249DEC3"
_DATA = _MAPPING + "_data"
_KEY_INDEX = _MAPPING + "_key"
_SCHEMA = {
    _MAPPING: (
        "table", _MAPPING,
        f"CREATE TABLE {_MAPPING} (key INTEGER NOT NULL, "
        "filename TEXT NOT NULL UNIQUE PRIMARY KEY)",
    ),
    _DATA: (
        "table", _DATA,
        f"CREATE TABLE {_DATA} (key INTEGER NOT NULL PRIMARY KEY UNIQUE, value BLOB)",
    ),
    _KEY_INDEX: (
        "index", _MAPPING,
        f"CREATE INDEX {_KEY_INDEX} ON {_MAPPING}(key)",
    ),
}


@dataclass(frozen=True, slots=True)
class StoreIdentity:
    store_guid: str
    key: int


@dataclass(frozen=True, slots=True)
class StoreRecord:
    identity: StoreIdentity
    data_state: str
    mapping_state: str
    record: EnhancedRecord | None
    diagnostics: tuple[RecordDiagnostic, ...]


@dataclass(frozen=True, slots=True)
class FilenameAliasPage:
    identity: StoreIdentity
    filenames: tuple[str, ...]
    final: bool


@dataclass(frozen=True, slots=True)
class StoreReadSummary:
    contract_version: str
    status: str
    reason: str | None
    records: int
    aliases: int
    payload_bytes: int
    alias_bytes: int


class _Stopped(Exception):
    pass


class _Budget:
    def __init__(self, cancelled: Callable[[], bool] | None) -> None:
        self.cancelled = cancelled
        self.deadline = monotonic() + MAX_READ_SECONDS
        self.reason: str | None = None
        self.records = self.aliases = self.payload_bytes = self.alias_bytes = 0

    def check(self) -> None:
        if self.reason is None:
            try:
                if self.cancelled is not None and self.cancelled():
                    self.reason = "cancelled"
            except Exception:
                self.reason = "cancellation_callback_failed"
            if self.reason is None and monotonic() >= self.deadline:
                self.reason = "read_deadline_exceeded"
        if self.reason is not None:
            raise _Stopped(self.reason)

    def progress(self) -> int:
        try:
            self.check()
        except _Stopped:
            return 1
        return 0

    def admit_bytes(self, count: int, *, alias: bool = False) -> None:
        if count > MAX_EVIDENCE_BYTES - self.payload_bytes - self.alias_bytes:
            raise _Stopped("evidence_bytes_exceeded")
        if alias:
            self.alias_bytes += count
        else:
            self.payload_bytes += count

    def summary(self, reason: str | None) -> StoreReadSummary:
        status = "complete" if reason is None else "rejected"
        if reason == "store_absent":
            status = "unavailable"
        return StoreReadSummary(
            _CONTRACT_VERSION, status, reason,
            self.records, self.aliases, self.payload_bytes, self.alias_bytes,
        )


def _authorizer(action: int, first: str | None, second: str | None,
                database: str | None, source: str | None) -> int:
    # Fixed statements only. Defense in depth against views, attached DBs,
    # extension functions, writes, and accidental future query expansion.
    if source is not None:
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_SELECT:
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_READ and database == "main":
        columns = {
            "sqlite_master": {"type", "name", "tbl_name", "sql"},
            "sqlite_schema": {"type", "name", "tbl_name", "sql"},
            _MAPPING: {"key", "filename", "ROWID", "rowid", ""},
            _DATA: {"key", "value", ""},
        }
        if first in columns and second in columns[first]:
            return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION and second in ("typeof", "length"):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_PRAGMA and (first, second) in (
        ("query_only", "ON"), ("query_only", None),
        ("trusted_schema", "OFF"), ("trusted_schema", None),
    ):
        return sqlite3.SQLITE_OK
    if (action == sqlite3.SQLITE_PRAGMA and database == "main"
            and first == "integrity_check" and second == "1"):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_TRANSACTION and first == "BEGIN":
        return sqlite3.SQLITE_OK
    return sqlite3.SQLITE_DENY


def _one(connection: sqlite3.Connection, sql: str, parameters: tuple = ()) -> tuple | None:
    with closing(connection.execute(sql, parameters)) as cursor:
        return cursor.fetchone()


def _validate_schema(connection: sqlite3.Connection) -> None:
    # Compare bounded schema text; NEVER execute SQL obtained from the file.
    if _one(connection, "SELECT 1 FROM main.sqlite_schema WHERE name IN (?, ?, ?) LIMIT 1",
            (_MAPPING, _DATA, _KEY_INDEX)) is None:
        raise _Stopped("store_absent")
    for name, expected in _SCHEMA.items():
        row = _one(connection, "SELECT type, tbl_name, CASE WHEN "
                   "length(CAST(sql AS BLOB)) <= 4096 THEN sql END "
                   "FROM main.sqlite_schema WHERE name = ?", (name,))
        if row is None or type(row[2]) is not str:
            raise _Stopped("unsupported_schema")
        if (row[0], row[1], " ".join(row[2].split())) != expected:
            raise _Stopped("unsupported_schema")
    # Implicit PK/UNIQUE indexes have NULL SQL. Reject extra explicit indexes
    # or triggers on either accepted table rather than expand this whitelist.
    if _one(connection, "SELECT 1 FROM main.sqlite_schema WHERE tbl_name IN (?, ?) "
            "AND sql IS NOT NULL AND name NOT IN (?, ?, ?) LIMIT 1",
            (_MAPPING, _DATA, _MAPPING, _DATA, _KEY_INDEX)) is not None:
        raise _Stopped("unsupported_schema")


def _validate_integrity(connection: sqlite3.Connection, budget: _Budget) -> None:
    # A fixed whole-main check, not a table-scoped partial check. SQLite's
    # existing LENGTH limit bounds each returned diagnostic before Python
    # receives it; never return diagnostic text from an uploaded artifact.
    # The argument caps reported errors, NOT pages read or elapsed time.
    budget.check()
    with closing(connection.execute("PRAGMA main.integrity_check(1)")) as cursor:
        row = cursor.fetchone()
        budget.check()
        if row != ("ok",):
            raise _Stopped("database_integrity_failed")
        del row
        if cursor.fetchone() is not None:
            raise _Stopped("database_integrity_failed")
        budget.check()


def _artifact_uri(path: Path) -> tuple[str, str]:
    if not isinstance(path, Path):
        raise _Stopped("invalid_snapshot_path")
    path = path.resolve(strict=True)
    if not path.is_file():
        raise _Stopped("invalid_snapshot_path")
    if path.stat().st_size > MAX_DATABASE_BYTES:
        raise _Stopped("database_too_large")
    if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise _Stopped("snapshot_not_self_contained")
    with path.open("rb") as source:
        header = source.read(100)
    if len(header) != 100 or header[:16] != b"SQLite format 3\x00":
        raise _Stopped("invalid_sqlite_header")
    if header[18:20] != b"\x01\x01":
        raise _Stopped("snapshot_not_self_contained")
    encoding = {1: "utf-8", 2: "utf-16-le", 3: "utf-16-be"}.get(
        int.from_bytes(header[56:60], "big"),
    )
    if encoding is None:
        raise _Stopped("invalid_sqlite_header")
    # as_uri escapes user filename '?'/'#'/'%' instead of accepting URI options.
    # immutable is valid ONLY because the intake caller guarantees a stable
    # artifact; the header/sidecar checks do not establish immutability for it.
    return path.as_uri() + "?mode=ro&immutable=1&cache=private", encoding


def _record(connection: sqlite3.Connection, budget: _Budget, key: int,
            value_type: str | None, size: int | None) -> StoreRecord:
    identity = StoreIdentity(ENHANCED_PLAYCOUNT_STORE_GUID, key)
    mapped = _one(connection, f"SELECT 1 FROM main.{_MAPPING} INDEXED BY {_KEY_INDEX} "
                  "WHERE key = ? LIMIT 1", (key,)) is not None
    state, decoded, diagnostics = "unavailable", None, (
        RecordDiagnostic("unavailable", "missing_data"),
    )
    if value_type == "null":
        state, diagnostics = "null", (RecordDiagnostic("unavailable", "null_value"),)
    elif value_type is not None and value_type != "blob":
        state, diagnostics = "malformed", (RecordDiagnostic("malformed", "invalid_value_type"),)
    elif value_type == "blob":
        if type(size) is not int or size < 0:
            raise _Stopped("invalid_blob_metadata")
        if size > MAX_RECORD_BYTES:
            state, diagnostics = "oversized", (RecordDiagnostic("too_large", "record_too_large"),)
        else:
            budget.admit_bytes(size)
            budget.check()
            # Repeat guards on acquisition; never fetch an unbounded BLOB and
            # check len afterwards. The same connection owns the entire scan.
            row = _one(connection, f"SELECT value FROM main.{_DATA} WHERE key = ? "
                       "AND typeof(value) = 'blob' AND length(value) = ? "
                       "AND length(value) <= ?", (key, size, MAX_RECORD_BYTES))
            if row is None or type(row[0]) is not bytes or len(row[0]) != size:
                raise _Stopped("inconsistent_blob_read")
            result = decode_enhanced_playcount_record(
                row[0], store_guid=ENHANCED_PLAYCOUNT_STORE_GUID,
            )
            state = "parsed" if result.status == "parsed" else result.diagnostics[0].category
            if state == "too_large":
                state = "oversized"
            decoded, diagnostics = result.record, result.diagnostics
    return StoreRecord(identity, state, "mapped" if mapped else "unresolved", decoded, diagnostics)


def _aliases(connection: sqlite3.Connection, budget: _Budget,
             identity: StoreIdentity, encoding: str) -> Iterator[FilenameAliasPage]:
    # rowid is only an internal pagination cursor, NEVER record/event identity.
    # Equal-key entries in the required index are rowid ordered: no whole-table
    # DISTINCT/UNION, alias sort, or joined history fan-out is necessary.
    sql = (f"SELECT rowid, typeof(filename), length(CAST(filename AS BLOB)) "
           f"FROM main.{_MAPPING} INDEXED BY {_KEY_INDEX} WHERE key = ? ORDER BY rowid")
    budget.check()
    with closing(connection.execute(sql, (identity.key,))) as cursor:
        row = cursor.fetchone()
        while row is not None:
            page: list[str] = []
            while row is not None and len(page) < ALIAS_PAGE_SIZE:
                budget.check()
                rowid, kind, size = row
                if kind != "text" or type(size) is not int or size <= 0:
                    raise _Stopped("invalid_filename")
                if size > MAX_FILENAME_BYTES:
                    raise _Stopped("filename_too_large")
                if budget.aliases >= MAX_ALIASES:
                    raise _Stopped("alias_limit_exceeded")
                budget.admit_bytes(size, alias=True)
                value = _one(connection, f"SELECT CAST(filename AS BLOB) FROM main.{_MAPPING} "
                             "WHERE rowid = ? AND typeof(filename) = 'text' "
                             "AND length(CAST(filename AS BLOB)) = ? "
                             "AND length(CAST(filename AS BLOB)) <= ?",
                             (rowid, size, MAX_FILENAME_BYTES))
                if value is None or type(value[0]) is not bytes or len(value[0]) != size:
                    raise _Stopped("inconsistent_alias_read")
                try:
                    # SQLite TEXT -> BLOB uses the database encoding, not
                    # necessarily UTF-8. Preserve the original Unicode alias.
                    filename = value[0].decode(encoding, "strict")
                except UnicodeDecodeError:
                    raise _Stopped("invalid_filename_encoding") from None
                if "\x00" in filename:
                    raise _Stopped("invalid_filename")
                page.append(filename)
                budget.aliases += 1
                row = cursor.fetchone()
            budget.check()
            yield FilenameAliasPage(identity, tuple(page), row is None)


def _scan(path: Path, budget: _Budget) -> Generator[
    StoreRecord | FilenameAliasPage, None, StoreReadSummary,
]:
    connection = None
    try:
        if budget.cancelled is not None and not callable(budget.cancelled):
            raise _Stopped("invalid_cancellation_callback")
        budget.check()
        uri, encoding = _artifact_uri(path)
        budget.check()
        connection = sqlite3.connect(uri, uri=True, timeout=0.0, isolation_level=None,
                                     detect_types=0, cached_statements=0)
        if not hasattr(connection, "setlimit"):
            raise _Stopped("sqlite_safety_unavailable")
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, _MAX_SQLITE_VALUE_BYTES)
        connection.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 65_536)
        connection.setlimit(sqlite3.SQLITE_LIMIT_ATTACHED, 0)
        # Extension loading is never enabled. Fresh stdlib connections provide
        # no caller-installed converters, functions, collations or attachments.
        connection.set_authorizer(_authorizer)
        connection.set_progress_handler(budget.progress, 1000)
        _one(connection, "PRAGMA query_only=ON")
        _one(connection, "PRAGMA trusted_schema=OFF")
        if _one(connection, "PRAGMA query_only") != (1,) or _one(
            connection, "PRAGMA trusted_schema",
        ) != (0,):
            raise _Stopped("sqlite_safety_unavailable")
        _one(connection, "BEGIN")
        _validate_schema(connection)
        _validate_integrity(connection, budget)
        # Data rows are unique by INTEGER PRIMARY KEY, including negative keys.
        # The second pass streams mapping keys lacking data in index order;
        # one previous-key scalar suppresses alias duplicates without SQL
        # GROUP BY/DISTINCT materialization. No other GUID's store is joined.
        scans = (
            f"SELECT key, typeof(value), CASE WHEN typeof(value) = 'blob' "
            f"THEN length(value) END FROM main.{_DATA} ORDER BY key",
            f"SELECT CASE WHEN typeof(m.key) = 'integer' THEN m.key END, NULL, NULL "
            f"FROM main.{_MAPPING} AS m INDEXED BY {_KEY_INDEX} "
            f"WHERE NOT EXISTS (SELECT 1 FROM main.{_DATA} AS d WHERE d.key = m.key) "
            "ORDER BY m.key",
        )
        for scan_index, sql in enumerate(scans):
            budget.check()
            previous_key = None
            with closing(connection.execute(sql)) as cursor:
                for key, kind, size in cursor:
                    budget.check()
                    if type(key) is not int:
                        raise _Stopped("invalid_mapping_key")
                    if key == previous_key:
                        if scan_index == 1:
                            continue
                        raise _Stopped("duplicate_data_key")
                    previous_key = key
                    if budget.records >= MAX_RECORDS:
                        raise _Stopped("record_limit_exceeded")
                    budget.records += 1
                    record = _record(connection, budget, key, kind, size)
                    budget.check()
                    yield record
                    yield from _aliases(connection, budget, record.identity, encoding)
        budget.check()
        return budget.summary(None)
    except _Stopped as error:
        return budget.summary(str(error))
    except (OSError, ValueError):
        return budget.summary("snapshot_unavailable")
    except sqlite3.Error as error:
        code = getattr(error, "sqlite_errorcode", 0) or 0
        reason = {sqlite3.SQLITE_BUSY: "database_busy", sqlite3.SQLITE_LOCKED: "database_busy",
                  sqlite3.SQLITE_CORRUPT: "database_corrupt", sqlite3.SQLITE_NOTADB: "database_corrupt"}
        return budget.summary(budget.reason or reason.get(code & 255, "sqlite_read_failed"))
    finally:
        if connection is not None:
            connection.close()


@contextmanager
def open_enhanced_sqlite_snapshot(path: Path, *, cancelled: Callable[[], bool] | None = None
                                  ) -> Iterator[Generator[
                                      StoreRecord | FilenameAliasPage, None, StoreReadSummary,
                                  ]]:
    """Yield a one-shot evidence stream; close its owned connection on exit.

    Exhaust the stream and inspect StopIteration.value.status == 'complete'
    before using any result. A late rejection invalidates ALL tentative output;
    an early break is NOT success. Never clear or replace prior source evidence
    because an attempt failed or an individual value is unavailable/rejected.
    A complete scan can contain null, malformed, unsupported or oversized rows.

    Keep consumption inside this context; a generator/context retained forever
    cannot be cleaned up for its caller. No raw BLOB is returned or retained.
    Alias pages refer to one StoreIdentity, never copy its timestamp arrays.
    Intake must enforce authorization, secure artifact ownership and lifetime;
    a path, header or GUID is not permission or proof of coherent acquisition.
    Finalization alone does not prove the original live source was quiescent.
    The whole-main integrity check must succeed before the first record. It
    does not check foreign keys or prove acquisition, completeness or events.
    The cooperative deadline starts at context entry, before first consumption.
    """
    budget = _Budget(cancelled)
    with closing(_scan(path, budget)) as stream:
        yield stream
