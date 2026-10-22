"""SOURCE-ONLY proposal: use only after isolated-harness approval.

No application initializer, config, capability probe, native backend or executor
is loaded. Exact audited FFmpeg imports use controlled external primitives. Six production
modules load unchanged under pinned hashes. No suite or product execution has occurred.
"""
import asyncio
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
    'mp3_gapless': '681472ddca1357875e8406a41b0fde605bfa250ffe2f05e5200664497deb7b39',
    'rooted_playback_adapter': '5c467aac2084f2b25afe28c493160625c3571daee7c00dea2470b413ee2a2550',
    'playback_pcm': '5775e2518c69b05352f67b039db100e5fdfba7c97dcffeac60960dee5d5854eb',
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
    runtime.hidden_subprocess_creation_flags = lambda: 0
    runtime.resolve_ffmpeg_executable = forbidden
    capability = types.ModuleType(prefix + 'ffmpeg_source_capability')
    capability.DEFAULT_SOURCE_CAPABILITY_PROBE = types.SimpleNamespace(matches=forbidden)
    routes = {
        'music_app.services.ffmpeg_runtime': runtime,
        'music_app.services.ffmpeg_source_capability': capability,
    }
    allowed = frozenset((*routes, 'music_app.services.rooted_local_file',
                         'music_app.services.retained_playback_source',
                         'music_app.services.mp3_gapless',
                         'music_app.services.rooted_playback_adapter'))
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
            if leaf in ('rooted_local_file', 'retained_playback_source',
                        'mp3_gapless', 'rooted_playback_adapter'):
                routes['music_app.services.' + leaf] = module
        yield types.SimpleNamespace(rooted=loaded[0], retained=loaded[1],
            mp3=loaded[2], adapter=loaded[3], pcm=loaded[4], leases=loaded[5])
    finally:
        changed = []
        for name, module in reversed(tuple(installed.items())):
            if sys.modules.get(name) is module:
                del sys.modules[name]
            else:
                changed.append(name)  # Never remove another party's replacement.
        if changed:
            raise AssertionError('private module identity changed: ' + ', '.join(changed))



class WorkerYield(BaseException):
    """Stop only the controlled thread primitive at its next idle wait."""


class ManualEvent:
    def __init__(self):
        self.signaled = False

    def set(self):
        self.signaled = True

    def clear(self):
        self.signaled = False

    def wait(self):
        if not self.signaled:
            raise WorkerYield()
        return True


class ManualThreads:
    """Run production _worker unchanged, one signaled iteration per tick.

    No production runner/pool/owner policy is reimplemented. Locks remain real;
    only Thread/Event scheduling primitives are controlled. No OS threads start.
    """
    Lock = staticmethod(threading.Lock)
    get_ident = staticmethod(threading.get_ident)
    Event = ManualEvent

    def __init__(self):
        self.threads = []
        self.hold = False
        self.start_error = None

    def Thread(self, *, target, args, daemon):
        outer = self
        class Thread:
            def __init__(self):
                self.starts = 0
                self.started = False
                self.dead = False
            def start(self):
                self.starts += 1
                self.started = True
                if outer.start_error:
                    raise outer.start_error
            def tick(self):
                if self.started and not self.dead and not outer.hold:
                    try:
                        target(*args)
                    except WorkerYield:
                        pass
                    except BaseException:
                        self.dead = True
                        raise
        value = Thread()
        self.threads.append(value)
        return value

    def tick(self):
        for thread in self.threads:
            thread.tick()


class Clock:
    value = 0.0
    def __call__(self):
        return self.value


class MemoryStream(io.BytesIO):
    def __init__(self, resource):
        super().__init__(resource.data)
        self.resource = resource
        self.close_attempts = 0
        self.read_sizes = []

    def read(self, count=-1):
        if count < 0:
            raise AssertionError('unbounded memory read')
        self.read_sizes.append(count)
        return super().read(min(count, self.resource.fragment))

    def fileno(self):
        self.resource.filenos += 1
        return 731  # Symbolic descriptor: never passed to any native API.

    def close(self):
        self.close_attempts += 1
        if self.resource.reader_close_error:
            raise OSError('controlled reader-close uncertainty')
        super().close()


class MemoryResource:
    def __init__(self, modules, suffix='.flac', data=b'controlled bytes'):
        root = modules.rooted
        self._cleanup_domain = root._CleanupDomain()
        self.observation = root.PosixObservation('posix', 1, 2, len(data), 3, 4)
        self.root_stamp = root.PosixRootStamp('posix', 1, 9)
        self.name, self.original_suffix = 'memory' + suffix, suffix
        self.data, self.fragment = data, 4096
        self.checks = self.closes = self.reader_opens = self.filenos = 0
        self.mutated = self.fail_close = self.reader_close_error = False
        self.cleanup_complete = True
        self.streams = []
        self.error = root.RootedFileUnavailable

    def check(self):
        self.checks += 1
        if self.mutated:
            raise self.error('source_changed')

    def reader(self):
        self.reader_opens += 1
        value = MemoryStream(self)
        self.streams.append(value)
        return value

    def close(self):
        self.closes += 1
        if self.fail_close:
            raise OSError('controlled source-close uncertainty')


class Pipe:
    def __init__(self, *script):
        self.script = list(script)
        self.reads = []
        self.active = self.peak = 0
        self.eof = False
        self.gate = None

    async def read(self, count):
        self.active += 1
        self.peak = max(self.peak, self.active)
        self.reads.append(count)
        try:
            if self.gate is not None:
                await self.gate.wait()
            item = self.script.pop(0) if self.script else b''
            if isinstance(item, BaseException):
                raise item
            if len(item) > count:
                self.script.insert(0, item[count:])
                item = item[:count]
            if not item:
                self.eof = True
            return item
        finally:
            self.active -= 1

    def at_eof(self):
        return self.eof


class Process:
    def __init__(self, stdout=None, stderr=None, result=0):
        self.stdout = stdout if stdout is not None else Pipe()
        self.stderr = stderr if stderr is not None else Pipe()
        self.result = result
        self.kills = self.waits = 0
        self.wait_gate = None
        self.kill_error = None
        self.returncode = None

    async def wait(self):
        self.waits += 1
        if self.wait_gate:
            await self.wait_gate.wait()
        self.returncode = self.result
        return self.result

    def kill(self):
        self.kills += 1
        if self.kill_error:
            raise self.kill_error


class Factory:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []
        self.gate = None

    async def __call__(self, *args, **options):
        assert options['pass_fds'] == (731,)
        assert options['close_fds'] is True
        assert args[args.index('-i') + 1] == 'fd:'
        assert args[args.index('-fd') + 1] == '731'
        assert options['stdin'] == asyncio.subprocess.DEVNULL
        assert options['stdout'] == options['stderr'] == asyncio.subprocess.PIPE
        assert not any('never-open' in str(arg) for arg in args)
        self.calls.append((args, options))
        if self.gate:
            await self.gate.wait()
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class Case(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loader = isolated_modules(Path(__file__).resolve().parents[2])
        self.m = self.loader.__enter__()
        self.addCleanup(self.loader.__exit__, None, None, None)
        self.clock = Clock()
        self.registry = self.m.leases.EvidenceSourceLeaseRegistry('epoch', self.clock)
        self.threads = ManualThreads()
        self.m.adapter.threading = self.threads  # Private module only.
        self.runner = self.m.adapter.BoundedPhysicalRunner()
        self.pool = self.m.adapter.RootedPlaybackLifecyclePool(physical_runner=self.runner)
        self.records = []
        self.callers = []
        self.peak_tasks = 0

    def source(self, suffix='.flac', data=b'controlled bytes'):
        resource = MemoryResource(self.m, suffix, data)
        rooted = self.m.rooted.RootedRegularFile(resource)
        source = self.m.retained.RetainedPlaybackSource.from_rooted_lease(rooted, original_suffix=suffix)
        owner, playback = self.m.retained.SharedPlaybackSourceOwner.create(source)
        return types.SimpleNamespace(resource=resource, rooted=rooted, source=source,
                                     owner=owner, playback=playback)

    def admit(self, source=None):
        source = source or self.source()
        record = self.pool.admit(source.owner, source.playback)
        self.records.append(record)
        return source, record

    def command(self, start=0, suffix='.flac'):
        return self.m.pcm.PcmOpenCommand(1, 1, 'current', Path('/never-open/replaced' + suffix),
                                        start, 48000, 999.0)

    def caller(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.callers.append(task)
        return task

    async def pump(self, predicate, rounds=300):
        # Finite scheduling budget, never a wall-clock/timing correctness oracle.
        for _ in range(rounds):
            self.threads.tick()
            await asyncio.sleep(0)
            for record in self.records:
                slots = [getattr(record, name) for name in
                         ('_driver', '_spawn_task', '_wait_task', '_stdout_task', '_stderr_task')]
                live = sum(task is not None and not task.done() for task in slots)
                self.peak_tasks = max(self.peak_tasks, live)
                self.assertLessEqual(live, 5)
                # Include product tasks even if omitted from the five slot fields.
                actual = 0
                for task in asyncio.all_tasks():
                    coroutine = task.get_coro()
                    frame = getattr(coroutine, 'cr_frame', None)
                    code = getattr(coroutine, 'cr_code', None)
                    if (frame is not None and code is not None
                            and code.co_filename == self.m.adapter.__file__
                            and frame.f_locals.get('self') is record):
                        actual += 1
                self.assertLessEqual(actual, 5)
            if predicate():
                return
        self.fail('finite controlled scheduling budget exhausted')

    async def result(self, task):
        await self.pump(task.done)
        return task.result()

    async def start(self, process=None, *, start=0, suffix='.flac', source=None, proof=True):
        source, record = self.admit(source or self.source(suffix))
        process = process or Process()
        factory = Factory(process)
        cap = types.SimpleNamespace(available=True, identity=types.SimpleNamespace(path='fake-ffmpeg'), protocol='fd')
        probe = types.SimpleNamespace(matches=lambda value: value is cap)
        task = self.caller(self.m.pcm.PcmDecoderProcess.start_retained(
            self.command(start, suffix), admission=record, capability=cap,
            process_factory=factory, capability_probe=probe, pipe_completion=lambda child: proof))
        decoder = await self.result(task)
        return source, record, decoder, process, factory

    async def read(self, decoder, frames=8192):
        return await self.result(self.caller(decoder.read_credited_frames(max_frames=frames)))

    async def asyncTearDown(self):
        # Harness task teardown is not claimed to dispose uncertain ownership.
        self.threads.hold = False
        self.threads.start_error = None
        for record in self.records:
            record.request_cancel()
        for _ in range(40):
            self.threads.tick()
            await asyncio.sleep(0)
        tasks = list(self.callers)
        for record in self.records:
            tasks.extend(getattr(record, name) for name in
                         ('_driver', '_spawn_task', '_wait_task', '_stdout_task', '_stderr_task'))
        for task in tasks:
            if task is not None and not task.done():
                task.cancel()
        for task in tasks:
            if task is not None:
                try:
                    await task
                except BaseException:
                    pass
