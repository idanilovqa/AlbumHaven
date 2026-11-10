package org.albumhaven.playback.decode

/** What a decoding reports, always on the playback thread. */
interface EncodedDecodeListener {
    fun decoded(audio: DecodedAudio)

    /** Every written byte is decoded after [EncodedDecoding.end]. */
    fun finished()

    fun failed(message: String)
}

/**
 * One encoded stream's decoding, driven from the playback thread. It decodes only as far as
 * [request] asks, so compressed audio stays compressed until the player needs it.
 */
interface EncodedDecoding {
    fun write(bytes: ByteArray, offset: Int, length: Int)

    /** No more bytes follow. */
    fun end()

    /** Asks for about [frames] more decoded frames than have been delivered; 0 pauses decoding. */
    fun request(frames: Int)

    /** Encoded bytes written and not decoded yet. */
    val bufferedBytes: Int

    /** Stops decoding; nothing more is reported. */
    fun close()
}

fun interface EncodedDecoders {
    fun open(codec: AudioCodec, listener: EncodedDecodeListener): EncodedDecoding
}

/**
 * Runs each decoding's [AudioDecoder] on its own thread and reports through [post], which
 * runs the listener on the playback thread.
 */
class ThreadedEncodedDecoders(
    private val post: (Runnable) -> Unit,
    private val open: (AudioCodec) -> AudioDecoder = StreamDecoder::open,
) : EncodedDecoders {
    override fun open(codec: AudioCodec, listener: EncodedDecodeListener): EncodedDecoding =
        Worker(open(codec), listener).also { it.start() }

    private inner class Worker(private val decoder: AudioDecoder, private val listener: EncodedDecodeListener) :
        EncodedDecoding {
        private val lock = Object()
        private var wanted = 0
        @Volatile private var closed = false

        // Set under [lock] once the decode thread freed the native decoder; nothing may touch it after.
        private var released = false
        private val thread = Thread(::run, "AlbumHavenDecode")

        fun start() = thread.start()

        private inline fun <T> withDecoder(fallback: T, action: (AudioDecoder) -> T): T =
            synchronized(lock) { if (closed || released) fallback else action(decoder) }

        override fun write(bytes: ByteArray, offset: Int, length: Int) = withDecoder(Unit) { it.write(bytes, offset, length) }

        override fun end() = withDecoder(Unit) { it.end() }

        override fun request(frames: Int) = synchronized(lock) {
            wanted = frames
            lock.notifyAll()
        }

        override val bufferedBytes: Int get() = withDecoder(0) { it.bufferedBytes }

        override fun close() = synchronized(lock) {
            if (closed) return
            closed = true
            if (!released) decoder.cancel()
            lock.notifyAll()
        }

        private fun report(action: () -> Unit) = post(Runnable { if (!closed) action() })

        private fun run() {
            try {
                while (true) {
                    synchronized(lock) {
                        while (wanted <= 0 && !closed) lock.wait()
                    }
                    if (closed) return
                    val audio = decoder.decode()
                    if (audio == null) {
                        report(listener::finished)
                        return
                    }
                    if (audio.frames == 0) continue
                    synchronized(lock) { wanted -= audio.frames }
                    report { listener.decoded(audio) }
                }
            } catch (error: DecoderException) {
                report { listener.failed(error.message ?: "decoding failed") }
            } catch (_: InterruptedException) {
                // Closing ends the thread.
            } finally {
                // The native decoder goes once no thread can be inside it.
                synchronized(lock) {
                    released = true
                    decoder.close()
                }
            }
        }
    }
}
