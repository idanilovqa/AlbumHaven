"""Fresh internal preparation transaction, never a durable ready receipt.

The server factory must supply an admitted intake capacity. No route, factory
configuration, persistence, upload retention or Apply success is supplied here.
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from music_app.services import foobar_snapshot_parser as parser
from music_app.services.foobar_snapshot_preview import build_foobar_preview
from music_app.services.foobar_import_policy import evaluate_foobar_track_policy
from music_app.services.foobar_preview_inventory_postgres import (
    FoobarInventoryUnavailable, read_foobar_inventory_scalars_on_connection,
)
from music_app.services.foobar_preview_inventory_bridge import (
    read_foobar_preview_inventory_on_connection,
)
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.track_preferences_postgres import (
    FoobarTasteUnavailable, read_foobar_taste_on_connection,
    _foobar_taste_phase_bytes,
)


class FoobarPreparationRejected(ValueError):
    code = "invalid_import_request"
    status_code = 400
    retryable = False

    def __init__(self):
        super().__init__("Foobar preparation input is invalid.")


@dataclass(frozen=True, slots=True)
class FoobarIntakeCapacity:
    """Server factory configuration only, never a request DTO or capability."""

    logical_bytes: int


@dataclass(frozen=True, slots=True)
class FoobarCandidateWindow:
    """Internal immutable observations, not authorization or durable readiness."""

    source_sha256: str
    inventory_revision: str
    offset: int
    total_rows: int
    rows: tuple
    targets: tuple
    taste_states: tuple


def _admit(capacity, required):
    # Missing/unconfigured factory fails before parser/database allocations.
    if (
        type(capacity) is not FoobarIntakeCapacity
        or type(capacity.logical_bytes) is not int
        or capacity.logical_bytes <= 0
        or type(required) is not int or required < 0
        or required > capacity.logical_bytes
    ):
        raise FoobarInventoryUnavailable()


def _parser_reservation(payload):
    """Conservative logical views, no decoding or copied record allocation."""
    n = min(parser.MAX_DATA_ROWS, payload.count(b"\n") + 1)
    cells = min(parser.MAX_TOTAL_CELLS, len(payload) + 1)
    # Cells and string-valued observations each charge the complete input once.
    # 128 bounds each fixed observation envelope excluding its string value.
    # Header/diagnostic/summary and one serial record/decoder workspace are fixed.
    tree = 12 * len(payload) + 3 * cells + (128 * 27 + 128) * n + 1_048_576
    return tree


def _inventory_reservation(file_count, path_bytes):
    """Complete N3 owners plus matcher maps and later full scalar fence."""
    n = file_count
    scalar = 132 * n + 2
    entries = 204 * n + 6 * path_bytes + 2
    target_map_and_tuple = (135 + 113) * n + 4
    # A whole scalar reader can reach the published maximum before comparison.
    scalar_reader = 73_200_004
    # N3 list/tuple, both scalar snapshots, targets and path projection owners.
    # Batch <=100; raw result <=80+6*b; path total per batch <=100*16384.
    batch = 132 * 100 + 2
    frame = 5 * (64 + 115 * 100) + 2
    raw_paths = 2 * (2 + 81 * 100 + 6 * 100 * 16384)
    bridge = (
        2 * scalar + 2 * entries + target_map_and_tuple
        + scalar_reader + batch + frame + raw_paths + 1_048_576
    )
    # Published matcher retains by_path, conflict set, projections and a sorted
    # current reference list. Each path occurrence is independently charged.
    matcher = 18 * path_bytes + 1024 * n + 1_048_576
    # The preliminary scalar tuple remains owned by this caller throughout.
    return scalar + bridge + matcher + 202 * n + 2


def _row_reservation(row):
    # No copied cells, JSON encoding or per-row dictionary is needed to count.
    # A UTF-8 encoding for one cell is temporary and separately reserved.
    raw = sum(len(cell.encode("utf-8")) for cell in row.source_row.cells)
    return 12 * raw + 3 * len(row.source_row.cells) + 128 * 27 + 4096


def inspect_foobar_candidate_window(
    database_url, context, *, payload, mapping_name, source_ref,
    offset=0, constraints=None, intake_capacity=None,
):
    """Actual locked read transaction; no receipt, storage callback or mutation.

    The future service factory must supply intake_capacity from server-owned
    deployment admission. Request values must never choose it. Its construction
    and route integration are intentionally absent and therefore fail closed.
    """
    _admit(intake_capacity, 0)
    if (
        type(payload) is not bytes or len(payload) > parser.MAX_INPUT_BYTES
        or type(mapping_name) is not str
        or mapping_name != "foobar_text_tools_snapshot_v1"
        or type(offset) is not int or not 0 <= offset < parser.MAX_DATA_ROWS
        or type(source_ref) is not str or len(source_ref) != 36
    ):
        raise FoobarPreparationRejected()
    try:
        if str(UUID(source_ref)) != source_ref:
            raise FoobarPreparationRejected()
    except (ValueError, AttributeError):
        raise FoobarPreparationRejected() from None

    p = _parser_reservation(payload)
    # Raw caller payload survives every nested call. Two parser tree views cover
    # parser list/tuple construction; fixed serial parser workspace is in p.
    _admit(intake_capacity, len(payload) + 2 * p)
    parsed = parser.parse_foobar_snapshot(payload, mapping_name=mapping_name)
    if parsed.status != "parsed" or offset >= len(parsed.rows):
        raise FoobarPreparationRejected()
    # Complete parser tree remains live during preliminary fixed scalar read.
    _admit(intake_capacity, len(payload) + 2 * p + 73_200_004 + 1_048_576)

    with current_library_transaction(
        database_url, context, constraints=constraints,
        inventory_publication_first=True,
    ) as (connection, live, sampled_now):
        preliminary = read_foobar_inventory_scalars_on_connection(
            connection, live, constraints=constraints,
        )
        n = len(preliminary)
        path_bytes = sum(row.path_bytes for row in preliminary)
        inventory_bytes = _inventory_reservation(n, path_bytes)
        # Preview source_row occurrences and construction/final report holders
        # are charged separately from the retained ParseResult.
        preview_bytes = 2 * p + 16384 * len(parsed.rows) + 1_048_576
        complete = len(payload) + p + inventory_bytes + preview_bytes
        _admit(intake_capacity, complete + 4_194_304 + _foobar_taste_phase_bytes(100))
        inventory = read_foobar_preview_inventory_on_connection(
            connection, live, constraints=constraints, expected_files=preliminary,
        )
        if inventory.files != preliminary:
            raise FoobarInventoryUnavailable()
        report = build_foobar_preview(
            parsed, inventory=inventory.inventory,
            inventory_revision=inventory.revision,
        )
        if report.status != "ready":
            raise FoobarInventoryUnavailable()

        # Mapping is from the actual complete bridge, never an opaque-ID parse.
        target_by_ref = {
            target.canonical_track_ref: target for target in inventory.targets
        }
        chosen = []
        targets = []
        track_ids = []
        private_bytes = 32768 + _foobar_taste_phase_bytes(100)
        for index in range(offset, min(len(report.rows), offset + 100)):
            row = report.rows[index]
            cost = 2 * (_row_reservation(row) + 512)
            if private_bytes + cost > 4_194_304:
                break
            private_bytes += cost
            target = None
            # Ambiguity and duplicates remain own-source evidence, not implicit
            # canonical overwrite decisions. No invalid count/date rejects taste.
            if row.match_status == "exact_unique" and row.duplicate_target_group is None:
                target = target_by_ref.get(row.suggested_track_ref)
                if target is None:
                    raise FoobarInventoryUnavailable()
                if target.track_id in track_ids:
                    raise FoobarInventoryUnavailable()
                track_ids.append(target.track_id)
            chosen.append(row)
            targets.append(target)
        if not chosen:
            raise FoobarInventoryUnavailable()

        states = read_foobar_taste_on_connection(
            connection, live, source_ref=source_ref,
            track_ids=tuple(track_ids), constraints=constraints,
        )
        current = read_foobar_inventory_scalars_on_connection(
            connection, live, constraints=constraints,
        )
        if current != inventory.files:
            raise FoobarInventoryUnavailable()
        for target in inventory.targets:
            policy = evaluate_foobar_track_policy(
                live, track_id=target.track_id, constraints=constraints,
            )
            if (policy.browse_allowed, policy.taste_allowed) != (
                target.browse_allowed, target.taste_allowed,
            ):
                raise FoobarInventoryUnavailable()
        # Every canonical state must agree with the independently captured map.
        for state in states:
            target = next(t for t in targets if t is not None and t.track_id == state.track_id)
            if (
                state.selection_status != target.selection_status
                or state.browse_allowed != target.browse_allowed
                or state.taste_allowed != target.taste_allowed
            ):
                raise FoobarTasteUnavailable("Foobar taste is unavailable.")
        result = FoobarCandidateWindow(
            parsed.source_sha256, inventory.revision, offset, len(parsed.rows),
            tuple(chosen), tuple(targets), states,
        )
    # Only successful exit from the real transaction exposes the private result.
    # Full caller-owned upload is not claimed released by this helper.
    return result

