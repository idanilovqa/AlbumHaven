"""Private prepared-envelope framing only, not source-semantic or ready admission.

A decoded envelope is NOT a valid original decision until the caller verifies
all embedded evidence, identity, merge, taste associations and current authority.
"""
from datetime import date, datetime
import hashlib
import json
import re

from . import foobar_prepare_gate as gate
from . import foobar_source_evidence as evidence
from . import track_preferences_postgres as taste
from .foobar_source_postgres import SourceUnavailable

VERSION = 'foobar_prepared_v2'
DECISION_DOMAIN = b'albumhaven.foobar.prepared.decision.v1\n'
MAX_BYTES = 4194304
CONTROL_BYTES = 8192
HASH_BYTES = 512
_MAX = 9223372036854775807
_TIME = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\Z')


def prepared_envelope_phase_bytes(payload_bytes, *, decode):
    if (type(payload_bytes) is not int or not 1 <= payload_bytes <= MAX_BYTES
            or type(decode) is not bool):
        raise SourceUnavailable()
    return (8 if decode else 5)*payload_bytes+CONTROL_BYTES+HASH_BYTES


def _hex_bytes(value, maximum):
    return (type(value) is str and 2 <= len(value) <= 2*maximum and len(value)%2 == 0
            and all(c in '0123456789abcdef' for c in value))


def _header(header, command):
    gate.validate_prepare_command(command)
    if type(header) is not tuple or len(header) != 17:
        raise SourceUnavailable()
    if (any(not gate._integer(header[k],1,_MAX) for k in (0,1,2))
            or any(not gate._uuid(header[k]) for k in (3,5,6))
            or not gate._integer(header[4],1,2147483647)
            or not gate._integer(header[7],0,_MAX)
            or any(not gate._hex(header[k]) for k in (8,14,15))
            or header[9] != evidence.PARSER_VERSION or type(header[9]) is not str
            or header[10] != gate.MAPPING or type(header[10]) is not str
            or not gate._integer(header[11],1,100000)
            or not gate._integer(header[12],1,header[11])
            or not gate._integer(header[13],header[12]+1,min(header[11]+1,header[12]+100))
            or type(header[16]) is not str or len(header[16]) != 27
            or _TIME.fullmatch(header[16]) is None):
        raise SourceUnavailable()
    instant = datetime.fromisoformat(header[16][:-1]+'+00:00')
    if (instant.isoformat(timespec='microseconds').replace('+00:00','Z') != header[16]
            or (instant.date()-date(1970,1,1)).days != header[4]):
        raise SourceUnavailable()
    if (header[3] != command.source_ref or header[4] != command.generation
            or header[5] != command.request_key or header[7] != command.expected_revision
            or header[8] != command.upload_sha256 or header[10] != command.mapping_name
            or header[12] != command.offset+1 or header[14] != command.inventory_sha256):
        raise SourceUnavailable()


def _bounded_state(values):
    # Representation limits BEFORE constructing the canonical typed record.
    # All semantic marker/protection decisions remain with its actual owner.
    if type(values) is not tuple or len(values) != 13:
        raise SourceUnavailable()
    if (not gate._integer(values[0],1,_MAX)
            or (values[2] is not None and not gate._integer(values[2],1,_MAX))
            or (values[4] is not None and not gate._integer(values[4],1,5))
            or any(type(values[k]) is not bool for k in (6,7,11,12))):
        raise SourceUnavailable()
    for index,maximum in ((1,9),(3,64),(5,8),(10,64)):
        if type(values[index]) is not str or not 1 <= len(values[index]) <= maximum or not values[index].isascii():
            raise SourceUnavailable()
    for index in (8,9):
        marker = values[index]
        if marker is None:
            continue
        if (type(marker) is not tuple or len(marker) != 4
                or any(type(marker[k]) is not str or len(marker[k]) != 36
                       or not marker[k].isascii() for k in (0,1))
                or not gate._integer(marker[2],1,_MAX)
                or not (gate._integer(marker[3],1,5)
                        or (type(marker[3]) is str and len(marker[3]) <= 5 and marker[3].isascii()))):
            raise SourceUnavailable()


def _validate(value, *, original_command, expected_header):
    if type(value) is not tuple or len(value) != 4 or value[0] != VERSION or type(value[0]) is not str:
        raise SourceUnavailable()
    header,rows,states = value[1],value[2],value[3]
    _header(header,original_command)
    _header(expected_header,original_command)
    if header != expected_header:
        raise SourceUnavailable()
    if (type(rows) is not tuple or len(rows) != header[13]-header[12]
            or type(states) is not tuple or len(states) > len(rows)):
        raise SourceUnavailable()
    last_id = 0
    for values in states:
        _bounded_state(values)
        # Genuine canonical owner: exact integer/marker/protection grammar,
        # not a second metadata interpretation or an inferred policy grant.
        state = taste.FoobarTasteState(*values)
        taste._foobar_taste_check_state(state,header[3])
        if state.track_id <= last_id:
            raise SourceUnavailable()
        last_id = state.track_id
        del state
    for index,row in enumerate(rows):
        if type(row) is not tuple or len(row) != 12:
            raise SourceUnavailable()
        if (not gate._integer(row[0],header[12]+index,header[12]+index)
                or not _hex_bytes(row[1],131072) or not gate._uuid(row[2])
                or not _hex_bytes(row[6],4194304) or not _hex_bytes(row[7],4194304)
                or not _hex_bytes(row[8],1048576)
                or (row[9] is not None and not gate._integer(row[9],0,len(states)-1))
                or (row[10] is not None and not gate._integer(row[10],1,5))
                or type(row[11]) is not bool):
            raise SourceUnavailable()
        if row[3] is None:
            if row[4] is not None or row[5] is not None:
                raise SourceUnavailable()
        elif (not gate._integer(row[3],1,header[7])
              or not gate._hex(row[4]) or not gate._hex(row[5])):
            raise SourceUnavailable()
        if any(row[1] == rows[j][1] or row[2] == rows[j][2] for j in range(index)):
            raise SourceUnavailable()
        if row[9] is None:
            eligible = False
        else:
            snapshot = states[row[9]]
            eligible = snapshot[1] == 'ok' and snapshot[11] and snapshot[12]
        shared = row[9] is not None and any(
            j != index and rows[j][9] == row[9] for j in range(len(rows))
        )
        if (not eligible or shared) and (row[10] is not None or row[11]):
            raise SourceUnavailable()
    if any(not any(row[9] == index for row in rows) for index in range(len(states))):
        raise SourceUnavailable()


def _scan(payload):
    if not payload.isascii():
        raise SourceUnavailable()
    depth = arrays = commas = 0
    quoted = escaped = False
    for c in payload:
        if quoted:
            if escaped:
                escaped = False
            elif c == 92:
                escaped = True
            elif c == 34:
                quoted = False
            continue
        if c == 34:
            quoted = True
        elif c == 91:
            depth += 1
            arrays += 1
            if depth > 4 or arrays > 404:
                raise SourceUnavailable()
        elif c == 93:
            depth -= 1
            if depth < 0:
                raise SourceUnavailable()
        elif c == 44:
            commas += 1
            if commas > 3200:
                raise SourceUnavailable()
        elif c in (123,125):
            raise SourceUnavailable()
    if depth or quoted or escaped:
        raise SourceUnavailable()


def _integer(text):
    if not 1 <= len(text) <= 19 or not text.isascii() or not text.isdecimal():
        raise SourceUnavailable()
    value = int(text)
    if value > _MAX:
        raise SourceUnavailable()
    return value


def _reject(_):
    raise SourceUnavailable()


def _freeze(value):
    if type(value) is list:
        return tuple(_freeze(item) for item in value)
    return value


def _encode(value):
    return json.dumps(value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')


def _digests(payload):
    prepared = hashlib.sha256(payload).hexdigest()
    decision = hashlib.sha256()
    decision.update(DECISION_DOMAIN)
    decision.update(payload)  # No domain+payload concatenation copy.
    return prepared,decision.hexdigest()


def encode_prepared_envelope(value, *, original_command, expected_header):
    """Input construction and other caller owners require prior compound admission."""
    try:
        size = evidence._json_size(value)  # Counter only; no encoding to measure.
        if max(prepared_envelope_phase_bytes(size,decode=False),
               prepared_envelope_phase_bytes(size,decode=True)) > MAX_BYTES:
            raise SourceUnavailable()
        _validate(value,original_command=original_command,expected_header=expected_header)
        payload = _encode(value)
        if len(payload) != size:
            raise SourceUnavailable()
        prepared,decision = _digests(payload)
        return payload,prepared,decision
    except SourceUnavailable:
        raise
    except Exception as exc:
        raise SourceUnavailable() from exc


def decode_prepared_envelope(payload, *, original_command, expected_header,
                             prepared_sha256, decision_sha256):
    """Verify trusted framing/hashes only. Never authorize ready replay by this alone."""
    try:
        if type(payload) is not bytes or prepared_envelope_phase_bytes(len(payload),decode=True) > MAX_BYTES:
            raise SourceUnavailable()
        if not gate._hex(prepared_sha256) or not gate._hex(decision_sha256):
            raise SourceUnavailable()
        prepared,decision = _digests(payload)
        if prepared != prepared_sha256 or decision != decision_sha256:
            raise SourceUnavailable()
        _scan(payload)
        text = payload.decode('ascii')
        decoded = json.loads(text,parse_int=_integer,parse_float=_reject,
                             parse_constant=_reject,object_pairs_hook=_reject)
        del text
        value = _freeze(decoded)
        del decoded
        _validate(value,original_command=original_command,expected_header=expected_header)
        canonical = _encode(value)
        if canonical != payload:
            raise SourceUnavailable()
        del canonical
        return value
    except SourceUnavailable:
        raise
    except Exception as exc:
        raise SourceUnavailable() from exc
