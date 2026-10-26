"""One bounded optional capability check per resolved FFmpeg version.

Uses the existing retained MP3 probe subprocess cleanup owner. Playback never
awaits it: unresolved, unsupported or replaced binaries use ordinary playback.
Only one background attempt is retained globally, not one per track.
"""
import asyncio
from pathlib import Path
import shutil

from music_app.services.mp3_gapless import Mp3GaplessProbe
from music_app.services.ffmpeg_runtime import hidden_subprocess_creation_flags

_state = None
_blocked_probe = None
_SHUTDOWN_SECONDS = 12.0


class _CapabilityProbe(Mp3GaplessProbe):
    def __init__(self, args):
        super().__init__()
        self.args = args

    async def _launch(self, path, executable):
        self._process = await asyncio.create_subprocess_exec(
            executable, '-hide_banner', *self.args,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            creationflags=hidden_subprocess_creation_flags())
        self._wait_task = asyncio.create_task(self._process.wait())
        self._wait_task.add_done_callback(self._observe)
        self._read_task = asyncio.create_task(self._read_output())
        self._read_task.add_done_callback(self._observe)

    async def collect_capability(self, executable):
        self._launch_task = asyncio.create_task(self._launch(None, executable))
        self._launch_task.add_done_callback(self._observe)
        try:
            await self._join(self._launch_task, 3.0, None)
            output = await self._join(self._read_task, 3.0, None)
            if len(output) > 8192 or await self._join(self._wait_task, 2.0, None) != 0:
                return None
            return output
        finally:
            self.request_cancel()
            await self.wait_closed()


def _identity(executable):
    try:
        resolved = Path(shutil.which(executable) or executable).resolve(strict=True)
        info = resolved.stat()
        return (str(resolved), info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    except (OSError, ValueError):
        return None


async def _check(identity):
    global _blocked_probe
    probe = _CapabilityProbe(('-protocols',))
    try:
        protocols = await probe.collect_capability(identity[0])
        if protocols is not None:
            protocols = protocols.replace(b'\r\n', b'\n')
        if protocols is None or b'Input:\n' not in protocols or b'Output:\n' not in protocols:
            return False
        inputs = protocols.split(b'Input:\n', 1)[1].split(b'Output:\n', 1)[0]
        if b'fd' not in [line.strip() for line in inputs.splitlines()]:
            return False
        probe = _CapabilityProbe(('-h', 'filter=ashowinfo'))
        description = await probe.collect_capability(identity[0])
        return (description is not None and description.splitlines()[:1] == [b'Filter ashowinfo']
            and _identity(identity[0]) == identity)
    except (Exception, asyncio.CancelledError):
        if not probe.cleanup_complete:
            _blocked_probe = probe
        return False


def fd_capture_ready(executable):
    global _state, _blocked_probe
    if _blocked_probe is not None:
        if not _blocked_probe.cleanup_complete:
            return False
        _blocked_probe = None
    identity = _identity(executable)
    if identity is None:
        return False
    if _state is not None:
        previous, task = _state
        if not task.done():
            return False
        if previous == identity:
            return not task.cancelled() and task.exception() is None and task.result() is True
    try:
        task = asyncio.get_running_loop().create_task(_check(identity))
    except RuntimeError:
        return False
    task.add_done_callback(Mp3GaplessProbe._observe)
    _state = (identity, task)
    return False


async def shutdown_fd_capture():
    """Join optional process-wide probe work through playback registry shutdown.

    A bounded shutdown failure retains the exact original task/probe. It does
    not clear state or authorize a replacement child while cleanup is pending.
    """
    state = _state
    if state is not None:
        task = state[1]
        if not task.done():
            task.cancel()
            done, _ = await asyncio.wait({task}, timeout=_SHUTDOWN_SECONDS)
            if task not in done:
                raise RuntimeError('FFmpeg capability cleanup unresolved')
        if not task.cancelled():
            task.exception()
    probe = _blocked_probe
    if probe is not None and not probe.cleanup_complete:
        await probe.cancel()
        if not probe.cleanup_complete:
            raise RuntimeError('FFmpeg capability cleanup unresolved')
