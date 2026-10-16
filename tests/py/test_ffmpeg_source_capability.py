"""Synthetic-only dormant probe tests. Never run a real executable or open media."""
import asyncio
from dataclasses import replace

import pytest

from music_app.services import ffmpeg_source_capability as capability

IDENTITY = capability.ExecutableIdentity('/synthetic/ffmpeg', 'win32', 1, 2, 3, 4, 5)


def declarations(protocol='handle'):
    return [b'ffmpeg version synthetic\n', ('Supported file protocols:\nInput:\n  ' + protocol + '\nOutput:\n  file\n').encode(),
            (protocol + ' AVOptions:\n  -' + protocol + ' <int64> .D......... source\n').encode()]


class Runner:
    def __init__(self, outputs=None):
        self.outputs = outputs or declarations()
        self.calls = []

    async def __call__(self, executable, args, remaining):
        self.calls.append((executable, args, remaining))
        return self.outputs[(len(self.calls) - 1) % 3]


def probe(runner, *, current=None, clock=None, platform='win32'):
    return capability.SourceCapabilityProbe(resolve=lambda: '/synthetic/ffmpeg',
        identify=lambda path, platform: current[0] if current else IDENTITY,
        run=runner, clock=lambda: clock[0] if clock else 0, platform=platform)


def test_exact_resolved_executable_three_commands_and_positive_cache():
    run = Runner(); owner = probe(run)
    first = asyncio.run(owner.check()); second = asyncio.run(owner.check())
    assert first is second and first.available and first.reason == 'declared_not_runtime_verified'
    assert [call[1] for call in run.calls] == [('-version',), ('-protocols',), ('-h', 'protocol=handle')]
    assert all(call[0] == IDENTITY.path for call in run.calls)
    assert run.calls[0][2] == 65536
    assert run.calls[1][2] == 65536 - len(run.outputs[0])
    assert run.calls[2][2] == 65536 - len(run.outputs[0]) - len(run.outputs[1])
    assert owner.matches(first)


def test_negative_cache_expires_without_rewriting_resolver_precedence():
    run = Runner([b'ffmpeg version synthetic\n', b'Input:\nfile\nOutput:\nhandle\n', b'handle AVOptions:\n -handle <int64> x\n'])
    now = [0]; owner = probe(run, clock=now)
    assert not asyncio.run(owner.check()).available
    now[0] = 29; assert not asyncio.run(owner.check()).available; assert len(run.calls) == 3
    now[0] = 30; assert not asyncio.run(owner.check()).available; assert len(run.calls) == 6


def test_positive_expiry_replacement_and_path_winner_invalidate_cache_and_launch_match():
    run = Runner(); now = [0]; current = [IDENTITY]; owner = probe(run, current=current, clock=now)
    first = asyncio.run(owner.check()); now[0] = 600
    asyncio.run(owner.check()); assert len(run.calls) == 6
    current[0] = replace(IDENTITY, inode=99)
    assert not owner.matches(first)
    asyncio.run(owner.check()); assert len(run.calls) == 9
    current[0] = replace(IDENTITY, path='/other/ffmpeg')
    assert not owner.matches(first)
    asyncio.run(owner.check()); assert run.calls[-1][0] == '/other/ffmpeg'


def test_executable_change_during_probe_is_never_cached_as_supported():
    current = [IDENTITY]; base = Runner()
    async def run(*args):
        result = await base(*args)
        if len(base.calls) == 3: current[0] = replace(IDENTITY, size=99)
        return result
    result = asyncio.run(probe(run, current=current).check())
    assert not result.available and result.reason == 'executable_changed'


@pytest.mark.parametrize('outputs', [
    [b'not ffmpeg', *declarations()[1:]],
    [declarations()[0], b'Input:\nfile\nOutput:\nhandle\n', declarations()[2]],
    [*declarations()[:2], b'Error: handle unavailable; use -handle <int64> instead\n'],
    [*declarations()[:2], b'handle AVOptions:\n -fd <int64> x\n'],
    [*declarations()[:2], b'\xff'],
])
def test_diagnostics_are_not_protocol_capability(outputs):
    assert not asyncio.run(probe(Runner(outputs)).check()).available


def test_posix_protocol_is_fd_not_windows_handle():
    run = Runner(declarations('fd')); result = asyncio.run(probe(run, platform='linux').check())
    assert result.available and result.protocol == 'fd'
    assert run.calls[-1][1] == ('-h', 'protocol=fd')


def test_global_busy_gate_refuses_without_enqueuing_or_spawning():
    run = Runner(); capability._GATE.acquire()
    try:
        result = asyncio.run(probe(run).check())
        assert result.reason == 'probe_busy' and run.calls == []
    finally:
        capability._GATE.release()


def test_cache_is_bounded_to_sixteen_executable_identities():
    current = [IDENTITY]; owner = probe(Runner(), current=current)
    for value in range(20):
        current[0] = replace(IDENTITY, inode=value)
        asyncio.run(owner.check())
    assert len(owner._cache) == 16 and IDENTITY not in owner._cache


class Output:
    def __init__(self, data): self.data = data
    async def read(self, count):
        data, self.data = self.data[:count], self.data[count:]
        return data


class Process:
    def __init__(self, data=b'', exit_code=0):
        self.stdout = Output(data); self.returncode = None; self.exit_code = exit_code
        self.kills = 0; self.waits = 0
    async def wait(self):
        self.waits += 1
        if self.returncode is None: self.returncode = self.exit_code
        return self.returncode
    def kill(self): self.kills += 1; self.returncode = -9


def test_real_runner_seam_bounds_output_uses_no_shell_and_kills_reaps_overflow():
    process = Process(b'x' * 20); calls = []
    async def spawn(*args, **kwargs): calls.append((args, kwargs)); return process
    with pytest.raises(ValueError, match='probe_output_limit'):
        asyncio.run(capability.bounded_command('/synthetic/ffmpeg', ('-version',), 10, spawn=spawn))
    assert process.kills == 1 and process.waits == 1 and process.stdout.data == b''
    args, kwargs = calls[0]
    assert args == ('/synthetic/ffmpeg', '-version')
    assert kwargs['close_fds'] is True and 'shell' not in kwargs and 'pass_fds' not in kwargs
    assert kwargs['stdin'] == asyncio.subprocess.DEVNULL
    assert kwargs['stderr'] == asyncio.subprocess.STDOUT and kwargs['limit'] == 8192


def test_runner_collects_short_reads_and_rejects_nonzero_exit():
    process = Process(b'abc', exit_code=2)
    async def spawn(*args, **kwargs): return process
    with pytest.raises(ValueError, match='probe_exit'):
        asyncio.run(capability.bounded_command('/synthetic/ffmpeg', ('-version',), 10, spawn=spawn))
    assert process.waits == 1 and process.kills == 0


def test_timeout_kills_and_drains_owned_process(monkeypatch):
    monkeypatch.setattr(capability, 'COMMAND_TIMEOUT', 0.01)
    class WaitingOutput:
        def __init__(self): self.killed = asyncio.Event()
        async def read(self, count): await self.killed.wait(); return b''
    async def scenario():
        process = Process(); process.stdout = WaitingOutput()
        def kill(): process.kills += 1; process.returncode = -9; process.stdout.killed.set()
        process.kill = kill
        async def spawn(*args, **kwargs): return process
        with pytest.raises(asyncio.TimeoutError):
            await capability.bounded_command('/synthetic/ffmpeg', ('-version',), 10, spawn=spawn)
        assert process.kills == 1 and process.waits == 1
    asyncio.run(scenario())


def test_cancellation_does_not_cache_success_and_releases_gate():
    async def run(*args): raise asyncio.CancelledError
    owner = probe(run)
    with pytest.raises(asyncio.CancelledError): asyncio.run(owner.check())
    assert owner._cache == {} and not capability._GATE.locked()


def test_running_probe_cancellation_kills_reaps_and_propagates():
    async def scenario():
        entered = asyncio.Event()
        class WaitingOutput:
            def __init__(self): self.killed = asyncio.Event()
            async def read(self, count): entered.set(); await self.killed.wait(); return b''
        process = Process(); process.stdout = WaitingOutput()
        def kill(): process.kills += 1; process.returncode = -9; process.stdout.killed.set()
        process.kill = kill
        async def spawn(*args, **kwargs): return process
        task = asyncio.create_task(capability.bounded_command('/synthetic/ffmpeg', ('-version',), 10, spawn=spawn))
        await entered.wait(); task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert process.kills == process.waits == 1
    asyncio.run(scenario())


def test_poisoned_cleanup_refuses_further_processes(monkeypatch):
    monkeypatch.setattr(capability, '_POISONED', True)
    run = Runner(); result = asyncio.run(probe(run).check())
    assert result.reason == 'probe_cleanup_incomplete' and run.calls == []


def test_overall_collection_budget_is_bounded_without_retry(monkeypatch):
    monkeypatch.setattr(capability, 'COLLECTION_BUDGET', 0.01)
    calls = []
    async def run(*args): calls.append(args); await asyncio.Event().wait()
    result = asyncio.run(probe(run).check())
    assert not result.available and len(calls) == 1 and not capability._GATE.locked()


@pytest.mark.parametrize('cached', [False, True])
def test_poison_during_resolution_is_rechecked_under_gate_even_for_cache(monkeypatch, cached):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    monkeypatch.setattr(capability, '_POISONED', False)
    run = Runner(); owner = probe(run)
    if cached: assert asyncio.run(owner.check()).available
    prior_calls = len(run.calls)
    reached = threading.Barrier(2); release = threading.Barrier(2)
    def identify(path, platform):
        reached.wait(timeout=5); release.wait(timeout=5); return IDENTITY
    owner.identify = identify
    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(lambda: asyncio.run(owner.check()))
        reached.wait(timeout=5)
        # Simulates another loop completing failed cleanup while holding gate.
        with capability._GATE:
            monkeypatch.setattr(capability, '_POISONED', True)
        release.wait(timeout=5)
        result = pending.result(timeout=5)
    assert not result.available and result.reason == 'probe_cleanup_incomplete'
    assert len(run.calls) == prior_calls and not capability._GATE.locked()
