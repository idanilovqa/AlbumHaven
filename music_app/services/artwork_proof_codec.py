"""Dormant, pure artwork proof codecs. Values and hashes never grant authority.

No caller or persistence wiring is provided. Legacy values retain object semantics;
only version 2 and inventories have this module's canonical byte representation.
PostgreSQL jsonb::text size checks remain the future persistence owner's obligation.
"""

from collections import namedtuple
from dataclasses import dataclass
import hashlib
import json
import re
from types import MappingProxyType
from weakref import ref


SOURCE_LIMIT = 65536
ACQUISITION_LIMIT = 2048
INVENTORY_LIMIT = 64 * 1024 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_INPUT_PIXELS = 16_000_000
_MAX_ID = (1 << 63) - 1
_MAX_U64 = (1 << 64) - 1
_MIN_S64 = -(1 << 63)
_SOURCE_DOMAIN = b'AlbumHaven/artwork-descriptor/v2\x00'
_INVENTORY_DOMAIN = b'AlbumHaven/artwork-root-inventory/v1\x00'
_RESOLVERS = {
    'posix': 'artwork-posix-bounded-selection-v1',
    'win32': 'artwork-win32-lexical-selection-v1',
}
_UNSIGNED = re.compile(r'(?:0|[1-9][0-9]*)\Z')
_SIGNED = re.compile(r'(?:0|-?[1-9][0-9]*)\Z')
_HEX128 = re.compile(r'[0-9a-f]{32}\Z')
_HEX256 = re.compile(r'[0-9a-f]{64}\Z')
_DRIVE = re.compile(r'[A-Za-z]:\Z')
_GUID = re.compile(
    r'\\\\\?\\Volume\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-'
    r'[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}\\\Z'
)
_TARGET = re.compile(r'\\Device\\HarddiskVolume[0-9]+\Z')
_RESERVED = frozenset(
    ('CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$')
    + tuple('COM' + char for char in '123456789¹²³')
    + tuple('LPT' + char for char in '123456789¹²³')
)
_SCOPE_KEYS = (
    'library_id', 'local_album_id', 'artwork_root_id', 'artwork_root_path',
    'stored_cover_path', 'resolved_cover_path', 'relative_parts',
)
_LEGACY_KEYS = _SCOPE_KEYS + ('root_device', 'root_inode')
_V2_KEYS = _SCOPE_KEYS + ('descriptor_version', 'platform', 'root', 'selection_context')


class InvalidArtworkProof(ValueError):
    """A bounded internal error without input values or paths."""

    def __init__(self):
        super().__init__('artwork_proof_invalid')


@dataclass(frozen=True)
class _Object:
    items: tuple


@dataclass(frozen=True)
class SourceProof:
    _tree: _Object


@dataclass(frozen=True)
class AcquisitionProof:
    _tree: _Object


@dataclass(frozen=True)
class InventoryProof:
    _tree: _Object


# These immutable implementation records are never accepted as public inputs.
# The marker/owner/identity checks detect ordinary fabricated or replaced wrappers;
# they are construction invariants, not credentials against privileged Python code.
_PREPARED_MARKER = object()
_PreparedRoot = namedtuple('_PreparedRoot', 'root_id root_path browse_eligible')
_PreparedInventoryState = namedtuple(
    '_PreparedInventoryState',
    'marker owner library_id platform resolver_contract digest root_count roots',
)


class PreparedInventoryBinding:
    """Phase-local validated inventory facts, never authorization or persisted input.

    Construct only with prepare_inventory_binding. There is no supported raw-state
    constructor, setter, cache, or cross-request use. Python callers that rewrite
    private implementation state are outside this object's immutability guarantee.
    """

    __slots__ = ('_state', '_state_identity', '_roots_identity', '__weakref__')

    def __new__(cls, *args, **kwargs):
        _fail()

    def __setattr__(self, name, value):
        _fail()

    def __delattr__(self, name):
        _fail()

    @property
    def digest(self):
        return _prepared_state(self).digest

    @property
    def library_id(self):
        return _prepared_state(self).library_id

    @property
    def platform(self):
        return _prepared_state(self).platform

    @property
    def resolver_contract(self):
        return _prepared_state(self).resolver_contract

    @property
    def root_count(self):
        return _prepared_state(self).root_count


@dataclass(frozen=True)
class _RawInteger:
    text: str


def _fail():
    raise InvalidArtworkProof()


def _keys(value, keys):
    if type(value) is not dict or value.keys() != set(keys):
        _fail()


def _integer(value, minimum, maximum=None):
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        _fail()


def _text(value, maximum, *, nonempty=True):
    if type(value) is not str or (nonempty and not value) or '\x00' in value:
        _fail()
    # A codepoint cannot occupy fewer than one UTF-8 byte. Reject before encoding.
    if len(value) > maximum:
        _fail()
    try:
        if len(value.encode('utf-8', 'strict')) > maximum:
            _fail()
    except UnicodeError:
        raise InvalidArtworkProof() from None


def _decimal(value, signed=False):
    if type(value) is not str or len(value) > 20:
        _fail()
    if (not (_SIGNED if signed else _UNSIGNED).fullmatch(value)
            or not ((_MIN_S64 if signed else 0) <= int(value)
                    <= (_MAX_ID if signed else _MAX_U64))):
        _fail()


def _hex(value, bits):
    if type(value) is not str or not (_HEX128 if bits == 128 else _HEX256).fullmatch(value):
        _fail()


def _platform(value):
    if type(value) is not str or value not in _RESOLVERS:
        _fail()


def _resolver(platform, value):
    if type(value) is not str or value != _RESOLVERS[platform]:
        _fail()


def _utf16(value, maximum=32766):
    try:
        if len(value.encode('utf-16-le', 'strict')) // 2 > maximum:
            _fail()
    except UnicodeError:
        raise InvalidArtworkProof() from None


def _windows_component(value):
    _text(value, 1020)
    _utf16(value, 255)
    if (value in ('.', '..') or value[-1] in ' .'
            or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in value)
            or value.split('.', 1)[0].rstrip(' .').upper() in _RESERVED):
        _fail()


def _posix_parts(path, maximum):
    _text(path, maximum)
    if path == '/':
        return ()
    if not path.startswith('/'):
        _fail()
    parts = tuple(path[1:].split('/'))
    if any(part in ('', '.', '..') for part in parts) or len(parts) + 1 > 256:
        _fail()
    return parts


def _windows_parts(path, maximum):
    _text(path, maximum)
    _utf16(path)
    if len(path) < 3 or not _DRIVE.fullmatch(path[:2]) or path[2] != '\\':
        _fail()
    parts = tuple(path[3:].split('\\')) if path[3:] else ()
    if len(parts) > 256:
        _fail()
    for part in parts:
        _windows_component(part)
    return parts


def _scope(value, platform):
    for key in ('library_id', 'local_album_id', 'artwork_root_id'):
        _integer(value[key], 1, _MAX_ID)
    _text(value['stored_cover_path'], 16384)
    if '://' in value['stored_cover_path']:
        _fail()
    relative = value['relative_parts']
    if type(relative) is not list or not 1 <= len(relative) <= 256:
        _fail()
    if platform == 'posix':
        root = _posix_parts(value['artwork_root_path'], 8192)
        cover = _posix_parts(value['resolved_cover_path'], 16384)
        for part in relative:
            _text(part, 16384)
            if part in ('.', '..') or '/' in part:
                _fail()
        if len(root) + 1 + len(relative) > 256 or cover != root + tuple(relative):
            _fail()
    else:
        root = _windows_parts(value['artwork_root_path'], 8192)
        cover = _windows_parts(value['resolved_cover_path'], 16384)
        for part in relative:
            _windows_component(part)
        prefix = value['artwork_root_path']
        joined = prefix + ('' if prefix.endswith('\\') else '\\') + '\\'.join(relative)
        if (len(root) + len(relative) > 256 or cover != root + tuple(relative)
                or value['resolved_cover_path'] != joined):
            _fail()


def _posix_identity(value):
    _keys(value, ('device', 'inode'))
    _decimal(value['device'])
    _decimal(value['inode'])


def _windows_identity(value):
    _keys(value, ('volume_serial', 'file_id'))
    _decimal(value['volume_serial'])
    _hex(value['file_id'], 128)


def _selector(value, root_path):
    _keys(value, ('drive', 'volume_guid', 'drive_target', 'guid_target'))
    for item in value.values():
        _text(item, 131064)
        _utf16(item)
    if (not _DRIVE.fullmatch(value['drive']) or value['drive'] != root_path[:2]
            or not _GUID.fullmatch(value['volume_guid'])
            or not _TARGET.fullmatch(value['drive_target'])
            or value['drive_target'] != value['guid_target']):
        _fail()


def _source(value):
    if type(value) is not dict:
        _fail()
    if 'descriptor_version' not in value:
        _keys(value, _LEGACY_KEYS)
        _scope(value, 'posix')
        _integer(value['root_device'], 0)
        _integer(value['root_inode'], 0)
        return
    _keys(value, _V2_KEYS)
    _integer(value['descriptor_version'], 2, 2)
    platform = value['platform']
    _platform(platform)
    _scope(value, platform)
    context = value['selection_context']
    _keys(context, ('version', 'resolver_contract', 'inventory_digest'))
    _integer(context['version'], 1, 1)
    _resolver(platform, context['resolver_contract'])
    _hex(context['inventory_digest'], 256)
    root = value['root']
    if platform == 'posix':
        _posix_identity(root)
    else:
        _keys(root, ('volume_serial', 'file_id', 'selector'))
        _windows_identity({key: root[key] for key in ('volume_serial', 'file_id')})
        _selector(root['selector'], value['artwork_root_path'])
    _canonical(value, SOURCE_LIMIT)


def _acquisition(value):
    if type(value) is not dict:
        _fail()
    versioned = 'acquisition_version' in value
    _keys(value, ('acquisition_version', 'platform', 'descriptor_digest', 'file',
                  'input_bytes', 'input_pixels') if versioned
          else ('file', 'input_bytes', 'input_pixels'))
    _integer(value['input_bytes'], 1, MAX_INPUT_BYTES)
    _integer(value['input_pixels'], 1, MAX_INPUT_PIXELS)
    info = value['file']
    if not versioned:
        _keys(info, ('device', 'inode', 'size', 'mtime_ns', 'ctime_ns'))
        for key in ('device', 'inode'):
            _integer(info[key], 0)
        for key in ('mtime_ns', 'ctime_ns'):
            if type(info[key]) is not int:
                _fail()
    else:
        _integer(value['acquisition_version'], 2, 2)
        _platform(value['platform'])
        _hex(value['descriptor_digest'], 256)
        if value['platform'] == 'posix':
            _keys(info, ('device', 'inode', 'size', 'mtime_ns', 'ctime_ns'))
            for key in ('device', 'inode'):
                _decimal(info[key])
            for key in ('mtime_ns', 'ctime_ns'):
                _decimal(info[key], signed=True)
        else:
            _keys(info, ('root_identity', 'leaf_identity', 'size',
                         'last_write_time', 'change_time'))
            _windows_identity(info['root_identity'])
            _windows_identity(info['leaf_identity'])
            if info['root_identity']['volume_serial'] != info['leaf_identity']['volume_serial']:
                _fail()
            for key in ('last_write_time', 'change_time'):
                _decimal(info[key], signed=True)
    _integer(info['size'], 1, MAX_INPUT_BYTES)
    if info['size'] != value['input_bytes']:
        _fail()
    if versioned:
        _canonical(value, ACQUISITION_LIMIT)


def _inventory(value):
    _keys(value, ('inventory_version', 'library_id', 'platform', 'resolver_contract', 'roots'))
    _integer(value['inventory_version'], 1, 1)
    _integer(value['library_id'], 1, _MAX_ID)
    _platform(value['platform'])
    _resolver(value['platform'], value['resolver_contract'])
    roots = value['roots']
    if type(roots) is not list or len(roots) > 1024:
        _fail()
    previous = 0
    for root in roots:
        _keys(root, ('root_id', 'root_path', 'browse_eligible'))
        _integer(root['root_id'], 1, _MAX_ID)
        if root['root_id'] <= previous or type(root['browse_eligible']) is not bool:
            _fail()
        previous = root['root_id']
        # Hash exact stored spelling, even where selection will reject its syntax.
        _text(root['root_path'], 8192)
    return _canonical(value, INVENTORY_LIMIT)


def _canonical(value, limit):
    """Internal: called only after exact schema validation or on validated values."""
    encoder = json.JSONEncoder(ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)
    chunks = []
    count = 0
    for chunk in encoder.iterencode(value):
        encoded = chunk.encode('ascii')
        count += len(encoded)
        if count > limit:
            _fail()
        chunks.append(encoded)
    return b''.join(chunks)


def _freeze(value):
    if type(value) is dict:
        return _Object(tuple((key, _freeze(item)) for key, item in value.items()))
    if type(value) is list:
        return tuple(_freeze(item) for item in value)
    return value


def _thaw(value, depth=0):
    # Exact proof schemas are much shallower. Forged wrappers get a local bound,
    # independent of interpreter recursion settings and without traversing cycles.
    if depth > 16:
        _fail()
    if type(value) is _Object:
        if type(value.items) is not tuple:
            _fail()
        result = {}
        for entry in value.items:
            if type(entry) is not tuple or len(entry) != 2:
                _fail()
            key, item = entry
            if type(key) is not str or key in result:
                _fail()
            result[key] = _thaw(item, depth + 1)
        return result
    if type(value) is tuple:
        return [_thaw(item, depth + 1) for item in value]
    return value


def _pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            _fail()
        value[key] = item
    return value


def _constant(_value):
    _fail()


def _local_decimal(text):
    """Bounded caller-selected token only; never int(a process-limit-sized string)."""
    negative = text.startswith('-')
    digits = text[1:] if negative else text
    result = 0
    for offset in range(0, len(digits), 9):
        chunk = digits[offset:offset + 9]
        result = result * (10 ** len(chunk)) + int(chunk)
    return -result if negative else result


def _raw_numbers(value, wrapper, *, legacy, path=(), depth=0):
    if depth > 16:
        _fail()
    if type(value) is _RawInteger:
        unbounded = legacy and (
            (wrapper is SourceProof and path in (('root_device',), ('root_inode',)))
            or (wrapper is AcquisitionProof and path in (
                ('file', 'device'), ('file', 'inode'), ('file', 'mtime_ns'), ('file', 'ctime_ns')))
        )
        # Other JSON-number fields are bounded identifiers/version/count scalars.
        # Their exact ranges/types are checked by the ordinary schema validator.
        if not unbounded and len(value.text) > 20:
            _fail()
        return _local_decimal(value.text)
    if type(value) is dict:
        return {key: _raw_numbers(item, wrapper, legacy=legacy, path=path + (key,), depth=depth + 1)
                for key, item in value.items()}
    if type(value) is list:
        return [_raw_numbers(item, wrapper, legacy=legacy, path=path + (index,), depth=depth + 1)
                for index, item in enumerate(value)]
    return value


def _decode(value, limit, wrapper):
    if type(value) is wrapper:
        try:
            return _thaw(value._tree)
        except (TypeError, ValueError, RecursionError):
            raise InvalidArtworkProof() from None
    if type(value) is dict:
        return value
    if type(value) not in (str, bytes):
        _fail()
    try:
        if len(value) > limit:
            _fail()
        raw = value.encode('utf-8', 'strict') if type(value) is str else value
        if len(raw) > limit or raw.startswith(b'\xef\xbb\xbf'):
            _fail()
        def integer_token(text):
            # Inventory's larger transport bound never authorizes big-int work.
            maximum = 20 if wrapper is InventoryProof else limit
            if len(text) > maximum:
                _fail()
            return _RawInteger(text)

        decoded = json.loads(raw.decode('utf-8', 'strict'), object_pairs_hook=_pairs,
                             parse_constant=_constant, parse_float=_constant,
                             parse_int=integer_token)
        legacy = type(decoded) is dict and (
            (wrapper is SourceProof and 'descriptor_version' not in decoded)
            or (wrapper is AcquisitionProof and 'acquisition_version' not in decoded))
        return _raw_numbers(decoded, wrapper, legacy=legacy)
    except (ValueError, UnicodeError, RecursionError):
        raise InvalidArtworkProof() from None


def parse_source(value):
    value = _decode(value, SOURCE_LIMIT, SourceProof)
    _source(value)
    return SourceProof(_freeze(value))


def parse_acquisition(value):
    value = _decode(value, ACQUISITION_LIMIT, AcquisitionProof)
    _acquisition(value)
    return AcquisitionProof(_freeze(value))


def parse_inventory(value):
    value = _decode(value, INVENTORY_LIMIT, InventoryProof)
    _inventory(value)
    return InventoryProof(_freeze(value))


def source_object(value):
    """Fresh object; legacy emission gains no canonical encoding or new fields."""
    return _thaw(parse_source(value)._tree)


def acquisition_object(value):
    return _thaw(parse_acquisition(value)._tree)


def inventory_object(value):
    return _thaw(parse_inventory(value)._tree)


def canonical_source_bytes(value):
    value = source_object(value)
    if 'descriptor_version' not in value:
        _fail()
    return _canonical(value, SOURCE_LIMIT)


def canonical_acquisition_bytes(value):
    value = acquisition_object(value)
    if 'acquisition_version' not in value:
        _fail()
    return _canonical(value, ACQUISITION_LIMIT)


def canonical_inventory_bytes(value):
    return _canonical(inventory_object(value), INVENTORY_LIMIT)


def descriptor_digest(value):
    return hashlib.sha256(_SOURCE_DOMAIN + canonical_source_bytes(value)).hexdigest()


def inventory_digest(value):
    return hashlib.sha256(_INVENTORY_DOMAIN + canonical_inventory_bytes(value)).hexdigest()


def _prepared_root_index(roots):
    # This dictionary is newly owned here, never supplied by or returned to callers.
    return MappingProxyType({root['root_id']: _PreparedRoot(
        root['root_id'], root['root_path'], root['browse_eligible']) for root in roots})


def _prepare_inventory_binding(inventory):
    inventory = _decode(inventory, INVENTORY_LIMIT, InventoryProof)
    # One complete schema validation and canonical encoding, not a public helper
    # that reparses/re-encodes the inventory. Retain neither bytes nor raw input.
    canonical = _inventory(inventory)
    digest = hashlib.sha256(_INVENTORY_DOMAIN + canonical).hexdigest()
    del canonical
    validated = InventoryProof(_freeze(inventory))
    roots = _prepared_root_index(inventory['roots'])
    prepared = object.__new__(PreparedInventoryBinding)
    state = _PreparedInventoryState(
        _PREPARED_MARKER, ref(prepared), inventory['library_id'], inventory['platform'],
        inventory['resolver_contract'], digest, len(roots), roots,
    )
    object.__setattr__(prepared, '_state', state)
    object.__setattr__(prepared, '_state_identity', state)
    object.__setattr__(prepared, '_roots_identity', roots)
    return prepared, validated


def prepare_inventory_binding(inventory):
    """Validate/copy/index complete untrusted inventory once for this operation.

    Accepts exactly parse_inventory's input forms, never a prepared-context shortcut.
    The digest uses the unchanged inventory domain and canonical bytes. The private
    read-only index retains exact stored spelling, including nonselected roots.
    """
    return _prepare_inventory_binding(inventory)[0]


def _prepared_state(prepared):
    if type(prepared) is not PreparedInventoryBinding:
        _fail()
    try:
        state = object.__getattribute__(prepared, '_state')
        identity = object.__getattribute__(prepared, '_state_identity')
        roots_identity = object.__getattribute__(prepared, '_roots_identity')
    except AttributeError:
        raise InvalidArtworkProof() from None
    if (type(state) is not _PreparedInventoryState or len(state) != 8
            or state is not identity or state.marker is not _PREPARED_MARKER
            or type(state.owner) is not ref or state.owner.__callback__ is not None
            or state.owner() is not prepared):
        _fail()
    # Fixed scalar checks and O(1) index metadata, never an inventory traversal.
    _integer(state.library_id, 1, _MAX_ID)
    _platform(state.platform)
    _resolver(state.platform, state.resolver_contract)
    _hex(state.digest, 256)
    _integer(state.root_count, 0, 1024)
    if (state.roots is not roots_identity or type(state.roots) is not MappingProxyType
            or len(state.roots) != state.root_count):
        _fail()
    return state


def _selected_prepared_root(state, root_id):
    selected = state.roots.get(root_id)
    if type(selected) is not _PreparedRoot or len(selected) != 3:
        _fail()
    _integer(selected.root_id, 1, _MAX_ID)
    _text(selected.root_path, 8192)
    if selected.root_id != root_id or type(selected.browse_eligible) is not bool:
        _fail()
    return selected


def _bind_prepared_source(source, state):
    # The sole inventory-binding predicate owner for both public APIs. Its source
    # has just passed the existing strict source parser independently on each call.
    if 'descriptor_version' not in source:
        _fail()
    context = source['selection_context']
    if (source['library_id'] != state.library_id
            or source['platform'] != state.platform
            or context['resolver_contract'] != state.resolver_contract
            or context['inventory_digest'] != state.digest):
        _fail()
    selected = _selected_prepared_root(state, source['artwork_root_id'])
    if (not selected.browse_eligible
            or selected.root_path != source['artwork_root_path']):
        _fail()
    return SourceProof(_freeze(source))


def bind_prepared_inventory(source, prepared):
    """Strictly bind one source using this phase's codec-created inventory index."""
    source = source_object(source)
    return _bind_prepared_source(source, _prepared_state(prepared))


def bind_inventory(source, inventory):
    """Verify claimed context against complete validated inventory, not authority."""
    source = source_object(source)
    prepared, inventory = _prepare_inventory_binding(inventory)
    return _bind_prepared_source(source, _prepared_state(prepared)), inventory


def validate_pair(source, acquisition):
    """Recompute descriptor binding; does not probe current leaf or grant authority."""
    source = source_object(source)
    acquisition = acquisition_object(acquisition)
    versioned = 'descriptor_version' in source
    if versioned != ('acquisition_version' in acquisition):
        _fail()
    if versioned:
        if (source['platform'] != acquisition['platform']
                or acquisition['descriptor_digest'] != descriptor_digest(source)):
            _fail()
        if source['platform'] == 'win32':
            expected = {key: source['root'][key] for key in ('volume_serial', 'file_id')}
            if acquisition['file']['root_identity'] != expected:
                _fail()
    return SourceProof(_freeze(source)), AcquisitionProof(_freeze(acquisition))
