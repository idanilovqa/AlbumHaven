"""Pure, bounded exact-path suggestions over immutable Foobar observations.

The caller supplies direct parser output and a complete authorized inventory.
Structural validation does not certify source truth, authority or availability.
No effective taste, history events, persistence or Apply is implemented here.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import foobar_snapshot_parser as parser


_CONTRACT_VERSION = "foobar_snapshot_preview_v1"
_MATCHER_VERSION = "foobar_exact_path_v1"
_PARSER_VERSION = "foobar_text_tools_snapshot_v1"
_MAX_INVENTORY_ENTRIES = 100_000
_MAX_INVENTORY_BYTES = 67_108_864
_MAX_REFERENCE_BYTES = 128
_MAX_CANDIDATES = 20
_MAX_COUNT = 9_223_372_036_854_775_807
_PATH_FIELD = parser.FIELD_NAMES.index("path")
_COUNTS = frozenset(("play_count", "play_count_enhanced"))
_DATES = frozenset(parser.FIELD_NAMES[13:19])
_HISTORY = frozenset(parser.FIELD_NAMES[22:])
_SPECIAL = _COUNTS | _DATES | _HISTORY | frozenset(("rating", "favorite"))
_STATES = ("absent", "empty", "unavailable", "valid", "invalid", "unsupported")
_EVIDENCE_FIELDS = (
    ("rating", "source_taste_observation"),
    ("play_count", "aggregate_count"),
    ("play_count_enhanced", "aggregate_count"),
    ("first_played", "raw_date_boundary"),
    ("last_played", "raw_date_boundary"),
    ("added", "raw_date_boundary"),
    ("first_played_enhanced", "raw_date_boundary"),
    ("last_played_enhanced", "raw_date_boundary"),
    ("added_enhanced", "raw_date_boundary"),
    ("favorite", "source_taste_observation"),
    ("played_times", "local_history_field_unparsed"),
    ("played_times_js", "local_history_field_unparsed"),
    ("played_times_raw", "local_history_field_unparsed"),
    ("lastfm_played_times_js", "lastfm_history_field_unparsed"),
    ("lastfm_play_count", "lastfm_count_field_unparsed"),
)


@dataclass(frozen=True, slots=True)
class InventoryEntry:
    file_ref: str
    canonical_track_ref: str
    path: str
    identity_conflict: bool


@dataclass(frozen=True, slots=True)
class EvidenceLabel:
    field_name: str
    category: str
    state: str


@dataclass(frozen=True, slots=True)
class PreviewRow:
    ordinal: int
    line_number: int
    source_row: parser.ParsedRow
    match_status: str
    suggested_track_ref: str | None
    candidate_refs: tuple[str, ...]
    candidate_count: int
    candidates_truncated: bool
    duplicate_target_group: str | None
    evidence_labels: tuple[EvidenceLabel, ...]


@dataclass(frozen=True, slots=True)
class PreviewSummary:
    rows_total: int
    exact_unique_rows: int
    ambiguous_rows: int
    unmatched_rows: int
    identity_conflict_rows: int
    duplicate_target_groups: int
    duplicate_target_rows: int
    rows_with_field_errors: int
    unsupported_nonempty_field_count: int


@dataclass(frozen=True, slots=True)
class PreviewReport:
    contract_version: str
    matcher_version: str
    status: str
    reason: str | None
    parser_version: str | None
    source_sha256: str | None
    inventory_revision: str | None
    rows: tuple[PreviewRow, ...]
    summary: PreviewSummary


def _utf8_size(value: object, limit: int, *, nonempty: bool = False) -> int | None:
    # Character bounds come first, so encoding never copies an unbounded value.
    if type(value) is not str or len(value) > limit or (nonempty and not value):
        return None
    try:
        size = len(value.encode("utf-8", "strict"))
    except UnicodeEncodeError:
        return None
    return size if size <= limit else None


def _rejected(reason: str) -> PreviewReport:
    return PreviewReport(
        _CONTRACT_VERSION, _MATCHER_VERSION, "rejected", reason,
        None, None, None, (), PreviewSummary(0, 0, 0, 0, 0, 0, 0, 0, 0),
    )


def _valid_observation(
    observation: object, name: str, column: int | None, cells: tuple[str, ...],
) -> bool:
    if type(observation) is not parser.FieldObservation:
        return False
    state = observation.state
    if type(state) is not str or state not in _STATES:
        return False
    if column is None:
        return (
            observation.column_index is None and state == "absent"
            and observation.value is None and observation.code is None
        )
    if type(observation.column_index) is not int or observation.column_index != column:
        return False
    if state == "absent":
        return False
    raw = cells[column]
    if name not in _SPECIAL:
        if not raw:
            return state == "empty" and observation.value is None and observation.code is None
        return (
            state == "valid" and type(observation.value) is str
            and observation.value == raw and observation.code is None
        )
    if name in _HISTORY and state not in ("empty", "unavailable", "unsupported"):
        return False
    if state in ("empty", "unavailable"):
        return observation.value is None and observation.code is None
    if state in ("invalid", "unsupported"):
        return observation.value is None and _utf8_size(
            observation.code, _MAX_REFERENCE_BYTES, nonempty=True,
        ) is not None
    if observation.code is not None:
        return False
    value = observation.value
    if name == "rating":
        return type(value) is int and 1 <= value <= 5
    if name == "favorite":
        return type(value) is bool
    if name in _COUNTS:
        return type(value) is int and 0 <= value <= _MAX_COUNT
    # Dates stay raw strings. Numeric, date and history text is never reparsed.
    return type(value) is str and value == raw


def _parser_error(parsed: object) -> str | None:
    if type(parsed) is not parser.ParseResult or type(parsed.contract_version) is not str:
        return "invalid_input"
    if parsed.contract_version != _PARSER_VERSION:
        return "unsupported_parser_version"
    if type(parsed.status) is not str or parsed.status not in ("parsed", "rejected"):
        return "invalid_input"
    digest = parsed.source_sha256
    if digest is not None and (
        type(digest) is not str or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        return "invalid_input"
    if parsed.status == "parsed" and digest is None:
        return "invalid_input"
    if (
        type(parsed.headers) is not tuple or type(parsed.rows) is not tuple
        or type(parsed.diagnostics) is not tuple or type(parsed.summary) is not parser.ParseSummary
    ):
        return "invalid_input"
    summary = parsed.summary
    counts = (
        summary.data_rows, summary.rows_without_field_errors, summary.rows_with_field_errors,
        summary.field_error_count, summary.unsupported_nonempty_field_count, summary.diagnostic_count,
    )
    if any(type(value) is not int or value < 0 for value in counts):
        return "invalid_input"
    if type(summary.diagnostics_truncated) is not bool:
        return "invalid_input"
    if parsed.status == "rejected":
        if (
            parsed.headers or parsed.rows or counts != (0, 0, 0, 0, 0, 1)
            or summary.diagnostics_truncated or len(parsed.diagnostics) != 1
        ):
            return "invalid_input"
        diagnostic = parsed.diagnostics[0]
        if type(diagnostic) is not parser.Diagnostic:
            return "invalid_input"
        if _utf8_size(diagnostic.code, _MAX_REFERENCE_BYTES, nonempty=True) is None:
            return "invalid_input"
        if diagnostic.line_number is not None and (
            type(diagnostic.line_number) is not int or diagnostic.line_number < 1
        ):
            return "invalid_input"
        if diagnostic.column_index is not None and (
            type(diagnostic.column_index) is not int or diagnostic.column_index < 0
        ):
            return "invalid_input"
        return "parser_rejected"

    width, row_count = len(parsed.headers), len(parsed.rows)
    if (
        not 1 <= width <= parser.MAX_COLUMNS or not 1 <= row_count <= parser.MAX_DATA_ROWS
        or (row_count + 1) * width > parser.MAX_TOTAL_CELLS
        or len(parsed.diagnostics) > parser.MAX_DIAGNOSTICS
    ):
        return "invalid_input"
    columns: dict[str, int] = {}
    header_bytes = width - 1
    for column, name in enumerate(parsed.headers):
        size = _utf8_size(name, parser.MAX_CELL_UTF8_BYTES, nonempty=True)
        if size is None:
            return "invalid_input"
        if (
            name != name.strip(" \t") or name in columns
            or any(ord(character) < 32 or ord(character) == 127 for character in name)
        ):
            return "invalid_input"
        columns[name] = column
        header_bytes += size
    if "path" not in columns or header_bytes > parser.MAX_RECORD_UTF8_BYTES:
        return "invalid_input"
    named_columns = tuple(columns.get(name) for name in parser.FIELD_NAMES)
    # One LF between records is the minimum reconstructible source overhead.
    total_bytes = header_bytes + row_count
    dirty_rows = field_errors = unsupported_fields = 0
    diagnostic_count = len(parsed.diagnostics)
    for ordinal, row in enumerate(parsed.rows, 1):
        if type(row) is not parser.ParsedRow:
            return "invalid_input"
        if (
            type(row.ordinal) is not int or row.ordinal != ordinal
            or type(row.line_number) is not int or row.line_number != ordinal + 1
            or type(row.cells) is not tuple or len(row.cells) != width
            or type(row.fields) is not tuple or len(row.fields) != len(parser.FIELD_NAMES)
            or type(row.field_error_count) is not int or row.field_error_count < 0
        ):
            return "invalid_input"
        record_bytes = width - 1
        for cell in row.cells:
            size = _utf8_size(cell, parser.MAX_CELL_UTF8_BYTES)
            if size is None:
                return "invalid_input"
            record_bytes += size
        if record_bytes == 0 or record_bytes > parser.MAX_RECORD_UTF8_BYTES:
            return "invalid_input"
        total_bytes += record_bytes
        if total_bytes > parser.MAX_INPUT_BYTES:
            return "invalid_input"
        row_errors = 0
        for name, column, observation in zip(parser.FIELD_NAMES, named_columns, row.fields):
            if not _valid_observation(observation, name, column, row.cells):
                return "invalid_input"
            if observation.state not in ("invalid", "unsupported"):
                continue
            if field_errors < parser.MAX_DIAGNOSTICS:
                if field_errors >= diagnostic_count:
                    return "invalid_input"
                diagnostic = parsed.diagnostics[field_errors]
                if (
                    type(diagnostic) is not parser.Diagnostic
                    or type(diagnostic.code) is not str
                    or type(diagnostic.line_number) is not int
                    or type(diagnostic.column_index) is not int
                    or diagnostic.code != observation.code
                    or diagnostic.line_number != row.line_number
                    or diagnostic.column_index != column
                ):
                    return "invalid_input"
            row_errors += 1
            field_errors += 1
            unsupported_fields += int(observation.state == "unsupported")
        if row.field_error_count != row_errors:
            return "invalid_input"
        dirty_rows += int(row_errors > 0)
    expected_diagnostics = min(field_errors, parser.MAX_DIAGNOSTICS)
    if (
        counts != (row_count, row_count - dirty_rows, dirty_rows, field_errors,
                   unsupported_fields, expected_diagnostics)
        or diagnostic_count != expected_diagnostics
        or summary.diagnostics_truncated != (field_errors > parser.MAX_DIAGNOSTICS)
    ):
        return "invalid_input"
    return None


def _inventory_error(inventory: object, revision: object) -> str | None:
    if type(inventory) is not tuple:
        return "invalid_inventory"
    if _utf8_size(revision, _MAX_REFERENCE_BYTES, nonempty=True) is None:
        return "invalid_inventory_revision"
    if len(inventory) > _MAX_INVENTORY_ENTRIES:
        return "inventory_too_large"
    total_bytes = 0
    # Finish scalar validation before detecting duplicates or aggregate overflow.
    for entry in inventory:
        if type(entry) is not InventoryEntry or type(entry.identity_conflict) is not bool:
            return "invalid_inventory"
        for value, limit in (
            (entry.file_ref, _MAX_REFERENCE_BYTES),
            (entry.canonical_track_ref, _MAX_REFERENCE_BYTES),
            (entry.path, parser.MAX_CELL_UTF8_BYTES),
        ):
            size = _utf8_size(value, limit, nonempty=True)
            if size is None:
                return "invalid_inventory"
            total_bytes += size
    file_refs: set[str] = set()
    for entry in inventory:
        if entry.file_ref in file_refs:
            return "invalid_inventory"
        file_refs.add(entry.file_ref)
    if total_bytes > _MAX_INVENTORY_BYTES:
        return "inventory_too_large"
    return None


def _path_projections(
    inventory: tuple[InventoryEntry, ...],
) -> dict[str, tuple[str, tuple[str, ...], int, bool, str | None]]:
    by_path: dict[str, set[str]] = {}
    conflicts: set[str] = set()
    for entry in inventory:
        if entry.path not in by_path:
            by_path[entry.path] = set()
        by_path[entry.path].add(entry.canonical_track_ref)
        if entry.identity_conflict:
            conflicts.add(entry.path)
    projections = {}
    for path, references in by_path.items():
        count = len(references)
        candidates = tuple(sorted(references)[:_MAX_CANDIDATES])
        if path in conflicts:
            status = "identity_conflict"
        else:
            status = "exact_unique" if count == 1 else "ambiguous"
        suggested = candidates[0] if status == "exact_unique" else None
        projections[path] = (status, candidates, count, count > _MAX_CANDIDATES, suggested)
    return projections


def build_foobar_preview(
    parsed: parser.ParseResult, *, inventory: tuple[InventoryEntry, ...], inventory_revision: str,
) -> PreviewReport:
    """Preserve source observations with deterministic, uncommitted suggestions."""
    reason = _parser_error(parsed)
    if reason is not None:
        return _rejected(reason)
    reason = _inventory_error(inventory, inventory_revision)
    if reason is not None:
        return _rejected(reason)
    projections = _path_projections(inventory)
    target_counts: dict[str, int] = {}
    for row in parsed.rows:
        path = row.cells[row.fields[_PATH_FIELD].column_index]
        projection = projections.get(path) if path else None
        if projection is not None and projection[0] == "exact_unique":
            target = projection[4]
            target_counts[target] = target_counts.get(target, 0) + 1
    duplicate_sizes = tuple(count for count in target_counts.values() if count >= 2)
    evidence_fields = tuple(
        (parser.FIELD_NAMES.index(name), name, category)
        for name, category in _EVIDENCE_FIELDS if name in parsed.headers
    )
    rows: list[PreviewRow] = []
    match_counts = {"exact_unique": 0, "ambiguous": 0, "unmatched": 0, "identity_conflict": 0}
    for row in parsed.rows:
        path = row.cells[row.fields[_PATH_FIELD].column_index]
        projection = projections.get(path) if path else None
        if projection is None:
            status, candidates, count, truncated, suggested = "unmatched", (), 0, False, None
        else:
            status, candidates, count, truncated, suggested = projection
        duplicate = suggested if suggested is not None and target_counts[suggested] >= 2 else None
        labels = tuple(
            EvidenceLabel(name, category, row.fields[index].state)
            for index, name, category in evidence_fields
        )
        rows.append(PreviewRow(
            row.ordinal, row.line_number, row, status, suggested,
            candidates, count, truncated, duplicate, labels,
        ))
        match_counts[status] += 1
    summary = PreviewSummary(
        len(rows), match_counts["exact_unique"], match_counts["ambiguous"],
        match_counts["unmatched"], match_counts["identity_conflict"],
        len(duplicate_sizes), sum(duplicate_sizes), parsed.summary.rows_with_field_errors,
        parsed.summary.unsupported_nonempty_field_count,
    )
    return PreviewReport(
        _CONTRACT_VERSION, _MATCHER_VERSION, "ready", None, _PARSER_VERSION,
        parsed.source_sha256, inventory_revision, tuple(rows), summary,
    )
