"""AUTHORED, NOT RUN: actual decoder at synthetic pipe boundaries; no media."""
import asyncio
from dataclasses import replace
from pathlib import Path
import pytest
from music_app.services.playback_pcm import PcmOpenCommand, PcmDecoderProcess
from music_app.routes.playback_stream_asgi import _capture_source_event
from tests.py.test_playback_capture_source import _Process, _consume, _FailOnceReader


def command(*, local=True, start=48000, rate=48000):
    return PcmOpenCommand(generation=7, stream_id=11, role='current',
        path=Path('synthetic-local-output.flac'), start_frame=start, sample_rate=rate,
        provisional_duration_seconds=999, capture_local_coordinates=local)


@pytest.mark.asyncio
async def test_seek_local_output_is_not_requested_offset_or_full_track_extent():
    decoder=PcmDecoderProcess(command(), _Process(bytes(4*8)))
    try:
        before=_capture_source_event(decoder.metadata)
        assert before['coordinateBasis']=='decoded-output-local'
        assert before['sourceBase48']==0 and before['requestedStart48']==48000
        assert before['extentFrames48'] is None
        metadata=await _consume(decoder,4)
        assert metadata.authoritative_total_frames==48004  # Display timeline only.
        assert metadata.capture_extent_frames48==4  # This decoder's output only.
        assert metadata.capture_coordinate_basis=='decoded-output-local'
    finally:await decoder.cancel()


@pytest.mark.asyncio
@pytest.mark.parametrize('local,start,rate,basis',[
    (False,48000,48000,'unknown'),(True,48000,44100,'unknown'),
    (False,0,48000,'decoded-output-zero'),(True,0,48000,'decoded-output-zero'),
])
async def test_default_off_and_unsupported_rate_never_gain_nonzero_coordinates(local,start,rate,basis):
    decoder=PcmDecoderProcess(command(local=local,start=start,rate=rate),_Process(bytes(2*8)))
    try:
        assert decoder.metadata.capture_coordinate_basis==basis
        result=await _consume(decoder,2)
        assert result.capture_extent_frames48==(2 if basis=='decoded-output-zero' else None)
    finally:await decoder.cancel()


@pytest.mark.asyncio
async def test_nonzero_reconnect_is_distinct_even_with_same_command_and_bytes():
    a=PcmDecoderProcess(command(),_Process(bytes(2*8)))
    b=PcmDecoderProcess(command(),_Process(bytes(2*8)))
    try:
        assert a.metadata.capture_source_id!=b.metadata.capture_source_id
        assert a.metadata.capture_source_base48==b.metadata.capture_source_base48==0
        # Equal local zero/count cannot establish equality of source coordinates.
        await _consume(a,2)
        assert b.metadata.capture_extent_frames48 is None
    finally:await asyncio.gather(a.cancel(),b.cancel())


@pytest.mark.asyncio
async def test_local_failure_and_cancellation_never_create_eof_extent():
    decoder=PcmDecoderProcess(command(),_Process(stdout=_FailOnceReader(RuntimeError('synthetic read failure'))))
    try:
        decoder.grant_credit(2)
        with pytest.raises(RuntimeError,match='synthetic read failure'):
            await decoder.read_credited_frames(max_frames=2)
        assert decoder.metadata.capture_extent_frames48 is None
        assert decoder.outstanding_credit_frames==2
    finally:await decoder.cancel()
    assert decoder.metadata.capture_extent_frames48 is None


def test_local_metadata_cannot_be_relabeled_as_absolute_origin():
    # Construct without a subprocess; no process or asyncio work is started.
    from music_app.services.playback_pcm import PcmStreamMetadata
    value=PcmStreamMetadata(generation=7,stream_id=11,role='current',sample_rate=48000,
        channels=2,provisional_total_frames=999,requested_start_frame=48000,timeline_start_frame=48000,
        capture_source_id='11111111-1111-4111-8111-111111111111',capture_source_base48=0,
        capture_local_coordinates=True)
    with pytest.raises(ValueError):replace(value,capture_local_coordinates=False)
    with pytest.raises(ValueError):replace(value,capture_source_base48=48000)


@pytest.mark.asyncio
@pytest.mark.parametrize('admitted',[True,False])
async def test_actual_route_local_admission_precedes_metadata_and_failure_keeps_audio(monkeypatch,admitted):
    from tests.py.test_playback_cleanup import (_connection,_open_control,_route_factory,
        _Process as RouteProcess,_bounded,_settle_connection)
    process=RouteProcess();calls=[]
    async def factory(*args,**kwargs):
        calls.append(args)
        return process
    _route_factory(monkeypatch,factory)
    registry,socket,connection,_=await _connection()
    async def prepare(*args):return ('synthetic-db',object(),None,object())
    async def record(stream):
        assert stream.decoder.command.capture_local_coordinates is True
        assert stream.decoder.metadata.capture_coordinate_basis=='decoded-output-local'
        assert not any(e.get('type')=='metadata' for e in socket.events)
        if not admitted:stream.capture_admission=None
    monkeypatch.setattr(connection,'_prepare_capture_admission',prepare)
    monkeypatch.setattr(connection,'_record_capture_open',record)
    control=_open_control();control['startFrame']=48000
    decoder=None
    try:
        assert await _bounded(connection._open(control))
        decoder=connection._streams_by_id[11].decoder
        assert decoder.metadata.capture_coordinate_basis==('decoded-output-local' if admitted else 'unknown')
        # No timestamp or filter experiments; this is the original lossless invocation.
        args=calls[0]
        assert args[args.index('-ss')+1]=='1.000000000'
        assert '-copyts' not in args and '-af' not in args
        assert args[args.index('-f')+1]=='f32le'
    finally:
        process.settle_all()
        if decoder:await _settle_connection(connection,decoder,process)
        else:await connection.cleanup()
