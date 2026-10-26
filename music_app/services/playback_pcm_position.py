"""Bounded same-decoder PCM/sideband verifier, not an admission authority.

Only a separately qualified, timestamp-preserving packed f32le stereo48k
producer may feed this observer. A returned interval describes bytes already
consumed, not audio rendered or permission to retroactively qualify old audio.
Caller owns the decoder identity and any admission-before-enqueue lifecycle.
"""
from collections import deque
from dataclasses import dataclass
import re
import zlib

_MAX = 2**53 - 1
_LINE_LIMIT = 2048
_QUEUE_LIMIT = 32
_FRAME_LIMIT = 16384
_LINE = re.compile(rb'^\[Parsed_ashowinfo_[0-9]+ @ [^\]\r\n]{1,64}\] n:([0-9]+) pts:(-?[0-9]+) pts_time:\S+ (?:pos:\S+ )?fmt:flt channels:2 chlayout:stereo rate:48000 nb_samples:([0-9]+) checksum:([0-9A-Fa-f]{1,8}) plane_checksums: \[\s*([0-9A-Fa-f]{1,8})\s*\]$')


@dataclass(frozen=True, slots=True)
class VerifiedPcmInterval:
    output_start48: int
    source_start48: int
    frames48: int


class PcmPositionObserver:
    """Fail closed once, never wait for sideband and never retain PCM.

    Missing/late descriptors cause permanent loss rather than stalling audio.
    Call feed_stderr with arbitrary byte fragments, then consume_pcm in exact
    stdout order. Input chunks must be bounded by the existing caller. The only
    retained data is a bounded line and descriptor queue plus checksum counters.
    """
    def __init__(self, *, require_wav_header=False):
        self._require_wav_header = require_wav_header
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
    def source_end48(self):
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
                self._wav_stream = re.fullmatch(rb'  Stream #0:0: Audio: pcm_s16le(?: \([^\r\n]*\))?, 48000 Hz, stereo, s16, [0-9]+ kb/s', line) is not None
            if line.startswith(b'  Stream #0:0 -> '):
                self._wav_mapping = line == b'  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_f32le (native))'
        if b'ashowinfo' not in line or b' n:' not in line:
            return
        if self._require_wav_header and not (self._wav_demuxer and self._wav_stream and self._wav_mapping):
            self.lose('unsupported_input')
            return
        match = _LINE.fullmatch(line)
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
                verified.append(VerifiedPcmInterval(self._output_bytes // 8 - frames, pts, frames))
                self._queue.popleft()
                self._frame_bytes = 0
                self._checksum = 0
        return tuple(verified)

    def finish(self):
        if self.available and (self._line or self._queue or self._frame_bytes or not self._next_n):
            self.lose('incomplete_output')
        return self.available
