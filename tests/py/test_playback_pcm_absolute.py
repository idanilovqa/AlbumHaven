import asyncio
from dataclasses import replace
from pathlib import Path
import struct
import os
import wave
import pytest
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand
from music_app.services.playback_pcm_position import PcmPositionObserver
from music_app.services.playback_pcm_wave_source import open_qualified_wave
from music_app.services import playback_pcm_fd_capability as capability
from tests.py.test_playback_pcm import FakeProcess, factory_for
from tests.py.test_playback_pcm_position import line

HEADER = (b"Input #0, wav, from 'fd:':\n"
    b'  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 48000 Hz, stereo, s16, 1536 kb/s\n'
    b'  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_f32le (native))\n')


def fixture(path, frames=16, bits=16):
    with wave.open(str(path), 'wb') as out:
        out.setnchannels(2);out.setsampwidth(bits//8);out.setframerate(48000)
        out.writeframes(b''.join((sample << (bits-16)).to_bytes(bits//8,'little',signed=True)
                                for n in range(frames) for sample in (n,-n)))
    return path


def profile_header(bits):
    return HEADER.replace(b'pcm_s16le',f'pcm_s{bits}le'.encode()).replace(
        b', s16,', {16:b', s16,',24:b', s32 (24 bit),',32:b', s32,'}[bits]).replace(
        b'1536 kb/s',f'{96*bits} kb/s'.encode())


def command(path):
    return PcmOpenCommand(7, 41, 'current', path, 7, 48000, 123,
        capture_local_coordinates=True, capture_absolute_coordinates=True)


@pytest.mark.parametrize('bits',[16,24,32])
def test_qualified_same_open_file(tmp_path,bits):
    path=fixture(tmp_path/'valid.wav',bits=bits)
    source=open_qualified_wave(path)
    assert source is not None and source.tell()==0
    assert source.qualification_bits==bits and source.qualification_frames==16
    assert os.lseek(source.fileno(),0,os.SEEK_CUR)==0
    assert source.read(4)==b'RIFF'
    source.close()


@pytest.mark.parametrize('change', ['metadata', 'wrong_rate', 'wrong_layout', 'truncated', 'newline_path',
    'wrong_width','wrong_alignment','wrong_byte_rate','float_encoding','extensible_encoding','partial_frame'])
def test_noncanonical_input_rejected(tmp_path, change):
    path=fixture(tmp_path/('bad\nfile.wav' if change=='newline_path' else 'bad.wav'))
    data=bytearray(path.read_bytes())
    if change=='metadata':data+=b'LIST\0\0\0\0'
    if change=='wrong_rate':data[24:28]=struct.pack('<I',44100)
    if change=='wrong_layout':data[22:24]=struct.pack('<H',1)
    if change=='truncated':data=data[:-1]
    if change=='wrong_width':data[34:36]=struct.pack('<H',20)
    if change=='wrong_alignment':data[32:34]=struct.pack('<H',6)
    if change=='wrong_byte_rate':data[28:32]=struct.pack('<I',288000)
    if change=='float_encoding':data[20:22]=struct.pack('<H',3)
    if change=='extensible_encoding':data[20:22]=struct.pack('<H',65534)
    if change=='partial_frame':
        data=data[:-1]
        data[4:8]=struct.pack('<I',len(data)-8)
        data[40:44]=struct.pack('<I',len(data)-44)
    path.write_bytes(data)
    assert open_qualified_wave(path) is None


def test_actual_header_required():
    pcm=bytes(32); observer=PcmPositionObserver(require_wav_header=True)
    observer.feed_stderr(line(pcm))
    assert observer.loss_reason=='unsupported_input'


def test_actual_header_and_boundaries():
    pcm=bytes(32); observer=PcmPositionObserver(require_wav_header=True)
    observer.feed_stderr(HEADER+line(pcm))
    assert observer.consume_pcm(pcm)[0].source_start48==7
    assert observer.finish() and observer.source_end48==11


def test_metadata_line_cannot_impersonate_descriptor():
    observer=PcmPositionObserver(require_wav_header=True)
    observer.feed_stderr(HEADER+b'    comment: '+line(bytes(32)))
    assert observer.loss_reason=='unsupported_descriptor'


@pytest.mark.asyncio
@pytest.mark.parametrize('bits',[16,24,32])
async def test_unsupported_capability_preserves_original_invocation(tmp_path, monkeypatch,bits):
    monkeypatch.setattr(capability,'fd_capture_ready',lambda executable:False)
    calls=[];process=FakeProcess(stdout=bytes(32))
    path=fixture(tmp_path/'valid.wav',bits=bits)
    decoder=await PcmDecoderProcess.start(command(path),ffmpeg_executable='ffmpeg',process_factory=factory_for(process,calls))
    try:
        assert calls[0][0][calls[0][0].index('-i')+1]==str(path)
        assert '-copyts' not in calls[0][0] and decoder.absolute_metadata is None
        assert decoder.metadata.capture_coordinate_basis=='decoded-output-local'
    finally:await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('bits',[16,24,32])
async def test_split_frame_only_current_unsent_suffix_qualified(tmp_path, monkeypatch,bits):
    monkeypatch.setattr(capability,'fd_capture_ready',lambda executable:True)
    pcm=bytes(32);calls=[];process=FakeProcess(stdout=pcm,stderr=profile_header(bits)+line(pcm))
    # The fake emits native source frames7..10 then EOF: declare that exact end.
    path=fixture(tmp_path/'valid.wav',frames=11,bits=bits)
    decoder=await PcmDecoderProcess.start(command(path),ffmpeg_executable='ffmpeg',process_factory=factory_for(process,calls))
    try:
        await decoder._stderr_task
        assert calls[0][0][calls[0][0].index('-i')+1]=='fd:'
        assert calls[0][0]==('ffmpeg','-hide_banner','-loglevel','info','-copyts','-nostdin',
            '-ss','0.000145833','-i','fd:','-vn','-af',
            'aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,asettb=expr=1/48000,ashowinfo',
            '-f','f32le','-acodec','pcm_f32le','-ac','2','-ar','48000','pipe:1')
        assert not calls[0][1]['stdin'].closed
        assert calls[0][1]['stdin'].qualification_bits==bits
        decoder.grant_credit(2)
        first=await decoder.read_credited_frames(max_frames=2)
        assert first.pcm==pcm[:16] and first.verified_absolute_ranges==()
        decoder.grant_credit(2)
        second=await decoder.read_credited_frames(max_frames=2)
        assert second.verified_absolute_ranges==((0,9,2),)
        assert decoder.metadata.capture_coordinate_basis=='decoded-output-local'
        assert decoder.absolute_metadata.capture_coordinate_basis=='decoded-output-absolute-wav48'
        assert decoder.absolute_metadata.capture_source_id!=decoder.metadata.capture_source_id
        decoder.grant_credit(1);await decoder.read_credited_frames(max_frames=1)
        assert decoder.absolute_metadata.capture_extent_frames48==11
        assert decoder.metadata.capture_extent_frames48==4
    finally:await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('bits',[24,32])
async def test_profile_mismatch_loses_coordinates_without_changing_audio(tmp_path,monkeypatch,bits):
    monkeypatch.setattr(capability,'fd_capture_ready',lambda executable:True)
    pcm=bytes(32);process=FakeProcess(stdout=pcm,stderr=HEADER+line(pcm))
    decoder=await PcmDecoderProcess.start(command(fixture(tmp_path/'profile.wav',frames=11,bits=bits)),
        ffmpeg_executable='ffmpeg',process_factory=factory_for(process,[]))
    try:
        await decoder._stderr_task
        decoder.grant_credit(4)
        chunk=await decoder.read_credited_frames(max_frames=4)
        assert chunk.pcm==pcm and chunk.verified_absolute_ranges==()
        assert decoder._absolute_observer.loss_reason=='unsupported_input'
        decoder.grant_credit(1);await decoder.read_credited_frames(max_frames=1)
        assert decoder.absolute_metadata.capture_extent_frames48 is None
    finally:await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('bits',[16,24,32])
async def test_missing_sideband_retains_audio_local_time(tmp_path,monkeypatch,bits):
    monkeypatch.setattr(capability,'fd_capture_ready',lambda executable:True)
    pcm=bytes(32);process=FakeProcess(stdout=pcm)
    decoder=await PcmDecoderProcess.start(command(fixture(tmp_path/'valid.wav',bits=bits)),
        ffmpeg_executable='ffmpeg',process_factory=factory_for(process,[]))
    try:
        decoder.grant_credit(4)
        chunk=await decoder.read_credited_frames(max_frames=4)
        assert chunk.pcm==pcm and not chunk.verified_absolute_ranges
        assert decoder._absolute_observer.loss_reason=='missing_or_late_descriptor'
    finally:await decoder.cancel()


@pytest.mark.asyncio
async def test_route_admission_does_not_wait_and_json_precedes_exact_pcm(tmp_path, monkeypatch):
    from tests.py.test_playback_cleanup import _connection
    from music_app.services.playback_pcm import PcmChunk
    process=FakeProcess(stdout=bytes(32))
    decoder=PcmDecoderProcess(replace(command(tmp_path/'unused.wav'),stream_id=11),process)
    decoder.absolute_metadata=replace(decoder.metadata,capture_local_coordinates=False,
        capture_absolute_coordinates=True)
    registry,socket,connection,stream=await _connection(decoder)
    socket.app.state.config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED':True,
        'ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED':True}
    gate=asyncio.Event()
    async def record(_stream):
        await gate.wait();return True
    monkeypatch.setattr(connection,'_record_absolute_open',record)
    chunk=PcmChunk(4,bytes(32),((0,7,4),))
    original_json=socket.send_json;original_bytes=socket.send_bytes
    async def locked_json(value):
        assert connection._send_lock.locked()
        return await original_json(value)
    async def locked_bytes(value):
        assert connection._send_lock.locked()
        return await original_bytes(value)
    monkeypatch.setattr(socket,'send_json',locked_json)
    monkeypatch.setattr(socket,'send_bytes',locked_bytes)
    try:
        assert connection._absolute_positions(stream,chunk) is None
        assert not stream.absolute_admission_task.done()
        assert await connection._send_stream_bytes(stream,b'local')
        assert socket.events==[b'local']
        gate.set();await stream.absolute_admission_task
        positions=connection._absolute_positions(stream,chunk)
        assert positions['sequence']==0 and positions['ranges']==((0,7,4),)
        assert await connection._send_stream_bytes(stream,b'mapped',positions)
        assert socket.events[-2:]==[positions,b'mapped']
    finally:
        gate.set()
        await connection.cleanup()


@pytest.mark.asyncio
async def test_failed_absolute_admission_keeps_packets_local(tmp_path,monkeypatch):
    from tests.py.test_playback_cleanup import _connection
    from music_app.services.playback_pcm import PcmChunk
    decoder=PcmDecoderProcess(replace(command(tmp_path/'unused.wav'),stream_id=11),FakeProcess(stdout=bytes(32)))
    decoder.absolute_metadata=replace(decoder.metadata,capture_local_coordinates=False,capture_absolute_coordinates=True)
    registry,socket,connection,stream=await _connection(decoder)
    socket.app.state.config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED':True,'ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED':True}
    async def refuse(_stream):return False
    monkeypatch.setattr(connection,'_record_absolute_open',refuse)
    chunk=PcmChunk(4,bytes(32),((0,7,4),))
    try:
        assert connection._absolute_positions(stream,chunk) is None
        await stream.absolute_admission_task
        assert connection._absolute_positions(stream,chunk) is None
        assert await connection._send_stream_bytes(stream,b'ordinary')
        assert socket.events==[b'ordinary']
    finally:await connection.cleanup()


@pytest.mark.asyncio
@pytest.mark.parametrize('bits',[16,24,32])
async def test_in_place_source_mutation_loses_coordinates_not_audio(tmp_path,monkeypatch,bits):
    monkeypatch.setattr(capability,'fd_capture_ready',lambda executable:True)
    pcm=bytes(32);path=fixture(tmp_path/'mutated.wav',bits=bits);calls=[]
    decoder=await PcmDecoderProcess.start(command(path),ffmpeg_executable='ffmpeg',
        process_factory=factory_for(FakeProcess(stdout=pcm,stderr=profile_header(bits)+line(pcm)),calls))
    source=calls[0][1]['stdin']
    try:
        await decoder._stderr_task
        with path.open('r+b') as file:
            file.seek(44);file.write(b'xxxx');file.flush();os.fsync(file.fileno())
        decoder.grant_credit(4)
        chunk=await decoder.read_credited_frames(max_frames=4)
        assert chunk.pcm==pcm and chunk.verified_absolute_ranges==()
        assert decoder._absolute_observer.loss_reason=='source_changed'
        decoder.grant_credit(1);await decoder.read_credited_frames(max_frames=1)
        assert decoder.absolute_metadata.capture_extent_frames48 is None
    finally:
        await decoder.cancel()
        assert source.closed


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_settlement", [False, True, "before_start"])
async def test_stalled_optional_storage_releases_decoder_slots_and_bounds_new_work(tmp_path,monkeypatch,cancel_settlement):
    from tests.py.test_playback_cleanup import _connection
    from music_app.services.playback_pcm import PcmChunk
    from music_app.routes import playback_stream_asgi as routes
    def make(number):
        value=PcmDecoderProcess(replace(command(tmp_path/'unused.wav'),stream_id=number),FakeProcess(stdout=bytes(32)))
        value.absolute_metadata=replace(value.metadata,capture_local_coordinates=False,capture_absolute_coordinates=True)
        return value
    registry,socket,connection,first=await _connection(make(11))
    socket.app.state.config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED':True,'ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED':True}
    gate=asyncio.Event();calls=[]
    async def stalled(stream):
        calls.append(stream.stream_id)
        await gate.wait();return True
    monkeypatch.setattr(connection,'_record_absolute_open',stalled)
    monkeypatch.setattr(routes,'PCM_CLEANUP_JOIN_SECONDS',0.05)
    chunk=PcmChunk(4,bytes(32),((0,7,4),))
    try:
        assert connection._absolute_positions(first,chunk) is None
        if cancel_settlement == "before_start":
            connection._start_absolute_settlement(first, False)
            first.absolute_settlement_task.cancel()
        await connection._retire_stream(first)
        assert registry.active_decoder_count==0 and len(connection._absolute_capture_owners)==1
        assert not first.absolute_admission_task.done()
        if cancel_settlement is True:
            await asyncio.sleep(0)
            first.absolute_settlement_task.cancel()
            await asyncio.sleep(0)
            assert not first.absolute_settlement_task.done()
            assert not first.absolute_admission_task.cancelled()
            assert len(connection._absolute_capture_owners)==1
        assert await registry.acquire_decoder()
        second=routes._PlaybackStream(make(12),7,12,'current')
        connection._streams_by_id[12]=second;connection._streams_by_role['current']=second
        assert connection._absolute_positions(second,chunk) is None
        await connection._retire_stream(second)
        assert registry.active_decoder_count==0 and len(connection._absolute_capture_owners)==2
        assert await registry.acquire_decoder()
        third=routes._PlaybackStream(make(13),7,13,'current')
        connection._streams_by_id[13]=third;connection._streams_by_role['current']=third
        assert connection._absolute_positions(third,chunk) is None
        assert third.absolute_admission_task is None
        assert await connection._send_stream_bytes(third,b'ordinary while storage stalled')
        with pytest.raises(RuntimeError,match='unresolved'):
            await connection.cleanup()
        assert registry.active_decoder_count==0
        assert registry.active_connection_count==1
        assert len(connection._absolute_capture_owners)==2
        gate.set()
        await asyncio.wait_for(asyncio.shield(connection._finalize_task),1)
        assert registry.active_connection_count==0 and not connection._absolute_capture_owners
        assert calls==[11,12]
    finally:
        gate.set()
        await connection.cleanup()


def test_output_header_does_not_replace_qualified_input_header():
    pcm=bytes(32); observer=PcmPositionObserver(require_wav_header=True)
    observer.feed_stderr(HEADER+line(pcm))
    assert observer.consume_pcm(pcm)
    observer.feed_stderr(b"Output #0, f32le, to 'pipe:1':\n"
        b'  Stream #0:0: Audio: pcm_f32le, 48000 Hz, stereo, flt, 3072 kb/s\n')
    observer.feed_stderr(line(pcm).replace(b'n:0 pts:7 ', b'n:1 pts:11 '))
    assert observer.consume_pcm(pcm)[0].source_start48==11
    assert observer.finish()


@pytest.mark.parametrize('row, expected', [(None,False), ({'ready':False},False), ({'ready':1},False), ({'ready':True},True)])
def test_absolute_schema_marker_must_be_explicitly_ready(row,expected):
    from music_app.services.playback_decoder_observation import absolute_wav_observation_ready
    class Connection:
        def execute(self,sql):
            assert 'c.convalidated' in sql and 'pg_get_constraintdef' in sql
            assert 'playback_decoder_observation_absolute_wav48_v1' in sql
            return self
        def fetchone(self):return row
    assert absolute_wav_observation_ready(Connection()) is expected


def test_alias_serial_same_stream_preserves_lineage_and_checks_server_reference(monkeypatch):
    from types import SimpleNamespace
    from music_app.services.playback_capture import _validate_position_lineage,CaptureError
    from music_app.services import playback_decoder_observation as observation
    runs=[dict(generation=7,stream_id=11,source_base48=0,binding_serial=serial,
        continuity_serial=1,ordinal_start=start,output_start=start,frames=4,epoch=1,
        source_start48=source,source_observation_ref=ref)
        for serial,start,source,ref in [(1,0,0,'local'),(2,4,12005,'absolute'),(1,8,8,'local')]]
    _validate_position_lineage(runs)
    parent=dict(original_track_id=1,original_file_id=2,original_root_id=3)
    rows=[dict(parent,observation_ref=ref,auth_session_guard='guard',original_library_id=8,
        generation=7,stream_id=11,source_base48=0,extent_frames48=end)
        for ref,end in [('local',20),('absolute',20000)]]
    class Connection:
        def execute(self,sql,params):
            assert 'account_id=%s' in sql and params==(9,['absolute','local'])
            return self
        def fetchall(self):return rows
    monkeypatch.setattr(observation,'decoder_observation_ready',lambda connection:True)
    live=SimpleNamespace(actor=SimpleNamespace(account_id=9),library_id=8)
    observation.validate_known_observations(Connection(),live,parent,dict(runs=runs),'guard')
    rows[1]['stream_id']=12
    with pytest.raises(CaptureError,match='capture_conflict'):
        observation.validate_known_observations(Connection(),live,parent,dict(runs=runs),'guard')


@pytest.mark.asyncio
async def test_producer_serializes_shared_client_boundary_fixture(tmp_path,monkeypatch,record_property):
    import json
    from tests.py.test_playback_cleanup import _connection
    from music_app.services.playback_pcm import PcmChunk,pack_pcm_frame
    from music_app.routes.playback_stream_asgi import _metadata_event
    decoder=PcmDecoderProcess(replace(command(tmp_path/'unused.wav'),stream_id=11),FakeProcess(stdout=bytes(64)))
    decoder.metadata=replace(decoder.metadata,capture_source_id='11111111-1111-4111-8111-111111111111')
    decoder.absolute_metadata=replace(decoder.metadata,capture_source_id='22222222-2222-4222-8222-222222222222',
        capture_local_coordinates=False,capture_absolute_coordinates=True)
    registry,socket,connection,stream=await _connection(decoder)
    socket.app.state.config={'ALBUM_HAVEN_POSITION_CAPTURE_ENABLED':True,'ALBUM_HAVEN_WAV_ABSOLUTE_CAPTURE_ENABLED':True}
    async def admitted(_stream):return True
    monkeypatch.setattr(connection,'_record_absolute_open',admitted)
    chunk=PcmChunk(8,struct.pack('<16f',*([.25]*16)),((2,12003,4),))
    try:
        assert connection._absolute_positions(stream,chunk) is None
        await stream.absolute_admission_task
        control=connection._absolute_positions(stream,chunk)
        payload=pack_pcm_frame(generation=7,stream_id=11,role='current',sequence=0,frame_count=8,pcm=chunk.pcm)
        assert await connection._send_stream_bytes(stream,payload,control)
        assert socket.events==[control,payload]
        record_property('producer_wire',json.dumps(dict(
            metadata=_metadata_event(decoder.metadata,role='current'),control=control,pcm_hex=payload.hex()),sort_keys=True))
    finally:await connection.cleanup()
