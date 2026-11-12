package org.albumhaven.playback.engine

import org.albumhaven.playback.decode.AudioCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Encoded streams: the server sends compressed bytes and the client decodes them, as the web player does. */
class EncodedPcmEngineTest {
    private val first = SyntheticTrack(tag = 1, frames = 30_000)
    private val second = SyntheticTrack(tag = 2, frames = 20_000)

    @Test
    fun anEncodedStreamPlaysEveryKeptFrameOnceWithoutThePrimingOrPadding() {
        val harness = PcmHarness(first, encoded = true)
        harness.engine.start(first.pcm)
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(listOf(Run(1, 0, first.frames)), harness.sink.runs())
        assertEquals(listOf("mp3"), harness.sent<PcmClientControl.Open>().single().codecs)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aPreparedEncodedSuccessorFollowsWithoutAGap() {
        val harness = PcmHarness(first, second, encoded = true)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(listOf(Run(1, 0, first.frames), Run(2, 0, second.frames)), harness.sink.runs())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aSeekReopensTheEncodedStreamAtTheExactFrame() {
        val harness = PcmHarness(first, encoded = true)
        harness.engine.start(first.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 4_096 }
        val heard = harness.sink.writtenFrames.toLong()
        harness.engine.seek(20_000)
        harness.playToEnd()

        assertEquals(null, harness.failure())
        val runs = harness.sink.runs()
        assertEquals(Run(1, 20_000, first.frames - 20_000), runs.last())
        assertTrue("the old place played on until the cutover", runs.first().start == 0L && runs.first().length >= heard)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun encodedAudioKeepsBufferingWhilePausedWithoutDecodingIt() {
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 60)
        val harness = PcmHarness(long, encoded = true)
        harness.server.decoding = false
        harness.engine.start(long.pcm)
        harness.deliver()
        harness.engine.pause(immediate = true)
        harness.server.decoding = true
        harness.server.decodeAll()
        repeat(20) { harness.step() }

        assertEquals(0, harness.sink.writtenFrames)
        assertTrue("byte credit continued while paused", harness.server.bytesCredited.sum() >= PcmEngineConfig.ENCODED_BUFFER_MIN_BYTES)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aFailedDecoderNamesItsCodecAndStopsTheEngine() {
        val harness = PcmHarness(first, encoded = true)
        harness.decoding = false
        harness.engine.start(first.pcm)
        harness.deliver()
        harness.decoders.opened.single().failNext = true
        harness.decoding = true
        harness.step()

        assertEquals(listOf(PcmEngineEvent.DecoderFailed(AudioCodec.MP3)), harness.emitted<PcmEngineEvent.DecoderFailed>())
        assertEquals("decoder-failed", harness.failure()?.code)
        assertEquals(0, harness.sink.writtenFrames)
    }

    @Test
    fun theReplacedStreamsDecoderIsClosed() {
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 60)
        val harness = PcmHarness(long, encoded = true)
        harness.engine.start(long.pcm)
        harness.deliver()
        harness.engine.start(long.pcm, startFrame = 10_000)
        harness.deliver()

        assertEquals(listOf(true, false), harness.decoders.opened.map { it.closed })
    }

    @Test
    fun metadataNamingACodecThatWasNotOfferedFails() {
        // Without decoders nothing is offered, so encoded metadata is a protocol error.
        val harness = PcmHarness(first)
        harness.engine.start(first.pcm)
        assertEquals(emptyList<String>(), harness.sent<PcmClientControl.Open>().single().codecs)
        harness.server.outbox.clear()
        harness.engine.onServerText(
            """{"type":"metadata","generation":1,"streamId":1,"role":"current","sampleRate":48000,"channels":2,""" +
                """"provisionalTotalFrames":30000,"requestedStartFrame":0,"timelineStartFrame":0,"codec":"mp3",""" +
                """"skipFrames":0,"totalFrames":30000,"initialCreditBytes":65536}""",
        )

        assertEquals("metadata-protocol-error", harness.failure()?.code)
    }

    @Test
    fun aTrackHeardWholeIsKeptAndItsReplayAsksNothingOfTheServer() {
        val cache = MemoryTrackCache()
        val harness = PcmHarness(first, encoded = true, cache = cache)
        harness.engine.start(first.pcm)
        harness.playToEnd()
        assertEquals(setOf("key-1"), cache.tracks.keys)

        val opens = harness.sent<PcmClientControl.Open>().size
        val written = harness.sink.writtenFrames
        harness.engine.start(first.pcm)
        harness.playUntil { harness.emitted<PcmEngineEvent.Ended>().size == 2 }

        assertEquals("the replay opened no server stream", opens, harness.sent<PcmClientControl.Open>().size)
        assertEquals(listOf(Run(1, 0, first.frames), Run(1, 0, first.frames)), harness.sink.runs())
        assertEquals(first.frames.toInt() * 2, harness.sink.writtenFrames.also { assertTrue(it > written) })
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aSuccessorFetchedAheadIsKeptOnlyOnceItIsHeard() {
        val cache = MemoryTrackCache()
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 30)
        val skipped = PcmHarness(long, second, encoded = true, cache = cache)
        skipped.engine.start(long.pcm)
        skipped.engine.setQueuedNext(second.pcm)
        skipped.playUntil { skipped.sent<PcmClientControl.Open>().size == 2 && skipped.server.outbox.isEmpty() && skipped.sink.writtenFrames > 48_000 }
        // The successor arrived whole but was never heard.
        assertEquals(false, "key-2" in cache.tracks.keys)

        val heard = PcmHarness(first, second, encoded = true, cache = cache)
        heard.engine.start(first.pcm)
        heard.engine.setQueuedNext(second.pcm)
        heard.playToEnd()
        assertTrue("key-2" in cache.tracks.keys)
    }

    @Test
    fun aCachedSuccessorFollowsWithoutAGapOrAServerPromote() {
        val cache = MemoryTrackCache()
        PcmHarness(second, encoded = true, cache = cache).apply {
            engine.start(second.pcm)
            playToEnd()
        }
        val harness = PcmHarness(first, second, encoded = true, cache = cache)
        harness.engine.start(first.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playToEnd()

        assertEquals(listOf(Run(1, 0, first.frames), Run(2, 0, second.frames)), harness.sink.runs())
        assertEquals(listOf("ref-1"), harness.sent<PcmClientControl.Open>().map { it.track.playbackRef })
        assertEquals(emptyList<PcmClientControl.Promote>(), harness.sent<PcmClientControl.Promote>())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aStartPartWayThroughAKeptTrackIsStreamed() {
        val cache = MemoryTrackCache()
        val harness = PcmHarness(first, encoded = true, cache = cache)
        harness.engine.start(first.pcm)
        harness.playToEnd()
        harness.engine.start(first.pcm, startFrame = 10_000)
        harness.playUntil { harness.emitted<PcmEngineEvent.Ended>().size == 2 }

        assertEquals(listOf(0L, 10_000L), harness.sent<PcmClientControl.Open>().map { it.startFrame })
        assertEquals(Run(1, 10_000, first.frames - 10_000), harness.sink.runs().last())
    }

    @Test
    fun anEarlySkipToACachedSuccessorClosesTheServerStreamItLeaves() {
        val cache = MemoryTrackCache()
        PcmHarness(second, encoded = true, cache = cache).apply {
            engine.start(second.pcm)
            playToEnd()
        }
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 60)
        val harness = PcmHarness(long, second, encoded = true, cache = cache)
        harness.engine.start(long.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.sink.writtenFrames > 48_000 }

        assertTrue(harness.engine.skipToPrepared())
        harness.playToEnd()

        val close = harness.sent<PcmClientControl.Close>().single()
        assertEquals("replaced-by-cache", close.reason)
        assertEquals(harness.sent<PcmClientControl.Open>().single().streamId, close.streamId)
        assertEquals(Run(2, 0, second.frames), harness.sink.runs().last())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aSeekIntoReceivedAudioPlaysTheExactFrameWithoutTheServer() {
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 30)
        val harness = PcmHarness(long, encoded = true)
        harness.engine.start(long.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 48_000 }
        val heard = harness.sink.writtenFrames.toLong()
        harness.engine.seek(600_000)
        harness.step()
        harness.engine.seek(200_000)
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals("both seeks stayed on the device", 1, harness.sent<PcmClientControl.Open>().size)
        val runs = harness.sink.runs()
        assertEquals(Run(3, 200_000, long.frames - 200_000), runs.last())
        assertTrue("the old place played on until the first cutover", runs.first().start == 0L && runs.first().length >= heard)
        assertEquals(listOf(600_000L, 200_000L), harness.emitted<PcmEngineEvent.Boundary>().map { it.timelineFrame })
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aLostSocketPlaysOnFromTheReceivedAudioAndTheNextSocketTakesOverWithoutAGap() {
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 60)
        val harness = PcmHarness(long, second, encoded = true)
        harness.engine.start(long.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 48_000 }

        harness.server.disconnect()
        val splice = checkNotNull(harness.engine.detach())
        // Offline, the received audio keeps playing up to the splice frame and no control is sent.
        val controls = harness.server.controls.size
        repeat(40) { harness.step() }
        assertEquals(null, harness.failure())
        assertEquals(controls, harness.server.controls.size)
        assertTrue("it played on while offline", harness.sink.writtenFrames > 48_000 + 30_000)

        harness.server.reconnect()
        assertTrue(harness.engine.resume())
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(listOf(Run(3, 0, long.frames), Run(2, 0, second.frames)), harness.sink.runs())
        assertEquals(splice, harness.sent<PcmClientControl.Open>().single { it.track == long.pcm && it.startFrame > 0 }.startFrame)
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aLostSocketAfterTheWholeSongArrivedPlaysItToTheEndAndTheNextSocketPreparesWhatFollows() {
        // Two seconds of the fake codec is far less than the minutes the engine keeps ahead.
        val whole = SyntheticTrack(tag = 4, frames = 96_000)
        val harness = PcmHarness(whole, second, encoded = true)
        harness.engine.start(whole.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 24_000 }

        harness.server.disconnect()
        assertEquals(whole.frames, harness.engine.detach())
        playsOnAloneToItsEnd(harness, whole)

        harness.server.reconnect()
        assertTrue(harness.engine.resume())
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(listOf(Run(4, 0, whole.frames), Run(2, 0, second.frames)), harness.sink.runs())
        // A successor prepared on the lost socket is prepared again on the next; the song itself is not.
        assertEquals("ref-4", opened(harness).single { it != "ref-2" })
        assertEquals("ref-2", opened(harness).last())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aLostSocketWhileACachedSongPlaysPlaysItToTheEndAndTheNextSocketPreparesWhatFollows() {
        val whole = SyntheticTrack(tag = 4, frames = 96_000)
        val cache = MemoryTrackCache()
        PcmHarness(whole, encoded = true, cache = cache).apply {
            engine.start(whole.pcm)
            playToEnd()
        }
        val harness = PcmHarness(whole, second, encoded = true, cache = cache)
        harness.engine.start(whole.pcm)
        harness.engine.setQueuedNext(second.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 24_000 }

        harness.server.disconnect()
        assertEquals(whole.frames, harness.engine.detach())
        playsOnAloneToItsEnd(harness, whole)

        harness.server.reconnect()
        assertTrue(harness.engine.resume())
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(listOf(Run(4, 0, whole.frames), Run(2, 0, second.frames)), harness.sink.runs())
        // The successor prepared on the lost socket was never heard, so it was not kept; the next
        // socket prepares it again. The cached song itself never asked the server for anything.
        assertEquals("only the successor came from the server", listOf("ref-2", "ref-2"), opened(harness))
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    @Test
    fun aSeekPastWhatIsOnTheDeviceWhileOfflineRunsOnTheNextSocket() {
        val whole = SyntheticTrack(tag = 4, frames = 96_000)
        val harness = PcmHarness(whole, encoded = true)
        harness.engine.start(whole.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 24_000 }
        harness.server.disconnect()
        assertEquals(whole.frames, harness.engine.detach())

        val controls = harness.server.controls.size
        harness.engine.seek(70_000)
        repeat(5) { harness.step() }
        assertEquals("nothing was sent on the lost socket", controls, harness.server.controls.size)
        harness.server.reconnect()
        assertTrue(harness.engine.resume())
        harness.playToEnd()

        assertEquals(null, harness.failure())
        assertEquals(70_000L, harness.sent<PcmClientControl.Open>().last().startFrame)
        assertEquals(Run(4, 70_000, whole.frames - 70_000), harness.sink.runs().last())
        assertEquals(emptyList<String>(), harness.server.violations)
    }

    /** With no socket, [track] plays to its last frame and then waits for its successor; no control is sent. */
    private fun playsOnAloneToItsEnd(harness: PcmHarness, track: SyntheticTrack) {
        val controls = harness.server.controls.size
        val underruns = harness.emitted<PcmEngineEvent.Underrun>().size
        harness.playUntil { harness.emitted<PcmEngineEvent.Underrun>().size > underruns }
        assertEquals(null, harness.failure())
        assertEquals(controls, harness.server.controls.size)
        assertEquals(listOf(Run(track.tag, 0, track.frames)), harness.sink.runs())
        assertEquals(emptyList<PcmEngineEvent.Ended>(), harness.emitted<PcmEngineEvent.Ended>())
    }

    private fun opened(harness: PcmHarness) = harness.sent<PcmClientControl.Open>().map { it.track.playbackRef }

    @Test
    fun aSocketLostBeforeAnyWholeSeekPointStopsAsBefore() {
        val harness = PcmHarness(first, encoded = true)
        harness.server.decoding = false
        harness.engine.start(first.pcm)
        harness.deliver()
        harness.server.disconnect()

        assertEquals(null, harness.engine.detach())
    }

    @Test
    fun aSeekPastTheReceivedAudioAsksTheServer() {
        val long = SyntheticTrack(tag = 3, frames = 48_000L * 300)
        val harness = PcmHarness(long, encoded = true)
        harness.engine.start(long.pcm)
        harness.playUntil { harness.sink.writtenFrames >= 48_000 }
        // Five minutes of float audio is far more than the bytes credited so far.
        harness.engine.seek(long.frames - 48_000)
        harness.playToEnd()

        assertEquals(listOf(0L, long.frames - 48_000), harness.sent<PcmClientControl.Open>().map { it.startFrame })
        assertEquals(Run(3, long.frames - 48_000, 48_000), harness.sink.runs().last())
    }
}
