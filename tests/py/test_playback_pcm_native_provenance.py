"""N3.P1 synthetic-unit-only retained WAV / PCM provenance contracts.

No real FFmpeg is launched. Diagnostics are constructed test stimuli, NOT captured
binary output. Ordered fake pipes do not qualify real concurrent pipe scheduling.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import fields, FrozenInstanceError, replace
import os
import stat
import struct
from uuid import UUID
import wave
import zlib

import pytest
from music_app.services import playback_pcm as pcm_owner
from music_app.services import playback_pcm_fd_capability as capability
from music_app.services import playback_pcm_wave_source as wave_owner
from music_app.services.playback_pcm import PcmDecoderProcess, PcmOpenCommand
from tests.py.test_playback_pcm import FakeProcess, FragmentingStream, factory_for

EXTENT = 196619
ORIGIN = 123456
OBS_FIELDS = {'source_id', 'generation', 'stream_id', 'revision', 'source_rate_hz',
    'decoded_rate_hz', 'source_origin_frame', 'source_extent_frames', 'decoded_extent_frames',
    'emitted_frames', 'qualified_emitted_frames', 'decoder_complete'}
RANGE_FIELDS = {'chunk_offset_frames', 'decoded_start_frame', 'source_start_frame', 'frames'}


def samples(frame):
    # Independent two-channel integer index encoding, unique over this finite corpus.
    return frame % 65536 - 32768, frame // 65536 - 32768


def float_pcm(start, count):
    return b''.join(struct.pack('<ff', *(value / 32768 for value in samples(i)))
                    for i in range(start, start + count))


def make_wave(path, *, frames=EXTENT, rate=44100, bits=16):
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(2); output.setsampwidth(bits // 8); output.setframerate(rate)
        output.writeframes(b''.join((value << (bits - 16)).to_bytes(bits // 8, 'little', signed=True)
            for i in range(frames) for value in samples(i)))
    return path


def header(rate=44100, bits=16, bitrate='1411'):
    fmt = {16: 's16', 24: 's32 (24 bit)', 32: 's32'}[bits]
    return ("Input #0, wav, from 'fd:':\n"
        f'  Stream #0:0: Audio: pcm_s{bits}le, {rate} Hz, stereo, {fmt}, {bitrate} kb/s\n'
        f'  Stream #0:0 -> #0:0 (pcm_s{bits}le (native) -> pcm_f32le (native))\n').encode()


def descriptor(data, *, pts=ORIGIN, n=0, rate=44100):
    checksum = zlib.adler32(data, 0) & 0xffffffff
    return (f'[Parsed_ashowinfo_2 @ 0x123] n:{n} pts:{pts} pts_time:0.0 '
        f'fmt:flt channels:2 chlayout:stereo rate:{rate} nb_samples:{len(data)//8} '
        f'checksum:{checksum:08X} plane_checksums: [ {checksum:08X} ]\n').encode()


def command(path, start=ORIGIN, rate=44100):
    # Deliberately false provisional duration cannot become native source extent.
    return PcmOpenCommand(7, 41, 'current', path, start, rate, 999,
        capture_local_coordinates=True, capture_absolute_coordinates=True)


def assert_retained(calls, path):
    args, kwargs = calls[0]
    # PRIMARY baseline RED: this existing observable fails before future fields/accessors.
    assert args[args.index('-i') + 1] == 'fd:', 'native44100 must retain the qualified file, not reopen its pathname'
    source = kwargs['stdin']
    assert source is not asyncio.subprocess.DEVNULL
    assert stat.S_ISREG(os.fstat(source.fileno()).st_mode)
    assert os.fstat(source.fileno()).st_ino == path.stat().st_ino
    assert source.tell() == 0
    raw = source.read(44); source.seek(0)
    assert raw[:4] == b'RIFF' and struct.unpack_from('<I', raw, 24)[0] == 44100
    return source


@asynccontextmanager
async def launched(path, monkeypatch, process, *, start=ORIGIN, rate=44100, release=None):
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: True)
    calls = []
    decoder = await PcmDecoderProcess.start(command(path, start, rate), ffmpeg_executable='synthetic-unit-ffmpeg',
        process_factory=factory_for(process, calls))
    try:
        yield decoder, calls
    finally:
        decoder.request_cancel()
        if release is not None: release()
        await decoder.cancel()
        assert decoder.cleanup_complete
        assert process.wait_calls == 1
        source = calls[0][1]['stdin']
        if hasattr(source, 'closed'): assert source.closed


async def read(decoder, count):
    decoder.grant_credit(count)
    return await decoder.read_credited_frames(max_frames=count)


def assert_unknown(decoder, chunk=None):
    assert decoder.native_observation_snapshot() is None
    assert decoder.absolute_metadata is None
    assert decoder.metadata.capture_coordinate_basis == 'unknown'
    if chunk is not None:
        assert chunk.native_observation is None and chunk.native_ranges == ()
        assert chunk.verified_absolute_ranges == ()


def assert_observation(decoder, chunk, *, origin=ORIGIN, extent=EXTENT, emitted, qualified):
    observation = chunk.native_observation
    assert {field.name for field in fields(observation)} == OBS_FIELDS
    identity = UUID(observation.source_id)
    assert identity.version == 4 and identity.int and str(identity) == observation.source_id
    assert observation.generation == 7 and observation.stream_id == 41
    assert observation.source_rate_hz == observation.decoded_rate_hz == 44100
    assert observation.source_origin_frame == origin and observation.source_extent_frames == extent
    assert observation.emitted_frames == emitted and observation.qualified_emitted_frames == qualified
    assert observation.decoder_complete is False and observation.decoded_extent_frames is None
    assert decoder.native_observation_snapshot() is observation
    assert decoder.native_observation_is_current(observation)
    assert not decoder.native_observation_is_current(replace(observation))
    for name in OBS_FIELDS - {'source_id', 'decoder_complete', 'decoded_extent_frames'}:
        value = getattr(observation, name)
        assert type(value) is int and 0 <= value <= 2**53 - 1
    assert observation.revision > 0
    assert decoder.absolute_metadata is None and chunk.verified_absolute_ranges == ()
    assert decoder.metadata.capture_source_base48 is None
    with pytest.raises(FrozenInstanceError): observation.emitted_frames = 0
    return observation


@pytest.mark.asyncio
@pytest.mark.parametrize('start,seek', [(0, '0.000000000'), (123456, '2.799455782'), (196618, '4.458458050')], ids=["start,seek=(0, '0.000000000')", "start,seek=(123456, '2.799455782')", "start,seek=(196618, '4.458458050')"])
async def test_p1_01_02_retained_native_invocation_has_no_rate_conversion(tmp_path, monkeypatch, start, seek):
    path = make_wave(tmp_path/'native.wav')
    async with launched(path, monkeypatch, FakeProcess(), start=start) as (decoder, calls):
        source = assert_retained(calls, path)
        assert calls[0][0] == ('synthetic-unit-ffmpeg', '-hide_banner', '-loglevel', 'info', '-copyts', '-nostdin',
            '-ss', seek, '-i', 'fd:', '-vn', '-af', 'aformat=sample_fmts=flt,asettb=expr=1/44100,ashowinfo',
            '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1')
        assert calls[0][1]['stdout'] is asyncio.subprocess.PIPE and calls[0][1]['stderr'] is asyncio.subprocess.PIPE
        assert 'creationflags' in calls[0][1] and not source.closed
        assert decoder.native_observation_snapshot() is None


@pytest.mark.asyncio
@pytest.mark.parametrize('start', [0, 123456, 196618], ids=['start=0', 'start=123456', 'start=196618'])
async def test_p1_03_native_observed_origin_and_distinct_complete_extents(tmp_path, monkeypatch, start):
    path = make_wave(tmp_path/'native.wav'); count = EXTENT - start
    data = float_pcm(start, count)
    pieces = [data[offset:offset+16384*8] for offset in range(0, len(data), 16384*8)]
    stderr = header() + b''.join(descriptor(piece, pts=start + index*16384, n=index) for index, piece in enumerate(pieces))
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=stderr), start=start) as (decoder, calls):
        source = assert_retained(calls, path)
        await decoder._stderr_task  # Deliberate synthetic ordering, NOT real pipe qualification.
        emitted = 0; previous = None
        for piece in pieces:
            chunk = await read(decoder, len(piece)//8)
            assert chunk.pcm == piece
            emitted += chunk.frame_count
            observation = assert_observation(decoder, chunk, origin=start, emitted=emitted, qualified=emitted)
            if previous is not None:
                assert observation.source_id == previous.source_id and observation.revision > previous.revision
                assert not decoder.native_observation_is_current(previous)
            assert len(chunk.native_ranges) == 1
            item = chunk.native_ranges[0]
            assert {field.name for field in fields(item)} == RANGE_FIELDS
            assert all(type(getattr(item, name)) is int for name in RANGE_FIELDS)
            assert (item.chunk_offset_frames, item.decoded_start_frame, item.source_start_frame, item.frames) == (
                0, emitted-chunk.frame_count, start+emitted-chunk.frame_count, chunk.frame_count)
            with pytest.raises(FrozenInstanceError): item.frames = 0
            previous = observation
        assert (await read(decoder, 1)).pcm == b''
        terminal = decoder.native_observation_snapshot()
        assert terminal.decoder_complete is True and terminal.decoded_extent_frames == count
        assert terminal.source_extent_frames == EXTENT
        assert terminal.source_origin_frame + terminal.decoded_extent_frames == EXTENT
        assert terminal.emitted_frames == terminal.qualified_emitted_frames == count
        assert decoder.metadata.capture_extent_frames48 is None and decoder.absolute_metadata is None
        assert terminal.revision > previous.revision and not decoder.native_observation_is_current(previous)
        assert decoder.native_observation_is_current(terminal) and source.closed
        decoder.request_cancel()
        assert decoder.native_observation_snapshot() is None
        assert not decoder.native_observation_is_current(terminal)


@pytest.mark.asyncio
@pytest.mark.parametrize('bitrate', ['1411', '1411.2'], ids=['bitrate=1411', 'bitrate=1411.2'])
async def test_p1_04_rounded_diagnostic_bitrate_is_not_rate_authority(tmp_path, monkeypatch, bitrate):
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=header(bitrate=bitrate)+descriptor(data, pts=0)), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        chunk = await read(decoder, 4)
        assert_observation(decoder, chunk, origin=0, extent=4, emitted=4, qualified=4)


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['wrong_origin', 'wrong_rate', 'wrong_sequence', 'wrong_count', 'planar', 'mono',
    'checksum', 'metadata_prefix', 'negative_pts', 'unsafe_pts', 'extent_overrun', 'missing_header'], ids=['fault=wrong_origin', 'fault=wrong_rate', 'fault=wrong_sequence', 'fault=wrong_count', 'fault=planar', 'fault=mono', 'fault=checksum', 'fault=metadata_prefix', 'fault=negative_pts', 'fault=unsafe_pts', 'fault=extent_overrun', 'fault=missing_header'])
async def test_p1_04_invalid_proof_is_irrevocable_but_pcm_is_unchanged(tmp_path, monkeypatch, fault):
    path = make_wave(tmp_path/'native.wav'); data = float_pcm(ORIGIN, 4)
    row = descriptor(data)
    if fault == 'wrong_origin': row = descriptor(data, pts=ORIGIN-1)
    elif fault == 'wrong_rate': row = descriptor(data, rate=48000)
    elif fault == 'wrong_sequence': row = descriptor(data, n=1)
    elif fault == 'wrong_count': row = row.replace(b'nb_samples:4', b'nb_samples:0')
    elif fault == 'planar': row = row.replace(b'fmt:flt ', b'fmt:fltp ')
    elif fault == 'mono': row = row.replace(b'channels:2 chlayout:stereo', b'channels:1 chlayout:mono')
    elif fault == 'checksum': row = descriptor(bytes(32))
    elif fault == 'metadata_prefix': row = b'    comment: ' + row
    elif fault == 'negative_pts': row = descriptor(data, pts=-1)
    elif fault == 'unsafe_pts': row = descriptor(data, pts=2**53-1)
    elif fault == 'extent_overrun': row = descriptor(data, pts=EXTENT-1)
    prefix = b'' if fault == 'missing_header' else header()
    # A later valid descriptor cannot repair a failed first observation.
    stderr = prefix + row + descriptor(data, pts=ORIGIN+(3 if fault == 'wrong_origin' else 4), n=1)
    async with launched(path, monkeypatch, FakeProcess(stdout=data*2, stderr=stderr)) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        for _ in range(2):
            chunk = await read(decoder, 4); assert chunk.pcm == data; assert_unknown(decoder, chunk)
        await read(decoder, 1); assert_unknown(decoder)


@pytest.mark.asyncio
async def test_p1_05_checksum_split_never_retroactively_qualifies_sent_prefix(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=header()+descriptor(data, pts=0)), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        first = await read(decoder, 2); assert first.pcm == data[:16]; assert_unknown(decoder, first)
        second = await read(decoder, 2); assert second.pcm == data[16:]
        observation = assert_observation(decoder, second, origin=0, extent=4, emitted=4, qualified=2)
        assert [(r.chunk_offset_frames, r.decoded_start_frame, r.source_start_frame, r.frames) for r in second.native_ranges] == [(0, 2, 2, 2)]
        await read(decoder, 1); terminal = decoder.native_observation_snapshot()
        assert terminal.decoder_complete and terminal.decoded_extent_frames == 4
        assert terminal.emitted_frames == 4 and terminal.qualified_emitted_frames == 2
        assert not decoder.native_observation_is_current(observation)
        assert first.native_observation is None and first.native_ranges == ()


@pytest.mark.asyncio
async def test_p1_05_late_descriptor_never_waits_or_requalifies_consumed_pcm(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=8); data = float_pcm(0, 8)
    process = FakeProcess(stdout=data); process.stderr = asyncio.StreamReader()
    async with launched(path, monkeypatch, process, start=0, release=process.stderr.feed_eof) as (decoder, calls):
        assert_retained(calls, path)
        first = await asyncio.wait_for(read(decoder, 4), 1)
        assert first.pcm == data[:32]; assert_unknown(decoder, first)
        assert not decoder._stderr_task.done(), 'PCM returned while test-owned diagnostic pipe is still pending'
        process.stderr.feed_data(header()+descriptor(data[:32], pts=0)+descriptor(data[32:], pts=4, n=1))
        process.stderr.feed_eof(); await decoder._stderr_task
        second = await read(decoder, 4); assert second.pcm == data[32:]; assert_unknown(decoder, second)
        await read(decoder, 1); assert_unknown(decoder)


def change_stamp(path):
    before = path.stat()
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns + 1000000))


@pytest.mark.asyncio
@pytest.mark.parametrize('when', ['after_launch', 'inside_pcm_read', 'snapshot_access', 'before_terminal',
    pytest.param('path_replacement', marks=pytest.mark.skipif(os.name == 'nt',
        reason='POSIX retained-open inode replacement witness; Windows sharing may forbid replacement'))], ids=['when=after_launch', 'when=inside_pcm_read', 'when=snapshot_access', 'when=before_terminal', 'when=path_replacement'])
async def test_p1_06_source_changes_irrevocably_retire_snapshot_and_new_ranges(tmp_path, monkeypatch, when):
    path = make_wave(tmp_path/'small.wav', frames=8); data = float_pcm(0, 8)
    process = FakeProcess(stdout=data, stderr=header()+descriptor(data[:32], pts=0)+descriptor(data[32:], pts=4, n=1))
    async with launched(path, monkeypatch, process, start=0) as (decoder, calls):
        source = assert_retained(calls, path); await decoder._stderr_task
        previous = None
        if when in ('snapshot_access', 'before_terminal'):
            count = 8 if when == 'before_terminal' else 4
            previous = (await read(decoder, count)).native_observation
            assert previous is not None and decoder.native_observation_is_current(previous)
        if when == 'inside_pcm_read':
            original = process.stdout.read
            async def mutating_read(size):
                result = await original(size); change_stamp(path); return result
            monkeypatch.setattr(process.stdout, 'read', mutating_read)
        elif when == 'path_replacement':
            retained_inode = os.fstat(source.fileno()).st_ino
            replacement = make_wave(tmp_path/'replacement.wav', frames=8)
            os.replace(replacement, path)
            assert os.fstat(source.fileno()).st_ino == retained_inode != path.stat().st_ino
        else: change_stamp(path)
        if when == 'snapshot_access': assert decoder.native_observation_snapshot() is None
        remaining = 0 if when == 'before_terminal' else 4 if previous is not None else 8
        if remaining:
            chunk = await read(decoder, remaining)
            assert chunk.pcm == data[-remaining*8:]; assert_unknown(decoder, chunk)
        await read(decoder, 1); assert_unknown(decoder)
        if previous is not None: assert not decoder.native_observation_is_current(previous)


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['width24', 'width32', 'rate48000', 'mono', 'metadata_chunk', 'truncated',
    'partial_frame', 'bad_byte_rate', 'float_format', 'newline_path', 'directory'], ids=['fault=width24', 'fault=width32', 'fault=rate48000', 'fault=mono', 'fault=metadata_chunk', 'fault=truncated', 'fault=partial_frame', 'fault=bad_byte_rate', 'fault=float_format', 'fault=newline_path', 'fault=directory'])
async def test_p1_07_unsupported_native_profile_never_creates44100_proof(tmp_path, monkeypatch, fault):
    path = make_wave(tmp_path/'bad.wav', frames=8,
        rate=48000 if fault == 'rate48000' else 44100,
        bits=24 if fault == 'width24' else 32 if fault == 'width32' else 16)
    raw = bytearray(path.read_bytes())
    if fault == 'mono': raw[22:24] = struct.pack('<H', 1)
    elif fault == 'metadata_chunk': raw += b'LIST\0\0\0\0'
    elif fault == 'truncated': raw = raw[:-1]
    elif fault == 'partial_frame':
        raw = raw[:-1]; raw[4:8] = struct.pack('<I', len(raw)-8); raw[40:44] = struct.pack('<I', len(raw)-44)
    elif fault == 'bad_byte_rate': raw[28:32] = struct.pack('<I', 192000)
    elif fault == 'float_format': raw[20:22] = struct.pack('<H', 3)
    path.write_bytes(raw)
    # Unsafe path is an input to validation; never create an OS-invalid Windows filename.
    if fault == 'newline_path': path = tmp_path/'bad\n.wav'
    if fault == 'directory': path.unlink(); path.mkdir()
    process = FakeProcess(stdout=float_pcm(0, 4), stderr=header()+descriptor(float_pcm(0, 4), pts=0))
    async with launched(path, monkeypatch, process, start=0) as (decoder, calls):
        assert calls[0][0][calls[0][0].index('-i')+1] == str(path)
        assert calls[0][1]['stdin'] is asyncio.subprocess.DEVNULL
        chunk = await read(decoder, 4); assert chunk.pcm == float_pcm(0, 4)
        # Legacy absence is unknown too; positive lane cases independently require new fields.
        assert getattr(chunk, 'native_observation', None) is None
        assert getattr(chunk, 'native_ranges', ()) == ()
        assert decoder.absolute_metadata is None and chunk.verified_absolute_ranges == ()


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['no_descriptors', 'incomplete_descriptor', 'short_endpoint'], ids=['fault=no_descriptors', 'fault=incomplete_descriptor', 'fault=short_endpoint'])
async def test_p1_08_clean_child_alone_cannot_publish_terminal_proof(tmp_path, monkeypatch, fault):
    path = make_wave(tmp_path/'small.wav', frames=8); data = float_pcm(0, 4)
    row = b'' if fault == 'no_descriptors' else descriptor(data*2 if fault == 'incomplete_descriptor' else data, pts=0)
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=header()+row), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        chunk = await read(decoder, 4); assert chunk.pcm == data
        old = chunk.native_observation
        assert (await read(decoder, 1)).pcm == b''
        assert_unknown(decoder)
        if old is not None: assert not decoder.native_observation_is_current(old)


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['partial_pcm', 'child_exit'], ids=['fault=partial_pcm', 'fault=child_exit'])
async def test_p1_08_playback_failures_still_raise_original_errors_without_success_chunk(tmp_path, monkeypatch, fault):
    path = make_wave(tmp_path/'small.wav', frames=8); data = float_pcm(0, 4)
    process = FakeProcess(stdout=data + (b'partial' if fault == 'partial_pcm' else b''),
        stderr=header()+descriptor(data, pts=0), returncode=23 if fault == 'child_exit' else 0)
    async with launched(path, monkeypatch, process, start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        first = await read(decoder, 4); assert first.pcm == data
        previous = first.native_observation
        assert previous is not None and decoder.native_observation_is_current(previous)
        message = 'ffmpeg returned truncated partial PCM frame' if fault == 'partial_pcm' else 'ffmpeg exited with code 23'
        with pytest.raises(RuntimeError, match=message): await read(decoder, 4)
        assert decoder.emitted_frames == 4 and decoder.outstanding_credit_frames == 4
        assert_unknown(decoder)
        assert not decoder.native_observation_is_current(previous)


@pytest.mark.asyncio
@pytest.mark.parametrize('fault', ['line_limit', 'queue_limit', 'frame_limit', 'source_discontinuity'], ids=['fault=line_limit', 'fault=queue_limit', 'fault=frame_limit', 'fault=source_discontinuity'])
async def test_p1_09_bounded_observer_failures_never_recover(tmp_path, monkeypatch, fault):
    path = make_wave(tmp_path/'small.wav', frames=100); data = float_pcm(0, 4)
    if fault == 'line_limit': rows = b'x'*2049+b'\n'+descriptor(data, pts=0)
    elif fault == 'queue_limit': rows = b''.join(descriptor(float_pcm(i, 1), pts=i, n=i) for i in range(33))
    elif fault == 'frame_limit': rows = descriptor(data, pts=0).replace(b'nb_samples:4', b'nb_samples:16385')
    else: rows = descriptor(data, pts=0)+descriptor(data, pts=5, n=1)
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=header()+rows), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        chunk = await read(decoder, 4); assert chunk.pcm == data; assert_unknown(decoder, chunk)


@pytest.mark.asyncio
async def test_p1_09_fragmented_stderr_and_pcm_preserve_exact_current_chunk_ranges(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    process = FakeProcess()
    process.stderr = FragmentingStream(*(bytes([value]) for value in header()+descriptor(data, pts=0)))
    process.stdout = FragmentingStream(data[:3], data[3:8], data[8:])
    async with launched(path, monkeypatch, process, start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        first = await read(decoder, 4); assert first.pcm == data[:8] and first.native_ranges == ()
        second = await read(decoder, 3); assert second.pcm == data[8:]
        assert_observation(decoder, second, origin=0, extent=4, emitted=4, qualified=3)
        assert [(r.chunk_offset_frames, r.decoded_start_frame, r.source_start_frame, r.frames) for r in second.native_ranges] == [(0, 1, 1, 3)]
        assert max(process.stderr.read_sizes) <= 8192 and max(process.stdout.read_sizes) <= 131072


@pytest.mark.asyncio
async def test_p1_10_cancelled_owner_invalidates_issued_native_snapshot(tmp_path, monkeypatch):
    close_calls = []
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    process = FakeProcess(stdout=data, stderr=header()+descriptor(data, pts=0))
    async with launched(path, monkeypatch, process, start=0) as (decoder, calls):
        source = assert_retained(calls, path); await decoder._stderr_task
        original_close = source.close
        def counted_close(): close_calls.append(True); return original_close()
        monkeypatch.setattr(source, 'close', counted_close)
        chunk = await read(decoder, 4); snapshot = chunk.native_observation
        assert snapshot is not None and decoder.native_observation_is_current(snapshot)
        decoder.request_cancel()
        assert decoder.native_observation_snapshot() is None and not decoder.native_observation_is_current(snapshot)
        with pytest.raises(RuntimeError, match='PCM decoder was cancelled'): await read(decoder, 1)
        await decoder.cancel(); assert source.closed and decoder.cleanup_complete
        assert snapshot.decoder_complete is False
    assert close_calls == [True], 'Repeated cancellation closes the exact retained FD once'


@pytest.mark.asyncio
async def test_p1_10_cancel_before_launch_never_creates_child(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4)
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: True)
    calls = []; owners = []; process = FakeProcess()
    def admitted(owner):
        owners.append(owner); owner.request_cancel()
    try:
        with pytest.raises(asyncio.CancelledError):
            await PcmDecoderProcess.start(command(path, 0), ffmpeg_executable='synthetic-unit-ffmpeg',
                process_factory=factory_for(process, calls), on_start=admitted)
        assert len(owners) == 1 and calls == []
    finally:
        for owner in owners: await owner.cancel()
    assert owners[0].cleanup_complete


@pytest.mark.asyncio
async def test_p1_10_cancel_during_retained_launch_keeps_exact_owner_until_child_settles(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4)
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: True)
    monkeypatch.setattr(pcm_owner, '_CLEANUP_JOIN_SECONDS', 0.01)
    entered = asyncio.Event(); release = asyncio.Event(); calls = []; owners = []; process = FakeProcess()
    async def factory(*args, **kwargs):
        calls.append((args, kwargs)); entered.set(); await release.wait(); return process
    task = asyncio.create_task(PcmDecoderProcess.start(command(path, 0), ffmpeg_executable='synthetic-unit-ffmpeg',
        process_factory=factory, on_start=owners.append))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        source = assert_retained(calls, path); owner = owners[0]
        owner.request_cancel()
        with pytest.raises(RuntimeError, match='cleanup unresolved'): await owner.cancel()
        assert not owner.cleanup_complete and not source.closed
        assert len(calls) == 1 and process.wait_calls == 0
        release.set()
        with pytest.raises(RuntimeError, match='PCM decoder was cancelled'): await task
        await owner.wait_closed()
        assert owner.cleanup_complete and source.closed and process.wait_calls == 1
        assert owner.native_observation_snapshot() is None
    finally:
        for owner in owners: owner.request_cancel()
        release.set()
        # The actual start is observed even if the primary retained-FD assertion failed.
        results = await asyncio.gather(task, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException) and not (isinstance(result, RuntimeError) and str(result) == 'PCM decoder was cancelled'):
                raise result
        for owner in owners: await owner.wait_closed()


@pytest.mark.asyncio
async def test_p1_08_eof_timeout_keeps_original_error_and_retained_cleanup(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4)
    monkeypatch.setattr(pcm_owner, '_EOF_SETTLEMENT_SECONDS', 0.01)
    process = FakeProcess(); process.stderr = asyncio.StreamReader()
    async with launched(path, monkeypatch, process, start=0, release=process.stderr.feed_eof) as (decoder, calls):
        assert_retained(calls, path)
        with pytest.raises(RuntimeError, match='ffmpeg EOF settlement timed out'): await read(decoder, 1)
        assert decoder.emitted_frames == 0 and decoder.native_observation_snapshot() is None
        assert process.wait_calls == 1
        process.stderr.feed_eof()


@pytest.mark.asyncio
@pytest.mark.parametrize('bits', [16, 24, 32], ids=['bits=16', 'bits=24', 'bits=32'])
async def test_p1_11_native48_argv_metadata_ranges_and_terminal_extent_remain_exact(tmp_path, monkeypatch, bits):
    path = make_wave(tmp_path/'legacy.wav', rate=48000, bits=bits)
    data = float_pcm(ORIGIN, EXTENT-ORIGIN)
    pieces = [data[offset:offset+16384*8] for offset in range(0, len(data), 16384*8)]
    stderr = header(48000, bits, str(96*bits)) + b''.join(
        descriptor(piece, pts=ORIGIN+index*16384, n=index, rate=48000) for index, piece in enumerate(pieces))
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=stderr), rate=48000) as (decoder, calls):
        assert calls[0][0] == ('synthetic-unit-ffmpeg', '-hide_banner', '-loglevel', 'info', '-copyts', '-nostdin',
            '-ss', '2.572000000', '-i', 'fd:', '-vn', '-af',
            'aformat=sample_fmts=flt:sample_rates=48000:channel_layouts=stereo,asettb=expr=1/48000,ashowinfo',
            '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '2', '-ar', '48000', 'pipe:1')
        source = calls[0][1]['stdin']; assert source.qualification_bits == bits
        await decoder._stderr_task; emitted = 0
        for piece in pieces:
            chunk = await read(decoder, len(piece)//8)
            assert chunk.pcm == piece
            assert chunk.verified_absolute_ranges == ((0, ORIGIN+emitted, len(piece)//8),)
            assert getattr(chunk, 'native_observation', None) is None and getattr(chunk, 'native_ranges', ()) == ()
            emitted += chunk.frame_count
        await read(decoder, 1)
        assert decoder.absolute_metadata.capture_coordinate_basis == 'decoded-output-absolute-wav48'
        assert decoder.absolute_metadata.capture_extent_frames48 == EXTENT
        assert decoder.metadata.capture_extent_frames48 == EXTENT-ORIGIN
        assert decoder.metadata.capture_coordinate_basis == 'decoded-output-local'
        assert source.closed


def test_p1_11_default_wave_qualifier_does_not_silently_change_legacy_profile(tmp_path):
    path = make_wave(tmp_path/'native.wav', frames=4)
    assert wave_owner.open_qualified_wave(path) is None
    for bits in (16, 24, 32):
        legacy = make_wave(tmp_path/f'legacy{bits}.wav', frames=4, rate=48000, bits=bits)
        source = wave_owner.open_qualified_wave(legacy)
        try:
            assert source is not None and source.qualification_bits == bits and source.qualification_frames == 4
        finally:
            if source is not None: source.close()


@pytest.mark.asyncio
async def test_p1_10_cancel_during_read_retains_original_cancel_and_reaps_owned_child(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4)
    process = FakeProcess(); process.stdout = asyncio.StreamReader()
    entered = asyncio.Event(); original = process.stdout.read
    async def observed_read(size):
        entered.set(); return await original(size)
    monkeypatch.setattr(process.stdout, 'read', observed_read)
    pending = None
    async with launched(path, monkeypatch, process, start=0, release=process.stdout.feed_eof) as (decoder, calls):
        try:
            source = assert_retained(calls, path)
            pending = asyncio.create_task(read(decoder, 4))
            await asyncio.wait_for(entered.wait(), 1)
            decoder.request_cancel()
            with pytest.raises(asyncio.CancelledError): await pending
            assert decoder.native_observation_snapshot() is None
            process.stdout.feed_eof(); await decoder.cancel()
            assert source.closed and decoder.cleanup_complete and process.wait_calls == 1
        finally:
            decoder.request_cancel(); process.stdout.feed_eof()
            if pending is not None:
                results = await asyncio.gather(pending, return_exceptions=True)
                for result in results:
                    if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError): raise result


@pytest.mark.asyncio
async def test_p1_06_header_read_stamp_change_cannot_qualify_fallback(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    original_open = open; intercepted = []
    class MutatingRead:
        def __init__(self, source): self.source = source
        def __getattr__(self, name): return getattr(self.source, name)
        def read(self, count):
            result = self.source.read(count)
            if count == 44:
                intercepted.append(count); change_stamp(path)
            return result
    def opening(*args, **kwargs): return MutatingRead(original_open(*args, **kwargs))
    monkeypatch.setattr(wave_owner, 'open', opening, raising=False)
    async with launched(path, monkeypatch, FakeProcess(stdout=data), start=0) as (decoder, calls):
        assert intercepted == [44], 'Actual native qualification must read the same retained file header'
        assert calls[0][0][calls[0][0].index('-i')+1] == str(path)
        assert calls[0][1]['stdin'] is asyncio.subprocess.DEVNULL
        chunk = await read(decoder, 4); assert chunk.pcm == data
        assert getattr(chunk, 'native_observation', None) is None and getattr(chunk, 'native_ranges', ()) == ()


@pytest.mark.asyncio
async def test_p1_07_missing_fd_capability_remains_unqualified_path_fallback(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4); data = float_pcm(0, 4)
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: False)
    process = FakeProcess(stdout=data); calls = []
    decoder = await PcmDecoderProcess.start(command(path, 0), ffmpeg_executable='synthetic-unit-ffmpeg',
        process_factory=factory_for(process, calls))
    try:
        assert calls[0][0][calls[0][0].index('-i')+1] == str(path)
        assert calls[0][1]['stdin'] is asyncio.subprocess.DEVNULL
        chunk = await read(decoder, 4); assert chunk.pcm == data
        assert getattr(chunk, 'native_observation', None) is None and getattr(chunk, 'native_ranges', ()) == ()
    finally: await decoder.cancel()


@pytest.mark.asyncio
async def test_p1_09_exact_descriptor_queue_capacity_remains_qualified(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=32); data = float_pcm(0, 32)
    stderr = header() + b''.join(descriptor(data[i*8:(i+1)*8], pts=i, n=i) for i in range(32))
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=stderr), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        chunk = await read(decoder, 32); assert chunk.pcm == data
        assert_observation(decoder, chunk, origin=0, extent=32, emitted=32, qualified=32)
        assert len(chunk.native_ranges) == 32
        assert [(r.chunk_offset_frames, r.decoded_start_frame, r.source_start_frame, r.frames) for r in chunk.native_ranges] == [(i, i, i, 1) for i in range(32)]


@pytest.mark.asyncio
async def test_p1_10_launch_error_preserves_exception_and_closes_retained_fd(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=4); owners = []; calls = []
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: True)
    failure = OSError('synthetic factory launch failed')
    async def factory(*args, **kwargs): calls.append((args, kwargs)); raise failure
    try:
        with pytest.raises(OSError) as caught:
            await PcmDecoderProcess.start(command(path, 0), ffmpeg_executable='synthetic-unit-ffmpeg',
                process_factory=factory, on_start=owners.append)
        assert caught.value is failure
        assert calls[0][0][calls[0][0].index('-i')+1] == 'fd:'
        assert calls[0][1]['stdin'].closed
        assert owners[0].native_observation_snapshot() is None
    finally:
        # Existing failed-launch owner is intentionally unresolved, not a fake successful cleanup.
        for owner in owners:
            with pytest.raises(RuntimeError, match='launch failed without settlement|remains unavailable'):
                await owner.cancel()
            assert not owner.cleanup_complete


@pytest.mark.asyncio
async def test_p1_05_known_origin_snapshot_advances_without_qualifying_incomplete_chunk(tmp_path, monkeypatch):
    path = make_wave(tmp_path/'small.wav', frames=6); data = float_pcm(0, 6)
    stderr = header()+descriptor(data[:16], pts=0)+descriptor(data[16:], pts=2, n=1)
    async with launched(path, monkeypatch, FakeProcess(stdout=data, stderr=stderr), start=0) as (decoder, calls):
        assert_retained(calls, path); await decoder._stderr_task
        first = await read(decoder, 2)
        first_observation = assert_observation(decoder, first, origin=0, extent=6, emitted=2, qualified=2)
        middle = await read(decoder, 2); assert middle.pcm == data[16:32] and middle.native_ranges == ()
        middle_observation = assert_observation(decoder, middle, origin=0, extent=6, emitted=4, qualified=2)
        assert middle_observation.revision > first_observation.revision
        assert not decoder.native_observation_is_current(first_observation)
        last = await read(decoder, 2); assert last.pcm == data[32:]
        assert_observation(decoder, last, origin=0, extent=6, emitted=6, qualified=4)
        assert [(r.chunk_offset_frames, r.decoded_start_frame, r.source_start_frame, r.frames) for r in last.native_ranges] == [(0, 4, 4, 2)]
        await read(decoder, 1); terminal = decoder.native_observation_snapshot()
        assert terminal.decoder_complete is True and terminal.decoded_extent_frames == 6
        assert terminal.qualified_emitted_frames == 4


@pytest.mark.asyncio
@pytest.mark.parametrize('fault_kind', ['exception', 'cancellation'])
async def test_p1_12_stderr_drain_fault_immediately_retires_issued_and_queued_native_proof(tmp_path, monkeypatch, fault_kind):
    """Synthetic pipe faults only; queued checksums do not survive diagnostic loss."""
    path = make_wave(tmp_path/'drain-fault.wav', frames=8)
    first, second = float_pcm(0, 4), float_pcm(4, 4)
    failure = OSError('exact owned diagnostic read failure')
    entered, release = asyncio.Event(), asyncio.Event()
    class FaultingDiagnosticPipe:
        def __init__(self): self.reads = 0
        async def read(self, size):
            self.reads += 1
            if self.reads == 1:
                return header() + descriptor(first, pts=0, n=0) + descriptor(second, pts=4, n=1)
            entered.set()
            await release.wait()
            raise failure
    process = FakeProcess(stdout=first+second); process.stderr = FaultingDiagnosticPipe()
    monkeypatch.setattr(capability, 'fd_capture_ready', lambda executable: True)
    decoder = None; calls = []; errors = []; source = None
    try:
        decoder = await PcmDecoderProcess.start(command(path, 0), ffmpeg_executable='synthetic-unit-ffmpeg',
            process_factory=factory_for(process, calls))
        source = assert_retained(calls, path)
        await asyncio.wait_for(entered.wait(), 1)
        chunk = await read(decoder, 4)
        assert chunk.pcm == first and len(chunk.native_ranges) == 1
        issued = assert_observation(decoder, chunk, origin=0, extent=8, emitted=4, qualified=4)
        assert process.stderr.reads == 2 and not decoder._stderr_task.done()
        if fault_kind == 'cancellation': decoder._stderr_task.cancel()
        else: release.set()
        if fault_kind == 'exception':
            with pytest.raises(OSError) as raised: await decoder._stderr_task
            assert raised.value is failure
        else:
            with pytest.raises(asyncio.CancelledError): await decoder._stderr_task
        # First r1 behavioral RED: a genuinely issued snapshot cannot stay current
        # merely because another complete checksum descriptor is already queued.
        assert decoder.native_observation_snapshot() is None
        assert not decoder.native_observation_is_current(issued)
        next_chunk = await read(decoder, 4)
        assert next_chunk.pcm == second and next_chunk.frame_count == 4
        assert_unknown(decoder, next_chunk)
        assert issued.emitted_frames == issued.qualified_emitted_frames == 4
        assert issued.decoder_complete is False
        if fault_kind == 'exception':
            with pytest.raises(OSError) as raised: await read(decoder, 1)
            assert raised.value is failure
        else:
            with pytest.raises(asyncio.CancelledError): await read(decoder, 1)
        assert decoder.native_observation_snapshot() is None
        assert not decoder.native_observation_is_current(issued)
    except BaseException as error:
        errors.append(error)
    finally:
        if decoder is not None:
            # Release only this fixture's held pipe gate, then retain all unexpected
            # action/cleanup outcomes. A faulted drain is deliberately NOT clean.
            decoder.request_cancel()
            if fault_kind == 'cancellation' and not decoder._stderr_task.done(): decoder._stderr_task.cancel()
            release.set()
            results = await asyncio.gather(decoder._stderr_task, return_exceptions=True)
            result = results[0]
            expected = result is failure if fault_kind == 'exception' else isinstance(result, asyncio.CancelledError)
            if not expected: errors.append(AssertionError(f'Unexpected owned drain settlement: {result!r}'))
            try:
                with pytest.raises(RuntimeError, match='^ffmpeg cleanup unresolved; decoder remains unavailable$'):
                    await decoder.cancel()
                with pytest.raises(RuntimeError, match='^ffmpeg cleanup failed; decoder remains unavailable$'):
                    await decoder.wait_closed()
                assert not decoder.cleanup_complete
                assert process.wait_calls == 1 and process.returncode is not None
                assert decoder._stderr_task.done() and decoder._stdout_discard_task.done() and decoder._wait_task.done()
                if source is not None: assert source.closed
            except BaseException as error:
                errors.append(error)
        else:
            release.set()
    if len(errors) == 1: raise errors[0]
    if errors: raise BaseExceptionGroup('Native diagnostic fault action and cleanup outcomes', errors)
