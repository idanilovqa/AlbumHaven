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
}
