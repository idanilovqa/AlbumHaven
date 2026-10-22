"""Synthetic handles only. No files, Windows API, FFmpeg or app startup executed."""
import asyncio
from dataclasses import replace
from types import SimpleNamespace

import pytest

from music_app.services import retained_playback_source as source_module
from music_app.services.ffmpeg_source_capability import ExecutableIdentity, SourceCapability

INFO = SimpleNamespace(st_mode=0o100644, st_dev=1, st_ino=2, st_size=6, st_mtime_ns=3, st_ctime_ns=4)
IDENTITY = ExecutableIdentity('/synthetic/ffmpeg', 'win32', 1, 9, 10, 11, 12)
CAPABILITY = SourceCapability(IDENTITY, 'handle', True, 'declared_not_runtime_verified')


class File:
    def __init__(self, descriptor): self.descriptor = descriptor; self.closed = False; self.position = 0
    def fileno(self): return self.descriptor
    def close(self): self.closed = True
    def read(self, count):
        result = b'abcdef'[self.position:self.position + count]; self.position += len(result); return result
    def seek(self, position): self.position = position


class WindowsBackend:
    platform = 'win32'
    def __init__(self): self.files = []; self.flags = {}; self.events = []; self.restore_error = False
    def open(self, path):
        file = File(100 + len(self.files)); self.files.append(file); self.flags[file.fileno()] = False; return file
    def reopen(self, anchor, path): self.events.append(('reopen', anchor.fileno())); return self.open(path)
    def value(self, file): return file.fileno()
    def inheritance(self, file):
        return {'startupinfo': SimpleNamespace(lpAttributeList={'handle_list': [file.fileno()]}), 'close_fds': True}
    def get_inheritable(self, handle): return self.flags[handle]
    def set_inheritable(self, handle, value):
        self.events.append(('inheritable', handle, value)); self.flags[handle] = value
        if not value and self.restore_error: raise OSError('restore failed')


class PosixBackend(WindowsBackend):
    platform = 'posix'
    def inheritance(self, file): return {'pass_fds': (file.fileno(),), 'close_fds': True}


class Probe:
    def __init__(self, values=None): self.values = iter(values) if values else None
    def matches(self, value): return next(self.values) if self.values else True


class Output:
    async def read(self, count): return b''


class Process:
    def __init__(self): self.returncode = None; self.stdout = Output(); self.stderr = Output(); self.kills = 0; self.waits = 0
    def kill(self): self.kills += 1; self.returncode = -9
    async def wait(self): self.waits += 1; return self.returncode


def opened(backend=None, info=None, path_info=None):
    backend = backend or WindowsBackend(); info = info or [INFO]; path_info = path_info or info
    source = source_module.RetainedPlaybackSource('/synthetic/song.MP3', backend=backend,
        fstat=lambda fd: info[0], path_stat=lambda path: path_info[0])
    return source, backend


def test_separate_reader_offsets_original_suffix_and_anchor_lifetime():
    source, backend = opened()
    first, second = source.reader(), source.reader()
    assert source.original_suffix == '.mp3'
    assert first.read(2) == second.read(2) == b'ab'
    first.seek(4); assert first.read(2) == b'ef' and second.read(2) == b'cd'
    first.close(); second.close(); assert not backend.files[0].closed
    source.close(); source.close(); assert backend.files[0].closed
    with pytest.raises(source_module.SourceUnavailable, match='source_closed'): source.reader()


def test_windows_explicit_allowlist_no_path_input_and_parent_reader_closes_after_spawn(monkeypatch):
    source, backend = opened(); process = Process(); calls = []
    monkeypatch.setattr(source_module, 'hidden_subprocess_creation_flags', lambda: 64)
    async def spawn(*args, **kwargs):
        calls.append((args, kwargs)); assert backend.flags[101] is True; assert not backend.files[1].closed
        return process
    result = asyncio.run(source_module.start_retained_process(source, CAPABILITY,
        ('-ss', '1.0'), ('-f', 'f32le', 'pipe:1'), probe=Probe(), spawn=spawn))
    assert result is process and process.kills == 0
    args, kwargs = calls[0]
    assert args == ('/synthetic/ffmpeg', '-nostdin', '-ss', '1.0', '-handle', '101', '-i', 'handle:', '-f', 'f32le', 'pipe:1')
    assert kwargs['startupinfo'].lpAttributeList == {'handle_list': [101]}
    assert kwargs['close_fds'] is True and kwargs['creationflags'] == 64
    assert 'pass_fds' not in kwargs and 'shell' not in kwargs and '/synthetic/song.MP3' not in args
    assert backend.flags[101] is False and backend.files[1].closed and not backend.files[0].closed
    source.close()


def test_posix_fd_allowlist_and_no_windows_inheritability_changes():
    source, backend = opened(PosixBackend()); calls = []
    async def spawn(*args, **kwargs): calls.append((args, kwargs)); return Process()
    capability = replace(CAPABILITY, protocol='fd', identity=replace(IDENTITY, platform='linux'))
    asyncio.run(source_module.start_retained_process(source, capability, (), (), probe=Probe(), spawn=spawn))
    assert calls[0][0][-4:] == ('-fd', '101', '-i', 'fd:')
    assert calls[0][1]['pass_fds'] == (101,) and calls[0][1]['close_fds'] is True
    assert 'startupinfo' not in calls[0][1]
    assert not any(event[0] == 'inheritable' for event in backend.events)
    assert backend.files[1].closed; source.close()


@pytest.mark.parametrize('failure', [OSError('spawn failed'), asyncio.CancelledError()])
def test_spawn_failure_or_cancellation_restores_flag_and_closes_parent_reader(failure):
    source, backend = opened()
    async def spawn(*args, **kwargs): raise failure
    with pytest.raises(type(failure)):
        asyncio.run(source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn))
    assert backend.files[1].closed and backend.flags[101] is False and not source._launching
    source.close()


def test_absent_capability_refuses_without_source_reader_or_process_and_leaves_anchor_usable():
    source, backend = opened()
    async def spawn(*args, **kwargs): pytest.fail('must not spawn')
    with pytest.raises(source_module.SourceUnavailable, match='capability_unavailable'):
        asyncio.run(source_module.start_retained_process(source, replace(CAPABILITY, available=False), (), (), probe=Probe(), spawn=spawn))
    assert len(backend.files) == 1 and source.check() == source.observation
    # The adapter does not call ordinary playback; a future caller owns fallback.
    source.close()


def test_executable_change_immediately_before_launch_does_not_spawn_or_leak_reader():
    source, backend = opened()
    async def spawn(*args, **kwargs): pytest.fail('must not spawn')
    with pytest.raises(source_module.SourceUnavailable, match='executable_changed'):
        asyncio.run(source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe([True, False]), spawn=spawn))
    assert backend.files[1].closed and backend.flags[101] is False; source.close()


@pytest.mark.parametrize('field', ['st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns'])
def test_mutated_source_or_replaced_path_cannot_supply_an_admitted_reader(field):
    current = [INFO]; source, backend = opened(path_info=current)
    changed = SimpleNamespace(**vars(INFO)); setattr(changed, field, 999); current[0] = changed
    with pytest.raises(source_module.SourceUnavailable, match='source_changed'): source.reader()
    assert len(backend.files) == 1; source.close()


def test_source_change_during_spawn_aborts_child_and_reaps_before_error():
    current = [INFO]; source, backend = opened(info=current); process = Process()
    async def spawn(*args, **kwargs):
        current[0] = SimpleNamespace(**{**vars(INFO), 'st_size': 99}); return process
    with pytest.raises(source_module.SourceUnavailable, match='source_changed'):
        asyncio.run(source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn))
    assert process.kills == process.waits == 1
    assert backend.flags[101] is False and backend.files[1].closed; source.close()


def test_inheritability_restore_failure_does_not_orphan_an_already_started_child():
    source, backend = opened(); backend.restore_error = True; process = Process()
    async def spawn(*args, **kwargs): return process
    with pytest.raises(OSError, match='restore failed'):
        asyncio.run(source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn))
    assert process.kills == process.waits == 1 and backend.files[1].closed
    assert not source._launching; source.close()


def test_concurrent_launch_and_close_are_refused_while_reader_is_temporarily_inheritable():
    async def scenario():
        source, backend = opened(); entered = asyncio.Event(); release = asyncio.Event()
        async def spawn(*args, **kwargs): entered.set(); await release.wait(); return Process()
        task = asyncio.create_task(source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn))
        await entered.wait()
        with pytest.raises(source_module.SourceUnavailable, match='source_launch_in_progress'):
            await source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn)
        with pytest.raises(source_module.SourceUnavailable, match='source_launch_in_progress'): source.close()
        release.set(); await task
        assert backend.files[1].closed and backend.flags[101] is False; source.close()
    asyncio.run(scenario())


def test_native_windows_open_reopen_contract_uses_read_only_shared_synchronous_handles():
    # Inspect the real binding methods through a fake kernel, without constructing
    # WindowsReaders (which would load ctypes/Windows APIs).
    backend = object.__new__(source_module.WindowsReaders); calls = []
    backend.kernel = SimpleNamespace(
        CreateFileW=lambda *args: calls.append(('open', args)) or 99,
        ReOpenFile=lambda *args: calls.append(('reopen', args)) or 100)
    backend._file = lambda handle: handle
    backend.value = lambda anchor: 99
    assert backend.open('/synthetic/song.MP3') == 99
    assert backend.reopen(object(), '/ignored/path') == 100
    assert calls == [('open', ('/synthetic/song.MP3', 0x80000000, 7, None, 3, 0x80, None)),
                     ('reopen', (99, 0x80000000, 7, 0))]


def test_simultaneous_distinct_sources_allowlist_only_their_own_reader():
    async def scenario():
        first, first_backend = opened(); second, second_backend = opened()
        # Give the second fake object its own native handle namespace.
        second_backend.files[0].descriptor = 200
        original_open = second_backend.open
        def new_open(path):
            file = original_open(path); file.descriptor += 100
            second_backend.flags[file.descriptor] = False; return file
        second_backend.open = new_open
        entered = 0; ready = asyncio.Event(); calls = []
        async def spawn(*args, **kwargs):
            nonlocal entered
            calls.append(kwargs['startupinfo'].lpAttributeList['handle_list']); entered += 1
            if entered == 2: ready.set()
            await ready.wait(); return Process()
        await asyncio.gather(
            source_module.start_retained_process(first, CAPABILITY, (), (), probe=Probe(), spawn=spawn),
            source_module.start_retained_process(second, CAPABILITY, (), (), probe=Probe(), spawn=spawn))
        assert sorted(calls) == [[101], [201]]
        assert first_backend.flags[101] is False and second_backend.flags[201] is False
        first.close(); second.close()
    asyncio.run(scenario())


def test_detected_mutation_stays_failed_even_if_metadata_is_later_restored():
    current = [INFO]; source, backend = opened(path_info=current)
    current[0] = SimpleNamespace(**{**vars(INFO), 'st_mtime_ns': 99})
    with pytest.raises(source_module.SourceUnavailable, match='source_changed'): source.check()
    current[0] = INFO
    with pytest.raises(source_module.SourceUnavailable, match='source_failed'): source.check()
    source.close()


@pytest.mark.parametrize('candidate_mode', [0o100644, 0o010644])
def test_candidate_mismatch_latches_failure_after_original_observations_return(candidate_mode):
    source, backend = opened()
    source._fstat = lambda fd: INFO if fd == 100 else SimpleNamespace(
        **{**vars(INFO), 'st_ino': 99, 'st_mode': candidate_mode})
    with pytest.raises(source_module.SourceUnavailable): source.reader()
    assert backend.files[1].closed and source._failed
    source._fstat = lambda fd: INFO
    with pytest.raises(source_module.SourceUnavailable, match='source_failed'): source.check()
    with pytest.raises(source_module.SourceUnavailable, match='source_failed'): source.reader()
    assert len(backend.files) == 2
    source.close()


@pytest.mark.parametrize('finalizer', ['restore', 'close'])
def test_compound_failure_keeps_one_pending_cleanup_owner(monkeypatch, finalizer):
    async def scenario():
        current = [INFO]; source, backend = opened(info=current); process = Process()
        release = asyncio.Event(); reads = []; owners = []
        class StuckOutput:
            async def read(self, count):
                reads.append(count); await release.wait(); return b''
        process.stdout = StuckOutput()
        async def synthetic_timeout(shielded, timeout):
            # Deterministic timeout after the owned cleanup enters its reads.
            await asyncio.sleep(0); await asyncio.sleep(0)
            owners.append(source._cleanup_task)
            shielded.cancel()  # shield cancellation never cancels its inner task
            raise asyncio.TimeoutError
        monkeypatch.setattr(source_module.asyncio, 'wait_for', synthetic_timeout)
        async def spawn(*args, **kwargs):
            current[0] = SimpleNamespace(**{**vars(INFO), 'st_size': 99})
            if finalizer == 'restore': backend.restore_error = True
            else:
                def bad_close(): raise OSError('reader close failed')
                backend.files[1].close = bad_close
            return process
        with pytest.raises(source_module.SourceUnavailable, match='cleanup_incomplete'):
            await source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn)
        assert len(owners) == 2 and owners[0] is owners[1] is source._cleanup_task
        assert not owners[0].done() and process.kills == process.waits == 1
        assert reads == [8192] and source._failed and not source._launching
        with pytest.raises(source_module.SourceUnavailable, match='source_launch_in_progress'): source.close()
        release.set(); await owners[0]
        assert source._cleanup_task is owners[0] and process.waits == 1
        source.close()
    asyncio.run(scenario())


def test_drain_error_still_waits_and_finishes_other_pipe():
    async def scenario():
        current = [INFO]; source, backend = opened(info=current); process = Process(); drained = []
        class BrokenOutput:
            async def read(self, count): raise OSError('pipe failed')
        class OtherOutput:
            async def read(self, count): drained.append(count); return b''
        process.stdout = BrokenOutput(); process.stderr = OtherOutput()
        async def spawn(*args, **kwargs):
            current[0] = SimpleNamespace(**{**vars(INFO), 'st_size': 99}); return process
        with pytest.raises(source_module.SourceUnavailable, match='cleanup_incomplete'):
            await source_module.start_retained_process(source, CAPABILITY, (), (), probe=Probe(), spawn=spawn)
        assert process.kills == process.waits == 1 and drained == [8192]
        assert source._cleanup_task.done() and source._failed
        source.close()
    asyncio.run(scenario())


@pytest.mark.parametrize('mode', [0o100644, 0o010644])
def test_posix_safe_open_validates_before_fdopen_and_closes_rejected_fifo(monkeypatch, mode):
    calls = []; file = File(77)
    fake_os = SimpleNamespace(
        O_RDONLY=0, O_NONBLOCK=1, O_CLOEXEC=2,
        open=lambda path, flags: calls.append(('open', path, flags)) or 77,
        fstat=lambda fd: calls.append(('stat', fd)) or SimpleNamespace(**{**vars(INFO), 'st_mode': mode}),
        fdopen=lambda *args, **kwargs: calls.append(('wrap', args, kwargs)) or file,
        close=lambda fd: calls.append(('close', fd)),
    )
    monkeypatch.setattr(source_module, 'os', fake_os)
    backend = source_module.PosixReaders()
    if mode == 0o100644:
        assert backend.open('/synthetic/source') is file
        assert calls[2] == ('wrap', (77, 'rb'), {'buffering': 0})
    else:
        with pytest.raises(source_module.SourceUnavailable, match='source_not_regular'): backend.open('/synthetic/source')
        assert calls[2:] == [('close', 77)]
    assert calls[0] == ('open', '/synthetic/source', source_module.os.O_RDONLY | source_module.os.O_NONBLOCK | source_module.os.O_CLOEXEC)
    assert calls[1] == ('stat', 77)
