package org.albumhaven.playback.decode

import java.io.File
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class DecoderSelfCheckTest {
    // Unit tests run in the module directory.
    private val webDecoders = File("../../../music_app/static/js/runtime/player-streaming-decoders.js")

    private fun clip(codec: AudioCodec): ByteArray = File("src/main/assets/${DecoderSelfCheck.clipAsset(codec)}").readBytes()

    @Test
    fun theClipsAndExpectationsAreTheWebPlayersOwn() {
        val source = webDecoders.readText()
        for (codec in AudioCodec.entries) {
            val match = Regex(""""${codec.wire}": \{\s*"bytes": "([^"]+)",\s*"frames": (\d+),\s*"magnitude": ([\d.]+)""")
                .find(source) ?: error("the web self-check has no ${codec.wire} clip")
            assertArrayEquals(Base64.getDecoder().decode(match.groupValues[1]), clip(codec))
            val expected = DecoderSelfCheck.EXPECTED.getValue(codec)
            assertEquals(match.groupValues[2].toInt(), expected.frames)
            assertEquals(match.groupValues[3].toDouble(), expected.magnitude, 0.0)
        }
        assertEquals(
            Regex("""STREAMING_DECODER_SELF_CHECK_TOLERANCE = ([\d.]+)""").find(source)!!.groupValues[1].toDouble(),
            DecoderSelfCheck.MAGNITUDE_TOLERANCE,
            0.0,
        )
    }

    /** Decodes every clip into [frames] frames whose left samples are each [left]. */
    private class FakeDecoder(private val frames: Int, private val left: Float) : AudioDecoder {
        var written = 0
        override val bufferedBytes = 0
        private var ended = false
        private var delivered = false

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            written += length
        }

        override fun end() {
            ended = true
        }

        override fun cancel() = Unit

        override fun decode(): DecodedAudio? {
            check(ended) { "the check must end its input before draining" }
            if (delivered) return null
            delivered = true
            return DecodedAudio(FloatArray(frames * 2) { if (it % 2 == 0) left else 9f }, 44_100)
        }

        override fun close() = Unit
    }

    private fun matching(codec: AudioCodec): FakeDecoder {
        val expected = DecoderSelfCheck.EXPECTED.getValue(codec)
        return FakeDecoder(expected.frames, (expected.magnitude / expected.frames).toFloat())
    }

    @Test
    fun aDecoderPassesOnlyWithTheExactFrameCountAndLeftChannelMagnitude() {
        val verified = DecoderSelfCheck.verifiedCodecs(::clip) { codec ->
            if (codec == AudioCodec.MP3) matching(codec) else FakeDecoder(DecoderSelfCheck.EXPECTED.getValue(codec).frames - 1, 0.05f)
        }
        assertEquals(setOf(AudioCodec.MP3), verified)
    }

    @Test
    fun aDecoderThatCannotOpenFailsOnlyItsOwnCodec() {
        val verified = DecoderSelfCheck.verifiedCodecs(::clip) { codec ->
            if (codec == AudioCodec.FLAC) throw DecoderException("flac decoder could not be set up") else matching(codec)
        }
        assertEquals(setOf(AudioCodec.MP3), verified)
    }

    @Test
    fun theWholeClipReachesTheDecoder() {
        val decoders = mutableListOf<FakeDecoder>()
        DecoderSelfCheck.verifiedCodecs(::clip) { codec -> matching(codec).also(decoders::add) }
        assertEquals(AudioCodec.entries.map { clip(it).size }, decoders.map { it.written })
    }
}
