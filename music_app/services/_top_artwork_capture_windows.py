"""Dormant fixed synchronous retained Windows capture; no application authority."""
from dataclasses import asdict, dataclass
import hashlib
import sys
import time
import zlib

from music_app.services import rooted_local_file
from music_app.services import _top_artwork_resolution as common
from music_app.services._top_artwork_resolution_windows import (
    _Context, _copy_stamp, _validate_stamp, _path,
)
from music_app.services._rooted_local_file_windows import (
    WindowsIdentity, WindowsRootStamp, WindowsObservation, WindowsUnavailable,
    validate_component,
)
from music_app.services.artwork_pixels import (
    ArtworkPixelsUnavailable, SanitizedArtworkPixels, sanitize_artwork_pixels,
)
from music_app.services.public_top_artwork_acquisition import (
    ArtworkAcquisitionUnavailable, ArtworkCaptureCleanupIncomplete, CapturedArtwork,
    MAX_INPUT_BYTES, MAX_INPUT_PIXELS, MAX_EDGE, MAX_OUTPUT_BYTES,
)


@dataclass(frozen=True)
class WindowsArtworkSourceDescriptor:
    library_id: int
    local_album_id: int
    artwork_root_id: int
    artwork_root_path: str
    stored_cover_path: str
    resolved_cover_path: str
    relative_parts: tuple[str, ...]
    root_stamp: WindowsRootStamp


def _invalid():
    raise ArtworkAcquisitionUnavailable('artwork_source_invalid')


def _validate_descriptor(source):
    common._record(source, WindowsArtworkSourceDescriptor, {
        'library_id', 'local_album_id', 'artwork_root_id', 'artwork_root_path',
        'stored_cover_path', 'resolved_cover_path', 'relative_parts', 'root_stamp'})
    if any(not common._identifier(value) for value in
           (source.library_id, source.local_album_id, source.artwork_root_id)):
        _invalid()
    drive, parts, _ = _path(source.artwork_root_path, root=True)
    cover_drive, cover_parts, _ = _path(source.resolved_cover_path, absolute=True)
    _path(source.stored_cover_path)
    relative = source.relative_parts
    if type(relative) is not tuple or not 1 <= len(relative) <= 256:
        _invalid()
    for part in relative:
        if type(part) is not str:
            _invalid()
        validate_component(part, 255)
    joined = source.artwork_root_path + ('' if source.artwork_root_path.endswith('\\') else '\\')
    joined += '\\'.join(relative)
    if (len(parts) + len(relative) > 256 or drive != cover_drive
            or cover_parts != (*parts, *relative) or joined != source.resolved_cover_path):
        _invalid()
    stamp = _validate_stamp(_copy_stamp(source.root_stamp), source.artwork_root_path)
    # Enforce the unchanged codec subset and encoded source limit as well as W2
    # lexical grammar. This fixed placeholder is validation only, never evidence.
    from music_app.services import artwork_proof_codec as codec
    value = {key: getattr(source, key) for key in ('library_id', 'local_album_id',
        'artwork_root_id', 'artwork_root_path', 'stored_cover_path', 'resolved_cover_path')}
    value.update(descriptor_version=2, platform='win32', relative_parts=list(relative),
        root={'volume_serial': str(stamp.identity.volume_serial),
              'file_id': stamp.identity.file_id.hex(), 'selector': asdict(stamp.selector)},
        selection_context={'version': 1, 'resolver_contract': 'artwork-win32-lexical-selection-v1',
                           'inventory_digest': '0' * 64})
    codec.canonical_source_bytes(value)
    return WindowsArtworkSourceDescriptor(source.library_id, source.local_album_id,
        source.artwork_root_id, source.artwork_root_path, source.stored_cover_path,
        source.resolved_cover_path, relative, stamp)


def artwork_source_from_observation(*, library_id, observation, root_observation):
    """Pure exact Windows observation adapter, including a missing tail."""
    try:
        common._record(observation, common.RowObservation, {'row_ref', 'local_album_id',
            'stored_cover_path', 'resolved_cover_path', 'relative_parts', 'root_id',
            'root_path', 'root_ledger_key', 'leaf_state'})
        common._record(root_observation, common.RootObservation,
                       {'root_ledger_key', 'initial', 'final'})
        if not common._uuid(observation.row_ref):
            _invalid()
        source = _validate_descriptor(WindowsArtworkSourceDescriptor(library_id,
            observation.local_album_id, observation.root_id, observation.root_path,
            observation.stored_cover_path, observation.resolved_cover_path,
            observation.relative_parts, root_observation.initial))
        initial = source.root_stamp
        final = _validate_stamp(_copy_stamp(root_observation.final), observation.root_path)
        key = ('win32', observation.root_id, observation.root_path)
        if (type(observation.root_ledger_key) is not tuple
                or type(root_observation.root_ledger_key) is not tuple
                or len(observation.root_ledger_key) != 3 or len(root_observation.root_ledger_key) != 3
                or any(type(value) is not expected for ledger in
                       (observation.root_ledger_key, root_observation.root_ledger_key)
                       for value, expected in zip(ledger, (str, int, str)))
                or observation.root_ledger_key != key or root_observation.root_ledger_key != key
                or initial != final or type(observation.leaf_state) is not str
                or observation.leaf_state not in {'regular', 'missing_tail'}):
            _invalid()
        return source
    except (ValueError, TypeError, AttributeError, WindowsUnavailable):
        raise ArtworkAcquisitionUnavailable('artwork_source_invalid') from None


def _identity(value):
    common._record(value, WindowsIdentity, {'platform', 'volume_serial', 'file_id'})
    if (type(value.platform) is not str or value.platform != 'win32'
            or type(value.volume_serial) is not int or not 0 <= value.volume_serial < 2 ** 64
            or type(value.file_id) is not bytes or len(value.file_id) != 16):
        _invalid()
    return WindowsIdentity(value.platform, value.volume_serial, value.file_id)


def _validate_observation(info, source):
    common._record(info, WindowsObservation, {'platform', 'root_identity', 'leaf_identity',
        'size', 'last_write_time', 'change_time', 'original_name', 'original_suffix'})
    root, leaf = _identity(info.root_identity), _identity(info.leaf_identity)
    if (type(info.platform) is not str or info.platform != 'win32'
            or root != source.root_stamp.identity or root.volume_serial != leaf.volume_serial
            or type(info.size) is not int or not 1 <= info.size <= MAX_INPUT_BYTES
            or any(type(value) is not int or not -(2 ** 63) <= value < 2 ** 63
                   for value in (info.last_write_time, info.change_time))
            or type(info.original_name) is not str or len(info.original_name) > 16384
            or type(info.original_suffix) is not str or len(info.original_suffix) > 16384):
        _invalid()
    return WindowsObservation('win32', root, leaf, info.size, info.last_write_time,
                              info.change_time, info.original_name, info.original_suffix)


def _check_lease(lease, expected, source):
    observed = lease.check()
    if observed is not None and _validate_observation(observed, source) != expected:
        raise ArtworkAcquisitionUnavailable('artwork_source_changed')


def _read_bounded(reader, context):
    chunks, count, chunk = [], 0, None
    try:
        while count <= MAX_INPUT_BYTES:
            requested = min(65536, MAX_INPUT_BYTES + 1 - count)
            context.before_syscall()
            chunk = reader.read(requested)
            context.check()
            if type(chunk) is not bytes or len(chunk) > requested:
                _invalid()
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_INPUT_BYTES:
                raise ArtworkAcquisitionUnavailable('artwork_input_limit')
            chunks.append(chunk)
        return b''.join(chunks)
    finally:
        chunks.clear()
        chunk = None


def _validate_png(png):
    # Bounded container validation only; never a second decoder invocation.
    position, seen_data = 8, False
    while position < len(png):
        if position + 12 > len(png):
            _invalid()
        size = int.from_bytes(png[position:position + 4], 'big')
        end = position + 12 + size
        if end > len(png):
            _invalid()
        kind = png[position + 4:position + 8]
        body = png[position + 8:end - 4]
        if zlib.crc32(png[position + 4:end - 4]) != int.from_bytes(png[end - 4:end], 'big'):
            _invalid()
        if position == 8:
            if kind != b'IHDR' or size != 13 or body[8:] not in (
                    b'\x08\x02\x00\x00\x00', b'\x08\x06\x00\x00\x00'):
                _invalid()
        elif kind == b'IDAT':
            seen_data = True
        elif kind == b'IEND':
            if size != 0 or end != len(png) or not seen_data:
                _invalid()
            return
        else:
            _invalid()
        position = end
    _invalid()


def _prepare_capture(source, info, image):
    common._record(image, SanitizedArtworkPixels,
                   {'png', 'width', 'height', 'input_bytes', 'input_pixels'})
    if (type(image.png) is not bytes or not 24 <= len(image.png) <= MAX_OUTPUT_BYTES
            or any(type(value) is not int or not 1 <= value <= MAX_EDGE
                   for value in (image.width, image.height))
            or type(image.input_bytes) is not int or image.input_bytes != info.size
            or type(image.input_pixels) is not int or not 1 <= image.input_pixels <= MAX_INPUT_PIXELS
            or image.width * image.height > image.input_pixels
            or image.png[:16] != b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR'
            or int.from_bytes(image.png[16:20], 'big') != image.width
            or int.from_bytes(image.png[20:24], 'big') != image.height):
        raise ArtworkAcquisitionUnavailable('artwork_invalid')
    _validate_png(image.png)
    return CapturedArtwork(source, info, image.png, hashlib.sha256(image.png).hexdigest(),
        image.width, image.height, image.input_bytes, image.input_pixels)


def _not_abandoned():
    return False


def capture_artwork_windows(source):
    """One original deadline, retained lease, reader, sanitizer and final fence."""
    context = _Context(time.monotonic() + 10.0, _not_abandoned)
    lease = reader = payload = image = prepared = None
    failure = interruption = None
    fatal = False
    try:
        context.check()
        source = _validate_descriptor(source)
        if sys.platform != 'win32':
            raise ArtworkAcquisitionUnavailable('artwork_platform_unavailable')
        lease = rooted_local_file.acquire(
            rooted_local_file.RootSelection('win32', source.artwork_root_path, source.relative_parts),
            expected_root_stamp=source.root_stamp, operation_context=context)
        if type(lease) is not rooted_local_file.RootedRegularFile:
            _invalid()
        if _validate_stamp(_copy_stamp(lease.root_stamp), source.artwork_root_path) != source.root_stamp:
            raise ArtworkAcquisitionUnavailable('artwork_source_changed')
        info = _validate_observation(lease.observation, source)
        reader = lease.independent_reader()
        _check_lease(lease, info, source)
        payload = _read_bounded(reader, context)
        _check_lease(lease, info, source)
        if not payload or len(payload) != info.size:
            raise ArtworkAcquisitionUnavailable('artwork_source_changed')
        context.check()
        image = sanitize_artwork_pixels(payload, max_input_bytes=MAX_INPUT_BYTES,
            max_pixels=MAX_INPUT_PIXELS, max_edge=MAX_EDGE, max_output_bytes=MAX_OUTPUT_BYTES)
        context.check()
        _check_lease(lease, info, source)
        prepared = _prepare_capture(source, info, image)
    except common._Stop as error:
        failure = str(error) if str(error) in {'artwork_probe_timeout', 'artwork_validation_limit'} else 'artwork_source_unavailable'
    except (ArtworkAcquisitionUnavailable, ArtworkPixelsUnavailable) as error:
        code = str(error)
        failure = code if code in {'artwork_source_invalid', 'artwork_source_changed',
            'artwork_platform_unavailable', 'artwork_input_limit', 'artwork_output_limit',
            'artwork_pixel_limit', 'artwork_decoder_unavailable', 'artwork_invalid'} else 'artwork_source_unavailable'
        code = None
    except Exception:
        failure = 'artwork_source_unavailable'
    except BaseException as error:
        # Keep genuine cancellation for confirmed cleanup, but leave its active
        # handler before cleanup can fail. A fatal must not inherit this chain.
        interruption = error
    finally:
        # Never gate cleanup on deadline/work admission. Never retry a close.
        if reader is not None:
            try:
                result = reader.close()
                if result is not None and result is not True:
                    fatal = True
            except BaseException:
                fatal = True
        if lease is not None:
            try:
                result = lease.close()
                if result is not None and result is not True:
                    fatal = True
            except BaseException:
                fatal = True
            try:
                if lease.cleanup_complete is not True:
                    fatal = True
            except BaseException:
                fatal = True
        try:
            context.assert_discharged()
        except BaseException:
            fatal = True
        if context.cleanup_incomplete:
            fatal = True
        payload = image = reader = lease = None
        if fatal or failure is not None or interruption is not None:
            prepared = None
    if fatal:
        # Drop the private primary traceback before constructing the outward
        # fatal, outside both primary and cleanup exception-handler contexts.
        interruption = None
        raise ArtworkCaptureCleanupIncomplete('artwork_cleanup_incomplete') from None
    if interruption is not None:
        raise interruption
    if failure is not None:
        raise ArtworkAcquisitionUnavailable(failure) from None
    try:
        context.check()
    except common._Stop:
        prepared = None
        raise ArtworkAcquisitionUnavailable('artwork_probe_timeout') from None
    return prepared
