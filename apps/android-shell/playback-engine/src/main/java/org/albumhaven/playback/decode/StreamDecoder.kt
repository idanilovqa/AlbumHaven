package org.albumhaven.playback.decode

/** Codecs the server streams encoded (`codecs` in the AHPC `open`). */
enum class AudioCodec(val wire: String, internal val nativeId: Int) {
    MP3("mp3", 1),
    FLAC("flac", 2);

    companion object {
        fun fromWire(wire: String?): AudioCodec? = entries.firstOrNull { it.wire == wire }
    }
}

/** Interleaved stereo float frames; the first two channels play, and mono plays on both. */
class DecodedAudio(val samples: FloatArray, val sampleRate: Int) {
    val frames: Int get() = samples.size / 2
}

class DecoderException(message: String) : Exception(message)

/**
 * An encoded stream's decoder. [write], [end] and [cancel] may be called from any thread;
 * [decode] runs on one decode thread, and [close] follows once that thread has left [decode].
 */
interface AudioDecoder : AutoCloseable {
    fun write(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset)

    /** Bytes written and not decoded yet; callable from any thread. */
    val bufferedBytes: Int

    /** No more bytes follow; [decode] returns null once it has decoded them all. */
    fun end()

    /** Wakes a waiting [decode], which then throws. */
    fun cancel()

    /**
     * Waits for bytes and returns what they decode (possibly nothing yet), or null once every
     * byte is decoded after [end]. Throws [DecoderException] on a decoder error or a [cancel].
     */
    fun decode(): DecodedAudio?
}

/** [AudioDecoder] over the same mpg123 and libFLAC builds as the web player's pinned decoders. */
class StreamDecoder private constructor(private var handle: Long) : AudioDecoder {

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        require(offset >= 0 && length >= 0 && offset + length <= bytes.size) { "range is outside the bytes" }
        if (length > 0 && !nativeWrite(live(), bytes, offset, length)) throw DecoderException("decoder ran out of memory")
    }

    override val bufferedBytes: Int get() = nativeBufferedBytes(live())

    override fun end() = nativeEnd(live())

    override fun cancel() = nativeCancel(live())

    override fun decode(): DecodedAudio? {
        val handle = live()
        return when (nativeProcess(handle)) {
            1 -> DecodedAudio(nativeSamples(handle), nativeSampleRate(handle))
            0 -> null
            else -> throw DecoderException("decoding failed or was cancelled")
        }
    }

    override fun close() {
        if (handle == 0L) return
        nativeClose(handle)
        handle = 0
    }

    private fun live(): Long = handle.takeIf { it != 0L } ?: throw IllegalStateException("decoder is closed")

    companion object {
        init {
            System.loadLibrary("ahdecoders")
        }

        fun open(codec: AudioCodec): StreamDecoder {
            val handle = nativeOpen(codec.nativeId)
            if (handle == 0L) throw DecoderException("${codec.wire} decoder could not be set up")
            return StreamDecoder(handle)
        }

        @JvmStatic private external fun nativeOpen(codec: Int): Long
        @JvmStatic private external fun nativeWrite(handle: Long, bytes: ByteArray, offset: Int, length: Int): Boolean
        @JvmStatic private external fun nativeBufferedBytes(handle: Long): Int
        @JvmStatic private external fun nativeEnd(handle: Long)
        @JvmStatic private external fun nativeCancel(handle: Long)
        @JvmStatic private external fun nativeProcess(handle: Long): Int
        @JvmStatic private external fun nativeSamples(handle: Long): FloatArray
        @JvmStatic private external fun nativeSampleRate(handle: Long): Int
        @JvmStatic private external fun nativeClose(handle: Long)
    }
}
