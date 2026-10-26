"""Real bounded preview service. No source UUID, receipt, mutation or raw retention."""
from __future__ import annotations

from collections.abc import Mapping
import json
import threading

from music_app.services import foobar_snapshot_parser as parser
from music_app.services.foobar_snapshot_preview import _path_projections, _EVIDENCE_FIELDS
from music_app.services.foobar_import_preparation import (
    FoobarIntakeCapacity, _inventory_reservation,
)
from music_app.services.foobar_preview_inventory_postgres import read_foobar_inventory_scalars_on_connection
from music_app.services.foobar_preview_inventory_bridge import read_foobar_preview_inventory_on_connection
from music_app.services.foobar_import_policy import evaluate_foobar_track_policy
from music_app.services.private_library_authority import current_library_transaction, PrivateLibraryAuthorityError
from music_app.services.runtime_shutdown import create_daemon_executor

PROTOCOL = "foobar_preview_v1"
MAPPING = "foobar_text_tools_snapshot_v1"
MAX_INPUT_BYTES = 67_108_864
MAX_RESPONSE_BYTES = 262_144
MAX_WINDOW_ROWS = 100
PARSER_WORK_BYTES = 25_165_824
SCALAR_WORK_BYTES = 73_200_004
PUBLIC_WORK_BYTES = 4_194_304
_PATH = parser.FIELD_NAMES.index("path")


class FoobarPreviewError(RuntimeError):
    def __init__(self, code="preview_unavailable", status_code=503):
        self.code = code
        self.status_code = status_code
        super().__init__("Foobar preview is unavailable.")


def _wire(value):
    # Fixed public grammar proves <=204096 before construction/encoding.
    encoded = json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("ascii")
    if len(encoded) > MAX_RESPONSE_BYTES:
        raise FoobarPreviewError()
    return encoded


def error_wire(code):
    return _wire({"protocol": PROTOCOL, "error": code})


def capabilities(service, context_ref):
    return {
        "protocol": PROTOCOL, "context_ref": context_ref,
        "status": "available" if type(service) is FoobarPreviewService and service.available else "unavailable",
        "mapping": MAPPING, "max_input_bytes": MAX_INPUT_BYTES,
        "max_response_bytes": MAX_RESPONSE_BYTES, "max_window_rows": MAX_WINDOW_ROWS,
    }


def _admit(capacity, size):
    if type(size) is not int or size < 0 or size > capacity.logical_bytes:
        raise FoobarPreviewError("preview_capacity_unavailable")


def _match(row, projections):
    path = row.cells[row.fields[_PATH].column_index]
    return projections.get(path) if path else None


def _scan(payload, projections, *, offset=None, counts=None):
    """Consume to the typed terminal result; never return tentative rows."""
    stream = parser.iter_foobar_snapshot_rows(payload, mapping_name=MAPPING)
    matches = {"exact_unique": 0, "ambiguous": 0, "unmatched": 0, "identity_conflict": 0}
    target_counts = {} if counts is None else counts
    output = []
    try:
        while True:
            try:
                row = next(stream)
            except StopIteration as finished:
                terminal = finished.value
                break
            projection = _match(row, projections)
            status, candidates, count, truncated, suggested = (
                projection if projection is not None else ("unmatched", (), 0, False, None)
            )
            matches[status] += 1
            if counts is None and status == "exact_unique":
                # At most one key per actual inventory target, never per raw row.
                target_counts[suggested] = target_counts.get(suggested, 0) + 1
            if offset is not None and offset < row.ordinal <= offset + MAX_WINDOW_ROWS:
                fields = []
                for name, category in _EVIDENCE_FIELDS:
                    field = row.fields[parser.FIELD_NAMES.index(name)]
                    if field.column_index is not None:
                        fields.append({"name": name, "category": category, "state": field.state})
                output.append({
                    "ordinal": row.ordinal, "line_number": row.line_number,
                    "match_status": status, "candidate_count": count,
                    "candidates_truncated": truncated,
                    "duplicate_target": suggested is not None and target_counts.get(suggested, 0) >= 2,
                    "fields": fields,
                })
        if type(terminal) is not parser.FoobarScanResult or terminal.status != "parsed":
            raise FoobarPreviewError("preview_invalid", 400)
        return terminal, matches, target_counts, output
    finally:
        stream.close()


def _preview(database_url, context, payload, offset, constraints, capacity, context_ref):
    # Five original-byte occurrences cover worker/build/scan/generator/UTF8 calls;
    # generator/header/record/old-new/terminal owners use a separate fixed ledger.
    _admit(capacity, 5 * len(payload) + PARSER_WORK_BYTES + SCALAR_WORK_BYTES + PUBLIC_WORK_BYTES)
    with current_library_transaction(
        database_url, context, constraints=constraints, inventory_publication_first=True,
    ) as (connection, live, sampled_now):
        preliminary = read_foobar_inventory_scalars_on_connection(connection, live, constraints=constraints)
        inventory_cost = _inventory_reservation(len(preliminary), sum(x.path_bytes for x in preliminary))
        _admit(capacity, 5 * len(payload) + PARSER_WORK_BYTES + inventory_cost + PUBLIC_WORK_BYTES)
        inventory = read_foobar_preview_inventory_on_connection(
            connection, live, constraints=constraints, expected_files=preliminary,
        )
        projections = _path_projections(inventory.inventory)
        first, matches, target_counts, unused = _scan(payload, projections)
        del unused
        if offset >= first.summary.data_rows:
            raise FoobarPreviewError("preview_invalid", 400)
        second, second_matches, same_counts, rows = _scan(
            payload, projections, offset=offset, counts=target_counts,
        )
        if first != second or matches != second_matches or same_counts is not target_counts:
            raise FoobarPreviewError()
        current = read_foobar_inventory_scalars_on_connection(connection, live, constraints=constraints)
        if current != inventory.files:
            raise FoobarPreviewError()
        for target in inventory.targets:
            policy = evaluate_foobar_track_policy(live, track_id=target.track_id, constraints=constraints)
            if (policy.browse_allowed, policy.taste_allowed) != (target.browse_allowed, target.taste_allowed):
                raise FoobarPreviewError()
        summary = {
            "rows_total": first.summary.data_rows,
            "exact_unique_rows": matches["exact_unique"], "ambiguous_rows": matches["ambiguous"],
            "unmatched_rows": matches["unmatched"], "identity_conflict_rows": matches["identity_conflict"],
            "duplicate_target_groups": sum(count >= 2 for count in target_counts.values()),
            "duplicate_target_rows": sum(count for count in target_counts.values() if count >= 2),
            "rows_with_field_errors": first.summary.rows_with_field_errors,
            "unsupported_nonempty_field_count": first.summary.unsupported_nonempty_field_count,
        }
        next_offset = offset + len(rows)
        body = _wire({
            "protocol": PROTOCOL, "status": "preview_only", "mapping": MAPPING, "context_ref": context_ref,
            "source_sha256": first.source_sha256, "inventory_revision": inventory.revision,
            "offset": offset, "total_rows": first.summary.data_rows,
            "returned_rows": len(rows),
            "next_offset": next_offset if next_offset < first.summary.data_rows else None,
            "summary": summary, "rows": rows,
        })
    return body


class _UploadLease:
    """Heavy-work slot survives both request cancellation and worker execution."""
    def __init__(self, service, declared_bytes):
        self.service = service
        self.declared_bytes = declared_bytes
        self.buffer = bytearray()
        self.payload = None
        self.submitted = False
        self.worker_done = False
        self.request_done = False
        self.released = False
        self.lock = threading.Lock()

    def append(self, chunk):
        if len(self.buffer) + len(chunk) > self.declared_bytes:
            raise FoobarPreviewError("preview_too_large", 413)
        self.buffer.extend(chunk)

    def finish_upload(self):
        if len(self.buffer) != self.declared_bytes:
            raise FoobarPreviewError("preview_invalid", 400)
        self.payload = bytes(self.buffer)
        self.buffer = None

    def finish_request(self):
        with self.lock:
            self.request_done = True
            self.buffer = None
            if not self.submitted:
                self.payload = None
                self.worker_done = True
            self._release_if_done()

    def finish_worker(self, future):
        with self.lock:
            # A cancelled queued job never consumed its payload.
            self.payload = None
            self.worker_done = True
            self._release_if_done()

    def _release_if_done(self):
        if self.request_done and self.worker_done and not self.released:
            self.released = True
            self.service.slots.release()


class FoobarPreviewService:
    def __init__(self, database_url, *, intake_bytes, max_concurrent):
        self.database_url = database_url
        self.capacity = FoobarIntakeCapacity(intake_bytes)
        self.slots = threading.BoundedSemaphore(max_concurrent)
        self.executor = create_daemon_executor(max_workers=max_concurrent, thread_name_prefix="foobar-preview")
        self.available = True

    def acquire(self, declared_bytes):
        if not self.available:
            raise FoobarPreviewError()
        _admit(self.capacity, max(
            5 * declared_bytes + PARSER_WORK_BYTES,
            5 * declared_bytes + PARSER_WORK_BYTES + SCALAR_WORK_BYTES + PUBLIC_WORK_BYTES,
        ))
        if not self.slots.acquire(blocking=False):
            raise FoobarPreviewError("preview_busy")
        try:
            return _UploadLease(self, declared_bytes)
        except BaseException:
            self.slots.release()
            raise

    def submit(self, lease, context, offset, constraints, context_ref):
        with lease.lock:
            lease.submitted = True
            try:
                future = self.executor.submit(self._run, lease, context, offset, constraints, context_ref)
            except BaseException:
                lease.submitted = False
                raise
        future.add_done_callback(lease.finish_worker)
        return future

    def _run(self, lease, context, offset, constraints, context_ref):
        payload = lease.payload
        lease.payload = None
        # Normalize resolver exceptions before the authority owner can mistake a
        # resolver-raised permission exception for an explicit denial.
        def checked_constraints(target):
            try:
                return constraints(target) if callable(constraints) else constraints
            except Exception:
                raise FoobarPreviewError() from None
        try:
            result = (200, _preview(
                self.database_url, context, payload, offset, checked_constraints, self.capacity, context_ref,
            ))
        except FoobarPreviewError as error:
            result = (error.status_code, error_wire(error.code))
        except PrivateLibraryAuthorityError:
            result = (403, error_wire("preview_denied"))
        except Exception:
            # Do not retain raw payload via an exception traceback in the Future.
            result = (503, error_wire("preview_unavailable"))
        finally:
            del payload
        return result

    def shutdown(self):
        self.available = False
        self.executor.shutdown(wait=False, cancel_futures=True)


def create_foobar_preview_service(config):
    """Actual server factory; absent/invalid values disable without defaults."""
    if not isinstance(config, Mapping):
        return None
    raw_bytes = config.get("ALBUM_HAVEN_FOOBAR_PREVIEW_INTAKE_BYTES")
    raw_count = config.get("ALBUM_HAVEN_FOOBAR_PREVIEW_MAX_CONCURRENT")
    database_url = config.get("ALBUM_HAVEN_APP_DATABASE_URL")
    def positive_integer(value):
        if type(value) is int:
            return value
        if type(value) is str and 1 <= len(value) <= 19 and value.isascii() and value.isdecimal() and not value.startswith("0"):
            return int(value)
        return 0
    intake_bytes, max_concurrent = positive_integer(raw_bytes), positive_integer(raw_count)
    # Even the minimal valid path-only file and an empty inventory must fit the
    # actual complete formula, otherwise advertising availability is misleading.
    minimum = PARSER_WORK_BYTES + _inventory_reservation(0, 0) + PUBLIC_WORK_BYTES + 30
    if (
        not minimum <= intake_bytes <= 9223372036854775807
        or not 1 <= max_concurrent <= 8
        or type(database_url) is not str or not database_url.strip()
    ):
        return None
    return FoobarPreviewService(database_url, intake_bytes=intake_bytes, max_concurrent=max_concurrent)

