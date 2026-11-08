package org.albumhaven.playback.engine

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class EncodedSeekIndexTest {
    /** MPEG-1 Layer III at 44.1 kHz, 128 kbps without padding: 417-byte frames of 1152 samples. */
    private fun mp3Frames(count: Int): ByteArray {
        val frame = ByteArray(417).also {
            it[0] = 0xFF.toByte(); it[1] = 0xFB.toByte(); it[2] = 0x90.toByte(); it[3] = 0x00
        }
        return ByteArray(417 * count) { frame[it % 417] }
    }

    private fun store(bytes: ByteArray, upTo: Int = bytes.size) = ByteStore().also { it.append(bytes, 0, upTo) }

    @Test
    fun mp3WindowsAreTheServersWindowsForEachTarget() {
        val bytes = mp3Frames(100)
        val firstSample = 1105L
        val total = 100L * 1152 - firstSample - 1000
        val index = Mp3SeekIndex(firstSample, total)
        val store = store(bytes)
        index.update(store)
        for (target in listOf(0L, 1L, 20_000L, 57_600L, 90_000L)) {
            // mp3_stream_map.Mp3StreamMap.window: preroll of eight frames before the target's frame.
            val kept = firstSample + target
            val firstSent = maxOf(0L, kept / 1152 - 8)
            val window = index.window(store, target)!!
            assertEquals(firstSent.toInt() * 417, window.byteOffset)
            assertEquals(kept - firstSent * 1152, window.skipFrames)
            assertEquals(total - target, window.totalFrames)
        }
    }

    @Test
    fun anMp3TargetWhoseFrameHasNotArrivedHasNoWindow() {
        val bytes = mp3Frames(100)
        val index = Mp3SeekIndex(1105, 100_000)
        val partial = store(bytes, 417 * 30 + 100)
        index.update(partial)
        assertNull(index.window(partial, 29L * 1152))
        assertEquals(417 * 19, index.window(partial, 27L * 1152 - 1105)!!.byteOffset)
        // The rest arrives and is indexed from where the scan stopped.
        partial.append(bytes, 417 * 30 + 100, bytes.size - (417 * 30 + 100))
        index.update(partial)
        assertEquals(417 * 21, index.window(partial, 29L * 1152)!!.byteOffset)
    }

    private fun crc8(bytes: List<Int>): Int {
        var crc = 0
        for (byte in bytes) {
            crc = crc xor byte
            repeat(8) { crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x07) and 0xFF else (crc shl 1) and 0xFF }
        }
        return crc
    }

    /** A fixed-blocksize FLAC stream: header, then 4096-sample frames of [frameBytes] bytes. */
    private fun flac(frames: Int, frameBytes: Int = 300): Pair<ByteArray, ByteArray> {
        val header = ByteArray(42)
        "fLaC".toByteArray().copyInto(header)
        header[4] = 0x80.toByte(); header[7] = 34
        header[8] = 0x10; header[9] = 0x00; header[10] = 0x10; header[11] = 0x00
        val out = header.toMutableList()
        repeat(frames) { number ->
            val frameHeader = mutableListOf(0xFF, 0xF8, 0xC9, 0x18)
            // Frame number in the UTF-8-like coding.
            if (number < 0x80) frameHeader += number else frameHeader += listOf(0xC0 or (number shr 6), 0x80 or (number and 0x3F))
            frameHeader += crc8(frameHeader)
            out += frameHeader.map { it.toByte() }
            // Audio bytes that include a fake sync whose CRC does not match.
            out += List(frameBytes - frameHeader.size) { index -> if (index == 50) 0xFF.toByte() else if (index == 51) 0xF8.toByte() else 7 }
        }
        return out.toByteArray() to header
    }

    @Test
    fun flacWindowsStartAtTheTargetsFrameAfterTheHeader() {
        val (bytes, header) = flac(200)
        val index = FlacSeekIndex(200L * 4096)
        val store = store(bytes)
        index.update(store)
        val window = index.window(store, 150L * 4096 + 1234)!!
        assertEquals(42 + 150 * 300, window.byteOffset)
        assertEquals(1234L, window.skipFrames)
        assertEquals(200L * 4096 - (150L * 4096 + 1234), window.totalFrames)
        assertArrayEquals(header, window.prefix)
        // The last frame's end is unknown until a later frame or the end arrives.
        assertNull(index.window(store, 199L * 4096))
    }
}
