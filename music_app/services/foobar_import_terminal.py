"""Proposed internal terminal metadata codec; not an Apply or commit operation.

Caller must reserve the contribution alongside ALL live original/current owners.
Only a genuine successful writer may supply actual mutation classifications.
No product execution or integration is claimed by this source proposal.
"""
import hashlib
import json
import re

VERSION = "foobar_terminal_v2"
MAX_WIRE_BYTES = 669
# Contributions count logical serialized occurrences, not Python/DB heap bytes.
ENCODE_CONTRIBUTION = 5 * MAX_WIRE_BYTES + 1024
DECODE_CONTRIBUTION = 3 * MAX_WIRE_BYTES + 1024
MAX_BIGINT = 9223372036854775807
_HEX = "0123456789abcdef"
_UUID = r'"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"'
_HASH = r'"[0-9a-f]{64}"'
_INT = r'(?:0|[1-9][0-9]{0,18})'
# Fixed flat scalar grammar rejects whitespace, escapes, nested values,
# objects/duplicate keys, NaN, exponent/float/sign/leading-zero spellings.
_WIRE = re.compile(r'\["foobar_terminal_v2",' + _HASH + ','
    + ','.join([_UUID] * 4) + ',' + ','.join([_HASH] * 5) + ','
    + ','.join([_INT] * 12) + r'\]')
_SCOPE_DOMAIN = b"albumhaven.foobar.terminal.scope.v2\n"


class FoobarTerminalUnavailable(Exception):
    code = "import_unavailable"
    status_code = 503
    retryable = False

    def __init__(self):
        super().__init__("Foobar import is unavailable.")


def _fail():
    raise FoobarTerminalUnavailable()


def _uint(value, maximum):
    if type(value) is not int or not 0 <= value <= maximum:
        _fail()


def _hex(value, length):
    if type(value) is not str or len(value) != length:
        _fail()
    if any(char not in _HEX for char in value):
        _fail()


def _uuid(value):
    if type(value) is not str or len(value) != 36:
        _fail()
    for index, char in enumerate(value):
        if index in (8, 13, 18, 23):
            if char != "-":
                _fail()
        elif char not in _HEX:
            _fail()


def terminal_scope_sha256(account_id, library_id, source_ref, generation):
    """New domain proposal; integers stay private, only digest is serialized.

    Caller separately admits 1024 logical scratch bytes plus its retained scope.
    This unkeyed binding is not authentication or proof of current authority.
    """
    _uint(account_id, MAX_BIGINT)
    _uint(library_id, MAX_BIGINT)
    if not account_id or not library_id:
        _fail()
    _uuid(source_ref)
    _uint(generation, 2147483647)
    if not generation:
        _fail()
    frame = (_SCOPE_DOMAIN + str(account_id).encode("ascii") + b":"
             + str(library_id).encode("ascii") + b":" + source_ref.encode("ascii")
             + b":" + str(generation).encode("ascii"))
    return hashlib.sha256(frame).hexdigest()


def _header(value):
    if type(value) is not tuple or len(value) not in (17, 23):
        _fail()
    if type(value[0]) is not str or value[0] != VERSION:
        _fail()
    _hex(value[1], 64)
    for index in range(2, 6):
        _uuid(value[index])
    for index in range(6, 11):
        _hex(value[index], 64)
    _uint(value[11], MAX_BIGINT)
    _uint(value[12], MAX_BIGINT)
    if value[12] < value[11] or value[12] - value[11] not in (0, 1):
        _fail()
    _uint(value[13], 100000)
    _uint(value[14], 100001)
    _uint(value[15], 100001)
    if not 1 <= value[14] <= value[15] <= value[13] + 1:
        _fail()
    if value[15] - value[14] > 100:
        _fail()
    generation = value[16] if len(value) == 17 else value[22]
    _uint(generation, 2147483647)
    if not generation:
        _fail()


def _record(value):
    if type(value) is not tuple or len(value) != 23:
        _fail()
    _header(value)
    for index in range(16, 22):
        _uint(value[index], 100)
    unchanged, source_only, taste_only, both, ratings, favorites = value[16:22]
    if unchanged + source_only + taste_only + both != value[15] - value[14]:
        _fail()
    taste_changed = taste_only + both
    if ratings > taste_changed or favorites > taste_changed or ratings + favorites < taste_changed:
        _fail()
    changed = source_only + taste_only + both
    if value[12] - value[11] != int(changed > 0):
        _fail()


def encode_foobar_terminal(record):
    """Encode an already-produced immutable outcome, never manufacture success.

    Required local contribution: ENCODE_CONTRIBUTION plus caller-owned record,
    expected/original controls and any native/Python output transfer copies.
    """
    _record(record)
    # All strings use proven ASCII alphabets; JSON escaping is unnecessary.
    # At most23 bounded fragments; no generic dictionary or copied raw values.
    parts = []
    for value in record:
        parts.append('"' + value + '"' if type(value) is str else str(value))
    text = "[" + ",".join(parts) + "]"
    payload = text.encode("ascii")
    if len(payload) > MAX_WIRE_BYTES:
        _fail()
    return payload


def decode_foobar_terminal(payload, *, expected_header):
    """Decode only after locked same-scope receipt scalar/hash admission.

    expected_header is the exact17-field tuple from trusted original/receipt
    associations, NOT copied from unverified payload or external request.
    Required local contribution: DECODE_CONTRIBUTION plus caller-retained bytes,
    expected header and any native result occurrence. Failures are safe503.
    """
    _header(expected_header)
    if len(expected_header) != 17 or type(payload) is not bytes or not 1 <= len(payload) <= MAX_WIRE_BYTES:
        _fail()
    try:
        text = payload.decode("ascii")
        if _WIRE.fullmatch(text) is None:
            _fail()
        values = json.loads(text)
        record = tuple(values)
    except FoobarTerminalUnavailable:
        raise
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise FoobarTerminalUnavailable() from None
    _record(record)
    for index in range(16):
        if record[index] != expected_header[index]:
            _fail()
    if record[22] != expected_header[16]:
        _fail()
    return record
