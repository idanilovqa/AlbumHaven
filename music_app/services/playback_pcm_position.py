"""Bounded same-decoder PCM/sideband verifier, not an admission authority.

Only a separately qualified, timestamp-preserving packed f32le stereo
producer may feed these observers. Legacy *48 outputs stay native48000;
the explicitly selected native44100 observer uses rate-neutral coordinates. A returned interval describes bytes already
consumed, not audio rendered or permission to retroactively qualify old audio.
Caller owns the decoder identity and any admission-before-enqueue lifecycle.
"""
from collections import deque
from dataclasses import dataclass
import re
import zlib
from uuid import UUID

_MAX = 2**53 - 1
_LINE_LIMIT = 2048
_QUEUE_LIMIT = 32
_FRAME_LIMIT = 16384
_LINE_PATTERN = rb'^\[Parsed_ashowinfo_[0-9]+ @ [^\]\r\n]{1,64}\] n:([0-9]+) pts:(-?[0-9]+) pts_time:\S+ (?:pos:\S+ )?fmt:flt channels:2 chlayout:stereo rate:48000 nb_samples:([0-9]+) checksum:([0-9A-Fa-f]{1,8}) plane_checksums: \[\s*([0-9A-Fa-f]{1,8})\s*\]$'


@dataclass(frozen=True, slots=True)
class VerifiedPcmInterval:
    output_start48: int
    source_start48: int
    frames48: int


class _PcmPositionObserverCore:
    """Fail closed once, never wait for sideband and never retain PCM.

    Missing/late descriptors cause permanent loss rather than stalling audio.
    Call feed_stderr with arbitrary byte fragments, then consume_pcm in exact
    stdout order. Input chunks must be bounded by the existing caller. The only
    retained data is a bounded line and descriptor queue plus checksum counters.
    """
    def __init__(self, *, require_wav_header, wav_bits, source_frames, sample_rate, native=False):
        if type(wav_bits) is not int or wav_bits not in (16, 24, 32):
            raise ValueError('unsupported WAV sample width')
        if source_frames is not None and (type(source_frames) is not int
                or not 0 <= source_frames <= _MAX):
            raise ValueError('invalid native WAV frame extent')
        self.sample_rate = sample_rate
        self._require_wav_header = require_wav_header
        self._source_frames = source_frames
        self._descriptor_line = re.compile(_LINE_PATTERN.replace(b'rate:48000', b'rate:' + str(sample_rate).encode()))
        self._interval = _NativePcmInterval if native else VerifiedPcmInterval
        codec = f'pcm_s{wav_bits}le'.encode()
        sample_format = {16: rb's16', 24: rb's32 \(24 bit\)', 32: rb's32'}[wav_bits]
        self._wav_stream_line = re.compile(rb'  Stream #0:0: Audio: ' + codec
            + rb'(?: \([^\r\n]*\))?, ' + str(sample_rate).encode() + rb' Hz, stereo, ' + sample_format
            + rb', ' + (rb'[0-9]{1,6}(?:\.[0-9]{1,6})?' if native else str(96 * wav_bits).encode()) + rb' kb/s')
        self._wav_mapping_line = b'  Stream #0:0 -> #0:0 (' + codec + b' (native) -> pcm_f32le (native))'
        self._wav_demuxer = False
        self._wav_stream = False
        self._wav_mapping = False
        self._line = bytearray()
        self._queue = deque()
        self._next_n = 0
        self._next_source = None
        self._output_bytes = 0
        self._frame_bytes = 0
        self._checksum = 0
        self.loss_reason = None

    @property
    def source_end_frame(self):
        return self._next_source if self.available and not self._queue and not self._frame_bytes else None

    @property
    def available(self):
        return self.loss_reason is None

    def lose(self, reason):
        if self.available:
            self.loss_reason = reason
            self._line.clear()
            self._queue.clear()
            self._frame_bytes = 0
            self._checksum = 0

    def feed_stderr(self, chunk):
        if not self.available:
            return
        if type(chunk) is not bytes or len(chunk) > 8192:
            self.lose('invalid_stderr_chunk')
            return
        for value in chunk:
            if value == 10:
                line = bytes(self._line).rstrip(b'\r')
                self._line.clear()
                self._accept_line(line)
                if not self.available:
                    return
            else:
                if len(self._line) == _LINE_LIMIT:
                    self.lose('line_limit')
                    return
                self._line.append(value)

    def _accept_line(self, line):
        # Input qualification is complete at the first descriptor. FFmpeg then
        # prints its output stream header with the same stream number.
        if self._require_wav_header and self._next_n == 0:
            if line.startswith(b'Input #0, '):
                self._wav_demuxer = line.startswith(b"Input #0, wav, from '")
            if line.startswith(b'  Stream #0:0: Audio: '):
                self._wav_stream = self._wav_stream_line.fullmatch(line) is not None
            if line.startswith(b'  Stream #0:0 -> '):
                self._wav_mapping = line == self._wav_mapping_line
        if b'ashowinfo' not in line or b' n:' not in line:
            return
        if self._require_wav_header and not (self._wav_demuxer and self._wav_stream and self._wav_mapping):
            self.lose('unsupported_input')
            return
        match = self._descriptor_line.fullmatch(line)
        if match is None:
            self.lose('unsupported_descriptor')
            return
        # Digit lengths bounded before int conversion; PTS must be nonnegative.
        n, pts, count, checksum, plane = match.groups()
        if any(len(value) > 16 for value in (n, pts, count)):
            self.lose('integer_limit')
            return
        n, pts, count = int(n), int(pts), int(count)
        if (n != self._next_n or not 0 <= pts <= _MAX or not 0 < count <= _FRAME_LIMIT
                or pts + count > _MAX or int(checksum, 16) != int(plane, 16)
                or self._next_source is not None and pts != self._next_source):
            self.lose('descriptor_discontinuity')
            return
        if self._source_frames is not None and pts + count > self._source_frames:
            self.lose('source_extent_exceeded')
            return
        if len(self._queue) >= _QUEUE_LIMIT:
            self.lose('descriptor_queue_limit')
            return
        self._queue.append((pts, count, int(checksum, 16)))
        self._next_n += 1
        self._next_source = pts + count

    def consume_pcm(self, chunk):
        if not self.available:
            return ()
        if type(chunk) is not bytes or len(chunk) > 131072:
            self.lose('invalid_pcm_chunk')
            return ()
        verified = []
        offset = 0
        while offset < len(chunk):
            if not self._queue:
                self.lose('missing_or_late_descriptor')
                return ()
            pts, frames, expected = self._queue[0]
            amount = min(frames * 8 - self._frame_bytes, len(chunk) - offset)
            self._checksum = zlib.adler32(memoryview(chunk)[offset:offset + amount], self._checksum) & 0xffffffff
            self._frame_bytes += amount
            self._output_bytes += amount
            offset += amount
            if self._frame_bytes == frames * 8:
                if self._checksum != expected:
                    self.lose('checksum_mismatch')
                    return ()
                verified.append(self._interval(self._output_bytes // 8 - frames, pts, frames))
                self._queue.popleft()
                self._frame_bytes = 0
                self._checksum = 0
        return tuple(verified)

    def finish(self):
        if self.available and (self._line or self._queue or self._frame_bytes or not self._next_n):
            self.lose('incomplete_output')
        if (self.available and self._source_frames is not None
                and self._next_source != self._source_frames):
            self.lose('source_extent_mismatch')
        return self.available


class PcmPositionObserver(_PcmPositionObserverCore):
    """Legacy adapter: every returned *48 coordinate remains native48000."""
    def __init__(self, *, require_wav_header=False, wav_bits=16, source_frames48=None):
        super().__init__(require_wav_header=require_wav_header, wav_bits=wav_bits,
            source_frames=source_frames48, sample_rate=48000)

    @property
    def source_end48(self):
        return self.source_end_frame


@dataclass(frozen=True, slots=True)
class _NativePcmInterval:
    output_start_frame: int
    source_start_frame: int
    frames: int


class NativePcmPositionObserver(_PcmPositionObserverCore):
    """Same bounded checksum owner, with native units and an observed origin."""
    def __init__(self, *, source_frames, expected_start_frame):
        if (type(expected_start_frame) is not int
                or not 0 <= expected_start_frame <= _MAX):
            raise ValueError('invalid native seek expectation')
        super().__init__(require_wav_header=True, wav_bits=16,
            source_frames=source_frames, sample_rate=44100, native=True)
        self._expected_start_frame = expected_start_frame
        self.source_origin_frame = None

    def consume_pcm(self, chunk):
        intervals = super().consume_pcm(chunk)
        if intervals and self.source_origin_frame is None:
            first = intervals[0]
            # The request validates actual checksum-bound PTS; it never supplies it.
            if first.output_start_frame != 0 or first.source_start_frame != self._expected_start_frame:
                self.lose('unexpected_source_origin')
                return ()
            self.source_origin_frame = first.source_start_frame
        return intervals


def _safe_integer(name, value, *, positive=False):
    if type(value) is not int or not (1 if positive else 0) <= value <= _MAX:
        raise ValueError(f'invalid native {name}')


@dataclass(frozen=True, slots=True)
class NativePcmRange:
    chunk_offset_frames: int
    decoded_start_frame: int
    source_start_frame: int
    frames: int

    def __post_init__(self):
        _safe_integer('frames', self.frames, positive=True)
        for name in ('chunk_offset_frames', 'decoded_start_frame', 'source_start_frame'):
            value = getattr(self, name)
            _safe_integer(name, value)
            if value + self.frames > _MAX:
                raise ValueError('native range exceeds safe coordinates')


@dataclass(frozen=True, slots=True)
class NativePcmObservation:
    source_id: str
    generation: int
    stream_id: int
    revision: int
    source_rate_hz: int
    decoded_rate_hz: int
    source_origin_frame: int
    source_extent_frames: int
    decoded_extent_frames: int | None
    emitted_frames: int
    qualified_emitted_frames: int
    decoder_complete: bool

    def __post_init__(self):
        if type(self.source_id) is not str:
            raise ValueError('invalid native source identity')
        identity = UUID(self.source_id)
        if str(identity) != self.source_id or identity.version != 4 or not identity.int:
            raise ValueError('invalid native source identity')
        for name in ('generation', 'stream_id', 'revision', 'source_rate_hz',
                'decoded_rate_hz', 'source_extent_frames'):
            _safe_integer(name, getattr(self, name), positive=True)
        for name in ('source_origin_frame', 'emitted_frames', 'qualified_emitted_frames'):
            _safe_integer(name, getattr(self, name))
        if self.source_rate_hz != 44100 or self.decoded_rate_hz != self.source_rate_hz:
            raise ValueError('unsupported native observation rate')
        if (self.source_origin_frame + self.emitted_frames > self.source_extent_frames
                or self.qualified_emitted_frames > self.emitted_frames):
            raise ValueError('invalid native observation extent')
        if type(self.decoder_complete) is not bool:
            raise ValueError('invalid native completion flag')
        if self.decoder_complete:
            _safe_integer('decoded_extent_frames', self.decoded_extent_frames)
            if (self.decoded_extent_frames != self.emitted_frames
                    or self.source_origin_frame + self.decoded_extent_frames != self.source_extent_frames):
                raise ValueError('incomplete native terminal extent')
        elif self.decoded_extent_frames is not None:
            raise ValueError('preterminal native extent is unknown')
