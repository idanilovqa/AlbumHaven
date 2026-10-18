"""SOURCE-ONLY proposal: use only after isolated-harness approval.

No application initializer, config, capability probe, native backend or executor
is loaded. Only the two specified FFmpeg dependencies are fail-closed stubs.
The three production modules are loaded unchanged, with pinned hashes.
"""
import builtins
import contextlib
import hashlib
import io
from pathlib import Path
import sys
import threading
import types
import unittest

HASHES = {
    'rooted_local_file': '495f59323e128d45214affcfe2e3c898d6424396d271d636bf8ab0de9c5c3ab2',
    'retained_playback_source': 'b5b9459c35a296dfb091bf55691711b706476a7f74c105263836500ade781e66',
    'playback_evidence_leases': 'f2dcd49b67ffb8c687f144bbb6527ba9a194742fe4200d84775e595a92885cd9',
}


def forbidden(*args, **kwargs):
    raise AssertionError('FFmpeg transport/capability must never execute')


@contextlib.contextmanager
def isolated_modules(repository):
    """Execute unchanged bytes under private names with local import routing.

    Existing product modules, global builtins and package containers are untouched.
    Only private names are installed for dataclass module lookup. No config source
    or production initializer is read, imported, synthesized, or patched.
    """
    loaded = []
    installed = {}
    prefix = '_retained_owner_units_' + str(id(loaded)) + '_'
    sources = {}
    for leaf, digest in HASHES.items():
        path = repository / 'music_app' / 'services' / (leaf + '.py')
        source = path.read_bytes()
        if hashlib.sha256(source).hexdigest() != digest:
            raise AssertionError('reviewed source guard changed: ' + leaf)
        sources[leaf] = (path, source)
    runtime = types.ModuleType(prefix + 'ffmpeg_runtime')
    runtime.hidden_subprocess_creation_flags = forbidden
    capability = types.ModuleType(prefix + 'ffmpeg_source_capability')
    capability.DEFAULT_SOURCE_CAPABILITY_PROBE = types.SimpleNamespace(matches=forbidden)
    routes = {
        'music_app.services.ffmpeg_runtime': runtime,
        'music_app.services.ffmpeg_source_capability': capability,
    }
    allowed = frozenset((*routes, 'music_app.services.rooted_local_file',
                         'music_app.services.retained_playback_source'))
    original_import = builtins.__import__
    def local_import(name, globals=None, locals=None, fromlist=(), level=0):
        if 'config' in name.split('.'):
            raise AssertionError('config imports forbidden in isolated source units')
        if name == 'music_app' or name.startswith('music_app.'):
            if level != 0 or not fromlist or name not in allowed or name not in routes:
                raise AssertionError('unreviewed product import: ' + name)
            return routes[name]
        return original_import(name, globals, locals, fromlist, level)
    try:
        for leaf, (path, source) in sources.items():
            name = prefix + leaf
            if name in sys.modules:
                raise AssertionError('private module name collision')
            module = types.ModuleType(name)
            module.__file__ = str(path)
            module.__package__ = ''
            module.__builtins__ = dict(vars(builtins), __import__=local_import)
            installed[name] = module
            sys.modules[name] = module
            # Compile/execute occurs only in a future authorized test run.
            # Direct byte execution avoids pycache writes or import resolution.
            exec(compile(source, str(path), 'exec'), module.__dict__)
            loaded.append(module)
            if leaf in ('rooted_local_file', 'retained_playback_source'):
                routes['music_app.services.' + leaf] = module
        yield types.SimpleNamespace(rooted=loaded[0], retained=loaded[1], leases=loaded[2])
    finally:
        changed = []
        for name, module in reversed(tuple(installed.items())):
            if sys.modules.get(name) is module:
                del sys.modules[name]
            else:
                changed.append(name)  # Never remove another party's replacement.
        if changed:
            raise AssertionError('private module identity changed: ' + ', '.join(changed))


class Barrier:
    """Event handshake; timeout is a deadlock watchdog, never a timing oracle."""
    def __init__(self):
        self.entered = threading.Event()
        self.resume = threading.Event()

    def block(self):
        self.entered.set()
        if not self.resume.wait(10):
            raise AssertionError('barrier watchdog')

    def reached(self):
        if not self.entered.wait(10):
            raise AssertionError('barrier never reached')


class Task:
    def __init__(self, call):
        self.result = None
        self.error = None
        self.done = threading.Event()
        def run():
            try:
                self.result = call()
            except BaseException as error:
                self.error = error
            finally:
                self.done.set()
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def finish(self):
        self.thread.join(10)
        if self.thread.is_alive():
            raise AssertionError('worker did not settle')
        return self


class ObservedLock:
    """Real lock; explicit attempted-entry signal proves a blocked release."""
    def __init__(self):
        self.lock = threading.Lock()
        self.contender = threading.Event()
        self.entries = 0

    def __enter__(self):
        self.entries += 1
        if self.entries > 1:
            self.contender.set()
        self.lock.acquire()
        return self

    def __exit__(self, *args):
        self.lock.release()


class Clock:
    def __init__(self):
        self.value = 0.0
        self.hook = None

    def __call__(self):
        value = self.value
        if self.hook is not None:
            hook, self.hook = self.hook, None
            hook()
        return value


class MemoryStream(io.BytesIO):
    def __init__(self, resource):
        super().__init__(b'controlled audio-shaped bytes')
        self.resource = resource
        self.close_attempts = 0
        self.fail_close = False

    def close(self):
        self.close_attempts += 1
        if self.fail_close:
            raise OSError('controlled reader cleanup uncertainty')
        super().close()

    def fileno(self):
        raise AssertionError('no descriptor or process exposure in this suite')


class MemoryResource:
    def __init__(self, modules):
        root = modules.rooted
        self._cleanup_domain = root._CleanupDomain()
        self.observation = root.PosixObservation('posix', 1, 2, 29, 3, 4)
        self.root_stamp = root.PosixRootStamp('posix', 1, 9)
        self.name, self.original_suffix = 'memory.flac', '.flac'
        self.checks = self.closes = self.reader_opens = 0
        self.mutated = self.fail_close = False
        self.cleanup_complete = True
        self.check_barrier = self.close_barrier = None
        self.streams = []
        self.error = root.RootedFileUnavailable

    def check(self):
        self.checks += 1
        if self.check_barrier:
            self.check_barrier.block()
        if self.mutated:
            raise self.error('source_changed')

    def reader(self):
        self.reader_opens += 1
        stream = MemoryStream(self)
        self.streams.append(stream)
        return stream

    def close(self):
        self.closes += 1
        if self.close_barrier:
            self.close_barrier.block()
        if self.fail_close:
            raise OSError('controlled resource cleanup uncertainty')


class Case(unittest.TestCase):
    def setUp(self):
        self.loader = isolated_modules(Path(__file__).resolve().parents[2])
        self.m = self.loader.__enter__()
        self.addCleanup(self.loader.__exit__, None, None, None)
        self.clock = Clock()
        self.registry = self.m.leases.EvidenceSourceLeaseRegistry('epoch', self.clock)

    def source(self):
        resource = MemoryResource(self.m)
        rooted = self.m.rooted.RootedRegularFile(resource)
        source = self.m.retained.RetainedPlaybackSource.from_rooted_lease(rooted, original_suffix='.flac')
        owner, playback = self.m.retained.SharedPlaybackSourceOwner.create(source)
        return types.SimpleNamespace(resource=resource, rooted=rooted, source=source,
                                     owner=owner, playback=playback)

    def binding(self, account='account', track='track'):
        return self.m.leases.SourceBinding('epoch', account, 'library', 'session',
                                          'device', 'logical', track, 'file', 'root', 48000)

    def attached(self, account='account', track='track'):
        value = self.source()
        value.binding = self.binding(account, track)
        value.reservation = self.registry.reserve(account)
        value.lease = self.registry.attach(value.reservation, value.owner,
                                          value.playback, value.binding)
        return value

    def pin(self, value, kind='checkpoint', checked=False):
        pin = self.registry.lookup_and_pin('epoch', value.lease.decoder_uuid, value.binding, kind)
        if checked:
            pin.check()
        return pin

    def playback_check(self, value):
        pin = value.owner.pin_playback(value.playback)
        try:
            return pin.check()
        finally:
            pin.release()

    def retire(self, value):
        if value.lease.delivery_open:
            self.registry.abandon(value.lease, 'test_complete')
        value.owner.release_playback(value.playback)
        self.registry.reap_cleanup()

    def unavailable(self, text):
        return self.assertRaisesRegex(self.m.retained.SourceUnavailable, text)
