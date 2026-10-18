"""W3 synthetic retained capture contracts; not native/decoder acceptance.

Source-authored only. Later execution requires its own reviewed import closure.
Real neutral ownership and operation accounting wrap inert streams/resources.
"""
import ast
from dataclasses import fields, replace
import gc
import hashlib
import importlib
from pathlib import Path
import sys
from types import SimpleNamespace
import weakref

import pytest


def _checkout_imports():
    here = Path(__file__).resolve(strict=True)
    if here.parts[-3:] != ('tests', 'py', 'test_top_artwork_windows_capture.py'):
        raise AssertionError('unexpected synthetic suite origin')
    root = here.parents[2]
    names = ('rooted_local_file', '_rooted_local_file_windows', '_top_artwork_resolution',
             '_top_artwork_resolution_windows', 'artwork_pixels',
             'public_top_artwork_acquisition', '_top_artwork_capture_windows', 'artwork_proof_codec')
    expected = {'music_app': root / 'music_app/__init__.py',
                'music_app.services': root / 'music_app/services/__init__.py'}
    expected.update({'music_app.services.' + name: root / ('music_app/services/' + name + '.py')
                     for name in names})
    for name, path in expected.items():
        assert path.is_file(), 'incomplete trusted checkout'
        module = sys.modules.get(name)
        if module is not None:
            assert getattr(module, '__file__', None) and Path(module.__file__).resolve(strict=True) == path
    added = str(root) not in sys.path
    if added:
        sys.path.insert(0, str(root))
    try:
        modules = tuple(importlib.import_module('music_app.services.' + name) for name in names)
        for name, path in expected.items():
            assert Path(sys.modules[name].__file__).resolve(strict=True) == path
    finally:
        if added:
            sys.path.remove(str(root))
    return modules


rooted, windows, resolution, winresolution, pixels, facade, capture, codec = _checkout_imports()
ROOT = 'C:\\Music'
GUID = '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\'
TARGET = '\\Device\\HarddiskVolume23'
SERIAL = 2 ** 64 - 1
PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01\xf6\x178U\x00\x00\x00\x00IEND\xaeB`\x82'


def stamp():
    return windows.WindowsRootStamp('win32', windows.WindowsIdentity('win32', SERIAL,
        bytes.fromhex('fedcba98765432100123456789abcdef')),
        windows.SelectorSnapshot('C:', GUID, TARGET, TARGET))


def source():
    return capture.WindowsArtworkSourceDescriptor(1, 2, 3, ROOT, 'album\\cover.jpg',
        ROOT + '\\album\\cover.jpg', ('album', 'cover.jpg'), stamp())


def observation(size=3):
    return windows.WindowsObservation('win32', stamp().identity,
        windows.WindowsIdentity('win32', SERIAL, b'\xff' * 16), size,
        -(2 ** 63), 2 ** 63 - 1, 'cover.jpg', '.jpg')


def row_root(state='regular'):
    key = ('win32', 3, ROOT)
    return (resolution.RowObservation('00000000-0000-4000-8000-000000000001', 2,
        'album\\cover.jpg', ROOT + '\\album\\cover.jpg', ('album', 'cover.jpg'),
        3, ROOT, key, state), resolution.RootObservation(key, stamp(), stamp()))


class Harness:
    def __init__(self, monkeypatch, chunks=None, size=3):
        self.now = 0.0
        self.events, self.requests, self.contexts, self.leases = [], [], [], []
        self.chunks = list([b'abc', b''] if chunks is None else chunks)
        self.info = observation(size)
        self.image = pixels.SanitizedArtworkPixels(PNG, 1, 1, size, 1)
        self.hooks = {}
        self.read_error = self.sanitize_error = self.reader_close_error = self.lease_close_error = None
        self.checks = self.sanitizes = self.reader_closes = self.lease_closes = 0
        self.domain = rooted._CleanupDomain()
        harness = self
        class Context(winresolution._Context):
            def __init__(self, deadline, abandoned):
                super().__init__(deadline, abandoned, clock=lambda: harness.now)
                harness.contexts.append(self)
            def check(self):
                harness.events.append('context.check')
                return super().check()
            def before_syscall(self):
                harness.events.append('before.read')
                return super().before_syscall()
            def assert_discharged(self):
                harness.events.append('discharge')
                harness.fire('discharge')
                return super().assert_discharged()
        monkeypatch.setattr(capture, '_Context', Context)
        monkeypatch.setattr(capture, 'time', SimpleNamespace(monotonic=lambda: self.now))
        monkeypatch.setattr(capture, 'sys', SimpleNamespace(platform='win32'))
        monkeypatch.setattr(rooted, 'acquire', self.acquire)
        monkeypatch.setattr(capture, 'sanitize_artwork_pixels', self.sanitize)
        class Stream:
            def read(self, count):
                harness.events.append('read')
                harness.requests.append(count)
                harness.fire('read')
                if harness.read_error:
                    raise harness.read_error
                return harness.chunks.pop(0) if harness.chunks else b''
            def close(self):
                harness.events.append('reader.close')
                harness.reader_closes += 1
                harness.fire('reader.close')
                if harness.reader_close_error:
                    raise harness.reader_close_error
            def seek(self, *args):
                raise AssertionError('capture must not seek')
            def fileno(self):
                raise AssertionError('capture must not borrow a descriptor')
        class Resource:
            def __init__(self):
                self.observation = harness.info
                self.root_stamp = stamp()
                self._cleanup_domain = harness.domain
            def check(self):
                harness.checks += 1
                harness.events.append('lease.check')
                harness.fire('lease.check')
            def reader(self):
                harness.events.append('reader.open')
                harness.fire('reader.open')
                return Stream()
            def close(self):
                harness.events.append('lease.close')
                harness.lease_closes += 1
                harness.fire('lease.close')
                if harness.lease_close_error:
                    raise harness.lease_close_error
        self.Resource = Resource

    def fire(self, event):
        if event in self.hooks:
            self.hooks[event](self)

    def expire(self):
        self.now = self.contexts[0].deadline

    def acquire(self, selection, *, expected_root_stamp, operation_context):
        self.events.append('acquire')
        assert type(selection) is rooted.RootSelection
        assert selection == rooted.RootSelection('win32', ROOT, ('album', 'cover.jpg'))
        assert expected_root_stamp == stamp()
        assert operation_context is self.contexts[0]
        self.fire('acquire')
        # The neutral lease and ownership registry are real. Only its resource
        # is inert; no backend, raw handle, native DLL or filename is opened.
        with rooted._CleanupScope(operation_context=operation_context):
            lease = rooted.RootedRegularFile(self.Resource())
        self.leases.append(lease)
        return lease

    def sanitize(self, payload, **kwargs):
        self.events.append('sanitize')
        self.sanitizes += 1
        assert type(payload) is bytes and len(payload) == self.info.size
        assert kwargs == dict(max_input_bytes=16777216, max_pixels=16000000,
                              max_edge=256, max_output_bytes=327680)
        self.fire('sanitize')
        if self.sanitize_error:
            raise self.sanitize_error
        return self.image

    def run(self):
        return facade.capture_artwork(source())


def unavailable(call, code=None):
    with pytest.raises(facade.ArtworkAcquisitionUnavailable) as caught:
        call()
    assert type(caught.value) is facade.ArtworkAcquisitionUnavailable
    if code is not None:
        assert str(caught.value) == code
    assert 'C:' not in str(caught.value)
    assert caught.value.__cause__ is None
    return caught.value


def test_exact_descriptor_copies_nested_stamp_and_preserves_high_bits():
    original = source()
    copied = capture._validate_descriptor(original)
    assert type(copied) is capture.WindowsArtworkSourceDescriptor
    assert copied == original and copied is not original
    assert copied.root_stamp is not original.root_stamp
    assert copied.root_stamp.identity is not original.root_stamp.identity
    assert copied.root_stamp.selector is not original.root_stamp.selector
    assert copied.root_stamp.identity.file_id.hex() == 'fedcba98765432100123456789abcdef'
    assert [f.name for f in fields(copied)] == ['library_id', 'local_album_id', 'artwork_root_id',
        'artwork_root_path', 'stored_cover_path', 'resolved_cover_path', 'relative_parts', 'root_stamp']


@pytest.mark.parametrize('field,value', [
    ('library_id', True), ('library_id', 0), ('local_album_id', 2 ** 63),
    ('artwork_root_id', -1), ('relative_parts', ['album', 'cover.jpg']),
    ('relative_parts', ()), ('relative_parts', ('..', 'cover.jpg')),
    ('relative_parts', ('CON',)), ('artwork_root_path', 'c:\\Music'),
    ('stored_cover_path', '..\\cover.jpg'), ('stored_cover_path', 'cover.jpg:stream'),
    ('resolved_cover_path', 'C:\\Other\\album\\cover.jpg'),
    ('root_stamp', rooted.PosixRootStamp('posix', 1, 2)),
])
def test_invalid_descriptor_rejected_before_acquire(monkeypatch, field, value):
    h = Harness(monkeypatch)
    unavailable(lambda: capture.capture_artwork_windows(replace(source(), **{field: value})))
    assert 'acquire' not in h.events


@pytest.mark.parametrize('kind', ['descriptor_subclass', 'descriptor_extra', 'identity_subclass',
    'identity_extra', 'stamp_extra', 'selector_extra', 'serial_bool', 'serial_overflow',
    'file_id_mutable', 'file_id_short', 'selector_mismatch'])
def test_exact_nested_record_guards(monkeypatch, kind):
    value = source()
    if kind == 'descriptor_subclass':
        class Child(capture.WindowsArtworkSourceDescriptor):
            pass
        value = Child(**value.__dict__)
    elif kind == 'identity_subclass':
        class Child(windows.WindowsIdentity):
            pass
        value = replace(value, root_stamp=replace(value.root_stamp,
            identity=Child(**value.root_stamp.identity.__dict__)))
    elif kind.endswith('_extra'):
        target = {'descriptor_extra': value, 'identity_extra': value.root_stamp.identity,
                  'stamp_extra': value.root_stamp, 'selector_extra': value.root_stamp.selector}[kind]
        object.__setattr__(target, 'extra', 1)
    elif kind.startswith('serial_'):
        value = replace(value, root_stamp=replace(value.root_stamp, identity=replace(
            value.root_stamp.identity, volume_serial=True if kind == 'serial_bool' else 2 ** 64)))
    elif kind.startswith('file_id_'):
        value = replace(value, root_stamp=replace(value.root_stamp, identity=replace(
            value.root_stamp.identity, file_id=bytearray(16) if kind == 'file_id_mutable' else b'x')))
    else:
        value = replace(value, root_stamp=replace(value.root_stamp, selector=replace(
            value.root_stamp.selector, guid_target='\\Device\\HarddiskVolume24')))
    h = Harness(monkeypatch)
    unavailable(lambda: capture.capture_artwork_windows(value))
    assert 'acquire' not in h.events


@pytest.mark.parametrize('state', ['regular', 'missing_tail'])
def test_pure_facade_observation_adapter_has_no_io(monkeypatch, state):
    def denied(*args, **kwargs):
        raise AssertionError('pure adapter attempted I/O')
    monkeypatch.setattr(rooted, 'acquire', denied)
    row, root = row_root(state)
    assert facade.artwork_source_from_observation(library_id=1,
        observation=row, root_observation=root) == source()


@pytest.mark.parametrize('field,value', [('size', 0), ('size', 16777217), ('size', True),
    ('last_write_time', -(2 ** 63) - 1), ('change_time', 2 ** 63),
    ('change_time', True), ('platform', 'posix'), ('original_name', b'cover')])
def test_observation_exact_bounds(monkeypatch, field, value):
    h = Harness(monkeypatch)
    h.info = replace(h.info, **{field: value})
    unavailable(h.run)
    assert not h.requests and not h.sanitizes
    assert h.lease_closes == 1


@pytest.mark.parametrize('field', ['root_identity', 'leaf_identity'])
def test_observation_root_or_volume_mismatch(monkeypatch, field):
    h = Harness(monkeypatch)
    h.info = replace(h.info, **{field: replace(getattr(h.info, field), volume_serial=1)})
    unavailable(h.run)
    assert not h.requests and h.lease_closes == 1


def test_success_exact_envelope_single_context_budget_and_discharge(monkeypatch):
    h = Harness(monkeypatch)
    result = h.run()
    assert type(result) is facade.CapturedArtwork
    assert result.source == source() and result.file_observation == observation()
    assert result.file_observation is not h.info
    assert result.png == PNG and result.content_digest == hashlib.sha256(PNG).hexdigest()
    assert result.input_bytes == 3 and result.input_pixels == 1
    assert len(h.contexts) == 1 and h.contexts[0].deadline == 10.0
    assert h.contexts[0].abandoned() is False and h.contexts[0]._job is None
    assert h.requests == [65536, 65536] and h.contexts[0].syscalls == 2
    assert h.sanitizes == 1 and h.checks == 5
    assert h.events[-4:] == ['reader.close', 'lease.close', 'discharge', 'context.check']
    assert h.leases[0].cleanup_complete is True and not h.contexts[0]._cleanup_owners
    for i, event in enumerate(h.events):
        if event == 'read':
            assert h.events[i - 2:i] == ['before.read', 'context.check']
            assert h.events[i + 1] == 'context.check'


@pytest.mark.parametrize('chunks,size,success', [
    ([b'',], 1, False), ([b'a', b''], 3, False), ([b'abcd', b''], 3, False),
    ([b'a', b'b', b'c', b''], 3, True), ([None], 3, False),
    ([bytearray(b'abc')], 3, False), ([memoryview(b'abc')], 3, False),
    (['abc'], 3, False), ([b'x' * 65537], 3, False),
])
def test_stream_exact_types_short_reads_and_observed_size(monkeypatch, chunks, size, success):
    h = Harness(monkeypatch, chunks, size)
    if success:
        assert h.run().input_bytes == size
    else:
        unavailable(h.run)
        assert h.sanitizes == 0
    assert h.contexts[0].syscalls == len(h.requests)
    assert h.reader_closes == h.lease_closes == 1


@pytest.mark.parametrize('extra', [False, True])
def test_actual_sixteen_mib_boundary_and_one_excess_byte(monkeypatch, extra):
    chunks = [b'x' * 65536] * 256 + ([b'x'] if extra else [b''])
    h = Harness(monkeypatch, chunks, 16777216)
    if extra:
        unavailable(h.run)
        assert h.sanitizes == 0
    else:
        assert h.run().input_bytes == 16777216
    assert h.requests == [65536] * 256 + [1]
    assert h.contexts[0].syscalls == 257


@pytest.mark.parametrize('stage', ['acquire', 'reader.open', 'pre_read', 'read',
    'pre_sanitize', 'sanitize', 'post_sanitize'])
def test_original_deadline_equality_at_each_reached_boundary(monkeypatch, stage):
    h = Harness(monkeypatch)
    if stage == 'pre_read':
        h.hooks['lease.check'] = lambda x: x.expire() if x.checks == 3 else None
    elif stage == 'pre_sanitize':
        h.hooks['lease.check'] = lambda x: x.expire() if x.checks == 4 else None
    elif stage == 'post_sanitize':
        h.hooks['lease.check'] = lambda x: x.expire() if x.checks == 5 else None
    else:
        h.hooks[stage] = lambda x: x.expire()
    unavailable(h.run, 'artwork_probe_timeout')
    assert h.contexts[0].deadline == 10.0
    assert not h.contexts[0]._cleanup_owners
    if h.leases:
        assert h.leases[0].cleanup_complete


@pytest.mark.parametrize('stage', ['reader.close', 'lease.close', 'hash', 'result'])
def test_final_fence_rejects_equality_during_cleanup_hash_or_result(monkeypatch, stage):
    h = Harness(monkeypatch)
    if stage in ('reader.close', 'lease.close'):
        h.hooks[stage] = lambda x: x.expire()
    elif stage == 'hash':
        real = hashlib.sha256
        def hashing(value):
            digest = real(value)
            h.expire()
            return digest
        monkeypatch.setattr(capture, 'hashlib', SimpleNamespace(sha256=hashing))
    else:
        real = capture.CapturedArtwork
        def construct(*args, **kwargs):
            result = real(*args, **kwargs)
            h.expire()
            return result
        monkeypatch.setattr(capture, 'CapturedArtwork', construct)
    unavailable(h.run, 'artwork_probe_timeout')
    assert h.reader_closes == h.lease_closes == 1
    assert h.events[-2:] == ['discharge', 'context.check']
    assert h.leases[0].cleanup_complete


def test_work_exhaustion_prevents_unadmitted_read(monkeypatch):
    h = Harness(monkeypatch)
    h.hooks['lease.check'] = lambda x: setattr(x.contexts[0], 'components', 262144)
    unavailable(h.run, 'artwork_validation_limit')
    assert h.requests == [] and h.contexts[0].syscalls == 0
    assert h.reader_closes == h.lease_closes == 1


def test_many_one_byte_reads_share_combined_budget(monkeypatch):
    h = Harness(monkeypatch, [b'a'] * 5, 5)
    h.hooks['reader.open'] = lambda x: setattr(x.contexts[0], 'components', 262141)
    unavailable(h.run, 'artwork_validation_limit')
    assert len(h.requests) == 3 and h.contexts[0].syscalls == 3
    assert h.sanitizes == 0 and h.reader_closes == h.lease_closes == 1


@pytest.mark.parametrize('stage', ['read', 'sanitize'])
def test_retained_recheck_rejects_mutation(monkeypatch, stage):
    h = Harness(monkeypatch)
    def mutate(x):
        def changed(y):
            raise windows.WindowsUnavailable('private-path-mutation')
        x.hooks['lease.check'] = changed
    h.hooks[stage] = mutate
    unavailable(h.run)
    assert h.reader_closes == h.lease_closes == 1
    assert h.sanitizes == (1 if stage == 'sanitize' else 0)


@pytest.mark.parametrize('field,value', [('png', b''), ('png', b'x' * 24),
    ('png', bytearray(PNG)), ('png', PNG + b'x' * 327680), ('width', 0),
    ('width', 257), ('width', True), ('height', 2), ('input_bytes', 2),
    ('input_pixels', 0), ('input_pixels', 16000001), ('input_pixels', True)])
def test_malformed_sanitizer_output_never_publishes(monkeypatch, field, value):
    h = Harness(monkeypatch)
    h.image = replace(h.image, **{field: value})
    unavailable(h.run)
    assert h.sanitizes == 1 and h.reader_closes == h.lease_closes == 1


@pytest.mark.parametrize('primary', ['read', 'sanitize', 'deadline'])
@pytest.mark.parametrize('cleanup', ['reader', 'lease', 'undischarged', 'context_flag'])
def test_fatal_cleanup_has_priority_over_primary_and_expiry(monkeypatch, primary, cleanup):
    h = Harness(monkeypatch)
    if primary == 'read':
        h.read_error = OSError('PRIVATE C:\\Music\\cover')
    elif primary == 'sanitize':
        h.sanitize_error = ValueError('PRIVATE decoder buffer')
    else:
        h.hooks['read'] = lambda x: x.expire()
    if cleanup == 'reader':
        h.reader_close_error = OSError('PRIVATE close')
    elif cleanup == 'lease':
        h.lease_close_error = OSError('PRIVATE close')
    elif cleanup == 'undischarged':
        h.hooks['discharge'] = lambda x: x.contexts[0]._cleanup_owners.add(object())
    else:
        h.hooks['discharge'] = lambda x: setattr(x.contexts[0], 'cleanup_incomplete', True)
    with pytest.raises(facade.ArtworkCaptureCleanupIncomplete) as caught:
        h.run()
    assert str(caught.value) == 'artwork_cleanup_incomplete'
    assert not isinstance(caught.value, facade.ArtworkAcquisitionUnavailable)
    assert caught.value.__cause__ is None
    assert h.reader_closes == 1
    if cleanup != 'reader':
        assert h.lease_closes == 1
    assert h.contexts[0].cleanup_incomplete


def test_uncertain_generation_stays_strongly_retained_without_retry(monkeypatch):
    h = Harness(monkeypatch)
    h.reader_close_error = OSError('uncertain reader')
    with pytest.raises(facade.ArtworkCaptureCleanupIncomplete):
        h.run()
    lease = h.leases.pop()
    owner = lease._cleanup_owner
    reference = weakref.ref(lease)
    assert owner in h.domain._owners and owner in h.contexts[0]._cleanup_owners
    del lease
    gc.collect()
    assert reference() is not None and h.domain.is_blocked()
    assert h.reader_closes == 1 and h.lease_closes == 0
    assert not reference().cleanup_complete
    with pytest.raises(rooted.RootedFileUnavailable):
        rooted._CleanupOwner(h.domain)
    assert h.reader_closes == 1


def test_actual_nonwindows_runtime_fails_without_native_acquire(monkeypatch):
    h = Harness(monkeypatch)
    monkeypatch.setattr(capture, 'sys', SimpleNamespace(platform='linux'))
    unavailable(h.run)
    assert 'acquire' not in h.events


def test_fixed_api_and_no_alternate_open_executor_or_platform_knob():
    tree = ast.parse(Path(capture.__file__).read_text(encoding='utf-8'))
    entry = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'capture_artwork_windows')
    assert [arg.arg for arg in entry.args.args] == ['source']
    assert not entry.args.kwonlyargs and entry.args.vararg is None and entry.args.kwarg is None
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)]
    forbidden = {'open', 'fdopen', 'dup', 'fileno', 'seek', 'ThreadPoolExecutor',
                 'ProcessPoolExecutor', 'AcquisitionBudget', 'Semaphore', 'CancelIoEx'}
    assert not any((isinstance(n.func, ast.Name) and n.func.id in forbidden)
        or (isinstance(n.func, ast.Attribute) and n.func.attr in forbidden) for n in calls)
    assert len([n for n in ast.walk(entry) if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name) and n.func.id == '_Context']) == 1


@pytest.mark.parametrize('case', ['observation_subclass', 'observation_extra', 'image_subclass',
                                  'image_extra', 'bytes_subclass'])
def test_exact_runtime_records_and_stream_subclasses(monkeypatch, case):
    h = Harness(monkeypatch)
    if case == 'observation_subclass':
        class Child(windows.WindowsObservation):
            pass
        h.info = Child(**h.info.__dict__)
    elif case == 'observation_extra':
        object.__setattr__(h.info, 'extra', 1)
    elif case == 'image_subclass':
        class Child(pixels.SanitizedArtworkPixels):
            pass
        h.image = Child(**h.image.__dict__)
    elif case == 'image_extra':
        object.__setattr__(h.image, 'extra', 1)
    else:
        class Child(bytes):
            pass
        h.chunks = [Child(b'abc'), b'']
    unavailable(h.run)
    assert h.lease_closes == 1


@pytest.mark.parametrize('case', ['truncated', 'bad_crc', 'no_iend', 'trailing_bytes'])
def test_sanitizer_png_container_is_checked_without_second_decode(monkeypatch, case):
    h = Harness(monkeypatch)
    bad = {'truncated': PNG[:24], 'bad_crc': PNG[:-1] + bytes([PNG[-1] ^ 1]),
           'no_iend': PNG[:-12], 'trailing_bytes': PNG + b'x'}[case]
    h.image = replace(h.image, png=bad)
    unavailable(h.run)
    assert h.sanitizes == 1 and h.reader_closes == h.lease_closes == 1


@pytest.mark.parametrize('size', [1, 16000000])
def test_sanitizer_input_pixel_inclusive_limits(monkeypatch, size):
    h = Harness(monkeypatch)
    h.image = replace(h.image, input_pixels=size)
    assert h.run().input_pixels == size
    assert h.sanitizes == 1


def test_observation_copy_retains_exact_timestamp_endpoints():
    original = observation()
    copied = capture._validate_observation(original, source())
    assert copied == original and copied is not original
    assert copied.root_identity is not original.root_identity
    assert copied.leaf_identity is not original.leaf_identity
    assert copied.last_write_time == -(2 ** 63) and copied.change_time == 2 ** 63 - 1


def test_missing_retained_leaf_returns_no_capture(monkeypatch):
    h = Harness(monkeypatch)
    def missing(*args, **kwargs):
        raise rooted.RootedFileUnavailable('source_missing')
    monkeypatch.setattr(rooted, 'acquire', missing)
    row, root = row_root('missing_tail')
    descriptor = facade.artwork_source_from_observation(library_id=1,
        observation=row, root_observation=root)
    unavailable(lambda: facade.capture_artwork(descriptor))
    assert not h.requests and not h.sanitizes and not h.contexts[0]._cleanup_owners


def test_acquire_failure_with_registered_uncertainty_is_fatal(monkeypatch):
    h = Harness(monkeypatch)
    def failed(selection, *, expected_root_stamp, operation_context):
        with rooted._CleanupScope(operation_context=operation_context):
            owner = rooted._CleanupOwner(h.domain)
        owner.fail()
        raise OSError('private native failure')
    monkeypatch.setattr(rooted, 'acquire', failed)
    with pytest.raises(facade.ArtworkCaptureCleanupIncomplete):
        h.run()
    assert h.domain.is_blocked() and len(h.contexts[0]._cleanup_owners) == 1
    assert not h.requests and not h.sanitizes


def test_output_exception_frame_discards_pixels_after_final_expiry(monkeypatch):
    h = Harness(monkeypatch)
    h.hooks['lease.close'] = lambda x: x.expire()
    error = unavailable(h.run, 'artwork_probe_timeout')
    tb = error.__traceback__
    found = False
    while tb is not None:
        if tb.tb_frame.f_code.co_name == 'capture_artwork_windows':
            found = True
            local = tb.tb_frame.f_locals
            assert all(local.get(name) is None for name in ('payload', 'image', 'prepared', 'reader', 'lease'))
        tb = tb.tb_next
    assert found


class SyntheticCancellation(BaseException):
    """Inert stand-in for cancellation/interrupt; never a real process signal."""


@pytest.mark.parametrize('stage', ['read', 'sanitize'])
@pytest.mark.parametrize('cleanup', ['reader', 'lease'])
def test_cancellation_plus_cleanup_failure_has_scrubbed_fatal_chain(monkeypatch, stage, cleanup):
    h = Harness(monkeypatch)
    cancellation = SyntheticCancellation('private cancellation text and buffers')
    if stage == 'read':
        h.read_error = cancellation
    else:
        h.sanitize_error = cancellation
    if cleanup == 'reader':
        h.reader_close_error = OSError('private cleanup text')
    else:
        h.lease_close_error = OSError('private cleanup text')
    with pytest.raises(facade.ArtworkCaptureCleanupIncomplete) as caught:
        h.run()
    fatal = caught.value
    assert type(fatal) is facade.ArtworkCaptureCleanupIncomplete
    assert str(fatal) == 'artwork_cleanup_incomplete'
    assert fatal.__cause__ is None and fatal.__context__ is None
    tb = fatal.__traceback__
    while tb is not None:
        assert tb.tb_frame.f_code.co_name not in ('read', 'sanitize')
        if tb.tb_frame.f_code.co_name == 'capture_artwork_windows':
            local = tb.tb_frame.f_locals
            assert all(local.get(name) is None for name in ('payload', 'image', 'prepared', 'reader', 'lease'))
        tb = tb.tb_next
    assert h.reader_closes == 1
    if cleanup == 'lease':
        assert h.lease_closes == 1


@pytest.mark.parametrize('stage', ['read', 'sanitize'])
def test_confirmed_cleanup_preserves_cancellation_semantics(monkeypatch, stage):
    h = Harness(monkeypatch)
    cancellation = SyntheticCancellation('cancel this operation')
    if stage == 'read':
        h.read_error = cancellation
    else:
        h.sanitize_error = cancellation
    with pytest.raises(SyntheticCancellation) as caught:
        h.run()
    assert caught.value is cancellation
    assert h.reader_closes == h.lease_closes == 1
    assert h.leases[0].cleanup_complete is True
    assert not h.contexts[0]._cleanup_owners and not h.contexts[0].cleanup_incomplete
