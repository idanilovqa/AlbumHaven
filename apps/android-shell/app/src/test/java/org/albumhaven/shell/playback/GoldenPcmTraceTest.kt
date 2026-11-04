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
    fun aDifferentSuccessorWaitsForThePreparedOneAndFollowsItWithoutAGap() {
        val harness = harness(first, second, third)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.bufferedFrames(PcmRole.CONTINUITY) > 0 }
        // As `scheduleStreamingContinuity`: the prepared successor plays, the new one follows it.
        harness.engine.setQueuedNext(third.pcm)
        harness.playToEnd()

        assertEquals(
            listOf(Run(1, 0, first.frames), Run(2, 0, second.frames), Run(3, 0, third.frames)),
            harness.sink.runs(),
        )
        assertEquals(emptyList<PcmClientControl.Close>(), harness.sent<PcmClientControl.Close>())
        assertEquals(
            listOf(
                PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 1, 2, 0),
                PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 2, 3, 0),
            ),
            harness.emitted<PcmEngineEvent.Boundary>(),
        )
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun aShortLoopReplaysItsRetainedSamplesExactlyAndClearingResumesAfterTheLoop() {
        val harness = harness(first, second)
        val loopStart = 2L * RATE + 211
        val loopEnd = loopStart + 3L * RATE + 59
        val loopFrames = loopEnd - loopStart
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.engine.setLoop(loopStart, loopEnd, short = true)
        harness.playUntil { harness.emitted<PcmEngineEvent.Boundary>().size == 3 }
        harness.engine.clearLoop()
        harness.playToEnd()

        val runs = harness.sink.runs()
        val repeat = Run(1, loopStart, loopFrames)
        assertEquals(listOf(Run(1, 0, loopEnd), repeat, repeat), runs.take(3))
        // The worklet's `set-loop` off: a replay in progress jumps to the frame after the loop.
        assertEquals(1, runs[3].tag)
        assertEquals(loopStart, runs[3].start)
        assertTrue(runs[3].length in 1 until loopFrames)
        assertEquals(listOf(Run(1, loopEnd, first.frames - loopEnd), Run(2, 0, second.frames)), runs.drop(4))
        assertEquals(
            listOf(
                PcmEngineEvent.Boundary(PcmBoundaryKind.LOOP, 1, 2, loopStart),
                PcmEngineEvent.Boundary(PcmBoundaryKind.LOOP, 2, 2, loopStart),
                PcmEngineEvent.Boundary(PcmBoundaryKind.LOOP, 2, 2, loopStart),
                PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 1, 3, 0),
            ),
            harness.emitted<PcmEngineEvent.Boundary>(),
        )
        // The loop decoder is asked for exactly the loop and is never promoted.
        assertEquals(loopFrames, harness.sent<PcmClientControl.Credit>().filter { it.streamId == 2L }.sumOf { it.frames.toLong() })
        assertEquals(listOf(3L), harness.sent<PcmClientControl.Promote>().map { it.streamId })
        assertEquals(listOf(PcmClientControl.Close(1, 2, "loop-disabled")), harness.sent<PcmClientControl.Close>())
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun aShortLoopWaitsForItsWholeRetainedLoopWithoutInsertingSamples() {
        val harness = harness(first)
        harness.engine.start(first.pcm)
        harness.playUntil { harness.engine.timelineFrame >= RATE && harness.engine.bufferedFrames(PcmRole.CURRENT) >= 6 * RATE }
        val loopStart = harness.engine.timelineFrame + RATE / 2
        val loopEnd = loopStart + 2L * RATE + 3
        harness.server.decoding = false
        harness.engine.setLoop(loopStart, loopEnd, short = true)
        harness.playUntil { harness.engine.underruns > 0 }
        val waiting = harness.sink.writtenFrames
        repeat(20) { harness.step() }
        assertEquals(waiting, harness.sink.writtenFrames)

        harness.server.decoding = true
        harness.server.decodeAll()
        harness.playUntil { harness.emitted<PcmEngineEvent.Boundary>().size == 2 }
        harness.engine.clearLoop()
        harness.playToEnd()

        val runs = harness.sink.runs()
        assertEquals(listOf(Run(1, 0, loopEnd), Run(1, loopStart, loopEnd - loopStart)), runs.take(2))
        assertEquals(loopStart, runs[2].start)
        assertEquals(Run(1, loopEnd, first.frames - loopEnd), runs.last())
        assertEquals(4, runs.size)
        assertNull(harness.failure())
        assertEquals(emptyList<String>(), harness.server.violations)
        harness.assertOneUninterruptedWrite()
    }

    @Test
    fun aReplacementPlaysTheOutgoingTrackUntilTheNewStartIsBufferedThenCutsOverWithoutAGap() {
        val harness = harness(first, second, third)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.timelineFrame >= 3L * RATE && harness.engine.bufferedFrames(PcmRole.CONTINUITY) > 0 }
        val replacedAt = harness.engine.timelineFrame
        // The new start's decoder is slow: the outgoing track has to bridge the wait.
        harness.server.decoding = false
        assertTrue(harness.engine.replace(third.pcm, 0, null))
        repeat(10) { harness.step() }
        harness.server.decoding = true
        harness.server.decodeAll()
        harness.playToEnd()

        val runs = harness.sink.runs()
        assertEquals(2, runs.size)
        assertEquals(1, runs[0].tag)
        assertEquals(0L, runs[0].start)
        // The outgoing track kept sounding while the new start buffered: nothing silent, nothing repeated.
        assertTrue(runs[0].length > replacedAt)
        assertEquals(Run(3, 0, third.frames), runs[1])
        assertEquals(
            listOf(PcmEngineEvent.Boundary(PcmBoundaryKind.REPLACEMENT, 1, 3, 0)),
            harness.emitted<PcmEngineEvent.Boundary>(),
        )
        assertEquals(listOf(PcmClientControl.Close(1, 2, "replacement-target")), harness.sent<PcmClientControl.Close>())
        assertEquals(listOf(PcmEngineEvent.Ended(3, third.frames)), harness.emitted<PcmEngineEvent.Ended>())
        harness.assertCleanContract()
        harness.assertOneUninterruptedWrite()
    }
}
