package org.albumhaven.playback.engine

import androidx.annotation.VisibleForTesting
import kotlin.math.roundToLong
import org.albumhaven.playback.decode.AudioCodec
import org.albumhaven.playback.decode.DecodedAudio
import org.albumhaven.playback.decode.EncodedDecodeListener
import org.albumhaven.playback.decode.EncodedDecoders
import org.albumhaven.playback.decode.EncodedDecoding

/**
 * Buffer and credit limits of the web streaming engine
 * (music_app/static/js/runtime/player-streaming-engine.js and core-state-and-helpers.js).
 * Every limit is in seconds of the stream rate, so at 48 kHz the maximum credit is 48,000 frames.
 */
data class PcmEngineConfig(
    val sampleRate: Int,
    val currentBufferSeconds: Int = 12,
    val continuityBufferSeconds: Int = 12,
) {
    init {
        require(sampleRate in 8_000..192_000) { "sample rate is outside the PCM socket range" }
        require(currentBufferSeconds > MAX_CREDIT_SECONDS) { "current buffer must exceed one credit" }
        require(continuityBufferSeconds > 0) { "continuity buffer must be positive" }
    }

    fun frames(seconds: Double): Int = (seconds * sampleRate).roundToLong().toInt()

    val currentCapacityFrames: Int get() = frames(currentBufferSeconds.toDouble())
    val continuityCapacityFrames: Int get() = frames(continuityBufferSeconds.toDouble())
    val maxCreditFrames: Int get() = frames(MAX_CREDIT_SECONDS)

    companion object {
        const val MAX_CREDIT_SECONDS = 1.0
        const val CREDIT_LOW_WATER_SECONDS = 0.25
        /** A start or seek may be heard from this much PCM, if the rest arrives fast enough. */
        const val START_PLAYBACK_SECONDS = 0.5

        /** How many times faster than playback the PCM after the first must arrive for a short start. */
        const val PLAY_THROUGH_ARRIVAL_RATE = 2

        /** Otherwise, and after an underrun, the stream waits for this much, so a slow network does not stutter. */
        const val REBUFFER_CUSHION_SECONDS = 2.0
        const val QUEUED_NEXT_PREPARE_SECONDS = 3.0

        /** A seek prepares up to the cushion while the old place keeps playing; it may cut over sooner. */
        const val SEEK_PREPARE_SECONDS = REBUFFER_CUSHION_SECONDS
        const val QUEUED_NEXT_CURRENT_CUSHION_SECONDS = 1.0

        /** `dispatchActiveStreamingLoop`: a loop of at most five seconds is a `short-loop`. */
        const val SHORT_LOOP_MAX_SECONDS = 5

        /** The Web Audio render quantum the worklet's buffered seek must back after its skip. */
        const val RENDER_QUANTUM_FRAMES = 128

        // Encoded streams, as `refillStreamingEncodedBytes` and `streamingEncodedBufferBytes` size them.
        const val ENCODED_CREDIT_BYTES = 64 * 1024

        /** Several credits in flight, so a slow round trip does not cap a lossless stream's throughput. */
        const val ENCODED_MAX_OUTSTANDING_BYTES = 4 * ENCODED_CREDIT_BYTES
        const val ENCODED_CURRENT_BUFFER_SECONDS = 120
        const val ENCODED_CONTINUITY_BUFFER_SECONDS = 30
        const val ENCODED_BUFFER_MIN_BYTES = 1024 * 1024
        const val ENCODED_BUFFER_MAX_BYTES = 16 * 1024 * 1024

        /** `STREAMING_FALLBACK_BYTES_PER_SECOND`, until the stream's own rate is measured. */
        const val ENCODED_FALLBACK_BYTES_PER_SECOND = 40_000
    }
}

fun interface PcmControlSender {
    /** Returns false when the socket cannot deliver the control. */
    fun send(control: PcmClientControl): Boolean
}

enum class PcmBoundaryKind { QUEUED_NEXT, SEEK, LOOP }

sealed interface PcmEngineEvent {
    /** The server accepted the open of a [NativePcmEngine.start] stream: its decoder runs. */
    data class StartAccepted(val streamId: Long) : PcmEngineEvent

    /** The first PCM of a [NativePcmEngine.start] stream arrived; [FirstFrame] follows once it can play through. */
    data class StartPcmReceived(val streamId: Long) : PcmEngineEvent
    data class FirstFrame(val streamId: Long, val timelineFrame: Long) : PcmEngineEvent
    data class Boundary(
        val kind: PcmBoundaryKind,
        val outgoingStreamId: Long,
        val incomingStreamId: Long,
        val timelineFrame: Long,
    ) : PcmEngineEvent
    data class Underrun(val streamId: Long, val timelineFrame: Long) : PcmEngineEvent
    data class Buffering(val active: Boolean, val streamId: Long) : PcmEngineEvent
    data class Ended(val streamId: Long, val timelineFrame: Long) : PcmEngineEvent
    /** The queued track has another native rate; it starts on a new engine after [Ended]. */
    data class RateChangeRequired(val track: PcmTrack, val sampleRate: Int) : PcmEngineEvent
    /** The started track has another native rate; nothing played, so it restarts on a new engine now. */
    data class StartRateRequired(val track: PcmTrack, val startFrame: Long, val sampleRate: Int) : PcmEngineEvent
    data class Failed(val code: String, val message: String) : PcmEngineEvent

    /** [codec]'s decoder failed; [Failed] follows, and later opens should not offer the codec. */
    data class DecoderFailed(val codec: AudioCodec) : PcmEngineEvent
}

/**
 * Native port of the web `AHPC` client: one PCM socket, at most a current and a
 * continuity decoder role, and one [PcmSink]. The continuity role is promoted by
 * writing its first sample right after the last current sample; the sink is never
 * stopped or flushed at a boundary. Not thread-safe: callers serialize every call.
 */
class NativePcmEngine(
    private val config: PcmEngineConfig,
    private val sink: PcmSink,
    private val controls: PcmControlSender,
    /** Generations stay unique on a shared socket when a rate change replaces the engine. */
    lastGeneration: Long = 0,
    /** Milliseconds on a monotonic clock. */
    private val clockMs: () -> Long = { System.nanoTime() / 1_000_000 },
    /** Decodes encoded streams; without it every stream is server-decoded PCM. */
    private val decoders: EncodedDecoders? = null,
    /** The codecs each open offers the server. */
    private val codecs: () -> Set<AudioCodec> = { emptySet() },
    /** The quality each open asks for: null for the original, or `320` on a weak connection. */
    private val quality: () -> String? = { null },
    /** Recently played tracks; a cached track starts and follows with no server round trip. */
    private val cache: TrackCache? = null,
    /** Indexes a stream's kept bytes for seeks on the device: (codec, first kept frame, kept frames). */
    private val seekIndexes: (AudioCodec, Long, Long) -> EncodedSeekIndex? = ::seekIndexFor,
    private val events: (PcmEngineEvent) -> Unit,
) {
    init {
        require(sink.sampleRate == config.sampleRate) { "sink rate differs from the engine rate" }
    }

    private enum class StreamKind {
        START, QUEUED_NEXT, SEEK, LOOP
    }

    private class Stream(
        val track: PcmTrack,
        val generation: Long,
        val streamId: Long,
        var role: PcmRole,
        val kind: StreamKind,
        val startFrame: Long,
        var targetBufferFrames: Int,
    ) {
        var nextSequence = 0L
        var metadataAccepted = false
        var inFlightFrames = 0
        var deferredCreditFrames = 0
        var initialCreditDeferred = false
        var receivedFrames = 0L
        /** When this stream's first PCM arrived, on the engine's clock; how fast the rest follows decides when it may be heard. */
        var firstPcmAtMs: Long? = null
        var eosReceived = false
        var acceptsPromotedContinuityWireRole = false
        var firstFrameRendered = false
        /** The range a loop stream was opened for; another range reopens it, as the web's identity does. */
        var loopRange: LoopRange? = null

        /** The codecs this stream's open offered; metadata may name only one of them. */
        var offeredCodecs: Set<AudioCodec> = emptySet()
        var encoded: EncodedStream? = null

        /** Played from the device's cache: the server never heard of it, so no control names it. */
        var local = false
    }

    /**
     * The web's encoded role (`createStreamingEncodedRole`): encoded bytes go to the decoder as they
     * arrive, under byte credits sized to minutes of audio, while the stream's frame credits are
     * met locally from decoded audio, trimmed to the server's sample map.
     */
    private inner class EncodedStream(
        val stream: Stream,
        val codec: AudioCodec,
        var skipFrames: Long,
        var remainingFrames: Long,
        initialCreditBytes: Int,
    ) : EncodedDecodeListener {
        var decoding: EncodedDecoding = checkNotNull(decoders).open(codec, this)
        var outstandingBytes = initialCreditBytes
        var receivedBytes = 0L
        val decoded = ArrayDeque<FloatArray>()
        var decodedHeadFrame = 0
        var decodedFrames = 0
        var localCreditFrames = 0
        var deliveredFrames = 0L

        /** Every frame the decoder produced, trimmed or not, for the stream's measured byte rate. */
        var decoderFrames = 0L
        var serverEos: PcmServerEvent.Eos? = null
        var decoderFinished = false
        var closed = false

        /** The stream's map as the server sent it. */
        val initialSkipFrames = skipFrames
        val initialTotalFrames = remainingFrames

        /**
         * A stream from the track's first frame keeps its bytes as they arrive, indexed, so a seek
         * into them decodes on the device and the whole track can be kept in the cache.
         */
        var store: ByteStore? = null
        var index: EncodedSeekIndex? = null

        /** A seek decoding from the kept bytes until its first audio is ready to cut over to. */
        var localSeek: LocalSeek? = null

        fun keepBytes() {
            if (stream.startFrame != 0L) return
            store = ByteStore()
            index = seekIndexes(codec, initialSkipFrames, initialTotalFrames)
        }

        fun write(bytes: ByteArray, offset: Int, length: Int) {
            decoding.write(bytes, offset, length)
            localSeek?.decoding?.write(bytes, offset, length)
            val kept = store ?: return
            if (kept.size + length > MAX_CACHED_TRACK_BYTES) {
                store = null
                index = null
                return
            }
            kept.append(bytes, offset, length)
            index?.update(kept)
        }

        fun end() {
            decoding.end()
            localSeek?.decoding?.end()
        }

        override fun decoded(audio: DecodedAudio) {
            if (closed || failed) return
            decoderFrames += audio.frames
            val skipped = minOf(skipFrames, audio.frames.toLong()).toInt()
            skipFrames -= skipped
            val kept = minOf((audio.frames - skipped).toLong(), remainingFrames).toInt()
            if (kept > 0) {
                remainingFrames -= kept
                decoded.addLast(audio.samples.copyOfRange(skipped * PcmRing.CHANNELS, (skipped + kept) * PcmRing.CHANNELS))
                decodedFrames += kept
            }
            pumpEncoded(stream)
        }

        override fun finished() {
            if (closed || failed) return
            decoderFinished = true
            pumpEncoded(stream)
        }

        override fun failed(message: String) {
            if (closed || failed) return
            events(PcmEngineEvent.DecoderFailed(codec))
            fail("decoder-failed", "The ${codec.wire} decoder failed: $message")
        }

        fun close() {
            if (closed) return
            closed = true
            decoding.close()
            localSeek?.decoding?.close()
            localSeek = null
        }
    }

    /**
     * A seek inside the bytes a stream already received, as Spotify seeks inside its download: a
     * second decoder starts at the server's own window for the target while the old place keeps
     * playing, and takes over once its first audio is decoded. Nothing is asked of the server.
     */
    private inner class LocalSeek(val encoded: EncodedStream, val targetFrame: Long, window: LocalSeekWindow) :
        EncodedDecodeListener {
        val decoding: EncodedDecoding = checkNotNull(decoders).open(encoded.codec, this)
        var skipFrames = window.skipFrames
        var remainingFrames = window.totalFrames
        val decoded = ArrayDeque<FloatArray>()
        var decodedFrames = 0
        var finished = false
        var committed = false

        init {
            val store = checkNotNull(encoded.store)
            if (window.prefix.isNotEmpty()) decoding.write(window.prefix, 0, window.prefix.size)
            decoding.write(store.bytes, window.byteOffset, store.size - window.byteOffset)
            if (encoded.serverEos != null) decoding.end()
            decoding.request(config.frames(LOCAL_SEEK_READY_SECONDS) * 2)
        }

        val ready: Boolean get() = finished || decodedFrames >= config.frames(LOCAL_SEEK_READY_SECONDS)

        override fun decoded(audio: DecodedAudio) {
            if (committed) return encoded.decoded(audio)
            val skipped = minOf(skipFrames, audio.frames.toLong()).toInt()
            skipFrames -= skipped
            val kept = minOf((audio.frames - skipped).toLong(), remainingFrames).toInt()
            if (kept <= 0) return
            remainingFrames -= kept
            decoded.addLast(audio.samples.copyOfRange(skipped * PcmRing.CHANNELS, (skipped + kept) * PcmRing.CHANNELS))
            decodedFrames += kept
        }

        override fun finished() {
            if (committed) encoded.finished() else finished = true
        }

        override fun failed(message: String) = encoded.failed(message)
    }

    private var pumpingEncoded = false

    private companion object {
        /** A longer file is streamed every time rather than held in memory to be kept. */
        const val MAX_CACHED_TRACK_BYTES = 64 * 1024 * 1024

        /** A seek inside kept bytes cuts over once this much of the new place is decoded. */
        const val LOCAL_SEEK_READY_SECONDS = 0.1
    }

    private data class LoopRange(val startFrame: Long, val endFrame: Long, val short: Boolean) {
        val frames: Int get() = (endFrame - startFrame).toInt()
    }

    private class PendingPromotion(val streamId: Long) {
        var requestedSeekFrame: Long? = null
    }

    private class PendingSeek(val streamId: Long, val startFrame: Long) {
        var ready = false
    }

    private var currentRing = PcmRing(config.currentCapacityFrames)
    private var continuityRing = PcmRing(config.continuityCapacityFrames)
    /** The newest generation this engine opened; the server drops every older one on its open. */
    var generation = lastGeneration
        private set
    private var nextStreamId = 1L
    private var current: Stream? = null
    private var continuity: Stream? = null
    private var queuedNext: PcmTrack? = null
    private var loop: LoopRange? = null
    private var pendingSeek: PendingSeek? = null
    private var pendingPromotion: PendingPromotion? = null
    private var playing = false
    private var rebuffering = false

    /** Whether this generation wrote PCM to the sink, so a pause has something to fade. */
    private var sounded = false

    /** A [pause] fades the sink down; [render] polls until it has paused, and writes nothing meanwhile. */
    var pausing = false
        private set

    // The worklet's retained short loop: the loop stream's first PCM, replayed instead of promoting it.
    private var retained = FloatArray(0)
    private var retainedStreamId: Long? = null
    private var retainedCapturedFrames = 0
    private var retainedReadFrame = 0
    private var shortLoopRendering = false

    /** Streams stopped before the server answered their open: closed if it confirms, forgotten if it refuses. */
    private val unconfirmedCloses = mutableMapOf<Long, PcmClientControl.Close>()
    private var expectContinuity = false
    private var failed = false

    /** Track frame of the next sample written to the sink. */
    var timelineFrame = 0L
        private set

    /** Whether a seek has not cut over yet; until it does, [timelineFrame] still names the old place. */
    val seekPending: Boolean
        get() = pendingSeek != null || pendingPromotion?.requestedSeekFrame != null || current?.encoded?.localSeek != null

    // Inspection for the engine's own tests; production reads only the events.
    @VisibleForTesting
    internal var staleMessages = 0
        private set

    @VisibleForTesting
    internal val currentStreamId: Long? get() = current?.streamId

    @VisibleForTesting
    internal val continuityStreamId: Long? get() = continuity?.streamId

    @VisibleForTesting
    internal fun bufferedFrames(role: PcmRole): Int = ringFor(role).bufferedFrames

    @VisibleForTesting
    internal fun inFlightFrames(role: PcmRole): Int = streamFor(role)?.inFlightFrames ?: 0

    /**
     * Replaces everything with a new generation; the server drops older streams on its open. [fadeIn]
     * fades the output up as a resume does, for a stream reopened where a paused one stopped.
     */
    fun start(track: PcmTrack, startFrame: Long = 0, playWhenReady: Boolean = true, fadeIn: Boolean = false) {
        require(startFrame >= 0) { "start frame must be nonnegative" }
        resetPlayback()
        sink.pause()
        sink.flush()
        failed = false
        generation += 1
        // The open of a newer generation drops every older stream on the server.
        unconfirmedCloses.clear()
        timelineFrame = startFrame
        playing = playWhenReady
        when {
            !playing -> Unit
            fadeIn -> sink.resumeWithFadeIn()
            else -> sink.play()
        }
        open(PcmRole.CURRENT, track, StreamKind.START, startFrame)
    }

    /** Plays on from the next frame the sink holds, fading up from wherever a [pause] left it. */
    fun play() {
        if (failed || playing || current == null) return
        playing = true
        pausing = false
        if (sounded) sink.resumeWithFadeIn() else sink.play()
        for (stream in listOfNotNull(current, continuity)) {
            val deferred = stream.deferredCreditFrames
            stream.deferredCreditFrames = 0
            grantCredit(stream, deferred)
        }
        reconcileContinuity()
    }

    /**
     * Stops writing and fades out what the sink is playing now, so the pause is heard within the
     * fade; every frame the sink holds unplayed plays on the next [play]. [immediate] stops the sink
     * at once instead, for output that must not be heard any more.
     */
    fun pause(immediate: Boolean = false) {
        if (!playing && !pausing) return
        playing = false
        pausing = !immediate && sounded
        if (pausing) sink.fadeOutAndPause() else sink.pause()
    }

    /** Cancels every held decoder role and discards unplayed PCM. */
    fun stop(reason: String) {
        if (!failed) {
            for (stream in listOfNotNull(continuity, current).filterNot { it.local }) {
                val close = PcmClientControl.Close(stream.generation, stream.streamId, reason)
                // A refused open registers nothing, and the server rejects a close of an unknown stream.
                if (stream.metadataAccepted) send(close) else unconfirmedCloses[stream.streamId] = close
            }
        }
        resetPlayback()
        sink.pause()
        sink.flush()
    }

    fun release() {
        try {
            stop("released")
        } finally {
            sink.release()
        }
    }

    /**
     * Sets the immediate successor of the current track. As in `scheduleStreamingContinuity`, a
     * different successor waits while one is already prepared and follows it once it has promoted.
     */
    fun setQueuedNext(track: PcmTrack?) {
        queuedNext = track
        reconcileContinuity()
    }

    /**
     * Repeats track frames [startFrame, endFrame). A [short] loop (`short-loop`) replays the first
     * PCM of a decoder opened at [startFrame] from memory, as the worklet's retained loop does; a
     * long one promotes that decoder at every wrap. Another range releases the previous loop first.
     */
    fun setLoop(startFrame: Long, endFrame: Long, short: Boolean = false) {
        require(startFrame >= 0 && endFrame > startFrame) { "loop range is empty" }
        val range = LoopRange(startFrame, endFrame, short)
        // The worklet ignores a short loop longer than its retained buffer.
        if (range == loop || (short && range.frames > config.continuityCapacityFrames)) return
        releaseLoop()
        loop = range
        if (short && retained.size < range.frames * PcmRing.CHANNELS) retained = FloatArray(range.frames * PcmRing.CHANNELS)
        reconcileContinuity()
    }

    fun clearLoop() {
        releaseLoop()
        reconcileContinuity()
    }

    /**
     * Prepares [frame] on the continuity role and cuts over once its first PCM is buffered. An
     * active loop stays; a short one keeps replaying its retained PCM until the cutover, as the
     * worklet does.
     */
    fun seek(frame: Long) {
        require(frame >= 0) { "seek frame must be nonnegative" }
        val stream = current ?: return
        if (failed) return
        pendingPromotion?.let { promotion ->
            if (promotion.streamId == stream.streamId) promotion.requestedSeekFrame = frame
            return
        }
        if (seekWithinBuffer(stream, frame)) return
        if (seekWithinKeptBytes(stream, frame)) return
        if (continuity != null) closeContinuity("seek-replaced")
        val target = open(PcmRole.CONTINUITY, stream.track, StreamKind.SEEK, frame) ?: return
        pendingSeek = PendingSeek(target.streamId, frame)
    }

    /** The successor a continuity decoder is preparing, if any. */
    val preparedSuccessor: PcmTrack? get() = continuity?.takeIf { it.kind == StreamKind.QUEUED_NEXT }?.track

    /**
     * Next, while the successor is prepared: the current track is silenced at once, its unplayed
     * PCM goes, and the successor is heard from the next write. Nothing reopens, so the skip waits
     * on no server. Returns false when nothing is ready to skip to.
     */
    fun skipToPrepared(): Boolean {
        val next = continuity
        if (failed || !playing || current == null || next?.kind != StreamKind.QUEUED_NEXT ||
            continuityRing.bufferedFrames <= 0 || pendingSeek != null || pendingPromotion != null || loop != null
        ) {
            return false
        }
        sink.pause()
        sink.flush()
        promote(PcmBoundaryKind.QUEUED_NEXT, next.startFrame)
        sink.play()
        return true
    }

    /** Starts a [LocalSeek] when [frame] lies in bytes the playing stream already received. */
    private fun seekWithinKeptBytes(stream: Stream, frame: Long): Boolean {
        val encoded = stream.encoded ?: return false
        if (loop != null || stream.eosReceived || encoded.closed) return false
        val store = encoded.store ?: return false
        val window = encoded.index?.window(store, frame - stream.startFrame) ?: return false
        // The newest seek wins: an older one, local or on the server, is dropped.
        encoded.localSeek?.decoding?.close()
        if (continuity?.kind == StreamKind.SEEK) closeContinuity("seek-replaced")
        pendingSeek = null
        encoded.localSeek = LocalSeek(encoded, frame, window)
        return true
    }

    /** Cuts over to a [LocalSeek] whose first audio is decoded: the old place stops, the new one plays on. */
    private fun commitLocalSeek() {
        val stream = current ?: return
        val encoded = stream.encoded ?: return
        val seek = encoded.localSeek ?: return
        if (!seek.ready) return
        encoded.decoding.close()
        encoded.decoding = seek.decoding
        encoded.skipFrames = seek.skipFrames
        encoded.remainingFrames = seek.remainingFrames
        encoded.decoded.clear()
        encoded.decoded.addAll(seek.decoded)
        encoded.decodedHeadFrame = 0
        encoded.decodedFrames = seek.decodedFrames
        encoded.decoderFinished = seek.finished
        encoded.localCreditFrames = 0
        encoded.deliveredFrames = 0
        encoded.localSeek = null
        seek.committed = true
        currentRing.clear()
        stream.inFlightFrames = 0
        stream.receivedFrames = 0
        rebuffering = false
        timelineFrame = seek.targetFrame
        events(PcmEngineEvent.Boundary(PcmBoundaryKind.SEEK, stream.streamId, stream.streamId, seek.targetFrame))
        refillCredit(stream)
        pumpEncoded(stream)
    }

    /** The worklet's `set-loop` with `active: false`: a replay in progress resumes the track after the loop. */
    private fun releaseLoop() {
        val range = loop ?: return
        if (shortLoopRendering) timelineFrame = range.endFrame
        loop = null
        resetRetainedLoop()
    }

    private fun resetRetainedLoop() {
        shortLoopRendering = false
        retainedStreamId = null
        retainedCapturedFrames = 0
        retainedReadFrame = 0
    }

    /**
     * The web buffered-seek path (`seekStreamingPlayback` and the worklet's `commitBufferedSeek`):
     * a playing forward seek whose target the current ring already holds skips ahead in place,
     * keeping the prepared successor, so nothing reopens and no silence is inserted.
     */
    private fun seekWithinBuffer(stream: Stream, frame: Long): Boolean {
        val delta = frame - timelineFrame
        val eligible = playing && loop == null && pendingSeek == null &&
            continuity?.kind == StreamKind.QUEUED_NEXT && continuityRing.bufferedFrames > 0 &&
            delta >= 0 && delta < capacityFrames(PcmRole.CURRENT) && delta < currentRing.bufferedFrames &&
            frame < (stream.track.durationSeconds * config.sampleRate).roundToLong()
        if (!eligible) return false
        // The next render quantum must be backed by current PCM or by a known-EOS successor.
        val successorFramesNeeded = PcmEngineConfig.RENDER_QUANTUM_FRAMES - (currentRing.bufferedFrames - delta)
        if (successorFramesNeeded > 0 &&
            (!stream.eosReceived || continuityRing.bufferedFrames < successorFramesNeeded)
        ) {
            return false
        }
        currentRing.skip(delta.toInt())
        timelineFrame = frame
        refillCredit(stream)
        events(PcmEngineEvent.Boundary(PcmBoundaryKind.SEEK, stream.streamId, stream.streamId, frame))
        return true
    }

    fun onServerText(text: String) {
        if (failed) return
        val event = try {
            AhpcControlCodec.decode(text)
        } catch (error: AhpcProtocolException) {
            fail("control-protocol-error", error.message ?: "Invalid control")
            return
        }
        onServerEvent(event)
    }

    fun onServerEvent(event: PcmServerEvent) {
        if (failed || event is PcmServerEvent.ProbeResult) return
        val stream = event.streamId?.let(::streamById)
        if (stream == null || event.generation != generation) {
            if (!settleUnconfirmedClose(event)) staleMessages += 1
            return
        }
        when (event) {
            is PcmServerEvent.Metadata -> acceptMetadata(stream, event)
            is PcmServerEvent.Eos -> stream.encoded?.let { encoded ->
                if (encoded.serverEos != null) return
                encoded.serverEos = event
                encoded.end()
                keepInCache(stream, encoded)
                finishEncodedWhenDrained(stream)
            } ?: acceptEos(stream, event)
            is PcmServerEvent.Promoted -> acceptPromoted(event)
            is PcmServerEvent.RateMismatch -> acceptRateMismatch(stream, event)
            is PcmServerEvent.Error ->
                fail("server-error", event.message ?: event.code ?: "Streaming failed")
            is PcmServerEvent.Unknown ->
                fail("control-protocol-error", "Unknown active streaming control: ${event.type}")
            PcmServerEvent.ProbeResult -> Unit
        }
    }

    private fun settleUnconfirmedClose(event: PcmServerEvent): Boolean {
        val streamId = event.streamId ?: return false
        val close = unconfirmedCloses[streamId] ?: return false
        if (close.generation != event.generation) return false
        unconfirmedCloses.remove(streamId)
        if (event is PcmServerEvent.Metadata) send(close)
        return true
    }

    fun onBinary(bytes: ByteArray) {
        if (failed) return
        val frame = try {
            AhpcFrameCodec.decode(bytes)
        } catch (error: AhpcProtocolException) {
            fail("pcm-protocol-error", "PCM protocol error: ${error.message}")
            return
        }
        val stream = streamById(frame.streamId)
        if (stream == null || frame.generation != generation ||
            !wireRoleAccepted(stream, frame.role.wire) || frame.sequence != stream.nextSequence
        ) {
            staleMessages += 1
            return
        }
        if (!stream.metadataAccepted) return fail("pcm-protocol-error", "PCM arrived before metadata")
        val encoded = stream.encoded
        when (frame) {
            is AhpcPcmFrame -> {
                if (encoded != null) return fail("pcm-protocol-error", "PCM arrived on an encoded stream")
                if (frame.frameCount > stream.inFlightFrames) {
                    return fail("pcm-protocol-error", "frame exceeds granted credit")
                }
                if (frame.frameCount > capacityFrames(stream.role) - ringFor(stream.role).bufferedFrames) {
                    return fail("pcm-protocol-error", "frame exceeds inherited backing capacity")
                }
                stream.nextSequence += 1
                acceptPcm(stream, frame.frameCount) { ring -> ring.appendLittleEndian(frame.bytes, frame.payloadOffset, frame.frameCount) }
            }
            is AhpcEncodedFrame -> {
                if (encoded == null) return fail("pcm-protocol-error", "encoded audio arrived on a PCM stream")
                if (frame.payloadLength > encoded.outstandingBytes) {
                    return fail("pcm-protocol-error", "frame exceeds granted byte credit")
                }
                stream.nextSequence += 1
                encoded.outstandingBytes -= frame.payloadLength
                encoded.receivedBytes += frame.payloadLength
                encoded.write(frame.bytes, frame.payloadOffset, frame.payloadLength)
                refillEncodedBytes(stream)
            }
        }
    }

    /** Takes [frames] new frames of [stream], which [append] writes into its ring. */
    private fun acceptPcm(stream: Stream, frames: Int, append: (PcmRing) -> Unit) {
        val ring = ringFor(stream.role)
        append(ring)
        retainShortLoopPcm(stream, ring, frames)
        if (stream.receivedFrames == 0L) {
            stream.firstPcmAtMs = clockMs()
            if (stream.kind == StreamKind.START) events(PcmEngineEvent.StartPcmReceived(stream.streamId))
        }
        stream.receivedFrames += frames
        stream.inFlightFrames -= frames
        if (stream.role == PcmRole.CURRENT) {
            grantDeferredInitialCredit()
            reconcileContinuity()
        }
        refillCredit(stream)
        prepareSeekWhenBuffered(stream)
    }

    /** Meets [stream]'s local frame credit from decoded audio and keeps its decoder and byte credit going. */
    private fun pumpEncoded(stream: Stream) {
        val encoded = stream.encoded ?: return
        // Delivering refills the credit, which pumps again; the loop below takes that credit.
        if (pumpingEncoded) return
        pumpingEncoded = true
        try {
            while (!failed && !encoded.closed && encoded.localCreditFrames > 0 && encoded.decodedFrames > 0) {
                val head = encoded.decoded.first()
                val offset = encoded.decodedHeadFrame
                val frames = minOf(encoded.localCreditFrames, head.size / PcmRing.CHANNELS - offset)
                encoded.decodedHeadFrame += frames
                if (encoded.decodedHeadFrame * PcmRing.CHANNELS == head.size) {
                    encoded.decoded.removeFirst()
                    encoded.decodedHeadFrame = 0
                }
                encoded.localCreditFrames -= frames
                encoded.decodedFrames -= frames
                encoded.deliveredFrames += frames
                acceptPcm(stream, frames) { ring -> ring.appendFloats(head, offset * PcmRing.CHANNELS, frames) }
            }
        } finally {
            pumpingEncoded = false
        }
        if (failed || encoded.closed) return
        val wanted = if (encoded.remainingFrames > 0) encoded.localCreditFrames - encoded.decodedFrames else 0
        encoded.decoding.request(maxOf(0, wanted))
        refillEncodedBytes(stream)
        finishEncodedWhenDrained(stream)
    }

    /** Keeps minutes of [stream]'s encoded audio buffered, credited in 64 KiB steps. */
    private fun refillEncodedBytes(stream: Stream) {
        val encoded = stream.encoded ?: return
        if (failed || encoded.closed || encoded.serverEos != null) return
        // The stream being left must not compete with the audio the listener just asked for.
        if (stream === current && pendingSeek != null) return
        var missing = encodedTargetBytes(stream, encoded) - encoded.decoding.bufferedBytes - encoded.outstandingBytes
        while (missing >= PcmEngineConfig.ENCODED_CREDIT_BYTES &&
            encoded.outstandingBytes + PcmEngineConfig.ENCODED_CREDIT_BYTES <= PcmEngineConfig.ENCODED_MAX_OUTSTANDING_BYTES
        ) {
            if (!send(PcmClientControl.Credit(stream.generation, stream.streamId, PcmEngineConfig.ENCODED_CREDIT_BYTES))) return
            encoded.outstandingBytes += PcmEngineConfig.ENCODED_CREDIT_BYTES
            missing -= PcmEngineConfig.ENCODED_CREDIT_BYTES
        }
    }

    private fun encodedTargetBytes(stream: Stream, encoded: EncodedStream): Int {
        val consumedBytes = encoded.receivedBytes - encoded.decoding.bufferedBytes
        // Half a second of decoded audio measures the stream's own byte rate.
        val bytesPerSecond = if (encoded.decoderFrames >= config.sampleRate / 2 && consumedBytes > 0) {
            consumedBytes.toDouble() * config.sampleRate / encoded.decoderFrames
        } else {
            PcmEngineConfig.ENCODED_FALLBACK_BYTES_PER_SECOND.toDouble()
        }
        val seconds = if (stream.role == PcmRole.CURRENT) {
            PcmEngineConfig.ENCODED_CURRENT_BUFFER_SECONDS
        } else {
            PcmEngineConfig.ENCODED_CONTINUITY_BUFFER_SECONDS
        }
        return (bytesPerSecond * seconds).toInt()
            .coerceIn(PcmEngineConfig.ENCODED_BUFFER_MIN_BYTES, PcmEngineConfig.ENCODED_BUFFER_MAX_BYTES)
    }

    /** `finishStreamingEncodedRole`: once every kept frame is delivered, the stream ends at what was heard. */
    private fun finishEncodedWhenDrained(stream: Stream) {
        val encoded = stream.encoded ?: return
        val eos = encoded.serverEos ?: return
        if (stream.eosReceived || encoded.decodedFrames > 0) return
        if (encoded.remainingFrames > 0 && !encoded.decoderFinished) return
        val authoritative = (eos.authoritativeTotalFrames ?: 0) - encoded.remainingFrames
        encoded.close()
        acceptEos(stream, eos.copy(emittedFrames = encoded.deliveredFrames, authoritativeTotalFrames = authoritative))
    }

    /** The worklet's `enqueue` capture: the loop stream's first loop-length frames are kept for replay. */
    private fun retainShortLoopPcm(stream: Stream, ring: PcmRing, frames: Int) {
        val range = loop ?: return
        if (!range.short || stream.streamId != retainedStreamId || stream !== continuity) return
        val kept = minOf(frames, range.frames - retainedCapturedFrames)
        if (kept <= 0) return
        ring.copyTo(ring.bufferedFrames - frames, kept, retained, retainedCapturedFrames)
        retainedCapturedFrames += kept
    }

    fun onTransportClosed(code: Int) {
        if (!failed && current != null) fail("socket-closed", "Playback socket closed ($code)")
    }

    /**
     * Writes at most [maxFrames] frames the sink can take now, crossing prepared
     * boundaries inside one call. Returns the frames written.
     */
    fun render(maxFrames: Int): Int {
        if (failed || maxFrames <= 0) return 0
        commitLocalSeek()
        commitPreparedSeek()
        val head = current ?: return 0
        if (pausing) pausing = !sink.fadeOutSettled()
        if (!playing) return 0
        if (!head.firstFrameRendered && !playsThrough(head, currentRing, committedCapacityFrames(PcmRole.CURRENT))) return 0
        if (rebuffering) {
            val cushion = minOf(config.frames(PcmEngineConfig.REBUFFER_CUSHION_SECONDS), committedCapacityFrames(PcmRole.CURRENT))
            if (currentRing.bufferedFrames < cushion && !head.eosReceived) return 0
            rebuffering = false
            events(PcmEngineEvent.Buffering(false, head.streamId))
        }
        var written = 0
        while (written < maxFrames) {
            val stream = current ?: break
            val loopRange = loop
            if (loopRange != null && timelineFrame >= loopRange.endFrame) {
                if (loopRange.short) {
                    if (wrapShortLoop(stream, loopRange)) continue
                } else if (continuity?.kind == StreamKind.LOOP && continuityRing.bufferedFrames > 0) {
                    promote(PcmBoundaryKind.LOOP, loopRange.startFrame)
                    continue
                }
                underrun(stream)
                break
            }
            if (shortLoopRendering && loopRange != null) {
                // The retained loop plays from memory; the current ring waits at the loop end.
                val frames = minOf(maxFrames - written, loopRange.frames - retainedReadFrame)
                val accepted = sink.write(retained, retainedReadFrame * PcmRing.CHANNELS, frames)
                check(accepted in 0..frames) { "audio output answered $accepted for $frames frames" }
                if (accepted > 0) sounded = true
                retainedReadFrame = (retainedReadFrame + accepted) % loopRange.frames
                timelineFrame += accepted
                written += accepted
                if (accepted < frames) break
                continue
            }
            if (currentRing.bufferedFrames == 0) {
                if (!finishDrainedCurrent(stream)) break
                continue
            }
            var frames = minOf(maxFrames - written, currentRing.contiguousFrames())
            if (loopRange != null) frames = minOf(frames.toLong(), loopRange.endFrame - timelineFrame).toInt()
            val accepted = sink.write(currentRing.samples, currentRing.readFrame * PcmRing.CHANNELS, frames)
            check(accepted in 0..frames) { "audio output answered $accepted for $frames frames" }
            if (accepted == 0) break
            sounded = true
            if (!stream.firstFrameRendered) {
                stream.firstFrameRendered = true
                events(PcmEngineEvent.FirstFrame(stream.streamId, timelineFrame))
            }
            currentRing.consume(accepted)
            timelineFrame += accepted
            written += accepted
            if (accepted < frames) break
        }
        if (written > 0) current?.let(::refillCredit)
        reconcileContinuity()
        return written
    }

    /** Handles an empty current ring; returns true when rendering continues on a promoted ring. */
    private fun finishDrainedCurrent(stream: Stream): Boolean {
        if (!stream.eosReceived) {
            if (stream.firstFrameRendered) {
                underrun(stream)
                rebuffering = true
                events(PcmEngineEvent.Buffering(true, stream.streamId))
                grantCredit(stream, config.maxCreditFrames)
            }
            return false
        }
        val next = continuity
        if (pendingSeek != null) {
            underrun(stream)
            return false
        }
        if (next != null && continuityRing.bufferedFrames > 0) {
            val kind = if (next.kind == StreamKind.LOOP) PcmBoundaryKind.LOOP else PcmBoundaryKind.QUEUED_NEXT
            promote(kind, next.startFrame)
            return true
        }
        if (expectContinuity && next?.eosReceived != true) {
            if (stream.firstFrameRendered) underrun(stream)
            return false
        }
        playing = false
        events(PcmEngineEvent.Ended(stream.streamId, timelineFrame))
        return false
    }

    /**
     * The worklet's short-loop wrap: once the whole loop is retained, replay restarts at its first
     * frame; until then the wrap waits as an underrun, with nothing inserted.
     */
    private fun wrapShortLoop(stream: Stream, range: LoopRange): Boolean {
        val retainedId = retainedStreamId ?: return false
        if (retainedCapturedFrames != range.frames) return false
        val outgoingId = if (shortLoopRendering) retainedId else stream.streamId
        retainedReadFrame = 0
        shortLoopRendering = true
        timelineFrame = range.startFrame
        events(PcmEngineEvent.Boundary(PcmBoundaryKind.LOOP, outgoingId, retainedId, range.startFrame))
        return true
    }

    private fun underrun(stream: Stream) {
        events(PcmEngineEvent.Underrun(stream.streamId, timelineFrame))
    }

    private fun commitPreparedSeek() {
        val seek = pendingSeek ?: return
        if (!seek.ready || continuity?.streamId != seek.streamId || continuityRing.bufferedFrames <= 0) return
        promote(PcmBoundaryKind.SEEK, seek.startFrame)
    }

    private fun promote(kind: PcmBoundaryKind, incomingTimelineFrame: Long) {
        val outgoing = checkNotNull(current)
        val incoming = checkNotNull(continuity)
        outgoing.encoded?.close()
        val outgoingRing = currentRing
        currentRing = continuityRing
        continuityRing = outgoingRing
        continuityRing.clear()
        incoming.role = PcmRole.CURRENT
        incoming.acceptsPromotedContinuityWireRole = true
        incoming.targetBufferFrames = capacityFrames(PcmRole.CURRENT)
        current = incoming
        continuity = null
        timelineFrame = incomingTimelineFrame
        pendingPromotion = PendingPromotion(incoming.streamId)
        when (kind) {
            PcmBoundaryKind.QUEUED_NEXT -> {
                // A successor deferred behind the promoted one is prepared once the server confirms.
                if (queuedNext == incoming.track) queuedNext = null
                expectContinuity = false
            }
            PcmBoundaryKind.SEEK -> {
                pendingSeek = null
                expectContinuity = queuedNext != null
                // The loop stream the replay was retained from was closed by the seek; it is reopened and retained again.
                resetRetainedLoop()
            }
            PcmBoundaryKind.LOOP -> Unit
        }
        if (incoming.local) {
            // A cached stream promotes on the device alone; a server stream it replaces early is closed.
            pendingPromotion = null
            if (!outgoing.local && !outgoing.eosReceived) {
                send(PcmClientControl.Close(outgoing.generation, outgoing.streamId, "replaced-by-cache"))
            }
        } else if (!send(PcmClientControl.Promote(incoming.generation, incoming.streamId))) {
            return
        }
        if (kind == PcmBoundaryKind.SEEK && !incoming.eosReceived) {
            grantCredit(incoming, capacityFrames(PcmRole.CURRENT))
        }
        events(PcmEngineEvent.Boundary(kind, outgoing.streamId, incoming.streamId, incomingTimelineFrame))
    }

    private fun acceptMetadata(stream: Stream, event: PcmServerEvent.Metadata) {
        val codec = event.codec?.let { AudioCodec.fromWire(it)?.takeIf(stream.offeredCodecs::contains) }
        val valid = event.role == stream.role.wire &&
            event.sampleRate == config.sampleRate.toLong() &&
            event.channels == 2L &&
            (event.codec == null || (codec != null && (event.skipFrames ?: -1) >= 0 && (event.totalFrames ?: -1) >= 0 &&
                (event.initialCreditBytes ?: -1) >= 0)) &&
            (event.provisionalTotalFrames ?: -1) >= 0 &&
            event.requestedStartFrame == stream.startFrame &&
            (event.timelineStartFrame ?: -1) >= 0
        if (!valid) return fail("metadata-protocol-error", "Invalid streaming metadata")
        stream.metadataAccepted = true
        if (codec != null) {
            val encoded = EncodedStream(
                stream, codec, checkNotNull(event.skipFrames), checkNotNull(event.totalFrames),
                checkNotNull(event.initialCreditBytes).toInt(),
            )
            stream.encoded = encoded
            encoded.keepBytes()
            refillEncodedBytes(stream)
        }
        if (stream.kind == StreamKind.START) events(PcmEngineEvent.StartAccepted(stream.streamId))
        if (stream.kind == StreamKind.SEEK) {
            val remaining = checkNotNull(event.provisionalTotalFrames) - checkNotNull(event.timelineStartFrame)
            stream.targetBufferFrames = minOf(stream.targetBufferFrames.toLong(), maxOf(0L, remaining)).toInt()
        }
        grantInitialCredit(stream)
    }

    private fun acceptEos(stream: Stream, event: PcmServerEvent.Eos) {
        val emitted = event.emittedFrames
        val authoritative = event.authoritativeTotalFrames
        if (!wireRoleAccepted(stream, event.role) || emitted == null || emitted < 0 ||
            authoritative == null || authoritative < emitted
        ) {
            return fail("eos-protocol-error", "Invalid streaming end-of-stream event")
        }
        if (stream.eosReceived) return
        if (emitted != stream.receivedFrames) {
            return fail("eos-protocol-error", "End-of-stream frame count differs from received PCM")
        }
        stream.eosReceived = true
        stream.inFlightFrames = 0
        stream.deferredCreditFrames = 0
        if (stream.role == PcmRole.CURRENT) {
            grantDeferredInitialCredit()
            reconcileContinuity()
        }
        prepareSeekWhenBuffered(stream)
    }

    private fun acceptPromoted(event: PcmServerEvent.Promoted) {
        val promotion = pendingPromotion
        if (promotion == null || promotion.streamId != event.streamId || event.role != PcmRole.CURRENT.wire) {
            staleMessages += 1
            return
        }
        pendingPromotion = null
        val seekFrame = promotion.requestedSeekFrame
        if (seekFrame != null) seek(seekFrame) else reconcileContinuity()
    }

    private fun acceptRateMismatch(stream: Stream, event: PcmServerEvent.RateMismatch) {
        val rate = event.sampleRate
        if (stream === current && stream.kind == StreamKind.START && !stream.metadataAccepted && rate != null) {
            // The server registered no stream and nothing was rendered.
            resetPlayback()
            events(PcmEngineEvent.StartRateRequired(stream.track, stream.startFrame, rate.toInt()))
            return
        }
        if (stream !== continuity || stream.kind != StreamKind.QUEUED_NEXT || rate == null) {
            return fail("rate-mismatch", "The track sample rate changed")
        }
        // The server registered no stream, so there is nothing to close.
        continuity = null
        continuityRing.clear()
        expectContinuity = false
        queuedNext = null
        events(PcmEngineEvent.RateChangeRequired(stream.track, rate.toInt()))
    }

    /** Opens, replaces or closes the continuity role so it matches the loop or queued successor. */
    private fun reconcileContinuity() {
        if (failed) return
        val head = current ?: return
        val desiredKind = when {
            loop != null -> StreamKind.LOOP
            queuedNext != null -> StreamKind.QUEUED_NEXT
            else -> null
        }
        val desiredTrack = if (desiredKind == StreamKind.LOOP) head.track else queuedNext
        val desiredStart = loop?.startFrame ?: 0L
        continuity?.let { open ->
            if (open.kind == StreamKind.SEEK) return
            if (open.kind == desiredKind && open.track == desiredTrack && open.startFrame == desiredStart &&
                open.loopRange == loop?.takeIf { desiredKind == StreamKind.LOOP }
            ) {
                return
            }
            // The prepared successor plays; a different one is prepared after it has promoted.
            if (open.kind == StreamKind.QUEUED_NEXT && desiredKind == StreamKind.QUEUED_NEXT) return
            val loopDisabled = open.kind == StreamKind.LOOP && desiredKind != StreamKind.LOOP
            closeContinuity(if (loopDisabled) "loop-disabled" else "continuity-replaced")
        }
        if (desiredKind == null || desiredTrack == null || pendingPromotion != null || pendingSeek != null) return
        if (!head.firstFrameRendered) return
        if (desiredKind == StreamKind.QUEUED_NEXT) {
            val cushion = config.frames(PcmEngineConfig.QUEUED_NEXT_CURRENT_CUSHION_SECONDS)
            if (!playing || (!head.eosReceived && currentRing.bufferedFrames < cushion)) return
        }
        open(PcmRole.CONTINUITY, desiredTrack, desiredKind, desiredStart) ?: return
        if (desiredKind == StreamKind.QUEUED_NEXT) expectContinuity = true
    }

    private fun closeContinuity(reason: String) {
        val stream = continuity ?: return
        stream.encoded?.close()
        continuity = null
        continuityRing.clear()
        if (pendingSeek?.streamId == stream.streamId) pendingSeek = null
        if (stream.kind == StreamKind.QUEUED_NEXT) expectContinuity = false
        if (!stream.local) send(PcmClientControl.Close(stream.generation, stream.streamId, reason))
    }

    /** Keeps a whole encoded track on the device once every byte arrived. */
    private fun keepInCache(stream: Stream, encoded: EncodedStream) {
        val store = encoded.store ?: return
        val key = stream.track.cacheKey ?: return
        val bytes = store.copyOfRange(0, store.size)
        cache?.store(key, CachedTrack(encoded.codec.wire, config.sampleRate, encoded.initialSkipFrames, encoded.initialTotalFrames, bytes))
    }

    /**
     * Plays [stream] from the device's cache when it starts at the first frame and the track is
     * kept at this rate: its whole file goes to the decoder at once and nothing is asked of the server.
     */
    private fun openFromCache(stream: Stream): Boolean {
        val cache = cache ?: return false
        if (decoders == null || stream.startFrame != 0L || stream.kind == StreamKind.SEEK || stream.kind == StreamKind.LOOP) return false
        val key = stream.track.cacheKey ?: return false
        val cached = cache.load(key) ?: return false
        val codec = AudioCodec.fromWire(cached.codec)?.takeIf(stream.offeredCodecs::contains) ?: return false
        if (cached.sampleRate != config.sampleRate) return false
        stream.local = true
        stream.metadataAccepted = true
        val encoded = EncodedStream(stream, codec, cached.skipFrames, cached.totalFrames, initialCreditBytes = 0)
        stream.encoded = encoded
        encoded.receivedBytes = cached.bytes.size.toLong()
        encoded.keepBytes()
        encoded.write(cached.bytes, 0, cached.bytes.size)
        encoded.end()
        encoded.serverEos = PcmServerEvent.Eos(stream.generation, stream.streamId, stream.role.wire, cached.totalFrames, cached.totalFrames)
        if (stream.kind == StreamKind.START) events(PcmEngineEvent.StartAccepted(stream.streamId))
        grantInitialCredit(stream)
        return true
    }

    private fun open(role: PcmRole, track: PcmTrack, kind: StreamKind, startFrame: Long): Stream? {
        val capacity = capacityFrames(role)
        val target = when (kind) {
            StreamKind.QUEUED_NEXT -> config.frames(PcmEngineConfig.QUEUED_NEXT_PREPARE_SECONDS)
            StreamKind.SEEK -> config.frames(PcmEngineConfig.SEEK_PREPARE_SECONDS)
            // A short loop asks for exactly the frames it retains.
            StreamKind.LOOP -> loop?.takeIf { it.short }?.let { maxOf(1, it.frames) } ?: capacity
            StreamKind.START -> capacity
        }
        val stream = Stream(track, generation, nextStreamId++, role, kind, startFrame, minOf(capacity, target))
        ringFor(role).clear()
        if (role == PcmRole.CURRENT) current = stream else continuity = stream
        if (kind == StreamKind.LOOP) {
            stream.loopRange = loop
            if (loop?.short == true && retainedStreamId == null) retainedStreamId = stream.streamId
        }
        if (decoders != null) stream.offeredCodecs = codecs()
        if (openFromCache(stream)) return stream
        val accepted = send(
            PcmClientControl.Open(
                generation, stream.streamId, role, track, startFrame, config.sampleRate,
                codecs = AudioCodec.entries.filter(stream.offeredCodecs::contains).map { it.wire },
                quality = quality(),
            ),
        )
        return if (accepted) stream else null
    }

    private fun grantInitialCredit(stream: Stream) {
        val head = current
        // `continuityCreditNeedsOutgoingRenderCushion`: both cushions are one second.
        val needsOutgoingCushion = stream.role == PcmRole.CONTINUITY && stream.kind == StreamKind.QUEUED_NEXT &&
            head != null && !head.eosReceived &&
            currentRing.bufferedFrames < config.frames(PcmEngineConfig.QUEUED_NEXT_CURRENT_CUSHION_SECONDS)
        stream.initialCreditDeferred = needsOutgoingCushion
        if (needsOutgoingCushion) return
        val target = if (stream.targetBufferFrames > 0) stream.targetBufferFrames else config.maxCreditFrames
        grantCredit(stream, minOf(config.maxCreditFrames, target))
    }

    private fun grantDeferredInitialCredit() {
        val next = continuity ?: return
        if (next.initialCreditDeferred && next.metadataAccepted) grantInitialCredit(next)
    }

    private fun refillCredit(stream: Stream) {
        if (stream.eosReceived) return
        val missing = stream.targetBufferFrames - ringFor(stream.role).bufferedFrames - stream.inFlightFrames
        if (missing <= 0) return
        if (stream.role != PcmRole.CURRENT) {
            grantCredit(stream, missing)
            return
        }
        // The credit window is topped up in quarter seconds as PCM arrives, so it never drains
        // to a round trip's wait: on a slow link that wait is what starves playback.
        val chunk = config.frames(PcmEngineConfig.CREDIT_LOW_WATER_SECONDS)
        val free = config.maxCreditFrames - stream.inFlightFrames
        if (missing < chunk || free < chunk) return
        grantCredit(stream, minOf(missing, free))
    }

    private fun grantCredit(stream: Stream, requestedFrames: Int): Int {
        if (requestedFrames <= 0 || stream.eosReceived) return 0
        if (!playing) {
            stream.deferredCreditFrames += requestedFrames
            return 0
        }
        val available = committedCapacityFrames(stream.role) - ringFor(stream.role).bufferedFrames -
            stream.inFlightFrames
        val serverAvailable = config.maxCreditFrames - stream.inFlightFrames
        val frames = minOf(requestedFrames, available, serverAvailable)
        if (frames <= 0) return 0
        val encoded = stream.encoded
        if (encoded != null) {
            // Frame credit for an encoded stream is met from its decoder, not asked of the server.
            encoded.localCreditFrames += frames
            stream.inFlightFrames += frames
            pumpEncoded(stream)
            return frames
        }
        if (!send(PcmClientControl.Credit(stream.generation, stream.streamId, frames))) return 0
        stream.inFlightFrames += frames
        return frames
    }

    /** The old place keeps playing until the new one can play through without stopping. */
    private fun prepareSeekWhenBuffered(stream: Stream) {
        val seek = pendingSeek ?: return
        if (seek.streamId != stream.streamId || stream !== continuity || seek.ready) return
        if (continuityRing.bufferedFrames > 0 && playsThrough(stream, continuityRing, stream.targetBufferFrames)) seek.ready = true
    }

    /**
     * Whether [stream] can be heard from now without running dry: all of it is in, the
     * [PcmEngineConfig.REBUFFER_CUSHION_SECONDS] cushion (at most [cushionLimit]) is, or a short
     * start is and the rest arrives at least twice as fast as it plays.
     */
    private fun playsThrough(stream: Stream, ring: PcmRing, cushionLimit: Int): Boolean {
        val buffered = ring.bufferedFrames
        if (stream.eosReceived) return true
        if (buffered >= minOf(config.frames(PcmEngineConfig.REBUFFER_CUSHION_SECONDS), cushionLimit)) return true
        if (buffered < config.frames(PcmEngineConfig.START_PLAYBACK_SECONDS)) return false
        val since = stream.firstPcmAtMs ?: return false
        val elapsedFrames = (clockMs() - since) * config.sampleRate / 1000
        return stream.receivedFrames >= PcmEngineConfig.PLAY_THROUGH_ARRIVAL_RATE * elapsedFrames
    }

    private fun capacityFrames(role: PcmRole): Int {
        val logical = if (role == PcmRole.CURRENT) config.currentCapacityFrames else config.continuityCapacityFrames
        return minOf(logical, ringFor(role).capacityFrames)
    }

    private fun committedCapacityFrames(role: PcmRole): Int {
        val capacity = capacityFrames(role)
        return if (role == PcmRole.CURRENT && capacity == config.currentCapacityFrames) {
            maxOf(1, capacity - config.maxCreditFrames)
        } else {
            capacity
        }
    }

    private fun wireRoleAccepted(stream: Stream, wireRole: String?): Boolean =
        wireRole == stream.role.wire ||
            (wireRole == PcmRole.CONTINUITY.wire && stream.role == PcmRole.CURRENT &&
                stream.acceptsPromotedContinuityWireRole)

    private fun ringFor(role: PcmRole): PcmRing = if (role == PcmRole.CURRENT) currentRing else continuityRing

    private fun streamFor(role: PcmRole): Stream? = if (role == PcmRole.CURRENT) current else continuity

    private fun streamById(streamId: Long): Stream? =
        listOfNotNull(current, continuity).firstOrNull { it.streamId == streamId }

    private fun send(control: PcmClientControl): Boolean {
        if (controls.send(control)) return true
        fail("control-send-error", "Playback socket is not open for control delivery")
        return false
    }

    private fun fail(code: String, message: String) {
        if (failed) return
        failed = true
        // What the sink held unplayed is flushed, so the stopped timeline names the first frame not heard.
        timelineFrame = maxOf(0L, timelineFrame - sink.pendingFrames())
        resetPlayback()
        sink.pause()
        sink.flush()
        events(PcmEngineEvent.Failed(code, message))
    }

    private fun resetPlayback() {
        listOfNotNull(current, continuity).forEach { it.encoded?.close() }
        resetRetainedLoop()
        current = null
        continuity = null
        currentRing.clear()
        continuityRing.clear()
        queuedNext = null
        loop = null
        pendingSeek = null
        pendingPromotion = null
        playing = false
        rebuffering = false
        expectContinuity = false
        pausing = false
        sounded = false
    }
}
