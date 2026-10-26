import asyncio
import importlib.util
import sys
from pathlib import Path
import pytest
from music_app.services import playback_pcm_fd_capability as capability


@pytest.mark.parametrize('value, expected', [(None,False),('',False),('false',False),('0',False),('unknown',False),('1',True),(' true ',True),('YES',True)])
def test_supported_runtime_config_loads_capture_flags_default_off(tmp_path,monkeypatch,value,expected):
    import config
    from music_app import _build_runtime_config
    names=('ALBUM_HAVEN_POSITION_CAPTURE_ENABLED','ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED')
    for name in names:
        if value is None:monkeypatch.delenv(name,raising=False)
        else:monkeypatch.setenv(name,value)
    monkeypatch.setenv('MUSIC_APP_DATA_DIR',str(tmp_path/'config-owned'))
    spec=importlib.util.spec_from_file_location('isolated_capture_config',config.__file__)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    monkeypatch.setitem(sys.modules,'config',module)
    loaded=_build_runtime_config()
    assert all(loaded[name] is expected for name in names)


@pytest.mark.asyncio
async def test_probe_shutdown_retains_pending_task_on_timeout_and_does_not_reopen(monkeypatch):
    gate=asyncio.Event();started=asyncio.Event()
    async def work():
        started.set()
        try:await asyncio.Future()
        except asyncio.CancelledError:
            while not gate.is_set():
                try:await asyncio.shield(gate.wait())
                except asyncio.CancelledError:pass
        return False
    task=asyncio.create_task(work());await started.wait()
    identity=('test',1,2,3,4,5)
    monkeypatch.setattr(capability,'_state',(identity,task))
    monkeypatch.setattr(capability,'_blocked_probe',None)
    monkeypatch.setattr(capability,'_identity',lambda executable:identity)
    monkeypatch.setattr(capability,'_SHUTDOWN_SECONDS',.01)
    try:
        with pytest.raises(RuntimeError,match='cleanup unresolved'):await capability.shutdown_fd_capture()
        assert not task.done() and capability._state[1] is task
        assert capability.fd_capture_ready('test') is False
        gate.set();await task
        await capability.shutdown_fd_capture()
        assert capability.fd_capture_ready('test') is False
    finally:
        gate.set();await task


@pytest.mark.asyncio
async def test_registry_shutdown_joins_optional_capability_lifecycle(monkeypatch):
    from music_app.routes.playback_stream_asgi import PlaybackPcmRegistry
    calls=[]
    async def shutdown():calls.append('joined')
    monkeypatch.setattr(capability,'shutdown_fd_capture',shutdown)
    registry=PlaybackPcmRegistry();await registry.shutdown()
    assert calls==['joined'] and registry._shutting_down


@pytest.mark.asyncio
async def test_registry_surfaces_unsettled_optional_capability(monkeypatch):
    from music_app.routes.playback_stream_asgi import PlaybackPcmRegistry
    async def shutdown():raise RuntimeError('FFmpeg capability cleanup unresolved')
    monkeypatch.setattr(capability,'shutdown_fd_capture',shutdown)
    with pytest.raises(RuntimeError,match='capability cleanup unresolved'):
        await PlaybackPcmRegistry().shutdown()
