"""The shared child-process boundary, with real children on a real Selector loop."""

from __future__ import annotations

import asyncio
import errno
import hashlib
from pathlib import Path
import subprocess
import sys
import threading
import time

import pytest

from music_app.services import child_process
from music_app.services.child_process import start_child_process
from music_app.services.ffmpeg_runtime import hidden_subprocess_creation_flags
from tests.py.selector_loop_testing import children, on_selector_loop  # noqa: F401


MEBIBYTE = 1024 * 1024


def python_child(code: str) -> tuple[str, ...]:
    return (sys.executable, "-S", "-c", "import sys, os, time\n" + code)


@pytest.fixture(autouse=True)
def no_pipe_thread_outlives_its_child(children):
    yield
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        alive = [
            thread for thread in threading.enumerate()
            if thread.name in ("child-process-wait", "child-process-pipe")
        ]
        if not alive:
            return
        time.sleep(0.02)
    pytest.fail(f"child process threads outlived their child: {alive}")


def test_output_diagnostics_and_exit_code_arrive_intact():
    async def scenario():
        process = await start_child_process(
            *python_child(
                "sys.stdout.buffer.write(bytes(range(256)) * 4096)\n"
                "sys.stderr.write('diagnostic')\n"
                "sys.exit(7)"
            ),
            stderr=subprocess.PIPE,
        )
        output, errors = await asyncio.gather(process.stdout.read(), process.stderr.read())
        assert output == bytes(range(256)) * 4096
        assert errors == b"diagnostic"
        assert await process.wait() == process.returncode == 7
        assert process.stdout.at_eof()

    on_selector_loop(scenario())


def test_stdin_is_empty_so_a_child_never_waits_for_input():
    async def scenario():
        process = await start_child_process(*python_child("print(len(sys.stdin.buffer.read()))"))
        assert (await process.stdout.read()).strip() == b"0"
        assert await process.wait() == 0
        assert process.stderr is None

    on_selector_loop(scenario())


def test_an_unread_stream_holds_the_child_back_and_loses_nothing_when_read():
    async def scenario():
        process = await start_child_process(
            *python_child(
                "block = bytes(range(256)) * 256\n"
                "for _ in range(128):\n"
                "    sys.stdout.buffer.write(block)\n"
            )
        )
        # The reader's own buffer, because a silent child looks the same as one held back.
        buffered = process.stdout._buffer
        high_water = 2 * process.stdout._limit
        while len(buffered) <= high_water:
            await asyncio.sleep(0.02)
        await asyncio.sleep(1)
        assert high_water < len(buffered) <= high_water + 64 * 1024
        assert process.returncode is None

        digest = hashlib.sha256()
        received = 0
        while data := await process.stdout.read(16 * 1024):
            assert len(data) <= 16 * 1024
            digest.update(data)
            received += len(data)
        assert received == 8 * MEBIBYTE
        assert digest.digest() == hashlib.sha256(bytes(range(256)) * (256 * 128)).digest()
        assert await process.wait() == 0

    on_selector_loop(scenario())


def test_a_slow_handoff_to_the_loop_still_moves_small_writes_in_large_reads():
    """A busy Python thread makes each handoff wait some 5 ms: 4 KiB handoffs fell below realtime."""
    handoffs = []

    async def scenario():
        loop = asyncio.get_running_loop()
        schedule = loop.call_soon_threadsafe

        def slow_handoff(callback, *args, **kwargs):
            if threading.current_thread().name == "child-process-pipe":
                handoffs.append(callback)
                time.sleep(0.05)
            return schedule(callback, *args, **kwargs)

        loop.call_soon_threadsafe = slow_handoff
        process = await start_child_process(
            *python_child("for _ in range(256): os.write(1, bytes(4096))")
        )
        assert len(await process.stdout.read()) == MEBIBYTE
        assert await process.wait() == 0

    on_selector_loop(scenario())

    assert len(handoffs) <= 64


def test_a_failed_pipe_read_is_an_error_never_a_short_success(monkeypatch):
    pump = child_process._PipeReader.pump

    class FailsOnSecondRead:
        def __init__(self, pipe) -> None:
            self._pipe = pipe
            self._reads = 0

        def __enter__(self):
            return self

        def __exit__(self, *_error) -> None:
            self._pipe.close()

        def read(self, size):
            self._reads += 1
            if self._reads > 1:
                raise OSError(errno.ENOMEM, "pipe read failed")
            return self._pipe.read(size)

    monkeypatch.setattr(
        child_process._PipeReader, "pump", lambda reader, pipe: pump(reader, FailsOnSecondRead(pipe)),
    )

    async def scenario():
        process = await start_child_process(*python_child("os.write(1, bytes(3000))"))
        with pytest.raises(OSError, match="pipe read failed"):
            await process.stdout.read()
        await process.wait()

    on_selector_loop(scenario())


@pytest.mark.parametrize("thread_name", ["child-process-wait", "child-process-pipe"])
def test_a_thread_that_cannot_start_fails_the_caller_and_stops_the_child(
    monkeypatch, children, thread_name,
):
    start = threading.Thread.start

    def exhausted(thread):
        if thread.name == thread_name:
            raise RuntimeError("can't start new thread")
        start(thread)

    monkeypatch.setattr(threading.Thread, "start", exhausted)
    make_pipe = child_process._stdout_pipe
    pipes = []
    monkeypatch.setattr(child_process, "_stdout_pipe", lambda: pipes.append(make_pipe()) or pipes[-1])

    with pytest.raises(RuntimeError, match="can't start new thread"):
        on_selector_loop(start_child_process(*python_child("time.sleep(60)")))

    assert children[0].wait(10) != 0
    deadline = time.monotonic() + 10
    while not pipes[0][0].closed and time.monotonic() < deadline:
        time.sleep(0.02)
    assert pipes[0][0].closed


@pytest.mark.skipif(sys.platform != "win32", reason="Windows pipe handles")
@pytest.mark.parametrize("failing_end", [0, 1], ids=["read-end", "write-end"])
def test_a_pipe_that_cannot_be_wrapped_leaks_no_handle(monkeypatch, failing_end):
    create_pipe = child_process._winapi.CreatePipe
    wrap = child_process.msvcrt.open_osfhandle
    handles = []

    def recorded_pipe(*args):
        handles.extend(create_pipe(*args))
        return tuple(handles)

    def no_descriptor_left(handle, flags):
        if handle == handles[failing_end]:
            raise OSError(errno.EMFILE, "Too many open files")
        return wrap(handle, flags)

    monkeypatch.setattr(child_process._winapi, "CreatePipe", recorded_pipe)
    monkeypatch.setattr(child_process.msvcrt, "open_osfhandle", no_descriptor_left)

    with pytest.raises(OSError, match="Too many open files"):
        child_process._stdout_pipe()

    for handle in handles:
        with pytest.raises(OSError):
            child_process._winapi.GetFileType(handle)


@pytest.mark.parametrize("stop", ["kill", "terminate"])
def test_stopping_a_child_blocked_on_a_full_pipe_needs_no_reader(stop):
    async def scenario():
        process = await start_child_process(
            *python_child("while True: sys.stdout.buffer.write(bytes(65536))")
        )
        await process.stdout.readexactly(1)
        await asyncio.sleep(0.3)
        getattr(process, stop)()
        assert await asyncio.wait_for(process.wait(), 10) != 0
        assert len(await process.stdout.read()) < MEBIBYTE

    on_selector_loop(scenario())


def test_a_child_that_exits_with_unread_output_keeps_it_readable():
    size = 128 * 1024 + 4096

    async def scenario():
        process = await start_child_process(*python_child(f"sys.stdout.buffer.write(bytes({size}))"))
        assert await asyncio.wait_for(process.wait(), 10) == 0
        assert await process.stdout.read() == bytes(size)

    on_selector_loop(scenario())


def test_cancelling_a_read_or_wait_leaves_the_child_and_its_bytes_alone():
    async def scenario():
        process = await start_child_process(
            *python_child("time.sleep(1.5)\nsys.stdout.write('kept')")
        )
        waiters = [asyncio.create_task(process.stdout.read(4)), asyncio.create_task(process.wait())]
        await asyncio.sleep(0.05)
        for waiter in waiters:
            waiter.cancel()
        await asyncio.gather(*waiters, return_exceptions=True)
        assert await process.stdout.read() == b"kept"
        assert await process.wait() == 0

    on_selector_loop(scenario())


def test_a_slow_start_never_blocks_the_event_loop(monkeypatch):
    loop_ran = threading.Event()
    ran_during_start = []
    real_popen = subprocess.Popen

    def slow_popen(*args, **kwargs):
        ran_during_start.append(loop_ran.wait(5))
        return real_popen(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", slow_popen)

    async def scenario():
        starting = asyncio.create_task(start_child_process(*python_child("pass")))
        await asyncio.sleep(0.05)
        loop_ran.set()
        assert await (await starting).wait() == 0

    on_selector_loop(scenario())

    assert ran_during_start == [True]


def test_a_start_cancelled_during_creation_kills_the_child_it_made(monkeypatch, children):
    creating = threading.Event()
    cancelled = threading.Event()
    recording_popen = subprocess.Popen

    def slow_popen(*args, **kwargs):
        creating.set()
        assert cancelled.wait(5)
        return recording_popen(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", slow_popen)

    async def scenario():
        starting = asyncio.create_task(start_child_process(*python_child("time.sleep(60)")))
        assert await asyncio.to_thread(creating.wait, 5)
        starting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await starting
        cancelled.set()
        while not children or children[0].poll() is None:
            await asyncio.sleep(0.02)

    on_selector_loop(scenario())

    assert len(children) == 1 and children[0].returncode != 0


def test_a_missing_executable_fails_the_caller(tmp_path):
    with pytest.raises(FileNotFoundError):
        on_selector_loop(start_child_process(str(tmp_path / "no-such-decoder")))


def test_an_exiting_server_neither_waits_for_nor_orphans_a_child_that_writes(tmp_path):
    marker = tmp_path / "child-stopped"
    child = (
        "import sys\n"
        "try:\n"
        "    while True: sys.stdout.buffer.raw.write(bytes(65536))\n"
        "except OSError:\n"
        "    open(sys.argv[1], 'w').close()\n"
    )
    server = (
        "import asyncio, sys\n"
        "from music_app.services.child_process import start_child_process\n"
        "async def serve():\n"
        "    child = await start_child_process(sys.executable, '-S', '-c', sys.argv[1], sys.argv[2])\n"
        "    await child.stdout.readexactly(1)\n"
        "asyncio.SelectorEventLoop().run_until_complete(serve())\n"
    )

    subprocess.run(
        [sys.executable, "-c", server, child, str(marker)],
        cwd=Path(__file__).resolve().parents[2],
        check=True,
        timeout=60,
    )

    deadline = time.monotonic() + 10
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert marker.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows process creation flags")
def test_hidden_window_and_priority_flags_reach_the_child(children):
    # Children inherit a below-normal priority, so only a raised one proves the flag arrived.
    flags = hidden_subprocess_creation_flags() | subprocess.ABOVE_NORMAL_PRIORITY_CLASS

    async def scenario():
        process = await start_child_process(
            *python_child(
                "import ctypes\n"
                "kernel = ctypes.windll.kernel32\n"
                "kernel.GetCurrentProcess.restype = ctypes.c_void_p\n"
                "kernel.GetPriorityClass.argtypes = [ctypes.c_void_p]\n"
                "print(kernel.GetConsoleWindow(), kernel.GetPriorityClass(kernel.GetCurrentProcess()))"
            ),
            creationflags=flags,
        )
        window, priority_class = (await process.stdout.read()).split()
        assert int(window) == 0
        assert int(priority_class) == subprocess.ABOVE_NORMAL_PRIORITY_CLASS
        assert await process.wait() == 0

    on_selector_loop(scenario())

    # A parent without a console hides the window anyway, so the flag itself is asserted too.
    assert children[0].requested_flags == flags
    assert flags & subprocess.CREATE_NO_WINDOW
