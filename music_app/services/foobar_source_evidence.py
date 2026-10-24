"""Private bounded source evidence, not authority, matching, or commit success.

Caller admission must cover the named phase sizes before invoking each codec.
Rows require successful terminal validation of the SAME immutable upload.
"""
from __future__ import annotations

import json
from hashlib import sha256

from . import foobar_snapshot_parser as parser


VERSION = "foobar_source_evidence_v1"
PARSER_VERSION = "foobar_text_tools_snapshot_v1"
MAX_EVIDENCE_BYTES = 4_194_304
MAX_IDENTITY_BYTES = 131_072
# Two possible strip/lstrip views, each maximally escaped and quoted, plus
# bounded classifier/control/pairwise-provenance scratch. Reserve BEFORE counters.
CLASSIFIER_WORK_BYTES = 2 * (6 * parser.MAX_CELL_UTF8_BYTES + 2) + 32_768


class SourceEvidenceError(ValueError):
    """Trusted evidence or caller association is unavailable, never public text."""
    code = "import_unavailable"
    status_code = 503

    def __init__(self):
        super().__init__("Import evidence is unavailable.")


def _fail():
    raise SourceEvidenceError()


def _text_bytes(value):
    if type(value) is not str:
        _fail()
    size = 0
    for character in value:
        point = ord(character)
        if 0xD800 <= point <= 0xDFFF:
            _fail()
        size += 1 if point < 128 else 2 if point < 2048 else 3 if point < 65536 else 4
    return size


def _json_size(value):
    if value is None:
        return 4
    if type(value) is bool:
        return 4 if value else 5
    if type(value) is int:
        if not 0 <= value <= 9_223_372_036_854_775_807:
            _fail()
        return len(str(value))
    if type(value) is str:
        size = _text_bytes(value) + 2
        for character in value:
            if character in '\\"\b\f\n\r\t':
                size += 1
            elif ord(character) < 32:
                size += 5
        return size
    if type(value) in (tuple, list):
        return 2 + max(0, len(value) - 1) + sum(_json_size(item) for item in value)
    _fail()


def _digest(value):
    if type(value) is not str or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        _fail()


def _raw(value):
    if type(value) is not str or len(value) > parser.MAX_CELL_UTF8_BYTES:
        _fail()
    if any(c in value for c in ("\x00", "\r", "\t", "\n")):
        _fail()
    size = _text_bytes(value)
    if size > parser.MAX_CELL_UTF8_BYTES:
        _fail()
    return size


def _same(a, b):
    # bool and int must never compare as equivalent provenance values.
    return type(a) is type(b) and a == b


def _validate_fields(fields):
    if type(fields) is not tuple or len(fields) != len(parser.FIELD_NAMES):
        _fail()
    for name, field in zip(parser.FIELD_NAMES, fields):
        if type(field) is not tuple or len(field) != 5:
            _fail()
        state, raw, value, code, origin = field
        if type(state) is not str:
            _fail()
        if state == "absent":
            if name == "path" or any(part is not None for part in (raw, value, code, origin)):
                _fail()
            continue
        _raw(raw)
        if type(origin) is not tuple or len(origin) != 3:
            _fail()
        digest, ordinal, column = origin
        _digest(digest)
        if type(ordinal) is not int or not 1 <= ordinal <= parser.MAX_DATA_ROWS:
            _fail()
        if type(column) is not int or not 0 <= column < parser.MAX_COLUMNS:
            _fail()
        expected = parser._observation(name, 0, (raw,))
        if state != expected.state or not _same(value, expected.value) or not _same(code, expected.code):
            _fail()
    _validate_origins(fields)


def _validate_origins(fields, *, previous=None):
    # Inputs have already passed individual field validation. Select aliases,
    # not copied origin keys or a materialized merged field array.
    for index in range(len(fields)):
        current = fields[index]
        if previous is not None:
            old = previous[index]
            if current[0] in ("absent", "empty", "unavailable") or all(_same(old[i], current[i]) for i in range(4)):
                current = old
        origin = current[4]
        if origin is None:
            continue
        for earlier in range(index):
            other = fields[earlier]
            if previous is not None:
                old = previous[earlier]
                if other[0] in ("absent", "empty", "unavailable") or all(_same(old[i], other[i]) for i in range(4)):
                    other = old
            prior_origin = other[4]
            if (prior_origin is not None and origin[0] == prior_origin[0]
                    and origin[2] == prior_origin[2]):
                _fail()



def fields_from_row(row, *, upload_sha256):
    """Use only after complete successful scan; this validates the local row."""
    _digest(upload_sha256)
    if type(row) is not parser.ParsedRow:
        _fail()
    if type(row.ordinal) is not int or not 1 <= row.ordinal <= parser.MAX_DATA_ROWS:
        _fail()
    if type(row.line_number) is not int or row.line_number != row.ordinal + 1:
        _fail()
    if type(row.cells) is not tuple or not 1 <= len(row.cells) <= parser.MAX_COLUMNS:
        _fail()
    length = len(row.cells) - 1
    for cell in row.cells:
        length += _raw(cell)
    if length == 0 or length > parser.MAX_RECORD_UTF8_BYTES:
        _fail()
    if type(row.fields) is not tuple or len(row.fields) != len(parser.FIELD_NAMES):
        _fail()
    result = []
    used = set()
    errors = 0
    for name, observation in zip(parser.FIELD_NAMES, row.fields):
        if type(observation) is not parser.FieldObservation:
            _fail()
        column = observation.column_index
        if column is not None:
            if type(column) is not int or not 0 <= column < len(row.cells) or column in used:
                _fail()
            used.add(column)
        expected = parser._observation(name, column, row.cells)
        if not all(_same(a, b) for a, b in (
            (observation.state, expected.state), (observation.value, expected.value),
            (observation.code, expected.code),
        )):
            _fail()
        errors += observation.state in ("invalid", "unsupported")
        result.append((observation.state, None if column is None else row.cells[column],
            observation.value, observation.code,
            None if column is None else (upload_sha256, row.ordinal, column)))
    if type(row.field_error_count) is not int or row.field_error_count != errors:
        _fail()
    fields = tuple(result)
    _validate_fields(fields)
    return fields


def row_phase_bytes(record_bytes):
    """Preconstruction bound from the admitted record scalar, excluding upload."""
    if type(record_bytes) is not int or not 1 <= record_bytes <= parser.MAX_RECORD_UTF8_BYTES:
        _fail()
    # Raw and typed strings each escape by at most6; fixed27 origins/controls
    # fit16384. Parser row plus destination list/tuple are three named views.
    # Two maximal serial classifier string views and bounded set/control slots.
    return 3 * (12 * record_bytes + 16_384) + CLASSIFIER_WORK_BYTES


def merge_fields(previous, incoming):
    """Missing/empty/unavailable retains; identical evidence keeps its origin.

    This is the effective projection, not the current raw observation. Writers
    must persist incoming evidence separately; no export state means user clear.
    """
    merged_evidence_size(previous, incoming)  # Gate before destination allocation.
    if previous is None:
        return incoming
    result = []
    for old, new in zip(previous, incoming):
        identical = all(_same(old[i], new[i]) for i in range(4))
        result.append(old if new[0] in ("absent", "empty", "unavailable") or identical else new)
    return tuple(result)


def validate_observation(fields):
    """A raw observation belongs to one upload/row, unlike effective fields."""
    _validate_fields(fields)
    origin = fields[0][4]
    if origin is None or any(field[4] is not None and field[4][:2] != origin[:2]
                             for field in fields):
        _fail()


def same_observation(previous, incoming):
    """Compare validated raw observations without inventing new provenance.

    Upload/ordinal origins alone do not create another source revision.
    Unknown legacy raw is not equivalent to an actual observation.
    """
    validate_observation(incoming)
    if previous is None:
        return False
    validate_observation(previous)
    return all(_same(old[k], new[k])
               for old, new in zip(previous, incoming) for k in range(4))


def merged_evidence_size(previous, incoming):
    """Exact selected shape, without allocating a merged field array."""
    _validate_fields(incoming)
    if previous is None:
        return evidence_size(incoming)
    _validate_fields(previous)
    _validate_origins(incoming, previous=previous)
    size = 2 + _json_size(VERSION) + 1 + _json_size(PARSER_VERSION) + 1 + 2 + 26
    for old, new in zip(previous, incoming):
        identical = all(_same(old[i], new[i]) for i in range(4))
        size += _json_size(old if new[0] in ("absent", "empty", "unavailable") or identical else new)
    if size > MAX_EVIDENCE_BYTES:
        _fail()
    return size


def evidence_size(fields):
    _validate_fields(fields)
    size = _json_size((VERSION, PARSER_VERSION, fields))
    if size > MAX_EVIDENCE_BYTES:
        _fail()
    return size


def encode_evidence(fields):
    size = evidence_size(fields)  # Before JSON text/bytes allocation.
    result = json.dumps((VERSION, PARSER_VERSION, fields), ensure_ascii=False,
        allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(result) != size:
        _fail()
    return result


def decode_phase_bytes(payload_bytes):
    """Raw/input + decoded/destination-list/tuple + encoder chunks/text/bytes."""
    if type(payload_bytes) is not int or not 1 <= payload_bytes <= MAX_EVIDENCE_BYTES:
        _fail()
    return 8 * payload_bytes + CLASSIFIER_WORK_BYTES


def encode_phase_bytes(fields):
    """Caller fields, envelope view, encoder chunks, JSON text and output bytes."""
    return 5 * evidence_size(fields) + CLASSIFIER_WORK_BYTES


def merge_phase_bytes(previous, incoming):
    """Both input views plus destination list/tuple; inputs remain caller-owned."""
    new_size = evidence_size(incoming)
    old_size = 0 if previous is None else evidence_size(previous)
    # Every output field is taken from one input. Sum dominates merged shape,
    # including punctuation, without allocating the merged tuple to measure it.
    return 3 * (old_size + new_size) + CLASSIFIER_WORK_BYTES


def _integer(text):
    if len(text) > 19 or not text.isascii() or not text.isdecimal():
        _fail()
    value = int(text)
    if value > 9_223_372_036_854_775_807:
        _fail()
    return value


def _forbidden_number(text):
    _fail()


def _load(payload, limit):
    if type(payload) is not bytes or not 1 <= len(payload) <= limit:
        _fail()
    # Reject objects and excessive structure BEFORE the ordinary decoder.
    depth = arrays = commas = 0
    quoted = escaped = False
    for byte in payload:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (123, 125):
            _fail()
        elif byte == 91:
            depth += 1
            arrays += 1
            if depth > 4 or arrays > 56:
                _fail()
        elif byte == 93:
            depth -= 1
            if depth < 0:
                _fail()
        elif byte == 44:
            commas += 1
            if commas > 300:
                _fail()
    if quoted or depth != 0:
        _fail()
    try:
        return json.loads(payload.decode("utf-8"), parse_int=_integer,
            parse_float=_forbidden_number, parse_constant=_forbidden_number)
    except (ValueError, UnicodeError, RecursionError):
        raise SourceEvidenceError() from None


def decode_evidence(payload):
    """Trusted stored bytes only; caller gates projection and decode_phase_bytes."""
    root = _load(payload, MAX_EVIDENCE_BYTES)
    if type(root) is not list or len(root) != 3 or root[:2] != [VERSION, PARSER_VERSION]:
        _fail()
    if type(root[2]) is not list or len(root[2]) != len(parser.FIELD_NAMES):
        _fail()
    fields = []
    for field in root[2]:
        if type(field) is not list or len(field) != 5:
            _fail()
        origin = field[4]
        if origin is not None and (type(origin) is not list or len(origin) != 3):
            _fail()
        fields.append((field[0], field[1], field[2], field[3],
            None if origin is None else tuple(origin)))
    result = tuple(fields)
    if encode_evidence(result) != payload:
        _fail()
    return result


def source_identity(fields, *, upload_sha256, ordinal, identity_conflict):
    _validate_fields(fields)
    _digest(upload_sha256)
    if type(ordinal) is not int or not 1 <= ordinal <= parser.MAX_DATA_ROWS or type(identity_conflict) is not bool:
        _fail()
    raw_path = fields[0][1]
    if fields[0][4][:2] != (upload_sha256, ordinal):
        _fail()
    return _source_identity_bytes(raw_path, upload_sha256=upload_sha256,
                                  ordinal=ordinal, identity_conflict=identity_conflict)


def _source_identity_bytes(raw_path, *, upload_sha256, ordinal, identity_conflict):
    """Shared encoder for a real complete-upload proof, not external authority.

    Caller reserves the complete serial encoder phase before invoking this.
    Full field/header/proof association remains the owning caller's obligation.
    """
    _raw(raw_path)
    _digest(upload_sha256)
    if type(ordinal) is not int or not 1 <= ordinal <= parser.MAX_DATA_ROWS or type(identity_conflict) is not bool:
        _fail()
    # No trim, case folding, path normalization, native ID, or generation.
    identity = ("path", raw_path) if raw_path != "" and not identity_conflict else (
        "occurrence", upload_sha256, str(ordinal))
    size = _json_size(identity)
    if size > MAX_IDENTITY_BYTES:
        _fail()
    return json.dumps(identity, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def decode_identity(payload):
    value = _load(payload, MAX_IDENTITY_BYTES)
    if type(value) is not list or not value:
        _fail()
    if value[0] == "path" and len(value) == 2:
        _raw(value[1])
        if not value[1]:
            _fail()
    elif value[0] == "occurrence" and len(value) == 3:
        _digest(value[1])
        ordinal = value[2]
        if type(ordinal) is not str or not 1 <= len(ordinal) <= 6:
            _fail()
        if not ordinal.isascii() or not ordinal.isdecimal() or ordinal.startswith("0"):
            _fail()
        if not 1 <= int(ordinal) <= parser.MAX_DATA_ROWS:
            _fail()
    else:
        _fail()
    if json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8") != payload:
        _fail()
    return tuple(value)


def evidence_digest(payload):
    """Hash an already admitted encoded payload; never equality or validity proof."""
    if type(payload) is not bytes or not 1 <= len(payload) <= MAX_EVIDENCE_BYTES:
        _fail()
    return sha256(payload).hexdigest()
