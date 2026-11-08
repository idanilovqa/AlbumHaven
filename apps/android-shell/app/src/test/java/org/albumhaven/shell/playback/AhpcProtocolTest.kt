package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class AhpcProtocolTest {
    // Bytes from music_app.services.playback_pcm.pack_pcm_frame(generation=7, stream_id=3,
    // role="continuity", sequence=2, frame_count=2, pcm=struct.pack("<4f", 0.5, -0.25, 1.0, -1.0)).
    private val pythonFrame =
        hex("4148504301010000000000070000000300000002000000020000003f000080be0000803f000080bf")

    // pack_pcm_frame(generation=0x80000001, stream_id=0xFFFFFFFF, role="current", sequence=0,
    // frame_count=1, pcm=struct.pack("<2f", 0.0, 0.125)): header integers are unsigned.
    private val pythonUnsignedFrame =
        hex("414850430100000080000001ffffffff0000000000000001000000000000003e")

    @Test
    fun decodesTheServerFrameLayout() {
        val frame = AhpcFrameCodec.decode(pythonFrame) as AhpcPcmFrame

        assertEquals(PcmRole.CONTINUITY, frame.role)
        assertEquals(7L, frame.generation)
        assertEquals(3L, frame.streamId)
        assertEquals(2L, frame.sequence)
        assertEquals(2, frame.frameCount)
        val ring = PcmRing(4)
        ring.appendLittleEndian(frame.bytes, frame.payloadOffset, frame.frameCount)
        assertArrayEquals(floatArrayOf(0.5f, -0.25f, 1f, -1f, 0f, 0f, 0f, 0f), ring.samples, 0f)
        assertArrayEquals(pythonFrame, pcmFrame(PcmRole.CONTINUITY, 7, 3, 2, floatArrayOf(0.5f, -0.25f, 1f, -1f)))
    }

    @Test
    fun decodesTheServerEncodedFrameLayout() {
        // pack_encoded_frame(generation=7, stream_id=3, role="continuity", sequence=2, payload=b"abc").
        val frame = AhpcFrameCodec.decode(hex("41485043020100000000000700000003000000020000000361626" + "3")) as AhpcEncodedFrame

        assertEquals(PcmRole.CONTINUITY, frame.role)
        assertEquals(7L, frame.generation)
        assertEquals(3L, frame.streamId)
        assertEquals(2L, frame.sequence)
        assertEquals(3, frame.payloadLength)
        assertEquals("abc", String(frame.bytes, frame.payloadOffset, frame.payloadLength))
    }

    @Test
    fun readsHeaderIntegersAsUnsigned() {
        val frame = AhpcFrameCodec.decode(pythonUnsignedFrame)

        assertEquals(PcmRole.CURRENT, frame.role)
        assertEquals(0x80000001L, frame.generation)
        assertEquals(0xFFFFFFFFL, frame.streamId)
    }

    @Test
    fun rejectsMalformedFramesWithTheWebEngineReasons() {
        fun reason(bytes: ByteArray) = assertThrows(AhpcProtocolException::class.java) {
            AhpcFrameCodec.decode(bytes)
        }.message

        assertEquals("frame is shorter than the AHPC header", reason(pythonFrame.copyOf(23)))
        assertEquals("bad AHPC magic", reason(pythonFrame.copyOf().also { it[0] = 'X'.code.toByte() }))
        assertEquals("unsupported AHPC version", reason(pythonFrame.copyOf().also { it[4] = 3 }))
        // Version 2 counts payload bytes, so a PCM frame's frame count no longer matches its length.
        assertEquals("declared frame length does not match payload", reason(pythonFrame.copyOf().also { it[4] = 2 }))
        assertEquals("invalid stream role", reason(pythonFrame.copyOf().also { it[5] = 2 }))
        assertEquals("nonzero reserved flags", reason(pythonFrame.copyOf().also { it[7] = 1 }))
        assertEquals("declared frame length does not match payload", reason(pythonFrame.copyOf(36)))
        assertEquals(
            "declared frame length does not match payload",
            reason(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(0))),
        )
    }

    @Test
    fun encodesControlsAsTheServerReadsThem() {
        val track = PcmTrack("signed.ref", 12.5)
        fun json(control: PcmClientControl) = JSONObject(AhpcControlCodec.encode(control))

        val open = json(PcmClientControl.Open(4, 9, PcmRole.CONTINUITY, track, 480, RATE))
        assertEquals(
            setOf("type", "generation", "streamId", "role", "playbackRef", "startFrame", "sampleRate", "durationSeconds"),
            open.keys().asSequence().toSet(),
        )
        assertEquals("open", open.getString("type"))
        assertEquals("continuity", open.getString("role"))
        assertEquals("signed.ref", open.getString("playbackRef"))
        assertEquals(480, open.getInt("startFrame"))
        assertEquals(RATE, open.getInt("sampleRate"))
        assertEquals(12.5, open.getDouble("durationSeconds"), 0.0)

        // An encoded open names the codecs this client decodes and, on a weak connection, 320 kbps.
        val encoded = json(PcmClientControl.Open(4, 9, PcmRole.CURRENT, track, 0, RATE, listOf("mp3", "flac"), "320"))
        assertEquals(listOf("mp3", "flac"), encoded.getJSONArray("codecs").let { array -> (0 until array.length()).map(array::getString) })
        assertEquals("320", encoded.getString("quality"))

        val credit = json(PcmClientControl.Credit(4, 9, 48_000))
        assertEquals(setOf("type", "generation", "streamId", "frames"), credit.keys().asSequence().toSet())
        assertEquals(listOf("credit", 4, 9, 48_000), listOf("type", "generation", "streamId", "frames").map(credit::get))
        val promote = json(PcmClientControl.Promote(4, 9))
        assertEquals("continuity", promote.getString("fromRole"))
        assertEquals("current", promote.getString("toRole"))
        assertEquals("seek-replaced", json(PcmClientControl.Close(4, 9, "seek-replaced")).getString("reason"))
    }

    @Test
    fun decodesServerEvents() {
        val metadata = AhpcControlCodec.decode(
            """{"type":"metadata","generation":1,"streamId":2,"role":"current","sampleRate":48000,""" +
                """"channels":2,"provisionalTotalFrames":96000,"requestedStartFrame":0,"timelineStartFrame":0}""",
        )
        assertEquals(
            PcmServerEvent.Metadata(1, 2, "current", 48_000, 2, 96_000, 0, 0, null),
            metadata,
        )
        assertEquals(
            PcmServerEvent.Metadata(1, 2, "current", 44_100, 2, 96_000, 0, 0, "mp3", 1105, 94_895, 65_536),
            AhpcControlCodec.decode(
                """{"codec":"mp3","skipFrames":1105,"totalFrames":94895,"initialCreditBytes":65536,"type":"metadata",""" +
                    """"generation":1,"streamId":2,"role":"current","sampleRate":44100,"channels":2,""" +
                    """"provisionalTotalFrames":96000,"requestedStartFrame":0,"timelineStartFrame":0}""",
            ),
        )
        assertEquals(
            PcmServerEvent.Eos(1, 2, "continuity", 10, 10),
            AhpcControlCodec.decode(
                """{"type":"eos","generation":1,"streamId":2,"role":"continuity","emittedFrames":10,"authoritativeTotalFrames":10}""",
            ),
        )
        assertEquals(
            PcmServerEvent.Promoted(1, 2, "current"),
            AhpcControlCodec.decode("""{"type":"promoted","generation":1,"streamId":2,"role":"current"}"""),
        )
        assertEquals(
            PcmServerEvent.Error(1, 2, "decoder_failed", "Audio decoder failed."),
            AhpcControlCodec.decode(
                """{"type":"error","generation":1,"streamId":2,"role":"current","code":"decoder_failed",""" +
                    """"message":"Audio decoder failed.","recoverable":false}""",
            ),
        )
        assertEquals(
            PcmServerEvent.RateMismatch(1, 2, 44_100),
            AhpcControlCodec.decode(
                """{"type":"rate-mismatch","generation":1,"streamId":2,"sampleRate":44100,"fallbackSampleRate":48000}""",
            ),
        )
        val fractional = AhpcControlCodec.decode("""{"type":"eos","generation":1.5,"streamId":2}""")
        assertNull(fractional.generation)
        assertThrows(AhpcProtocolException::class.java) { AhpcControlCodec.decode("[]") }
    }

    @Test
    fun ringWrapsWithoutLosingOrReorderingFrames() {
        val ring = PcmRing(4)
        fun append(vararg values: Float) {
            val bytes = pcmFrame(PcmRole.CURRENT, 1, 1, 0, values)
            ring.appendLittleEndian(bytes, AhpcFrameCodec.HEADER_BYTES, values.size / 2)
        }
        append(1f, 1f, 2f, 2f, 3f, 3f)
        ring.consume(2)
        append(4f, 4f, 5f, 5f, 6f, 6f)

        assertEquals(4, ring.bufferedFrames)
        assertEquals(2, ring.contiguousFrames())
        assertEquals(3f, ring.samples[ring.readFrame * 2], 0f)
        ring.consume(2)
        assertEquals(0, ring.readFrame)
        assertEquals(floatArrayOf(5f, 5f, 6f, 6f).toList(), ring.samples.copyOfRange(0, 4).toList())
        assertThrows(IllegalArgumentException::class.java) { ring.consume(3) }
        assertThrows(IllegalArgumentException::class.java) {
            ring.appendLittleEndian(pcmFrame(PcmRole.CURRENT, 1, 1, 0, FloatArray(6)), 24, 3)
        }
    }

    private fun hex(value: String) = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
