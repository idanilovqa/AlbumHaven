package org.albumhaven.playback.decode

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/** The real native decoders on a device: the same checks the web build passes. */
@RunWith(AndroidJUnit4::class)
class StreamDecoderTest {
    private fun clip(codec: AudioCodec): ByteArray =
        InstrumentationRegistry.getInstrumentation().context.assets.open(DecoderSelfCheck.clipAsset(codec)).use { it.readBytes() }

    @Test
    fun bothNativeDecodersPassTheWebPlayersSelfCheck() {
        assertEquals(AudioCodec.entries.toSet(), DecoderSelfCheck.verifiedCodecs(::clip))
    }

    @Test
    fun bytesWrittenInPiecesDecodeExactlyAsAWholeWrite() {
        for (codec in AudioCodec.entries) {
            val bytes = clip(codec)
            val frames = StreamDecoder.open(codec).use { decoder ->
                bytes.toList().chunked(97).forEach { decoder.write(it.toByteArray()) }
                decoder.end()
                generateSequence { decoder.decode() }.sumOf { it.frames }
            }
            assertEquals(codec.wire, DecoderSelfCheck.EXPECTED.getValue(codec).frames, frames)
        }
    }

    @Test
    fun cancelWakesADecodeWaitingForBytes() {
        for (codec in AudioCodec.entries) {
            StreamDecoder.open(codec).use { decoder ->
                val waiting = CountDownLatch(1)
                val failed = CountDownLatch(1)
                val thread = Thread {
                    waiting.countDown()
                    try {
                        decoder.decode()
                    } catch (_: DecoderException) {
                        failed.countDown()
                    }
                }
                thread.start()
                assertTrue(waiting.await(5, TimeUnit.SECONDS))
                decoder.cancel()
                if (!failed.await(5, TimeUnit.SECONDS)) fail("${codec.wire} decode stayed blocked after cancel")
                thread.join(5_000)
            }
        }
    }

    @Test
    fun anEndedEmptyStreamDecodesNothing() {
        for (codec in AudioCodec.entries) {
            StreamDecoder.open(codec).use { decoder ->
                decoder.end()
                assertNull(codec.wire, generateSequence { decoder.decode() }.firstOrNull { it.frames > 0 })
            }
        }
    }
}
