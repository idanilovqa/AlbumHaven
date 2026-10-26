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


if __name__ == '__main__': unittest.main()
