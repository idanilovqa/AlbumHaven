import importlib.util
from pathlib import Path
import sys
import unittest
import zlib

from music_app.services import playback_pcm_position as m


def line(pcm, n=0, pts=7, pos=False):
    checksum = zlib.adler32(pcm, 0) & 0xffffffff
    return (f'[Parsed_ashowinfo_2 @ 0x123] n:{n} pts:{pts} pts_time:0.0 '
        + ('pos:44 ' if pos else '')
        + f'fmt:flt channels:2 chlayout:stereo rate:48000 nb_samples:{len(pcm)//8} '
        + f'checksum:{checksum:08X} plane_checksums: [ {checksum:08X} ]\n').encode()


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.o = m.PcmPositionObserver()
        self.pcm = bytes(range(32))

    def test_whole_frame(self):
        self.o.feed_stderr(line(self.pcm))
        self.assertEqual(self.o.consume_pcm(self.pcm), (m.VerifiedPcmInterval(0, 7, 4),))
        self.assertTrue(self.o.finish())

    def test_every_stderr_byte_fragment(self):
        for value in line(self.pcm): self.o.feed_stderr(bytes([value]))
        self.assertEqual(len(self.o.consume_pcm(self.pcm)), 1)

    def test_arbitrary_pcm_byte_fragmentation(self):
        self.o.feed_stderr(line(self.pcm))
        for value in self.pcm[:-1]: self.assertEqual(self.o.consume_pcm(bytes([value])), ())
        self.assertEqual(self.o.consume_pcm(self.pcm[-1:]), (m.VerifiedPcmInterval(0, 7, 4),))

    def test_optional_pos_compatibility(self):
        self.o.feed_stderr(line(self.pcm, pos=True))
        self.assertEqual(len(self.o.consume_pcm(self.pcm)), 1)

    def test_multiple_frames_same_chunk(self):
        self.o.feed_stderr(line(self.pcm) + line(self.pcm, 1, 11))
        self.assertEqual(self.o.consume_pcm(self.pcm * 2),
            (m.VerifiedPcmInterval(0, 7, 4), m.VerifiedPcmInterval(4, 11, 4)))

    def test_missing_descriptor_never_waits(self):
        self.assertEqual(self.o.consume_pcm(self.pcm), ())
        self.assertEqual(self.o.loss_reason, 'missing_or_late_descriptor')
        self.o.feed_stderr(line(self.pcm))
        self.assertEqual(self.o.consume_pcm(self.pcm), ())

    def test_corruption_loses_current_call_results(self):
        self.o.feed_stderr(line(self.pcm) + line(self.pcm, 1, 11))
        self.assertEqual(self.o.consume_pcm(self.pcm + b'x' * 32), ())
        self.assertEqual(self.o.loss_reason, 'checksum_mismatch')

    def test_duplicate_frame(self):
        self.o.feed_stderr(line(self.pcm) * 2)
        self.assertEqual(self.o.loss_reason, 'descriptor_discontinuity')

    def test_negative_pts(self):
        self.o.feed_stderr(line(self.pcm, pts=-1))
        self.assertFalse(self.o.available)

    def test_discontinuous_pts(self):
        self.o.feed_stderr(line(self.pcm) + line(self.pcm, 1, 12))
        self.assertFalse(self.o.available)

    def test_oversized_integer(self):
        self.o.feed_stderr(line(self.pcm, pts=10**17))
        self.assertEqual(self.o.loss_reason, 'integer_limit')

    def test_unknown_format(self):
        self.o.feed_stderr(line(self.pcm).replace(b'fmt:flt', b'fmt:fltp'))
        self.assertEqual(self.o.loss_reason, 'unsupported_descriptor')

    def test_queue_bound(self):
        for n in range(33): self.o.feed_stderr(line(self.pcm, n, 7+n*4))
        self.assertEqual(self.o.loss_reason, 'descriptor_queue_limit')
        self.assertEqual(len(self.o._queue), 0)

    def test_line_bound(self):
        self.o.feed_stderr(b'x' * 2049)
        self.assertEqual(self.o.loss_reason, 'line_limit')
        self.assertEqual(len(self.o._line), 0)

    def test_chunk_bounds(self):
        self.o.feed_stderr(b'x' * 8193)
        self.assertEqual(self.o.loss_reason, 'invalid_stderr_chunk')
        other=m.PcmPositionObserver()
        self.assertEqual(other.consume_pcm(b'x'*131073), ())
        self.assertEqual(other.loss_reason, 'invalid_pcm_chunk')

    def test_incomplete_eof(self):
        self.o.feed_stderr(line(self.pcm))
        self.o.consume_pcm(self.pcm[:-1])
        self.assertFalse(self.o.finish())

    def test_no_descriptors_eof(self):
        self.assertFalse(self.o.finish())

    def test_other_logs_ignored(self):
        self.o.feed_stderr(b'ordinary log\n' + line(self.pcm))
        self.assertEqual(len(self.o.consume_pcm(self.pcm)), 1)

    def test_explicit_loss_is_terminal(self):
        self.o.lose('cancelled')
        self.o.feed_stderr(line(self.pcm))
        self.assertEqual(self.o.consume_pcm(self.pcm), ())
        self.o.lose('replacement')
        self.assertEqual(self.o.loss_reason, 'cancelled')

    def test_empty_chunk_not_eof(self):
        self.assertEqual(self.o.consume_pcm(b''), ())
        self.assertTrue(self.o.available)

    def test_exact_native_profile_headers_and_frame_bound(self):
        for bits, sample_format in ((16,'s16'),(24,'s32 (24 bit)'),(32,'s32')):
            with self.subTest(bits=bits):
                observer=m.PcmPositionObserver(require_wav_header=True,wav_bits=bits,source_frames48=11)
                header=("Input #0, wav, from 'fd:':\n"
                    f'  Stream #0:0: Audio: pcm_s{bits}le, 48000 Hz, stereo, {sample_format}, {96*bits} kb/s\n'
                    f'  Stream #0:0 -> #0:0 (pcm_s{bits}le (native) -> pcm_f32le (native))\n').encode()
                observer.feed_stderr(header+line(self.pcm))
                self.assertEqual(observer.consume_pcm(self.pcm),(m.VerifiedPcmInterval(0,7,4),))
                self.assertTrue(observer.finish())
                self.assertEqual(observer.source_end48,11)

    def test_native_bound_rejects_overrun_before_mapping(self):
        observer=m.PcmPositionObserver(source_frames48=10)
        observer.feed_stderr(line(self.pcm))
        self.assertEqual(observer.loss_reason,'source_extent_exceeded')
        self.assertEqual(observer.consume_pcm(self.pcm),())
        self.assertIsNone(observer.source_end48)

    def test_native_bound_does_not_invent_missing_eof(self):
        observer=m.PcmPositionObserver(source_frames48=12)
        observer.feed_stderr(line(self.pcm))
        self.assertEqual(observer.consume_pcm(self.pcm),(m.VerifiedPcmInterval(0,7,4),))
        self.assertFalse(observer.finish())
        self.assertEqual(observer.loss_reason,'source_extent_mismatch')
        self.assertIsNone(observer.source_end48)

    def test_invalid_profile_inputs_rejected(self):
        for width in (8,20,64,True,'24',24.0,None):
            with self.subTest(width=width),self.assertRaises(ValueError):
                m.PcmPositionObserver(wav_bits=width)
        for frames in (-1,2**53,True,'11',11.0):
            with self.subTest(frames=frames),self.assertRaises(ValueError):
                m.PcmPositionObserver(source_frames48=frames)

    def test_profile_mapping_and_format_must_match(self):
        prefix=(b"Input #0, wav, from 'fd:':\n"
            b'  Stream #0:0: Audio: pcm_s24le, 48000 Hz, stereo, s32 (24 bit), 2304 kb/s\n'
            b'  Stream #0:0 -> #0:0 (pcm_s24le (native) -> pcm_f32le (native))\n')
        changes=((b'pcm_s24le',b'pcm_s16le'),(b's32 (24 bit)',b's32'),
            (b'48000 Hz',b'44100 Hz'),(b'stereo',b'mono'),(b'2304 kb/s',b'3072 kb/s'),
            (b'pcm_f32le (native)',b'pcm_f32le (unrecognized)'))
        for before,after in changes:
            with self.subTest(change=after):
                observer=m.PcmPositionObserver(require_wav_header=True,wav_bits=24,source_frames48=11)
                observer.feed_stderr(prefix.replace(before,after)+line(self.pcm))
                self.assertEqual(observer.loss_reason,'unsupported_input')
                self.assertEqual(observer.consume_pcm(self.pcm),())


if __name__ == '__main__': unittest.main()
