package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePcmEngineTest {
    private val first = SyntheticTrack(tag = 1, frames = 6L * RATE)
    private val second = SyntheticTrack(tag = 2, frames = 4L * RATE)

    private fun started() = PcmHarness(first, second).also { it.engine.start(first.pcm) }

    private fun metadata(harness: PcmHarness) {
        harness.server.decoding = false
        harness.deliver()
    }

    @Test
    fun limitsMatchTheWebEngineAtFortyEightKilohertz() {
        val config = PcmEngineConfig(RATE)

        assertEquals(12 * RATE, config.currentCapacityFrames)
        assertEquals(12 * RATE, config.continuityCapacityFrames)
        assertEquals(48_000, config.maxCreditFrames)
    }

    @Test
    fun opensWithAPathFreeReferenceAndCreditsOnlyAfterMetadata() {
        val harness = PcmHarness(first)
        harness.server.decoding = false
        harness.engine.start(first.pcm, startFrame = 960)

        assertEquals(
            listOf(PcmClientControl.Open(1, 1, PcmRole.CURRENT, first.pcm, 960, RATE)),
            harness.server.controls,
        )
        harness.deliver()
        assertEquals(listOf(PcmClientControl.Credit(1, 1, 48_000)), harness.sent<PcmClientControl.Credit>())
        assertEquals(48_000, harness.engine.inFlightFrames(PcmRole.CURRENT))
        assertEquals(960L, harness.engine.timelineFrame)
    }

    @Test
    fun outstandingCreditNeverExceedsOneSecondAndFillsTheCommittedRing() {
        val long = SyntheticTrack(tag = 5, frames = 30L * RATE)
        val harness = PcmHarness(long)
        harness.engine.start(long.pcm)
        harness.deliver()

        assertEquals(11 * RATE, harness.engine.bufferedFrames(PcmRole.CURRENT))
        assertEquals(RATE, harness.server.maxOutstanding)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun outOfOrderAndDuplicateSequencesAreDroppedAsStale() {
        val harness = started()
        metadata(harness)
        val samples = FloatArray(200)

        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 1, samples))
        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, samples))
        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, samples))

        assertEquals(100, harness.engine.bufferedFrames(PcmRole.CURRENT))
        assertEquals(2, harness.engine.staleMessages)
        assertNull(harness.failure())
    }

    @Test
    fun framesBeyondGrantedCreditFailTheStream() {
        val harness = started()
        metadata(harness)

        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(2 * 48_001)))

        assertEquals(
            PcmEngineEvent.Failed("pcm-protocol-error", "frame exceeds granted credit"),
            harness.failure(),
        )
        assertEquals(listOf("pause", "flush", "play", "pause", "flush"), harness.sink.operations)
    }

    @Test
    fun pcmBeforeMetadataAndMalformedFramesFail() {
        val early = started()
        early.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(2)))
        assertEquals("PCM arrived before metadata", early.failure()?.message)

        val malformed = started()
        malformed.engine.onBinary(ByteArray(8))
        assertEquals("PCM protocol error: frame is shorter than the AHPC header", malformed.failure()?.message)
    }

    @Test
    fun invalidMetadataEosAndServerErrorsFail() {
        val rate = started()
        rate.engine.onServerText(
            """{"type":"metadata","generation":1,"streamId":1,"role":"current","sampleRate":44100,""" +
                """"channels":2,"provisionalTotalFrames":1,"requestedStartFrame":0,"timelineStartFrame":0}""",
        )
        assertEquals("metadata-protocol-error", rate.failure()?.code)

        val eos = started()
        metadata(eos)
        eos.engine.onServerText(
            """{"type":"eos","generation":1,"streamId":1,"role":"current","emittedFrames":5,"authoritativeTotalFrames":5}""",
        )
        assertEquals("eos-protocol-error", eos.failure()?.code)

        val server = started()
        server.engine.onServerText(
            """{"type":"error","generation":1,"streamId":1,"role":"current","code":"decoder_failed",""" +
                """"message":"Audio decoder failed.","recoverable":false}""",
        )
        assertEquals(PcmEngineEvent.Failed("server-error", "Audio decoder failed."), server.failure())
    }

    @Test
    fun aNewGenerationIgnoresLateFramesOfTheOldOne() {
        val harness = started()
        metadata(harness)
        harness.engine.start(second.pcm)
        harness.deliver()

        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(2)))

        assertEquals(0, harness.engine.bufferedFrames(PcmRole.CURRENT))
        assertTrue(harness.engine.staleMessages >= 1)
        assertNull(harness.failure())
    }

    @Test
    fun startupWaitsForTheTwoSecondCushion() {
        val harness = started()
        metadata(harness)
        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(2 * RATE)))
        assertEquals(RATE, harness.engine.bufferedFrames(PcmRole.CURRENT))
        assertEquals(0, harness.engine.render(1_024))

        val ready = PcmHarness(first)
        ready.engine.start(first.pcm)
        ready.deliver()
        assertEquals(1_024, ready.engine.render(1_024))
        assertEquals(listOf(PcmEngineEvent.FirstFrame(1, 0)), ready.emitted<PcmEngineEvent.FirstFrame>())
    }

    @Test
    fun queuedNextWaitsForAudibleCurrentAndItsCushion() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        assertEquals(1, harness.sent<PcmClientControl.Open>().size)

        harness.step()

        val open = harness.sent<PcmClientControl.Open>()
        assertEquals(PcmClientControl.Open(1, 2, PcmRole.CONTINUITY, second.pcm, 0, RATE), open.last())
        assertEquals(3 * RATE, harness.engine.bufferedFrames(PcmRole.CONTINUITY))
    }

    @Test
    fun aContinuityStreamRejectsTheCurrentWireRoleBeforePromotion() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.continuityStreamId == 2L }
        val buffered = harness.engine.bufferedFrames(PcmRole.CONTINUITY)

        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 2, 999, FloatArray(2)))
        harness.engine.onServerEvent(PcmServerEvent.Promoted(1, 2, "current"))

        assertEquals(buffered, harness.engine.bufferedFrames(PcmRole.CONTINUITY))
        assertEquals(2, harness.engine.staleMessages)
        assertNull(harness.failure())
    }

    @Test
    fun promotedStreamKeepsAcceptingFramesStillLabelledContinuity() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        harness.server.holdingPromotes = true
        harness.playUntil { harness.engine.currentStreamId == 2L }
        repeat(200) { harness.step() }
        assertTrue(harness.sent<PcmClientControl.Credit>().any { it.streamId == 2L && it.frames > 0 })

        harness.server.releasePromotes()
        harness.playToEnd()

        assertNull(harness.failure())
        assertEquals(0, harness.engine.staleMessages)
        assertEquals(listOf(Run(1, 0, first.frames), Run(2, 0, second.frames)), harness.sink.runs())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aStarvedCurrentReportsOneUnderrunAndRebuffersWithoutFlushing() {
        val long = SyntheticTrack(tag = 5, frames = 30L * RATE)
        val harness = PcmHarness(long)
        harness.engine.start(long.pcm)
        harness.deliver()
        harness.server.decoding = false
        harness.playUntil { harness.emitted<PcmEngineEvent.Underrun>().isNotEmpty() }
        val operations = harness.sink.operations.toList()
        repeat(5) { harness.step() }

        assertEquals(1, harness.engine.underruns)
        assertEquals(listOf(PcmEngineEvent.Buffering(true, 1)), harness.emitted<PcmEngineEvent.Buffering>())
        harness.server.decoding = true
        harness.server.decodeAll()
        harness.step()
        assertEquals(PcmEngineEvent.Buffering(false, 1), harness.emitted<PcmEngineEvent.Buffering>().last())
        harness.playToEnd()
        assertEquals(1, harness.engine.underruns)
        assertEquals(operations, harness.sink.operations)
        assertEquals(listOf(Run(5, 0, long.frames)), harness.sink.runs())
    }

    @Test
    fun waitingForAnOpenSuccessorIsAnUnderrunNotAnEnd() {
        val harness = started()
        harness.playUntil { harness.engine.timelineFrame >= first.frames - 2_000 }
        harness.server.decoding = false
        harness.engine.setQueuedNext(second.pcm)
        repeat(4) { harness.step() }

        assertTrue(harness.engine.underruns > 0)
        assertEquals(emptyList<PcmEngineEvent.Ended>(), harness.emitted<PcmEngineEvent.Ended>())
        harness.server.decoding = true
        harness.server.decodeAll()
        harness.playToEnd()
        assertEquals(listOf(Run(1, 0, first.frames), Run(2, 0, second.frames)), harness.sink.runs())
        assertEquals(listOf(PcmEngineEvent.Ended(2, second.frames)), harness.emitted<PcmEngineEvent.Ended>())
    }

    @Test
    fun pauseDefersCreditUntilPlay() {
        val harness = PcmHarness(first)
        harness.server.decoding = false
        harness.engine.start(first.pcm, playWhenReady = false)
        harness.deliver()
        assertEquals(emptyList<PcmClientControl.Credit>(), harness.sent<PcmClientControl.Credit>())

        harness.engine.play()

        assertEquals(listOf(PcmClientControl.Credit(1, 1, 48_000)), harness.sent<PcmClientControl.Credit>())
        assertEquals(listOf("pause", "flush", "play"), harness.sink.operations)
    }

    @Test
    fun stopCancelsBothRolesAndLaterFramesNeverReachTheSink() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.continuityStreamId == 2L }
        harness.server.decoding = false
        val written = harness.sink.writtenFrames

        harness.engine.stop("stopped")
        harness.engine.onBinary(pcmFrame(PcmRole.CURRENT, 1, 1, 999, FloatArray(2)))
        harness.server.decoding = true
        harness.step()

        assertEquals(
            listOf(PcmClientControl.Close(1, 2, "stopped"), PcmClientControl.Close(1, 1, "stopped")),
            harness.sent<PcmClientControl.Close>(),
        )
        assertEquals(listOf("pause", "flush"), harness.sink.operations.takeLast(2))
        assertEquals(written, harness.sink.writtenFrames)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun clearingTheQueueClosesThePreparedSuccessorAndEndsAfterCurrent() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.engine.continuityStreamId == 2L }

        harness.engine.setQueuedNext(null)
        harness.playToEnd()

        assertEquals(listOf(PcmClientControl.Close(1, 2, "continuity-replaced")), harness.sent<PcmClientControl.Close>())
        assertEquals(listOf(Run(1, 0, first.frames)), harness.sink.runs())
        assertEquals(listOf(PcmEngineEvent.Ended(1, first.frames)), harness.emitted<PcmEngineEvent.Ended>())
        assertEquals(0, harness.engine.underruns)
    }

    @Test
    fun aStartedTrackAtAnotherRateAsksForARestartWithoutClosingAnything() {
        val other = SyntheticTrack(tag = 4, frames = RATE.toLong(), sampleRate = 44_100)
        val harness = PcmHarness(other)
        harness.engine.start(other.pcm, startFrame = 960)
        harness.deliver()

        assertEquals(
            listOf(PcmEngineEvent.StartRateRequired(other.pcm, 960, 44_100)),
            harness.emitted<PcmEngineEvent.StartRateRequired>(),
        )
        assertNull(harness.failure())
        assertNull(harness.engine.currentStreamId)
        assertEquals(emptyList<PcmClientControl.Close>(), harness.sent<PcmClientControl.Close>())
    }

    @Test
    fun aSuccessorAtAnotherRateEndsCurrentAndAsksForANewEngine() {
        val other = SyntheticTrack(tag = 4, frames = RATE.toLong(), sampleRate = 44_100)
        val harness = PcmHarness(first, other)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(other.pcm)
        harness.playToEnd()

        assertEquals(
            listOf(PcmEngineEvent.RateChangeRequired(other.pcm, 44_100)),
            harness.emitted<PcmEngineEvent.RateChangeRequired>(),
        )
        assertEquals(listOf(Run(1, 0, first.frames)), harness.sink.runs())
        assertEquals(0, harness.engine.underruns)
        assertEquals(emptyList<PcmClientControl.Close>(), harness.sent<PcmClientControl.Close>())
    }

    @Test
    fun aSeekDuringPromotionRunsAfterTheServerConfirmsIt() {
        val harness = started()
        harness.engine.setQueuedNext(second.pcm)
        harness.server.holdingPromotes = true
        harness.playUntil { harness.engine.currentStreamId == 2L }

        harness.engine.seek(RATE.toLong())
        assertEquals(2, harness.sent<PcmClientControl.Open>().size)
        harness.server.releasePromotes()
        harness.deliver()

        assertEquals(
            PcmClientControl.Open(1, 3, PcmRole.CONTINUITY, second.pcm, RATE.toLong(), RATE),
            harness.sent<PcmClientControl.Open>().last(),
        )
        harness.playToEnd()
        assertNull(harness.failure())
        val runs = harness.sink.runs()
        assertEquals(Run(1, 0, first.frames), runs[0])
        assertEquals(Run(2, RATE.toLong(), second.frames - RATE), runs.last())
        assertEquals(3, runs.size)
    }

    @Test
    fun aForwardSeekIntoBufferedPcmSkipsAheadWithoutReopening() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = PcmHarness(long, second)
        harness.engine.start(long.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil {
            harness.engine.bufferedFrames(PcmRole.CONTINUITY) > 0 && harness.engine.bufferedFrames(PcmRole.CURRENT) > 2 * RATE
        }
        val opens = harness.sent<PcmClientControl.Open>().size
        val cut = harness.sink.writtenFrames.toLong()
        val target = harness.engine.timelineFrame + RATE + 7

        harness.engine.seek(target)
        assertEquals(target, harness.engine.timelineFrame)
        harness.playToEnd()

        assertNull(harness.failure())
        assertEquals(opens, harness.sent<PcmClientControl.Open>().size)
        assertEquals(emptyList<PcmClientControl.Close>(), harness.sent<PcmClientControl.Close>())
        assertEquals(
            listOf(Run(3, 0, cut), Run(3, target, long.frames - target), Run(2, 0, second.frames)),
            harness.sink.runs(),
        )
        assertEquals(
            listOf(PcmEngineEvent.Boundary(PcmBoundaryKind.SEEK, 1, 1, target), PcmEngineEvent.Boundary(PcmBoundaryKind.QUEUED_NEXT, 1, 2, 0)),
            harness.emitted<PcmEngineEvent.Boundary>(),
        )
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aBufferedSeekAcrossTheRingsWrapKeepsEveryFrameInOrder() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = PcmHarness(long, second)
        harness.engine.start(long.pcm)
        harness.engine.setQueuedNext(second.pcm)
        // Past one ring capacity the read cursor sits near the end, so a two-second skip wraps.
        harness.playUntil { harness.engine.timelineFrame >= 11L * RATE && harness.engine.bufferedFrames(PcmRole.CURRENT) > 3 * RATE }
        val cut = harness.sink.writtenFrames.toLong()
        val target = harness.engine.timelineFrame + 2L * RATE + 5

        harness.engine.seek(target)
        harness.playToEnd()

        assertNull(harness.failure())
        assertEquals(
            listOf(Run(3, 0, cut), Run(3, target, long.frames - target), Run(2, 0, second.frames)),
            harness.sink.runs(),
        )
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aSeekBeyondBufferedPcmOrWithoutAPreparedSuccessorPreparesItsTarget() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val alone = PcmHarness(long)
        alone.engine.start(long.pcm)
        alone.playUntil { alone.engine.bufferedFrames(PcmRole.CURRENT) > 2 * RATE }
        alone.engine.seek(alone.engine.timelineFrame + RATE)
        assertEquals(PcmRole.CONTINUITY, alone.sent<PcmClientControl.Open>().last().role)

        val queued = PcmHarness(long, second)
        queued.engine.start(long.pcm)
        queued.engine.setQueuedNext(second.pcm)
        queued.playUntil { queued.engine.bufferedFrames(PcmRole.CONTINUITY) > 0 }
        val farTarget = queued.engine.timelineFrame + queued.engine.bufferedFrames(PcmRole.CURRENT) + 1
        queued.engine.seek(farTarget)
        assertEquals(PcmClientControl.Open(1, 3, PcmRole.CONTINUITY, long.pcm, farTarget, RATE), queued.sent<PcmClientControl.Open>().last())
        queued.playToEnd()
        assertEquals(Run(3, farTarget, long.frames - farTarget), queued.sink.runs()[1])
    }

    @Test
    fun controlDeliveryFailureFailsTheEngine() {
        val harness = PcmHarness(first)
        harness.server.accepting = false
        harness.engine.start(first.pcm)

        assertEquals("control-send-error", harness.failure()?.code)
        assertNull(harness.engine.currentStreamId)
    }

    @Test
    fun aReplacementIsRefusedWhereTheWebStartsAfresh() {
        val harness = PcmHarness(first, second)
        harness.engine.start(first.pcm)
        // Nothing heard yet.
        assertTrue(!harness.engine.replace(second.pcm, 0, null))
        harness.playUntil { harness.engine.timelineFrame > 0 }
        harness.engine.pause()
        assertTrue(!harness.engine.replace(second.pcm, 0, null))
        harness.engine.play()
        assertTrue(harness.engine.replace(second.pcm, 0, null))
        // A second replacement while one prepares.
        assertTrue(!harness.engine.replace(first.pcm, 0, null))
    }

    @Test
    fun theOutgoingTrackKeepsAtMostTwoSecondsWhileItIsReplaced() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = PcmHarness(long, second)
        harness.engine.start(long.pcm)
        harness.playUntil { harness.engine.timelineFrame > RATE && harness.engine.bufferedFrames(PcmRole.CURRENT) > 8 * RATE }
        harness.server.decoding = false
        assertTrue(harness.engine.replace(second.pcm, RATE.toLong(), null))
        harness.deliver()
        val creditsBefore = harness.sent<PcmClientControl.Credit>().count { it.streamId == 1L }
        harness.playUntil { harness.engine.bufferedFrames(PcmRole.CURRENT) < RATE * 3 / 2 }
        // Above two seconds buffered the outgoing decoder is not credited again.
        val outgoing = harness.sent<PcmClientControl.Credit>().filter { it.streamId == 1L }.drop(creditsBefore)
        assertTrue(outgoing.sumOf { it.frames } <= 2 * RATE)
        assertTrue(harness.engine.replacing)
    }

    @Test
    fun aSeekDuringAReplacementPreparesTheNewTrackAtTheSeekFrame() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = PcmHarness(long, second)
        harness.engine.start(long.pcm)
        harness.playUntil { harness.engine.timelineFrame > RATE && harness.engine.bufferedFrames(PcmRole.CURRENT) > 4 * RATE }
        harness.server.decoding = false
        assertTrue(harness.engine.replace(second.pcm, 0, null))
        harness.deliver()
        harness.engine.seek(5_000)
        harness.server.decoding = true
        harness.server.decodeAll()
        harness.playToEnd()

        assertEquals(PcmClientControl.Close(1, 2, "seek-replaced"), harness.sent<PcmClientControl.Close>().single())
        val runs = harness.sink.runs()
        assertEquals(listOf(3, 2), runs.map { it.tag })
        assertEquals(Run(2, 5_000, second.frames - 5_000), runs[1])
        assertEquals(PcmBoundaryKind.REPLACEMENT, harness.emitted<PcmEngineEvent.Boundary>().single().kind)
    }

    @Test
    fun aReplacementAtAnotherRateAsksForAFreshStartAndKeepsTheOutgoingTrack() {
        val other = SyntheticTrack(tag = 4, frames = RATE.toLong(), sampleRate = 44_100)
        val harness = PcmHarness(first, other)
        harness.engine.start(first.pcm)
        harness.playUntil { harness.engine.timelineFrame > 0 }
        assertTrue(harness.engine.replace(other.pcm, 960, null))
        harness.deliver()

        assertEquals(
            listOf(PcmEngineEvent.StartRateRequired(other.pcm, 960, 44_100)),
            harness.emitted<PcmEngineEvent.StartRateRequired>(),
        )
        assertNull(harness.failure())
        assertTrue(!harness.engine.replacing)
        assertEquals(1L, harness.engine.currentStreamId)
    }
}
