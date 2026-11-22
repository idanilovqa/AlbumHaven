"""Child processes for async code, whatever event loop serves it.

asyncio's subprocess transports need the Proactor loop on Windows, whose accept loop stops for
good after WinError 64, so deployments serve on the Selector loop, where those transports raise
NotImplementedError. Here threads do the blocking start, pipe reads and wait, and the caller
keeps ordinary StreamReaders with their usual backpressure.
"""

from __future__ import annotations

import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import suppress
import os
import subprocess
import sys
import threading
from typing import BinaryIO

if sys.platform == "win32":
    import _winapi
    import msvcrt


_PIPE_READ_BYTES = 64 * 1024
# Windows' default pipe holds about 4 KiB. Each read waits for the loop, and for the GIL while
# another thread is busy, so reads that small streamed audio slower than it plays.
_WINDOWS_STDOUT_PIPE_BYTES = 256 * 1024
# CreateProcess blocks, for seconds on a loaded host, so it never runs on the event loop.
_STARTER = ThreadPoolExecutor(max_workers=4, thread_name_prefix="child-process-start")


def _stdout_pipe() -> tuple[BinaryIO, BinaryIO]:
    if sys.platform == "win32":
        read, write = _winapi.CreatePipe(None, _WINDOWS_STDOUT_PIPE_BYTES)
        try:
            read_end = msvcrt.open_osfhandle(read, os.O_RDONLY)
        except OSError:
            _winapi.CloseHandle(read)
            _winapi.CloseHandle(write)
            raise
        try:
            descriptors = read_end, msvcrt.open_osfhandle(write, 0)
        except OSError:
            os.close(read_end)
            _winapi.CloseHandle(write)
            raise
    else:
        descriptors = os.pipe()
    return open(descriptors[0], "rb", buffering=0), open(descriptors[1], "wb", buffering=0)


class _PipeReader:
    """The transport of one StreamReader: its thread reads only while that reader has room."""

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.stream = asyncio.StreamReader()
        self.stream.set_transport(self)
        self._loop = loop
        self._room = threading.Event()
        self._paused = False
        self._released = False

    def pause_reading(self) -> None:
        self._paused = True

    def resume_reading(self) -> None:
        self._paused = False
        self._room.set()

    def release(self) -> None:
        """Stop holding back once the child exited: only what the OS pipe holds is left."""
        self._released = True
        self._room.set()

    def _deliver(self, data: bytes) -> None:
        self.stream.feed_data(data)
        if self._released or not self._paused:
            self._room.set()

    def pump(self, pipe: BinaryIO) -> None:
        # A closed loop refuses callbacks, and closing the pipe then stops the child's writes.
        # A pump already waiting for room ends with the child or with the server process.
        with suppress(RuntimeError):
            try:
                with pipe:
                    while data := pipe.read(_PIPE_READ_BYTES):
                        self._room.clear()
                        self._loop.call_soon_threadsafe(self._deliver, data)
                        self._room.wait()
            except Exception as error:
                # As in asyncio, a failed read is the caller's error, never a short success.
                self._loop.call_soon_threadsafe(self.stream.set_exception, error)
            else:
                self._loop.call_soon_threadsafe(self.stream.feed_eof)


class ChildProcess:
    """The part of asyncio.subprocess.Process the app uses."""

    def __init__(self, *, piped_stderr: bool) -> None:
        self._loop = asyncio.get_running_loop()
        self._stdout = _PipeReader(self._loop)
        self._stderr = _PipeReader(self._loop) if piped_stderr else None
        self.stdout = self._stdout.stream
        self.stderr = self._stderr.stream if self._stderr else None
        self._exited = self._loop.create_future()
        self._popen: subprocess.Popen[bytes]

    def launch(self, command: tuple[str, ...], stderr: int, creationflags: int) -> None:
        output, child_output = _stdout_pipe()
        try:
            with child_output:
                self._popen = subprocess.Popen(
                    command,
                    stdin=subprocess.DEVNULL,
                    stdout=child_output,
                    stderr=stderr,
                    creationflags=creationflags,
                    bufsize=0,
                )
        except BaseException:
            output.close()
            raise
        pipes = [(self._stdout, output)]
        if self._stderr:
            pipes.append((self._stderr, self._popen.stderr))
        pumps = []
        try:
            for reader, pipe in pipes:
                pump = threading.Thread(
                    target=reader.pump, args=(pipe,), name="child-process-pipe", daemon=True,
                )
                pump.start()
                pumps.append((reader, pump))
            threading.Thread(
                target=self._supervise, args=(pumps,), name="child-process-wait", daemon=True,
            ).start()
        except BaseException:
            # Out of threads: nobody would read or reap this child.
            self._popen.kill()
            for reader, _pipe in pipes:
                reader.release()
            for _reader, pipe in pipes[len(pumps):]:
                pipe.close()
            raise

    def _supervise(self, pumps: list[tuple[_PipeReader, threading.Thread]]) -> None:
        self._popen.wait()
        for reader, _pump in pumps:
            reader.release()
        for _reader, pump in pumps:
            pump.join()
        with suppress(RuntimeError):  # The loop closed first; nobody is waiting.
            self._loop.call_soon_threadsafe(self._exited.set_result, None)

    @property
    def returncode(self) -> int | None:
        return self._popen.returncode

    def terminate(self) -> None:
        self._popen.terminate()

    def kill(self) -> None:
        self._popen.kill()

    async def wait(self) -> int:
        """Return the exit code once the child exited and its pipes were read to their end."""
        await asyncio.shield(self._exited)
        return self._popen.returncode


async def start_child_process(
    *command: str,
    stderr: int = subprocess.DEVNULL,
    creationflags: int = 0,
) -> ChildProcess:
    """Start a child with no stdin and a piped stdout."""
    process = ChildProcess(piped_stderr=stderr == subprocess.PIPE)
    starting = _STARTER.submit(process.launch, command, stderr, creationflags)
    try:
        await asyncio.wrap_future(starting)
    except asyncio.CancelledError:
        def stop_unclaimed(started: Future[None]) -> None:
            if not started.cancelled() and started.exception() is None:
                process.kill()

        starting.add_done_callback(stop_unclaimed)
        raise
    return process
