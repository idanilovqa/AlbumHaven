"""Pure bounded TSV observations, without matching or import authority.

No source precedence, effective taste, event creation or Apply is implemented.
Raw strings in the returned immutable tree are private source evidence.
"""
from __future__ import annotations

import codecs
from collections.abc import Generator
from dataclasses import dataclass
from hashlib import sha256


MAX_INPUT_BYTES = 67_108_864
MAX_DATA_ROWS = 100_000
MAX_COLUMNS = 64
MAX_TOTAL_CELLS = 3_000_000
MAX_CELL_UTF8_BYTES = 16_384
MAX_RECORD_UTF8_BYTES = 262_144
MAX_DIAGNOSTICS = 2_048

FIELD_NAMES = (
    "path", "artist", "album_artist", "album", "date", "discnumber",
    "tracknumber", "title", "rating", "rating_stars", "rating_stars_fixed",
    "play_count", "play_count_enhanced", "first_played", "last_played", "added",
    "first_played_enhanced", "last_played_enhanced", "added_enhanced", "favorite",
    "length", "length_ex", "played_times", "played_times_js", "played_times_raw",
    "lastfm_played_times_js", "lastfm_play_count",
)
_VERSION = "foobar_text_tools_snapshot_v1"
_ASCII_SPACE = "\t\n\v\f\r "
_COUNTS = frozenset(("play_count", "play_count_enhanced"))
_DATES = frozenset(FIELD_NAMES[13:19])
_HISTORY = frozenset(FIELD_NAMES[22:])
_SPECIAL = _COUNTS | _DATES | _HISTORY | frozenset(("rating", "favorite"))
_MAX_COUNT_TEXT = "9223372036854775807"


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    line_number: int | None
    column_index: int | None


@dataclass(frozen=True, slots=True)
class FieldObservation:
    state: str
    column_index: int | None
    value: str | int | bool | None
    code: str | None


@dataclass(frozen=True, slots=True)
class ParsedRow:
    ordinal: int
    line_number: int
    cells: tuple[str, ...]
    fields: tuple[FieldObservation, ...]
    field_error_count: int


@dataclass(frozen=True, slots=True)
class ParseSummary:
    data_rows: int
    rows_without_field_errors: int
    rows_with_field_errors: int
    field_error_count: int
    unsupported_nonempty_field_count: int
    diagnostic_count: int
    diagnostics_truncated: bool


@dataclass(frozen=True, slots=True)
class ParseResult:
    contract_version: str
    status: str
    source_sha256: str | None
    headers: tuple[str, ...]
    rows: tuple[ParsedRow, ...]
    summary: ParseSummary
    diagnostics: tuple[Diagnostic, ...]


@dataclass(frozen=True, slots=True)
class FoobarScanResult:
    """Terminal whole-upload evidence, never a row collection or authority."""

    contract_version: str
    status: str
    source_sha256: str | None
    headers: tuple[str, ...]
    summary: ParseSummary
    diagnostics: tuple[Diagnostic, ...]


def _rejected(
    code: str, digest: str | None = None,
    line: int | None = None, column: int | None = None,
) -> FoobarScanResult:
    return FoobarScanResult(
        _VERSION, "rejected", digest, (),
        ParseSummary(0, 0, 0, 0, 0, 1, False),
        (Diagnostic(code, line, column),),
    )


def _valid_utf8(payload: bytes) -> bool:
    # Validate the entire input before record errors, without retaining a
    # second whole-file decoded representation. Split multibyte characters
    # are handled by the standard strict incremental decoder.
    decoder = codecs.getincrementaldecoder("utf-8")("strict")
    try:
        for start in range(0, len(payload), 65_536):
            decoder.decode(payload[start:start + 65_536], final=False)
        decoder.decode(b"", final=True)
    except UnicodeDecodeError:
        return False
    return True


def _observation(name: str, column: int | None, cells: tuple[str, ...]) -> FieldObservation:
    if column is None:
        return FieldObservation("absent", None, None, None)
    raw = cells[column]
    if raw == "":
        return FieldObservation("empty", column, None, None)
    if name not in _SPECIAL:
        return FieldObservation("valid", column, raw, None)
    normalized = raw.strip(_ASCII_SPACE)
    if normalized == "":
        return FieldObservation("empty", column, None, None)
    if normalized == "N/A":
        return FieldObservation("unavailable", column, None, None)
    if name in _DATES:
        # This is raw date evidence, never a timestamp-validation claim.
        return FieldObservation("valid", column, raw, None)
    if name in _HISTORY:
        return FieldObservation("unsupported", column, None, "unsupported_history_field")
    if name == "rating":
        if len(normalized) == 1 and normalized in "12345":
            return FieldObservation("valid", column, int(normalized), None)
        return FieldObservation("invalid", column, None, "invalid_rating")
    if name == "favorite":
        if normalized in ("0", "1"):
            return FieldObservation("valid", column, normalized == "1", None)
        return FieldObservation("invalid", column, None, "invalid_favorite")
    # Count conversion is bounded by significant decimal digits, not by
    # interpreter-global integer-string settings or the raw leading zeros.
    if not all("0" <= character <= "9" for character in normalized):
        return FieldObservation("invalid", column, None, "invalid_count")
    significant = normalized.lstrip("0") or "0"
    if len(significant) > 19 or (
        len(significant) == 19 and significant > _MAX_COUNT_TEXT
    ):
        return FieldObservation("invalid", column, None, "invalid_count")
    return FieldObservation("valid", column, int(significant), None)


def iter_foobar_snapshot_rows(
    payload: bytes, *, mapping_name: str,
) -> Generator[ParsedRow, None, FoobarScanResult]:
    """Yield tentative internal rows and return terminal whole-upload evidence.

    A later structural rejection invalidates EVERY previously yielded row.
    Consumers must exhaust this generator, inspect StopIteration.value, and
    discard all attempted outputs on rejection before preview or mutation.
    Stopping early is not validation. Keep the same immutable original bytes
    for another pass; the digest and row ordinals always cover that upload.
    No match, authorization, storage, or external side effect belongs here.
    """
    if type(payload) is not bytes:
        return _rejected("invalid_payload_type")
    if type(mapping_name) is not str or mapping_name != _VERSION:
        return _rejected("unsupported_mapping")
    if len(payload) > MAX_INPUT_BYTES:
        return _rejected("input_too_large")
    digest = sha256(payload).hexdigest()
    if not _valid_utf8(payload):
        return _rejected("invalid_utf8", digest)
    start = 3 if payload.startswith(b"\xef\xbb\xbf") else 0
    if start == len(payload):
        return _rejected("empty_input", digest)

    headers: tuple[str, ...] = ()
    known_columns: tuple[int | None, ...] = ()
    data_rows = 0
    diagnostics: list[Diagnostic] = []
    total_cells = 0
    line = 0
    dirty_rows = 0
    field_errors = 0
    unsupported_fields = 0
    while start < len(payload):
        line += 1
        newline = payload.find(b"\n", start)
        end = len(payload) if newline == -1 else newline
        if newline != -1 and end > start and payload[end - 1] == 13:
            end -= 1
        # Ordered structural phases: record size, NUL, CR, row count,
        # columns, width, total cells, cell bounds, then header/data syntax.
        if end - start > MAX_RECORD_UTF8_BYTES:
            return _rejected("record_too_large", digest, line)
        record = payload[start:end]
        if b"\x00" in record:
            return _rejected("forbidden_nul", digest, line)
        if b"\r" in record:
            return _rejected("invalid_line_ending", digest, line)
        if line > 1 and line - 1 > MAX_DATA_ROWS:
            return _rejected("too_many_rows", digest, line)
        width = record.count(b"\t") + 1
        if width > MAX_COLUMNS:
            return _rejected("too_many_columns", digest, line)
        if line > 1 and width != len(headers):
            return _rejected("invalid_row_width", digest, line)
        if total_cells + width > MAX_TOTAL_CELLS:
            return _rejected("too_many_cells", digest, line)
        total_cells += width
        # At most 64 bounded cells are split for a record. Do not split the
        # entire payload into record/cell arrays in advance.
        raw_cells = record.split(b"\t")
        for column, cell in enumerate(raw_cells):
            if len(cell) > MAX_CELL_UTF8_BYTES:
                return _rejected("cell_too_large", digest, line, column)
        cells = tuple(cell.decode("utf-8") for cell in raw_cells)
        if line == 1:
            seen: set[str] = set()
            for column, name in enumerate(cells):
                if (
                    not name or name != name.strip(" \t")
                    or any(ord(character) < 32 or ord(character) == 127 for character in name)
                ):
                    return _rejected("invalid_header", digest, 1, column)
                if name in seen:
                    return _rejected("duplicate_header", digest, 1, column)
                seen.add(name)
            if "path" not in seen:
                return _rejected("missing_path_header", digest, 1)
            headers = cells
            indices = {name: index for index, name in enumerate(headers)}
            known_columns = tuple(indices.get(name) for name in FIELD_NAMES)
        else:
            if record == b"":
                return _rejected("empty_record", digest, line)
            observations = tuple(
                _observation(name, column, cells)
                for name, column in zip(FIELD_NAMES, known_columns)
            )
            row_errors = 0
            for observation in observations:
                if observation.state not in ("invalid", "unsupported"):
                    continue
                row_errors += 1
                unsupported_fields += observation.state == "unsupported"
                if len(diagnostics) < MAX_DIAGNOSTICS:
                    diagnostics.append(Diagnostic(
                        observation.code, line, observation.column_index,
                    ))
            field_errors += row_errors
            dirty_rows += row_errors > 0
            data_rows += 1
            yield ParsedRow(line - 1, line, cells, observations, row_errors)
        if newline == -1:
            break
        start = newline + 1

    if not data_rows:
        return _rejected("no_data_rows", digest)
    return FoobarScanResult(
        _VERSION, "parsed", digest, headers,
        ParseSummary(
            data_rows, data_rows - dirty_rows, dirty_rows, field_errors,
            unsupported_fields, len(diagnostics), field_errors > MAX_DIAGNOSTICS,
        ),
        tuple(diagnostics),
    )


def parse_foobar_snapshot(payload: bytes, *, mapping_name: str) -> ParseResult:
    """Return the compatible eager tree or an atomic, data-free rejection.

    Bounded import flows use iter_foobar_snapshot_rows instead of this legacy
    collecting API. Both APIs share every decoding and observation rule.
    """
    rows: list[ParsedRow] = []
    iterator = iter_foobar_snapshot_rows(payload, mapping_name=mapping_name)
    while True:
        try:
            row = next(iterator)
        except StopIteration as terminal:
            scan = terminal.value
            break
        rows.append(row)
    return ParseResult(
        scan.contract_version, scan.status, scan.source_sha256, scan.headers,
        tuple(rows) if scan.status == "parsed" else (),
        scan.summary, scan.diagnostics,
    )


class FoobarIndexedUploadClosed(ValueError):
    pass


_INDEX_CONSTRUCTION = object()


@dataclass(frozen=True, slots=True, init=False, repr=False)
class FoobarIndexedUpload:
    """Ephemeral private parser output, not a persisted capability or authority.

    Retains one reference to the original immutable bytes until close. No disk
    copy, serialization, session resurrection, or database permission is implied.
    Confine to its owning worker; close only after its current operation settles.
    """
    _payload: bytes | None
    _spans: tuple
    _counts: tuple
    _terminal: FoobarScanResult | None
    _columns: tuple

    def __init__(self, token=None, *, payload=None, spans=(), counts=(), terminal=None):
        if token is not _INDEX_CONSTRUCTION:
            raise TypeError("Use the admitted upload-index factory.")
        object.__setattr__(self, '_payload', payload)
        object.__setattr__(self, '_spans', spans)
        object.__setattr__(self, '_counts', counts)
        object.__setattr__(self, '_terminal', terminal)
        columns = {name: index for index, name in enumerate(terminal.headers)}
        object.__setattr__(self, '_columns', tuple(columns.get(name) for name in FIELD_NAMES))

    def __reduce_ex__(self, protocol):
        raise TypeError("Upload indexes are ephemeral and cannot be serialized.")

    def _require_open(self):
        if self._payload is None or self._terminal is None:
            raise FoobarIndexedUploadClosed("Original upload must be selected again.")

    @property
    def terminal(self):
        self._require_open()
        return self._terminal

    @property
    def payload_bytes(self):
        self._require_open()
        return len(self._payload)

    def close(self):
        # Dropping our reference cannot erase another authorized caller's bytes.
        # Do not call while a consumer still owns yielded rows.
        object.__setattr__(self, '_payload', None)
        object.__setattr__(self, '_spans', ())
        object.__setattr__(self, '_counts', ())
        object.__setattr__(self, '_columns', ())
        object.__setattr__(self, '_terminal', None)

    def __enter__(self):
        self._require_open()
        return self

    def __exit__(self, *exc):
        self.close()

    def _bounds(self, offset, limit):
        self._require_open()
        if (type(offset) is not int or type(limit) is not int
                or not 0 <= offset < len(self._spans) or not 1 <= limit <= 100):
            raise ValueError("Invalid indexed source window.")
        return min(offset + limit, len(self._spans))

    def iter_window(self, *, offset=0, limit=100):
        """Yield <=100 original rows, then the original complete-scan terminal.

        Only indexed byte ranges are decoded; neither hashing nor UTF-8/full-file
        scans occur here. Row ordinals/line numbers and original schema survive.
        The shared observation decoder is identical to the streaming parser's.
        """
        end = self._bounds(offset, limit)
        for index in range(offset, end):
            self._require_open()
            start, stop = self._spans[index]
            cells = tuple(cell.decode('utf-8') for cell in self._payload[start:stop].split(b'\t'))
            observations = tuple(_observation(name, column, cells)
                                 for name, column in zip(FIELD_NAMES, self._columns))
            errors = sum(item.state in ('invalid', 'unsupported') for item in observations)
            yield ParsedRow(index + 1, index + 2, cells, observations, errors)
        return self.terminal

    def path_counts(self, *, offset=0, limit=100):
        end = self._bounds(offset, limit)
        return self._counts[offset:end]


def _build_validated_upload_index(payload, *, mapping_name):
    """Private parser owner. Caller MUST admit construction before entry.

    One complete genuine parser pass plus linear byte-position bookkeeping.
    Tentative offsets/counts are never returned if late structural input fails.
    Exact strings, not digests, establish whole-upload raw-path equality.
    """
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_INPUT_BYTES:
        raise ValueError("Invalid upload.")
    spans, path_ids, paths, occurrences = [], [], {}, []
    # The canonical parser rejects any unsupported header/line-ending/BOM form.
    newline = payload.find(b'\n')
    position = len(payload) if newline == -1 else newline + 1
    scan = iter_foobar_snapshot_rows(payload, mapping_name=mapping_name)
    try:
        while True:
            try:
                row = next(scan)
            except StopIteration as done:
                terminal = done.value
                break
            newline = payload.find(b'\n', position)
            stop = len(payload) if newline == -1 else newline
            if newline != -1 and stop > position and payload[stop - 1] == 13:
                stop -= 1
            spans.append((position, stop))
            position = len(payload) if newline == -1 else newline + 1
            field = row.fields[0]
            path = row.cells[field.column_index]
            if path == '':
                path_ids.append(None)
            else:
                identity = paths.get(path)
                if identity is None:
                    identity = len(occurrences)
                    paths[path] = identity
                    occurrences.append(0)
                occurrences[identity] += 1
                path_ids.append(identity)
        if (type(terminal) is not FoobarScanResult or terminal.status != 'parsed'
                or len(spans) != terminal.summary.data_rows):
            raise ValueError("Upload failed complete structural validation.")
        counts = tuple(0 if identity is None else occurrences[identity] for identity in path_ids)
        return FoobarIndexedUpload(_INDEX_CONSTRUCTION, payload=payload,
            spans=tuple(spans), counts=counts, terminal=terminal)
    finally:
        scan.close()
