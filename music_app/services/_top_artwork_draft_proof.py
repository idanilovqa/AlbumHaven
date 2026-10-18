"""Pure, fixed POSIX saved/draft proof adapters; no authority or native work.

Saved observations retain their exact legacy objects. Their private operation
hashes are neither persisted proof digests nor historical inventory bindings.
"""
from dataclasses import asdict
import hashlib
import json

from music_app.services import artwork_proof_codec as codec
from music_app.services import _top_artwork_resolution as resolution
from music_app.services.public_top_artwork_acquisition import (
    ArtworkSourceDescriptor, ArtworkFileObservation, CapturedArtwork,
    artwork_source_from_observation,
)
from music_app.services.rooted_local_file import PosixRootStamp
from music_app.services.owned_album_tops import AlbumTopError


_SAVED_SOURCE_DOMAIN = b'AlbumHaven/saved-artwork-source-observation/v1\x00'
_SAVED_ACQUISITION_DOMAIN = b'AlbumHaven/saved-artwork-acquisition-observation/v1\x00'


def unavailable():
    raise AlbumTopError('artwork_source_changed', 409)


def ready_binding(source, acquisition, prepared, *, library_id, local_album_id):
    if codec.source_object(source).get('platform') == 'win32':
        return _windows_ready_binding(source, acquisition, prepared,
            library_id=library_id, local_album_id=local_album_id)
    source, acquisition = codec.validate_pair(source, acquisition)
    source = codec.bind_prepared_inventory(source, prepared)
    value = codec.source_object(source)
    if (value.get('descriptor_version') != 2 or value.get('platform') != 'posix'
            or value['library_id'] != library_id or value['local_album_id'] != local_album_id):
        unavailable()
    expected = resolution.ExpectedSelection(value['artwork_root_id'], value['artwork_root_path'],
        value['resolved_cover_path'], tuple(value['relative_parts']),
        PosixRootStamp('posix', int(value['root']['device']), int(value['root']['inode'])))
    return (expected, codec.descriptor_digest(source),
            hashlib.sha256(codec.canonical_acquisition_bytes(acquisition)).hexdigest())


def _legacy_source(source):
    value = codec.source_object(source)
    if ('descriptor_version' in value
            or any(type(value[key]) is not int or not 0 <= value[key] <= (1 << 64) - 1
                   for key in ('root_device', 'root_inode'))):
        unavailable()
    # The codec deliberately admits older stored-cover spellings. Reuse the
    # fixed resolver's pure grammar before constructing an ExpectedSelection;
    # no normalization, native resolver invocation or cached-path substitute.
    try:
        resolution._path(value['stored_cover_path'])
    except resolution.ResolutionInputInvalid:
        unavailable()
    return value


def _bounded_legacy_bytes(value, limit):
    """Same fixed UTF-8 JSON rules as the shared snapshot encoder, per proof.

    SQL must already have bounded the original JSONB transport. This additional
    compact bound is not a PostgreSQL digest or a legacy canonical-byte API.
    Values here have passed the codec's exact source/acquisition schemas.
    """
    chunks, size = [], 0
    try:
        for chunk in json.JSONEncoder(sort_keys=True, separators=(',', ':'),
                ensure_ascii=False, allow_nan=False).iterencode(value):
            encoded = chunk.encode('utf-8')
            size += len(encoded)
            if size > limit:
                raise AlbumTopError('artwork_validation_limit', 409)
            chunks.append(encoded)
    except (TypeError, ValueError, UnicodeError, OverflowError):
        raise codec.InvalidArtworkProof() from None
    return b''.join(chunks)


def saved_ready_binding(source, acquisition, *, library_id, local_album_id,
                        stored_cover_path):
    """Strict legacy-only comparison for an already scoped immutable ready row.

    The caller checks included/ready state, actual saved item/source/library and
    immutable asset binding, and supplies CURRENT cover text from its bounded
    selected-source projection. Fresh inventory and policy remain caller-owned.
    No inventory digest is asserted for this historical unversioned evidence.
    """
    source, acquisition = codec.validate_pair(source, acquisition)
    value = _legacy_source(source)
    acquired = codec.acquisition_object(acquisition)
    if ('acquisition_version' in acquired
            or type(library_id) is not int or type(local_album_id) is not int
            or value['library_id'] != library_id or value['local_album_id'] != local_album_id
            or type(stored_cover_path) is not str
            or value['stored_cover_path'] != stored_cover_path):
        unavailable()
    # Equality to the codec-bounded text proves the supplied current text is
    # nonempty, UTF-8 bounded and unchanged, before any ready expectation exists.
    expected = resolution.ExpectedSelection(value['artwork_root_id'], value['artwork_root_path'],
        value['resolved_cover_path'], tuple(value['relative_parts']),
        PosixRootStamp('posix', value['root_device'], value['root_inode']))
    source_bytes = _bounded_legacy_bytes(value, codec.SOURCE_LIMIT)
    acquired_bytes = _bounded_legacy_bytes(acquired, codec.ACQUISITION_LIMIT)
    return (expected, hashlib.sha256(_SAVED_SOURCE_DOMAIN + source_bytes).hexdigest(),
            hashlib.sha256(_SAVED_ACQUISITION_DOMAIN + acquired_bytes).hexdigest())


def checked_observations(result, request):
    from music_app.services._top_artwork_resolution_windows import CONTRACT as WINDOWS_CONTRACT
    if (type(request) is not resolution.ResolutionInput or type(request.platform) is not str
            or type(request.resolver_contract) is not str
            or (request.platform, request.resolver_contract) not in {
                ('posix', resolution.CONTRACT), ('win32', WINDOWS_CONTRACT)}):
        unavailable()
    if type(request) is resolution.ResolutionInput and request.platform == 'win32':
        return _windows_checked_observations(result, request)
    if type(result) is resolution.Failure:
        code = result.error_code
        if code not in {'artwork_source_invalid', 'artwork_unavailable', 'artwork_source_changed',
                        'artwork_validation_limit', 'artwork_probe_busy', 'artwork_probe_timeout',
                        'artwork_probe_unavailable'}:
            code = 'artwork_probe_unavailable'
        raise AlbumTopError(code, 409)
    if (type(result) is not resolution.Success or type(result.rows) is not tuple
            or type(result.roots) is not tuple or len(result.rows) != len(request.rows)
            or len(result.roots) > len(request.roots)
            or (result.operation_ref, result.snapshot_digest, result.platform, result.resolver_contract)
               != (request.operation_ref, request.snapshot_digest, 'posix', resolution.CONTRACT)):
        unavailable()
    root_inputs = {root.root_id: root.root_path for root in request.roots}
    roots = {}
    previous = 0
    for root in result.roots:
        if (type(root) is not resolution.RootObservation or type(root.root_ledger_key) is not tuple
                or len(root.root_ledger_key) != 3 or root.root_ledger_key[0] != 'posix'
                or type(root.root_ledger_key[1]) is not int or root.root_ledger_key[1] <= previous
                or root_inputs.get(root.root_ledger_key[1]) != root.root_ledger_key[2]
                or type(root.initial) is not PosixRootStamp or type(root.final) is not PosixRootStamp
                or root.initial != root.final or root.initial.platform != 'posix'
                or any(type(x) is not int or not 0 <= x <= (1 << 64) - 1
                       for x in (root.initial.device, root.initial.inode))):
            unavailable()
        previous = root.root_ledger_key[1]
        roots[root.root_ledger_key] = root
    rows = {}
    used = set()
    for observed, requested in zip(result.rows, request.rows):
        if (type(observed) is not resolution.RowObservation
                or (observed.row_ref, observed.local_album_id, observed.stored_cover_path)
                   != (requested.row_ref, requested.local_album_id, requested.stored_cover_path)
                or type(observed.root_ledger_key) is not tuple
                or observed.root_ledger_key != ('posix', observed.root_id, observed.root_path)
                or observed.root_ledger_key not in roots or observed.row_ref in rows
                or observed.leaf_state not in {'regular', 'missing_tail'}):
            unavailable()
        root = roots[observed.root_ledger_key]
        # Reapply comparison at the adapter boundary; expected data is never
        # authority and an internal collaborator cannot replace a ready proof.
        expected = requested.expected
        if expected is not None and (expected.root_id, expected.root_path,
                expected.resolved_cover_path, expected.relative_parts, expected.root_stamp) != (
                observed.root_id, observed.root_path, observed.resolved_cover_path,
                observed.relative_parts, root.initial):
            unavailable()
        rows[observed.row_ref] = (observed, root)
        used.add(observed.root_ledger_key)
    if used != set(roots):
        unavailable()
    return rows


def saved_source_base(library_id, observation, root):
    """Validate every observed row; return descriptor and exact legacy base.

    This pure conversion runs outside the DB phase. It does not turn the fresh
    operation inventory into historical consent and never reads leaf bytes.
    """
    source = artwork_source_from_observation(library_id=library_id,
        observation=observation, root_observation=root)
    value = asdict(source)
    value['relative_parts'] = list(source.relative_parts)
    return source, _legacy_source(value)


def observation_source(library_id, observation, root, inventory_digest):
    """Validate the shared producer subset for every row, including off-batch."""
    from music_app.services._rooted_local_file_windows import WindowsRootStamp
    if type(root) is resolution.RootObservation and type(root.initial) is WindowsRootStamp:
        descriptor = artwork_source_from_observation(library_id=library_id,
            observation=observation, root_observation=root)
        return descriptor, _windows_source_value(descriptor, inventory_digest)
    source, value = saved_source_base(library_id, observation, root)
    value.pop('root_device')
    value.pop('root_inode')
    value.update(descriptor_version=2, platform='posix',
        root={'device': str(source.root_device), 'inode': str(source.root_inode)},
        selection_context={'version': 1, 'resolver_contract': resolution.CONTRACT,
                           'inventory_digest': inventory_digest})
    return source, codec.source_object(value)


def source_base(library_id, observation, root, prepared):
    source, value = observation_source(library_id, observation, root, prepared.digest)
    proof = codec.bind_prepared_inventory(value, prepared)
    return source, codec.source_object(proof)


def captured_pair(result, source):
    value = codec.source_object(source)
    if value.get('platform') == 'win32':
        return windows_saved_captured_pair(result, value)
    legacy = asdict(result.source)
    legacy['relative_parts'] = list(result.source.relative_parts)
    if (any(legacy[key] != value[key] for key in ('library_id', 'local_album_id',
            'artwork_root_id', 'artwork_root_path', 'stored_cover_path',
            'resolved_cover_path', 'relative_parts'))
            or str(legacy['root_device']) != value['root']['device']
            or str(legacy['root_inode']) != value['root']['inode']):
        unavailable()
    info = result.file_observation
    acquisition = {'acquisition_version': 2, 'platform': 'posix',
        'descriptor_digest': codec.descriptor_digest(value),
        'file': {'device': str(info.device), 'inode': str(info.inode), 'size': info.size,
                 'mtime_ns': str(info.mtime_ns), 'ctime_ns': str(info.ctime_ns)},
        'input_bytes': result.input_bytes, 'input_pixels': result.input_pixels}
    source, acquisition = codec.validate_pair(value, acquisition)
    return (codec.source_object(source), codec.acquisition_object(acquisition),
            codec.canonical_source_bytes(source).decode('ascii'))


def saved_captured_pair(result, source):
    """Return the unchanged saved completion shape, never v2 or canonical text.

    source is the legacy base object returned by saved_source_base, not its
    descriptor. The shared capture owner separately checks PNG/sanitizer/content
    bounds before calling this adapter. Exact descriptor fields and strict file,
    input-byte and input-pixel bounds are checked here as well.
    """
    value = _legacy_source(source)
    if (type(result) is not CapturedArtwork
            or type(result.source) is not ArtworkSourceDescriptor
            or type(result.source.relative_parts) is not tuple
            or type(result.file_observation) is not ArtworkFileObservation):
        unavailable()
    captured = asdict(result.source)
    captured['relative_parts'] = list(result.source.relative_parts)
    if _legacy_source(captured) != value:
        unavailable()
    acquisition = {'file': asdict(result.file_observation),
        'input_bytes': result.input_bytes, 'input_pixels': result.input_pixels}
    checked_source, checked_acquisition = codec.validate_pair(captured, acquisition)
    source_value = codec.source_object(checked_source)
    acquisition_value = codec.acquisition_object(checked_acquisition)
    _bounded_legacy_bytes(source_value, codec.SOURCE_LIMIT)
    _bounded_legacy_bytes(acquisition_value, codec.ACQUISITION_LIMIT)
    return source_value, acquisition_value


def _windows_source_value(source, inventory_digest):
    from music_app.services._top_artwork_capture_windows import _validate_descriptor
    from music_app.services._top_artwork_resolution_windows import CONTRACT
    source = _validate_descriptor(source)
    stamp = source.root_stamp
    value = {key: getattr(source, key) for key in ('library_id', 'local_album_id',
        'artwork_root_id', 'artwork_root_path', 'stored_cover_path', 'resolved_cover_path')}
    value.update(descriptor_version=2, platform='win32',
        relative_parts=list(source.relative_parts),
        root={'volume_serial': str(stamp.identity.volume_serial),
              'file_id': stamp.identity.file_id.hex(), 'selector': asdict(stamp.selector)},
        selection_context={'version': 1, 'resolver_contract': CONTRACT,
                           'inventory_digest': inventory_digest})
    return codec.source_object(value)


def _windows_ready_binding(source, acquisition, prepared, *, library_id, local_album_id):
    from music_app.services._rooted_local_file_windows import (
        WindowsIdentity, WindowsRootStamp, SelectorSnapshot,
    )
    source, acquisition = codec.validate_pair(source, acquisition)
    source = codec.bind_prepared_inventory(source, prepared)
    value = codec.source_object(source)
    if (value.get('descriptor_version') != 2 or value.get('platform') != 'win32'
            or type(library_id) is not int or type(local_album_id) is not int
            or value['library_id'] != library_id or value['local_album_id'] != local_album_id):
        unavailable()
    root = value['root']
    expected = resolution.ExpectedSelection(value['artwork_root_id'], value['artwork_root_path'],
        value['resolved_cover_path'], tuple(value['relative_parts']),
        WindowsRootStamp('win32', WindowsIdentity('win32', int(root['volume_serial']),
            bytes.fromhex(root['file_id'])), SelectorSnapshot(**root['selector'])))
    return (expected, codec.descriptor_digest(source),
            hashlib.sha256(codec.canonical_acquisition_bytes(acquisition)).hexdigest())


def windows_saved_source_base(library_id, observation, root, prepared):
    """Dormant saved-v2 producer; never upgrades saved-v1 evidence."""
    from music_app.services._top_artwork_capture_windows import WindowsArtworkSourceDescriptor
    source, value = source_base(library_id, observation, root, prepared)
    if type(source) is not WindowsArtworkSourceDescriptor or value.get('platform') != 'win32':
        unavailable()
    return source, value


def windows_saved_captured_pair(result, source):
    from music_app.services._top_artwork_capture_windows import (
        WindowsArtworkSourceDescriptor, _validate_observation,
    )
    value = codec.source_object(source)
    if (value.get('descriptor_version') != 2 or value.get('platform') != 'win32'
            or type(result) is not CapturedArtwork
            or type(result.source) is not WindowsArtworkSourceDescriptor):
        unavailable()
    resolution._record(result, CapturedArtwork, {'source', 'file_observation', 'png',
        'content_digest', 'width', 'height', 'input_bytes', 'input_pixels',
        'sanitizer_contract', 'mime_type'})
    captured = _windows_source_value(result.source, value['selection_context']['inventory_digest'])
    if captured != value:
        unavailable()
    info = _validate_observation(result.file_observation, result.source)
    def identity(value):
        return {'volume_serial': str(value.volume_serial), 'file_id': value.file_id.hex()}
    acquisition = {'acquisition_version': 2, 'platform': 'win32',
        'descriptor_digest': codec.descriptor_digest(captured),
        'file': {'root_identity': identity(info.root_identity),
                 'leaf_identity': identity(info.leaf_identity), 'size': info.size,
                 'last_write_time': str(info.last_write_time), 'change_time': str(info.change_time)},
        'input_bytes': result.input_bytes, 'input_pixels': result.input_pixels}
    checked_source, checked_acquisition = codec.validate_pair(captured, acquisition)
    return (codec.source_object(checked_source), codec.acquisition_object(checked_acquisition),
            codec.canonical_source_bytes(checked_source).decode('ascii'))


def windows_saved_ready_binding(source, acquisition, prepared, *, library_id,
                                local_album_id, stored_cover_path):
    value = codec.source_object(source)
    if (type(stored_cover_path) is not str or value.get('platform') != 'win32'
            or value['stored_cover_path'] != stored_cover_path):
        unavailable()
    return _windows_ready_binding(source, acquisition, prepared,
        library_id=library_id, local_album_id=local_album_id)


def _windows_checked_observations(result, request):
    from music_app.services import _top_artwork_resolution_windows as windows
    from music_app.services._top_artwork_capture_windows import artwork_source_from_observation as windows_source
    # Reuse the fixed pure request validator, never its native resolver.
    request = windows._validate(request)
    if type(result) is resolution.Failure:
        code = result.error_code
        if type(code) is not str or code not in {'artwork_source_invalid', 'artwork_unavailable',
                'artwork_source_changed', 'artwork_validation_limit', 'artwork_probe_busy',
                'artwork_probe_timeout', 'artwork_probe_unavailable'}:
            code = 'artwork_probe_unavailable'
        raise AlbumTopError(code, 409)
    resolution._record(result, resolution.Success, {'operation_ref', 'snapshot_digest',
        'platform', 'resolver_contract', 'rows', 'roots', 'counts'})
    if (type(result.rows) is not tuple or type(result.roots) is not tuple
            or len(result.rows) != len(request.rows) or len(result.roots) > len(request.roots)
            or any(type(value) is not str for value in (result.operation_ref,
                result.snapshot_digest, result.platform, result.resolver_contract))
            or (result.operation_ref, result.snapshot_digest, result.platform, result.resolver_contract)
                != (request.operation_ref, request.snapshot_digest, 'win32', windows.CONTRACT)):
        unavailable()
    root_inputs = {root.root_id: root.root_path for root in request.roots}
    roots, rows, used = {}, {}, set()
    previous = 0
    for root in result.roots:
        resolution._record(root, resolution.RootObservation, {'root_ledger_key', 'initial', 'final'})
        key = root.root_ledger_key
        if (type(key) is not tuple or len(key) != 3 or type(key[0]) is not str
                or key[0] != 'win32' or type(key[1]) is not int or key[1] <= previous
                or type(key[2]) is not str or root_inputs.get(key[1]) != key[2]):
            unavailable()
        initial = windows._validate_stamp(windows._copy_stamp(root.initial), key[2])
        final = windows._validate_stamp(windows._copy_stamp(root.final), key[2])
        if initial != final:
            unavailable()
        previous = key[1]
        roots[key] = resolution.RootObservation(key, initial, final)
    for observed, requested in zip(result.rows, request.rows):
        resolution._record(observed, resolution.RowObservation, {'row_ref', 'local_album_id',
            'stored_cover_path', 'resolved_cover_path', 'relative_parts', 'root_id',
            'root_path', 'root_ledger_key', 'leaf_state'})
        if (type(observed.row_ref) is not str or type(observed.local_album_id) is not int
                or type(observed.stored_cover_path) is not str
                or (observed.row_ref, observed.local_album_id, observed.stored_cover_path)
                    != (requested.row_ref, requested.local_album_id, requested.stored_cover_path)
                or type(observed.root_ledger_key) is not tuple
                or len(observed.root_ledger_key) != 3
                or any(type(value) is not expected for value, expected in
                       zip(observed.root_ledger_key, (str, int, str)))
                or observed.root_ledger_key not in roots or observed.row_ref in rows):
            unavailable()
        root = roots[observed.root_ledger_key]
        windows_source(library_id=1, observation=observed, root_observation=root)
        expected = requested.expected
        if expected is not None and (expected.root_id, expected.root_path,
                expected.resolved_cover_path, expected.relative_parts, expected.root_stamp) != (
                observed.root_id, observed.root_path, observed.resolved_cover_path,
                observed.relative_parts, root.initial):
            unavailable()
        rows[observed.row_ref] = (observed, root)
        used.add(observed.root_ledger_key)
    if used != set(roots):
        unavailable()
    return rows
