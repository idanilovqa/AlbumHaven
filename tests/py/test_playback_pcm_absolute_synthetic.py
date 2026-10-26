"""Exact installed FFmpeg, generated native WAV only; no app or user data."""
import asyncio
import struct
import wave
import pytest
from music_app.services import playback_pcm_fd_capability as capability
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand

BINARY='/usr/bin/ffmpeg'


async def ready():
    if not capability.fd_capture_ready(BINARY):
        task=capability._state[1]
        done,_=await asyncio.wait({task},timeout=25)
        assert task in done, 'bounded capability task not settled'
    assert capability.fd_capture_ready(BINARY)


@pytest.mark.asyncio
async def test_actual_binary_capability_is_background_and_cached():
    capability._state=None
    assert capability.fd_capture_ready(BINARY) is False
    original=capability._state
    assert capability.fd_capture_ready(BINARY) is False
    assert capability._state is original
    await ready()
    assert capability._state is original
    assert capability._blocked_probe is None


@pytest.mark.asyncio
async def test_actual_same_open_wav_ranges_match_sample_labels(tmp_path):
    await ready()
    path=tmp_path/'generated-labels.wav'
    frames=192000
    with wave.open(str(path),'wb') as out:
        out.setnchannels(2);out.setsampwidth(2);out.setframerate(48000)
        out.writeframes(b''.join(struct.pack('<hh',i%60000-30000,i//60000+1) for i in range(frames)))
    command=PcmOpenCommand(7,41,'current',path,12001,48000,99,
        capture_local_coordinates=True,capture_absolute_coordinates=True)
    decoder=await PcmDecoderProcess.start(command,ffmpeg_executable=BINARY)
    pcm=[];observed=[];output=0
    try:
        for _ in range(300):
            decoder.grant_credit(8192)
            chunk=await decoder.read_credited_frames(max_frames=8192)
            if not chunk.frame_count:break
            pairs=list(struct.iter_unpack('<ff',chunk.pcm))
            labels=[(round(b*32768)-1)*60000+round(a*32768)+30000 for a,b in pairs]
            for offset,source,count in chunk.verified_absolute_ranges:
                assert labels[offset:offset+count]==list(range(source,source+count))
                observed.append((output+offset,source,count))
            pcm.extend(labels);output+=chunk.frame_count
        else:pytest.fail('synthetic decoder did not reach EOF within bounded chunks')
        assert observed, (getattr(decoder._absolute_observer, 'loss_reason', 'no observer'), decoder.stderr_tail)
        assert pcm==list(range(pcm[0],frames))
        assert decoder.absolute_metadata.capture_extent_frames48==frames
        assert decoder.absolute_metadata.authoritative_total_frames==frames
        assert decoder.metadata.capture_extent_frames48==len(pcm)
        assert decoder.metadata.capture_coordinate_basis=='decoded-output-local'
    finally:
        await decoder.cancel()
        await decoder.wait_closed()
        assert decoder.cleanup_complete
