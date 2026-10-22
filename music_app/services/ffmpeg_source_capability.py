"""Dormant bounded capability inspection; never called by playback yet.

Declarations are not Windows seek acceptance. No executable installation, PATH
rewrite, application/config import, user-media probe or shell invocation.
"""
import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
import re
import stat
import sys
import threading
import time

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable, hidden_subprocess_creation_flags

OUTPUT_LIMIT = 65536
COMMAND_TIMEOUT = 2.0
COLLECTION_BUDGET = 4.0  # Reserve up to two seconds for cleanup within the six-second budget.
CACHE_SIZE = 16
POSITIVE_TTL = 600.0
NEGATIVE_TTL = 30.0
_GATE = threading.Lock()
_POISONED = False


@dataclass(frozen=True)
class ExecutableIdentity:
    path: str
    platform: str
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True)
class SourceCapability:
    identity: ExecutableIdentity | None
    protocol: str | None
    available: bool
    reason: str


class ProbeCleanupError(RuntimeError):
    pass


def executable_identity(path, platform=None):
    resolved = Path(path).resolve(strict=True)
    info = resolved.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('executable_not_regular')
    return ExecutableIdentity(str(resolved), platform or sys.platform, info.st_dev, info.st_ino,
                              info.st_size, info.st_mtime_ns, info.st_ctime_ns)


async def bounded_command(executable, arguments, remaining, *, spawn=asyncio.create_subprocess_exec):
    """Merged stdout/stderr, bounded bytes/time, kill/drain/reap on every failure.

    If OS cleanup cannot complete, poison subsequent probes rather than spawning
    more processes. Ordinary playback is not called or changed by this component.
    """
    global _POISONED
    process = None

    async def collect():
        nonlocal process
        process = await spawn(executable, *arguments, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            creationflags=hidden_subprocess_creation_flags(), close_fds=True, limit=8192)
        if process.stdout is None:
            raise ValueError('missing_probe_pipe')
        data = await process.stdout.read(remaining + 1)
        # StreamReader.read(n) may return fewer than n bytes before EOF.
        while len(data) <= remaining:
            chunk = await process.stdout.read(min(8192, remaining + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > remaining:
            raise ValueError('probe_output_limit')
        if await process.wait() != 0:
            raise ValueError('probe_exit')
        return data

    try:
        return await asyncio.wait_for(collect(), COMMAND_TIMEOUT)
    finally:
        if process is not None and process.returncode is None:
            async def cleanup():
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
                if process.stdout is not None:
                    while await process.stdout.read(8192):
                        pass
                await process.wait()
            task = asyncio.create_task(cleanup())
            try:
                await asyncio.wait_for(asyncio.shield(task), COMMAND_TIMEOUT)
            except BaseException:
                _POISONED = True
                # One bounded process/cleanup task remains owned; further probes
                # are refused. Consume eventual exception without unbounded retry.
                def finished(done):
                    if not done.cancelled():
                        done.exception()
                task.add_done_callback(finished)
                raise ProbeCleanupError('probe_cleanup_incomplete') from None


def _declares_input(data, protocol):
    lines = data.decode('ascii', errors='strict').splitlines()
    inputs = False
    found = False
    for line in lines:
        value = line.strip()
        if value == 'Input:':
            inputs = True
        elif value == 'Output:':
            inputs = False
        elif inputs and value == protocol:
            found = True
    return found


def _declares_option(data, protocol):
    text = data.decode('ascii', errors='strict')
    # Explicit option name/type, not a diagnostic containing the word handle/fd.
    return (re.search(r'^' + re.escape(protocol) + r' AVOptions:\s*$', text, re.MULTILINE) is not None
            and re.search(r'^\s+-' + re.escape(protocol) + r'\s+<(?:int|int64)>\s', text, re.MULTILINE) is not None)


class SourceCapabilityProbe:
    def __init__(self, *, resolve=resolve_ffmpeg_executable, identify=executable_identity,
                 run=bounded_command, clock=time.monotonic, platform=None):
        self.resolve, self.identify, self.run, self.clock = resolve, identify, run, clock
        self.platform = platform or sys.platform
        self._cache = OrderedDict()
        self._cache_lock = threading.Lock()

    def matches(self, capability):
        if not capability.available or capability.identity is None:
            return False
        try:
            selected = self.resolve()
            return bool(selected) and self.identify(selected, self.platform) == capability.identity
        except (OSError, ValueError):
            return False

    async def check(self):
        if _POISONED:
            return SourceCapability(None, None, False, 'probe_cleanup_incomplete')
        try:
            selected = self.resolve()
            if not selected:
                return SourceCapability(None, None, False, 'executable_unavailable')
            identity = self.identify(selected, self.platform)
        except (OSError, ValueError):
            return SourceCapability(None, None, False, 'executable_unavailable')
        protocol = 'handle' if self.platform == 'win32' else 'fd' if self.platform.startswith(('linux', 'darwin', 'freebsd')) else None
        if protocol is None:
            return SourceCapability(identity, None, False, 'unsupported_platform')
        # Nonblocking process-wide gate: no unbounded waiting queue, across loops.
        if not _GATE.acquire(blocking=False):
            return SourceCapability(identity, protocol, False, 'probe_busy')
        try:
            # Resolution/stat can release the GIL while another loop poisons the
            # process. Cache hits and fresh jobs share this admission fence.
            if _POISONED:
                return SourceCapability(identity, protocol, False, 'probe_cleanup_incomplete')
            now = self.clock()
            with self._cache_lock:
                cached = self._cache.get(identity)
                if cached and now < cached[0]:
                    self._cache.move_to_end(identity)
                    return cached[1]
            remaining = OUTPUT_LIMIT
            outputs = []
            deadline = asyncio.get_running_loop().time() + COLLECTION_BUDGET
            for args in (('-version',), ('-protocols',), ('-h', 'protocol=' + protocol)):
                budget = deadline - asyncio.get_running_loop().time()
                if budget <= 0:
                    raise asyncio.TimeoutError
                data = await asyncio.wait_for(self.run(identity.path, args, remaining), budget)
                if not isinstance(data, bytes) or len(data) > remaining:
                    raise ValueError('probe_output_limit')
                remaining -= len(data)
                outputs.append(data)
            if self.identify(identity.path, self.platform) != identity:
                return SourceCapability(identity, protocol, False, 'executable_changed')
            available = (outputs[0].startswith(b'ffmpeg version ') and
                         _declares_input(outputs[1], protocol) and _declares_option(outputs[2], protocol))
            result = SourceCapability(identity, protocol, available,
                                      'declared_not_runtime_verified' if available else 'protocol_unavailable')
        except asyncio.CancelledError:
            raise
        except (OSError, ValueError, UnicodeError, asyncio.TimeoutError, ProbeCleanupError):
            result = SourceCapability(identity, protocol, False, 'probe_unavailable')
        finally:
            _GATE.release()
        with self._cache_lock:
            self._cache[identity] = (self.clock() + (POSITIVE_TTL if result.available else NEGATIVE_TTL), result)
            self._cache.move_to_end(identity)
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)
        return result


DEFAULT_SOURCE_CAPABILITY_PROBE = SourceCapabilityProbe()
