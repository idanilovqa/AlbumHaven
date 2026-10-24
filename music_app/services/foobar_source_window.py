"""Complete-upload, bounded selected-window raw-path ambiguity proof.

This is private intake evidence, not authorization, a receipt, a canonical taste
decision or additive listening history. Both scans finish before a proof returns.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import foobar_snapshot_parser as parser
from . import foobar_source_evidence as evidence
from .foobar_import_preparation import FoobarPreparationRejected, _admit

VERSION = "foobar_source_window_v1"
MAPPING = "foobar_text_tools_snapshot_v1"
MAX_WINDOW_ROWS = 100
# Same complete two-scan parser owner as the accepted preview service.
PARSER_WORK_BYTES = 25_165_824
# JSON-logical worst case: control-character escaping is six bytes per raw byte.
PATH_VECTOR_BYTES = 1 + MAX_WINDOW_ROWS * (6 * parser.MAX_CELL_UTF8_BYTES + 3)
PATH_COUNT_MAP_BYTES = 1 + MAX_WINDOW_ROWS * (6 * parser.MAX_CELL_UTF8_BYTES + 10)
COUNT_VECTOR_BYTES = 1 + 7 * MAX_WINDOW_ROWS
WINDOW_WORK_BYTES = (
    3 * PATH_VECTOR_BYTES + PATH_COUNT_MAP_BYTES + 2 * COUNT_VECTOR_BYTES + 32768
)


@dataclass(frozen=True, slots=True)
class FoobarSourceWindowProof:
    source_sha256: str
    offset: int
    total_rows: int
    paths: tuple[str, ...]
    raw_path_row_counts: tuple[int, ...]


def source_window_intake_bytes(payload_bytes):
    if type(payload_bytes) is not int or not 1 <= payload_bytes <= parser.MAX_INPUT_BYTES:
        raise FoobarPreparationRejected()
    return 5 * payload_bytes + PARSER_WORK_BYTES + WINDOW_WORK_BYTES


def _terminal(value):
    if type(value) is not parser.FoobarScanResult or value.status != "parsed":
        raise FoobarPreparationRejected()
    return value


def _path(row):
    # Only called on actual rows yielded by the shared parser in this module.
    field = row.fields[0]
    return row.cells[field.column_index]


def _first_scan(payload, offset):
    paths = []
    iterator = parser.iter_foobar_snapshot_rows(payload, mapping_name=MAPPING)
    try:
        while True:
            try:
                row = next(iterator)
            except StopIteration as completed:
                terminal = _terminal(completed.value)
                break
            if offset < row.ordinal <= offset + MAX_WINDOW_ROWS:
                paths.append(_path(row))
        if offset >= terminal.summary.data_rows:
            raise FoobarPreparationRejected()
        if len(paths) != min(MAX_WINDOW_ROWS, terminal.summary.data_rows-offset):
            raise evidence.SourceEvidenceError()
        return tuple(paths), terminal
    finally:
        iterator.close()


def _second_scan(payload, paths, first):
    # Only selected-window keys: never a dictionary of every uploaded raw path.
    counts = {path: 0 for path in paths if path != ""}
    iterator = parser.iter_foobar_snapshot_rows(payload, mapping_name=MAPPING)
    try:
        while True:
            try:
                row = next(iterator)
            except StopIteration as completed:
                terminal = _terminal(completed.value)
                break
            path = _path(row)
            if path in counts:
                counts[path] += 1
        # Whole-upload digest, headers, diagnostics and complete summary must agree.
        if terminal != first:
            raise evidence.SourceEvidenceError()
        return tuple(0 if path == "" else counts[path] for path in paths)
    finally:
        iterator.close()


def prove_foobar_source_window(payload, *, offset=0, mapping_name=MAPPING, intake_capacity=None):
    """Call before inventory/private-source allocation, under real route authority.

    Capacity is the real server-owned FoobarIntakeCapacity. No default capacity
    and no request-supplied numeric budget are accepted. The caller continues to
    own its upload after return; later phases add the retained proof explicitly.
    """
    if (type(payload) is not bytes or not 1 <= len(payload) <= parser.MAX_INPUT_BYTES
            or type(offset) is not int or not 0 <= offset < parser.MAX_DATA_ROWS
            or type(mapping_name) is not str or mapping_name != MAPPING):
        raise FoobarPreparationRejected()
    _admit(intake_capacity, source_window_intake_bytes(len(payload)))
    paths, first = _first_scan(payload, offset)
    occurrences = _second_scan(payload, paths, first)
    return FoobarSourceWindowProof(
        first.source_sha256, offset, first.summary.data_rows, paths, occurrences,
    )


def _validate_proof(proof):
    if (type(proof) is not FoobarSourceWindowProof
            or type(proof.offset) is not int or type(proof.total_rows) is not int
            or not 0 <= proof.offset < proof.total_rows <= parser.MAX_DATA_ROWS
            or type(proof.paths) is not tuple or type(proof.raw_path_row_counts) is not tuple
            or len(proof.paths) != min(MAX_WINDOW_ROWS, proof.total_rows-proof.offset)
            or len(proof.paths) != len(proof.raw_path_row_counts)):
        raise evidence.SourceEvidenceError()
    evidence._digest(proof.source_sha256)
    for index, path in enumerate(proof.paths):
        evidence._raw(path)
        count = proof.raw_path_row_counts[index]
        if type(count) is not int or (count != 0 if path == "" else not 1 <= count <= proof.total_rows):
            raise evidence.SourceEvidenceError()
        local_occurrences = 1
        for earlier in range(index):
            if proof.paths[earlier] == path:
                local_occurrences += 1
                if proof.raw_path_row_counts[earlier] != count:
                    raise evidence.SourceEvidenceError()
        if path != "" and count < local_occurrences:
            raise evidence.SourceEvidenceError()


def source_window_proof_bytes(proof):
    """Size of the retained proof view; no encoder or normalized string copies."""
    _validate_proof(proof)
    return evidence._json_size((
        VERSION, proof.source_sha256, proof.offset, proof.total_rows,
        proof.paths, proof.raw_path_row_counts,
    ))


def source_window_identity_conflict(proof, *, ordinal, raw_path, native_identity_conflict):
    """Combine genuine native conflict with proved full-upload path repetition.

    A serialized/client-created proof is not authority. Caller must use the
    actual proof from the immutable upload and the real matching-owner boolean.
    The existing evidence.source_identity remains the sole identity encoder.
    """
    _validate_proof(proof)
    if (type(ordinal) is not int or not proof.offset < ordinal <= proof.offset + len(proof.paths)
            or type(raw_path) is not str or type(native_identity_conflict) is not bool):
        raise evidence.SourceEvidenceError()
    index = ordinal-proof.offset-1
    if raw_path != proof.paths[index]:
        raise evidence.SourceEvidenceError()
    return native_identity_conflict or (raw_path != "" and proof.raw_path_row_counts[index] > 1)



def indexed_upload_intake_bytes(payload_bytes):
    """Construction ceiling; bounded logical owners, not measured process RSS.

    Exact path keys total <= upload bytes. Reserve original references, decoder,
    escaped logical path views, hash-table/offset/ID/count construction and tuple
    transitions. Row envelopes scale to the parser's fixed 100,000-row ceiling.
    No per-window consumer may assume this replaces its own private admission.
    """
    if type(payload_bytes) is not int or not 1 <= payload_bytes <= parser.MAX_INPUT_BYTES:
        raise FoobarPreparationRejected()
    return 18 * payload_bytes + 512 * parser.MAX_DATA_ROWS + PARSER_WORK_BYTES


def build_foobar_upload_index(payload, *, mapping_name=MAPPING, intake_capacity=None):
    """Admitted ephemeral original-upload owner; no DB mutation or authority.

    The worker must keep this only for an explicitly active import, and close it
    after all in-flight work settles. Restart requires identical-source selection;
    neither derived state nor original file bytes are silently persisted.
    """
    if type(payload) is not bytes or type(mapping_name) is not str or mapping_name != MAPPING:
        raise FoobarPreparationRejected()
    _admit(intake_capacity, indexed_upload_intake_bytes(len(payload)))
    try:
        return parser._build_validated_upload_index(payload, mapping_name=mapping_name)
    except ValueError:
        raise FoobarPreparationRejected() from None


def prove_indexed_foobar_source_window(upload, *, offset=0, intake_capacity=None):
    """Original global path proof without rescanning or trusting a caller flag.

    Only genuine in-process parser output is accepted. This is private source
    evidence, not permission or a persisted job resume credential.
    """
    if type(upload) is not parser.FoobarIndexedUpload:
        raise FoobarPreparationRejected()
    _admit(intake_capacity, indexed_upload_intake_bytes(upload.payload_bytes) + WINDOW_WORK_BYTES)
    stream = upload.iter_window(offset=offset, limit=MAX_WINDOW_ROWS)
    paths = []
    try:
        while True:
            try:
                row = next(stream)
            except StopIteration as done:
                terminal = _terminal(done.value)
                break
            paths.append(_path(row))
        counts = upload.path_counts(offset=offset, limit=MAX_WINDOW_ROWS)
        proof = FoobarSourceWindowProof(terminal.source_sha256, offset,
            terminal.summary.data_rows, tuple(paths), counts)
        _validate_proof(proof)
        return proof
    finally:
        stream.close()
