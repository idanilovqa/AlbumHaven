package org.albumhaven.playback.engine

/** The bytes of an encoded stream from its first byte, as they arrive. */
class ByteStore(initialCapacity: Int = 64 * 1024) {
    var bytes = ByteArray(initialCapacity)
        private set
    var size = 0
        private set

    fun append(source: ByteArray, offset: Int, length: Int) {
        if (size + length > bytes.size) {
            var capacity = bytes.size
            while (capacity < size + length) capacity *= 2
            bytes = bytes.copyOf(capacity)
        }
        System.arraycopy(source, offset, bytes, size, length)
        size += length
    }

    fun copyOfRange(from: Int, to: Int): ByteArray = bytes.copyOfRange(from, to)
}

/**
 * Where a seek inside the received bytes starts decoding: [prefix] then the bytes from
 * [byteOffset], dropping [skipFrames] decoded frames and keeping [totalFrames]: exactly the
 * window the server would send for that seek.
 */
class LocalSeekWindow(val prefix: ByteArray, val byteOffset: Int, val skipFrames: Long, val totalFrames: Long)

/** The index for a stream sent from its first frame: MP3 by frame offsets, original FLAC by frame starts. */
fun seekIndexFor(codec: org.albumhaven.playback.decode.AudioCodec, firstSample: Long, totalFrames: Long): EncodedSeekIndex? = when {
    codec == org.albumhaven.playback.decode.AudioCodec.MP3 -> Mp3SeekIndex(firstSample, totalFrames)
    firstSample == 0L -> FlacSeekIndex(totalFrames)
    else -> null
}

/** Indexes a stream's received bytes so a seek into them decodes on the device. */
interface EncodedSeekIndex {
    /** Indexes whatever the store holds now. */
    fun update(store: ByteStore)

    /** The window for [targetFrame], or null until the bytes holding it have arrived. */
    fun window(store: ByteStore, targetFrame: Long): LocalSeekWindow?
}

/**
 * An MP3 stream the server sent from its first audio frame (mp3_stream_map.Mp3StreamMap.window
 * with start 0): frame offsets are scanned with the server's own header rules, and a seek window
 * keeps its eight frames of preroll, so the bit reservoir and overlap rebuild as on the server.
 */
class Mp3SeekIndex(private val firstSample: Long, private val totalFrames: Long) : EncodedSeekIndex {
    private var offsets = IntArray(1024)
    private var frames = 0
    private var scanned = 0
    private var samplesPerFrame = 0
    private var ended = false

    override fun update(store: ByteStore) {
        while (!ended) {
            val header = parseHeader(store.bytes, scanned, store.size) ?: run {
                // A header cut off by the end of what arrived is read once the rest arrives.
                if (scanned + 4 <= store.size) ended = true
                null
            } ?: return
            val (frameBytes, samples) = header
            if (scanned + frameBytes > store.size) return
            if (samplesPerFrame == 0) samplesPerFrame = samples
            if (samples != samplesPerFrame) {
                ended = true
                return
            }
            if (frames == offsets.size) offsets = offsets.copyOf(frames * 2)
            offsets[frames++] = scanned
            scanned += frameBytes
        }
    }

    override fun window(store: ByteStore, targetFrame: Long): LocalSeekWindow? {
        if (samplesPerFrame == 0 || targetFrame < 0 || targetFrame >= totalFrames) return null
        val keptStart = firstSample + targetFrame
        val audioFrame = (keptStart / samplesPerFrame).toInt()
        // The target's frame must have arrived whole: the frame after it is indexed.
        if (audioFrame + 1 >= frames) return null
        val firstSent = maxOf(0, audioFrame - SEEK_PREROLL_FRAMES)
        return LocalSeekWindow(
            prefix = ByteArray(0),
            byteOffset = offsets[firstSent],
            skipFrames = keptStart - firstSent.toLong() * samplesPerFrame,
            totalFrames = totalFrames - targetFrame,
        )
    }

    companion object {
        /** `_SEEK_PREROLL_FRAMES` in music_app/services/mp3_stream_map.py. */
        const val SEEK_PREROLL_FRAMES = 8
        private val BITRATES_MPEG1 = intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)
        private val BITRATES_MPEG2 = intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
        private val SAMPLE_RATES = intArrayOf(44_100, 48_000, 32_000)

        /** `parse_mp3_frame_header` in music_app/services/mp3_gapless.py: (frame bytes, samples) of a Layer III header. */
        fun parseHeader(data: ByteArray, offset: Int, size: Int): Pair<Int, Int>? {
            if (offset + 4 > size) return null
            val word = ((data[offset].toInt() and 0xFF) shl 24) or ((data[offset + 1].toInt() and 0xFF) shl 16) or
                ((data[offset + 2].toInt() and 0xFF) shl 8) or (data[offset + 3].toInt() and 0xFF)
            val version = (word ushr 19) and 3
            val layer = (word ushr 17) and 3
            val bitrateIndex = (word ushr 12) and 15
            val rateIndex = (word ushr 10) and 3
            if ((word ushr 21) != 0x7ff || version == 1 || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3) {
                return null
            }
            val divisor = when (version) { 3 -> 1; 2 -> 2; else -> 4 }
            val rate = SAMPLE_RATES[rateIndex] / divisor
            val samples = if (version == 3) 1152 else 576
            val bitrate = (if (version == 3) BITRATES_MPEG1 else BITRATES_MPEG2)[bitrateIndex] * 1000
            return (samples / 8 * bitrate / rate + ((word ushr 9) and 1)) to samples
        }
    }
}

/**
 * A FLAC stream the server sent from its first sample: its 42-byte header (fLaC and STREAMINFO),
 * then frames. Frame headers are found by their sync code and CRC-8 and must continue the sample
 * count, so audio that happens to look like a header is never taken for one. A seek decodes from
 * the frame holding the target after the same header, dropping the samples before the target:
 * lossless, so the very samples the server's re-framed stream holds.
 */
class FlacSeekIndex(private val totalFrames: Long) : EncodedSeekIndex {
    private var offsets = IntArray(1024)
    private var firstSamples = LongArray(1024)
    private var frames = 0
    private var scanned = HEADER_BYTES
    private var nextSample = 0L
    private var fixedBlockSize = 0

    override fun update(store: ByteStore) {
        if (store.size < HEADER_BYTES) return
        if (fixedBlockSize == 0) {
            val data = store.bytes
            if (data[0] != 'f'.code.toByte() || data[1] != 'L'.code.toByte()) return
            val minBlock = ((data[8].toInt() and 0xFF) shl 8) or (data[9].toInt() and 0xFF)
            val maxBlock = ((data[10].toInt() and 0xFF) shl 8) or (data[11].toInt() and 0xFF)
            fixedBlockSize = if (minBlock == maxBlock) maxBlock else -1
        }
        while (scanned + MAX_HEADER_BYTES <= store.size) {
            val header = parseHeader(store.bytes, scanned)
            if (header != null && header.first == nextSample) {
                if (frames == offsets.size) {
                    offsets = offsets.copyOf(frames * 2)
                    firstSamples = firstSamples.copyOf(frames * 2)
                }
                offsets[frames] = scanned
                firstSamples[frames++] = header.first
                nextSample = header.first + header.second
                scanned += MIN_FRAME_BYTES
            } else {
                scanned += 1
            }
        }
    }

    override fun window(store: ByteStore, targetFrame: Long): LocalSeekWindow? {
        if (targetFrame < 0 || targetFrame >= totalFrames) return null
        // The frame holding the target must have arrived whole: a later frame is indexed.
        var index = -1
        for (candidate in frames - 2 downTo 0) {
            if (firstSamples[candidate] <= targetFrame) {
                index = candidate
                break
            }
        }
        if (index < 0 || firstSamples[index + 1] <= targetFrame) return null
        return LocalSeekWindow(
            prefix = store.copyOfRange(0, HEADER_BYTES),
            byteOffset = offsets[index],
            skipFrames = targetFrame - firstSamples[index],
            totalFrames = totalFrames - targetFrame,
        )
    }

    /** (first sample, block size) of a valid frame header at [offset], or null. */
    private fun parseHeader(data: ByteArray, offset: Int): Pair<Long, Int>? {
        if ((data[offset].toInt() and 0xFF) != 0xFF) return null
        val second = data[offset + 1].toInt() and 0xFF
        if (second != 0xF8 && second != 0xF9) return null
        val variable = second == 0xF9
        val blockCode = (data[offset + 2].toInt() and 0xFF) ushr 4
        val rateCode = data[offset + 2].toInt() and 0x0F
        val third = data[offset + 3].toInt() and 0xFF
        if (blockCode == 0 || rateCode == 15 || (third ushr 4) > 10 || ((third ushr 1) and 7) == 3 || (third and 1) != 0) return null
        var position = offset + 4
        // The frame or sample number, coded like UTF-8 in one to seven bytes.
        val lead = data[position].toInt() and 0xFF
        val extra = when {
            lead and 0x80 == 0 -> 0
            lead and 0xE0 == 0xC0 -> 1
            lead and 0xF0 == 0xE0 -> 2
            lead and 0xF8 == 0xF0 -> 3
            lead and 0xFC == 0xF8 -> 4
            lead and 0xFE == 0xFC -> 5
            lead == 0xFE -> 6
            else -> return null
        }
        var number = (if (extra == 0) lead else lead and (0x3F ushr extra)).toLong()
        position += 1
        repeat(extra) {
            val continuation = data[position].toInt() and 0xFF
            if (continuation and 0xC0 != 0x80) return null
            number = (number shl 6) or (continuation and 0x3F).toLong()
            position += 1
        }
        val blockSize = when (blockCode) {
            1 -> 192
            in 2..5 -> 576 shl (blockCode - 2)
            6 -> (data[position++].toInt() and 0xFF) + 1
            7 -> (((data[position].toInt() and 0xFF) shl 8) or (data[position + 1].toInt() and 0xFF)).also { position += 2 } + 1
            else -> 256 shl (blockCode - 8)
        }
        when (rateCode) {
            12 -> position += 1
            13, 14 -> position += 2
        }
        if (crc8(data, offset, position) != (data[position].toInt() and 0xFF)) return null
        val firstSample = when {
            variable -> number
            fixedBlockSize > 0 -> number * fixedBlockSize
            else -> return null
        }
        return firstSample to blockSize
    }

    private fun crc8(data: ByteArray, from: Int, to: Int): Int {
        var crc = 0
        for (index in from until to) {
            crc = crc xor (data[index].toInt() and 0xFF)
            repeat(8) { crc = if (crc and 0x80 != 0) ((crc shl 1) xor 0x07) and 0xFF else (crc shl 1) and 0xFF }
        }
        return crc
    }

    private companion object {
        /** `fLaC`, the STREAMINFO block header and STREAMINFO: what read_flac_layout sends first. */
        const val HEADER_BYTES = 42

        /** The longest frame header: sync, codes, a seven-byte number, two size and two rate bytes, CRC. */
        const val MAX_HEADER_BYTES = 16

        /** Even a one-sample frame carries its header, subframe headers and CRC-16. */
        const val MIN_FRAME_BYTES = 10
    }
}
