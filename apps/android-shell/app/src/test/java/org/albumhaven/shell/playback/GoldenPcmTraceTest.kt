package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Golden traces: every written sample names its track and source frame, so a run list
 * proves zero missing, duplicated or inserted samples across each boundary. Tracks are
 * longer than the twelve-second ring so every ring wraps, server chunks and partial sink
 * writes never align with a boundary.
 */
class GoldenPcmTraceTest {
    private val first = SyntheticTrack(tag = 1, frames = 20L * RATE + 4_321)
    private val second = SyntheticTrack(tag = 2, frames = 5L * RATE + 77)
    private val third = SyntheticTrack(tag = 3, frames = 3L * RATE + 5)

    private fun harness(vararg tracks: SyntheticTrack) =
        PcmHarness(*tracks, chunkFrames = 4_093).also { it.sink.acceptFrames = 333 }

    private fun PcmHarness.assertCleanContract() {
        assertNull(failure())
        assertEquals(emptyList<String>(), server.violations)
        assertEquals(0, engine.underruns)
        assertTrue(server.maxOutstanding <= RATE)
    }

    /** No stop, pause or flush reaches the sink between the first and last written sample. */
    private fun PcmHarness.assertOneUninterruptedWrite() {
        assertEquals(listOf("pause", "flush", "play", "write"), sink.operations)
    }

    @Test
    fun queuedNextStartsOnTheSampleAfterTheLastCurrentSample() {
        val harness = harness(first, second, third)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.currentStreamId != 1L }
        harness.engine.setQueuedNext(third.pcm)
        harness.playToEnd()

        assertEquals(
            listOf(Run(1, 0, first.frames), Run(2, 0, second.frames), Run(3, 0, third.frames)),
            harness.sink.runs(),
        )
        assertEquals(
            listOf(
                PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 1, 2, 0),
                PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 2, 3, 0),
            ),
            harness.emitted<PcmEngineEvent.Boundary>(),
        )
        assertEquals(listOf(PcmEngineEvent.Ended(3, third.frames)), harness.emitted<PcmEngineEvent.Ended>())
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun forwardAndBackwardSeeksJoinTheTargetFrameToTheLastWrittenFrame() {
        val harness = harness(first, second)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.timelineFrame >= 3L * RATE }
        val forwardTarget = 15L * RATE + 11
        harness.engine.seek(forwardTarget)
        harness.playUntil { harness.emitted<PcmEngineEvent.Boundary>().isNotEmpty() }
        val forwardCut = harness.sink.runs().first().length
        harness.playUntil { harness.engine.timelineFrame >= forwardTarget + 2L * RATE }
        val backwardTarget = 2L * RATE + 3
        harness.engine.seek(backwardTarget)
        harness.playToEnd()

        val runs = harness.sink.runs()
        assertEquals(Run(1, 0, forwardCut), runs[0])
        assertEquals(1, runs[1].tag)
        assertEquals(forwardTarget, runs[1].start)
        assertEquals(Run(1, backwardTarget, first.frames - backwardTarget), runs[2])
        assertEquals(Run(2, 0, second.frames), runs[3])
        assertEquals(4, runs.size)
        assertEquals(
            listOf(PcmBoundaryKind.SEEK, PcmBoundaryKind.SEEK, PcmBoundaryKind.QUEUED_NEXT),
            harness.emitted<PcmEngineEvent.Boundary>().map { it.kind },
        )
        assertEquals(
            listOf(forwardTarget, backwardTarget),
            harness.emitted<PcmEngineEvent.Boundary>().take(2).map { it.timelineFrame },
        )
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun loopRepeatsExactlyTheRequestedFramesThenContinuesToTheTrackEnd() {
        val harness = harness(first, second)
        val loopStart = 1L * RATE + 17
        val loopEnd = 4L * RATE + 501
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.engine.setLoop(loopStart, loopEnd)
        harness.playUntil { harness.emitted<PcmEngineEvent.Boundary>().size == 3 }
        harness.engine.clearLoop()
        harness.playToEnd()

        val repeat = Run(1, loopStart, loopEnd - loopStart)
        assertEquals(
            listOf(
                Run(1, 0, loopEnd),
                repeat,
                repeat,
                Run(1, loopStart, first.frames - loopStart),
                Run(2, 0, second.frames),
            ),
            harness.sink.runs(),
        )
        assertEquals(
            listOf(loopStart, loopStart, loopStart, 0L),
            harness.emitted<PcmEngineEvent.Boundary>().map { it.timelineFrame },
        )
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun queueEditReplacesThePreparedSuccessorWithoutAGap() {
        val harness = harness(first, second, third)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.bufferedFrames(PcmRole.CONTINUITY) > 0 }
        harness.engine.setQueuedNext(third.pcm)
        harness.playToEnd()

        assertEquals(listOf(Run(1, 0, first.frames), Run(3, 0, third.frames)), harness.sink.runs())
        assertEquals(
            listOf(PcmClientControl.Close(1, 2, "continuity-replaced")),
            harness.sent<PcmClientControl.Close>(),
        )
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }
}
