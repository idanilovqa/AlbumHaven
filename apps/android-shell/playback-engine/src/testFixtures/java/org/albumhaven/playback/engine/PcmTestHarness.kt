package org.albumhaven.playback.engine

import org.albumhaven.playback.decode.AudioCodec
import org.albumhaven.playback.decode.DecodedAudio
import org.albumhaven.playback.decode.EncodedDecodeListener
import org.albumhaven.playback.decode.EncodedDecoders
import org.albumhaven.playback.decode.EncodedDecoding
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.nio.ByteBuffer
import java.nio.ByteOrder

const val RATE = 48_000

/** Every sample identifies itself: left is its source frame index, right is its track tag. */
class SyntheticTrack(val tag: Int, val frames: Long, val sampleRate: Int = RATE) {
    val pcm = PcmTrack("ref-$tag", frames.toDouble() / sampleRate)
}

fun encodedFrame(role: PcmRole, generation: Long, streamId: Long, sequence: Long, payload: ByteArray): ByteArray {
    val buffer = ByteBuffer.allocate(AhpcFrameCodec.HEADER_BYTES + payload.size)
    buffer.put("AHPC".toByteArray()).put(2.toByte()).put(role.code.toByte()).putShort(0)
    buffer.putInt(generation.toInt()).putInt(streamId.toInt()).putInt(sequence.toInt()).putInt(payload.size)
    buffer.put(payload)
    return buffer.array()
}

/**
 * The fake codec of [FakeAhpcServer.encoded] streams: its bytes are the synthetic frames as f32le,
 * preceded by [ENCODED_SKIP_FRAMES] and followed by [ENCODED_TRAILING_FRAMES] junk frames the
 * server's sample map tells the client to drop, as a decoder's priming and padding are.
 */
const val ENCODED_SKIP_FRAMES = 300
const val ENCODED_TRAILING_FRAMES = 200
const val JUNK_TAG = -7f

/** Decodes the fake codec only as far as [EncodedDecoding.request] asks, when a test lets it [run]. */
class FakeDecoders : EncodedDecoders {
    inner class Decoding(val codec: AudioCodec, private val listener: EncodedDecodeListener) : EncodedDecoding {
        private var bytes = ByteArray(0)
        private var wanted = 0
        private var ended = false
        var closed = false
        private var finished = false
        var failNext = false

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            check(!closed) { "write after close" }
            this.bytes += bytes.copyOfRange(offset, offset + length)
        }

        override fun end() {
            ended = true
        }

        override fun request(frames: Int) {
            wanted = frames
        }

        override val bufferedBytes: Int get() = bytes.size

        override fun close() {
            closed = true
        }

        /** Decodes what is asked and available; returns whether anything happened. */
        fun run(): Boolean {
            if (closed || finished) return false
            if (failNext && bytes.isNotEmpty()) {
                closed = true
                listener.failed("corrupt frame")
                return true
            }
            val frames = minOf(wanted, bytes.size / AhpcFrameCodec.BYTES_PER_FRAME)
            if (frames > 0) {
                val buffer = ByteBuffer.wrap(bytes, 0, frames * AhpcFrameCodec.BYTES_PER_FRAME).order(ByteOrder.LITTLE_ENDIAN)
                val samples = FloatArray(frames * 2) { buffer.float }
                bytes = bytes.copyOfRange(frames * AhpcFrameCodec.BYTES_PER_FRAME, bytes.size)
                wanted -= frames
                listener.decoded(DecodedAudio(samples, RATE))
                return true
            }
            if (ended && bytes.size < AhpcFrameCodec.BYTES_PER_FRAME) {
                finished = true
                listener.finished()
                return true
            }
            return false
        }
    }

    val opened = mutableListOf<Decoding>()

    override fun open(codec: AudioCodec, listener: EncodedDecodeListener): EncodedDecoding =
        Decoding(codec, listener).also(opened::add)

    fun run(): Boolean = opened.toList().fold(false) { any, decoding -> decoding.run() || any }
}

fun pcmFrame(
    role: PcmRole,
    generation: Long,
    streamId: Long,
    sequence: Long,
    samples: FloatArray,
): ByteArray {
    val buffer = ByteBuffer.allocate(AhpcFrameCodec.HEADER_BYTES + samples.size * 4)
    buffer.put("AHPC".toByteArray()).put(1.toByte()).put(role.code.toByte()).putShort(0)
    buffer.putInt(generation.toInt()).putInt(streamId.toInt()).putInt(sequence.toInt())
    buffer.putInt(samples.size / 2)
    buffer.order(ByteOrder.LITTLE_ENDIAN)
    samples.forEach(buffer::putFloat)
    return buffer.array()
}

/**
 * In-memory stand-in for `/playback/pcm` (music_app/routes/playback_stream_asgi.py). It reads
 * the controls back from their JSON encoding and records every contract violation.
 */
class FakeAhpcServer(tracks: List<SyntheticTrack>, var chunkFrames: Int = 4_096) : PcmControlSender {
    private class ServerStream(val generation: Long, val id: Long, var role: PcmRole, val track: SyntheticTrack, val start: Long) {
        var position = start
        var sequence = 0L
        var outstanding = 0
        /** The fake codec's bytes for an encoded stream, and how many of them were sent. */
        var encodedBytes: ByteArray? = null
        var sentBytes = 0
    }

    /** Streams offered `mp3` are sent encoded, in [encodedChunkBytes] pieces that split frames. */
    var encoded = false
    var encodedChunkBytes = 10_000
    val bytesCredited = mutableListOf<Int>()

    private val tracksByRef = tracks.associateBy { it.pcm.playbackRef }
    private val streams = linkedMapOf<Long, ServerStream>()
    private val completed = mutableMapOf<Long, PcmRole>()
    val controls = mutableListOf<PcmClientControl>()
    val outbox = ArrayDeque<Any>()
    val violations = mutableListOf<String>()
    var maxOutstanding = 0
    var accepting = true
    var decoding = true

    /** Holds promotes so frames already queued keep the continuity wire role, as on a real socket. */
    var holdingPromotes = false
    private val heldPromotes = mutableListOf<JSONObject>()

    override fun send(control: PcmClientControl): Boolean {
        if (!accepting) return false
        controls += control
        val json = JSONObject(AhpcControlCodec.encode(control))
        if (holdingPromotes && json.getString("type") == "promote") {
            heldPromotes += json
            return true
        }
        dispatch(json)
        return true
    }

    /** The same controls as JSON text, as a WebSocket client sends them. */
    fun receive(text: String): Boolean {
        if (!accepting) return false
        texts += text
        dispatch(JSONObject(text))
        return true
    }

    val texts = mutableListOf<String>()

    fun releasePromotes() {
        holdingPromotes = false
        heldPromotes.toList().also { heldPromotes.clear() }.forEach(::dispatch)
    }

    private fun dispatch(json: JSONObject) {
        val generation = json.getLong("generation")
        val id = json.getLong("streamId")
        when (json.getString("type")) {
            "open" -> open(json, generation, id)
            "credit" -> credit(id, json.getInt("frames"))
            "promote" -> promote(json, generation, id)
            "close" -> if (streams.remove(id) == null && completed.remove(id) == null) {
                violations += "close of unknown stream $id"
            }
            else -> violations += "unexpected control $json"
        }
    }

    fun decodeAll() = streams.values.toList().forEach(::drain)

    fun streamPosition(id: Long): Long? = streams[id]?.position

    private fun open(json: JSONObject, generation: Long, id: Long) {
        if (streams.values.any { it.generation != generation }) {
            streams.clear()
            completed.clear()
        }
        val role = if (json.getString("role") == "current") PcmRole.CURRENT else PcmRole.CONTINUITY
        if (streams.containsKey(id) || streams.values.any { it.role == role }) violations += "role conflict $id"
        if (json.has("path")) violations += "open carried a path"
        val track = checkNotNull(tracksByRef[json.getString("playbackRef")])
        if (track.sampleRate != json.getInt("sampleRate")) {
            outbox += JSONObject().put("type", "rate-mismatch").put("generation", generation)
                .put("streamId", id).put("sampleRate", track.sampleRate).toString()
            return
        }
        completed.entries.removeIf { it.value == role }
        val start = json.getLong("startFrame")
        val stream = ServerStream(generation, id, role, track, start)
        streams[id] = stream
        val offered = json.optJSONArray("codecs")?.let { array -> (0 until array.length()).map(array::getString) }.orEmpty()
        val metadata = JSONObject().put("type", "metadata").put("generation", generation).put("streamId", id)
            .put("role", role.wire).put("sampleRate", track.sampleRate).put("channels", 2)
            .put("provisionalTotalFrames", track.frames).put("requestedStartFrame", start)
            .put("timelineStartFrame", start)
        if (encoded && "mp3" in offered) {
            val kept = track.frames - start
            val buffer = ByteBuffer.allocate(((ENCODED_SKIP_FRAMES + kept + ENCODED_TRAILING_FRAMES) * 8).toInt())
                .order(ByteOrder.LITTLE_ENDIAN)
            repeat(ENCODED_SKIP_FRAMES) { buffer.putFloat(-1f).putFloat(JUNK_TAG) }
            for (frame in start until track.frames) buffer.putFloat(frame.toFloat()).putFloat(track.tag.toFloat())
            repeat(ENCODED_TRAILING_FRAMES) { buffer.putFloat(-1f).putFloat(JUNK_TAG) }
            stream.encodedBytes = buffer.array()
            stream.outstanding = INITIAL_CREDIT_BYTES
            metadata.put("codec", "mp3").put("skipFrames", ENCODED_SKIP_FRAMES).put("totalFrames", kept)
                .put("initialCreditBytes", INITIAL_CREDIT_BYTES)
        }
        outbox += metadata.toString()
        if (stream.encodedBytes != null && decoding) drain(stream)
    }

    private fun credit(id: Long, frames: Int) {
        val stream = streams[id]
        if (stream == null) {
            if (id !in completed) violations += "credit for unknown stream $id"
            return
        }
        stream.outstanding += frames
        maxOutstanding = maxOf(maxOutstanding, stream.outstanding)
        if (stream.encodedBytes != null) {
            bytesCredited += frames
            if (stream.outstanding > MAX_ENCODED_CREDIT_BYTES) violations += "outstanding byte credit ${stream.outstanding}"
        } else if (stream.outstanding > RATE) {
            violations += "outstanding credit ${stream.outstanding} exceeds $RATE"
        }
        if (decoding) drain(stream)
    }

    private fun drainEncoded(stream: ServerStream, bytes: ByteArray) {
        while (stream.outstanding > 0 && stream.sentBytes < bytes.size && streams[stream.id] === stream) {
            val length = minOf(stream.outstanding, encodedChunkBytes, bytes.size - stream.sentBytes)
            outbox += encodedFrame(stream.role, stream.generation, stream.id, stream.sequence,
                bytes.copyOfRange(stream.sentBytes, stream.sentBytes + length))
            stream.sequence += 1
            stream.sentBytes += length
            stream.outstanding -= length
        }
        if (stream.sentBytes == bytes.size && streams[stream.id] === stream) {
            val total = stream.track.frames
            outbox += JSONObject().put("type", "eos").put("generation", stream.generation)
                .put("streamId", stream.id).put("role", stream.role.wire)
                .put("emittedFrames", total - stream.start).put("authoritativeTotalFrames", total).toString()
            streams.remove(stream.id)
            completed[stream.id] = stream.role
        }
    }

    private fun drain(stream: ServerStream) {
        stream.encodedBytes?.let { return drainEncoded(stream, it) }
        while (stream.outstanding > 0 && streams[stream.id] === stream) {
            val remaining = stream.track.frames - stream.position
            if (remaining <= 0) {
                outbox += JSONObject().put("type", "eos").put("generation", stream.generation)
                    .put("streamId", stream.id).put("role", stream.role.wire)
                    .put("emittedFrames", stream.position - stream.start)
                    .put("authoritativeTotalFrames", stream.position).toString()
                streams.remove(stream.id)
                completed[stream.id] = stream.role
                return
            }
            val frames = minOf(stream.outstanding.toLong(), chunkFrames.toLong(), remaining).toInt()
            val samples = FloatArray(frames * 2) { index ->
                if (index % 2 == 0) (stream.position + index / 2).toFloat() else stream.track.tag.toFloat()
            }
            outbox += pcmFrame(stream.role, stream.generation, stream.id, stream.sequence, samples)
            stream.sequence += 1
            stream.position += frames
            stream.outstanding -= frames
        }
    }

    private fun promote(json: JSONObject, generation: Long, id: Long) {
        if (json.getString("fromRole") != "continuity" || json.getString("toRole") != "current") {
            violations += "bad promote roles"
        }
        val incoming = streams[id]
        if (incoming?.role == PcmRole.CONTINUITY && incoming.generation == generation) {
            streams.values.removeIf { it.role == PcmRole.CURRENT }
            completed.entries.removeIf { it.value == PcmRole.CURRENT }
            incoming.role = PcmRole.CURRENT
        } else if (completed[id] == PcmRole.CONTINUITY) {
            streams.values.removeIf { it.role == PcmRole.CURRENT }
            completed.clear()
            completed[id] = PcmRole.CURRENT
        } else {
            violations += "promote of unknown continuity $id"
            return
        }
        outbox += JSONObject().put("type", "promoted").put("generation", generation)
            .put("streamId", id).put("role", "current").toString()
    }
}

/** Frames of the synthetic signal: left is the source frame and right the track tag, both times the frame's gain. */
class PcmTrace {
    private var samples = FloatArray(1 shl 20)
    var frames = 0
        private set

    fun append(source: FloatArray, offsetSamples: Int, count: Int, gain: Float = 1f) {
        while ((frames + count) * 2 > samples.size) samples = samples.copyOf(samples.size * 2)
        for (sample in 0 until count * 2) samples[frames * 2 + sample] = source[offsetSamples + sample] * gain
        frames += count
    }

    /** Appends frame [frame] of [source] scaled by [gain]. */
    fun appendFrame(source: PcmTrace, frame: Int, gain: Float) = append(source.samples, frame * 2, 1, gain)

    /**
     * Contiguous runs of (tag, first source frame, length); any gap, repeat or insertion splits a run.
     * [envelopeTag] names the one track in the trace, so a frame scaled by a gain in (0, 1] is read
     * back as the frame it scales and a fade shows as one run; [gain] tells the envelope.
     */
    fun runs(envelopeTag: Int? = null): List<Run> {
        val runs = mutableListOf<Run>()
        for (frame in 0 until frames) {
            var index = samples[frame * 2].toLong()
            var tag = samples[frame * 2 + 1].toInt()
            if (envelopeTag != null) {
                val gain = gain(frame, envelopeTag)
                if (gain > 0.0 && gain <= 1.0) {
                    index = kotlin.math.round(samples[frame * 2] / gain).toLong()
                    tag = envelopeTag
                }
            }
            val last = runs.lastOrNull()
            if (last != null && last.tag == tag && last.start + last.length == index) {
                runs[runs.lastIndex] = last.copy(length = last.length + 1)
            } else {
                runs += Run(tag, index, 1)
            }
        }
        return runs
    }

    /** The gain frame [frame] carries, read off the tag channel of a track tagged [tag]. */
    fun gain(frame: Int, tag: Int): Double = samples[frame * 2 + 1].toDouble() / tag

    /**
     * Asserts the trace holds frames [firstFrame] onward of the track tagged [tag], every one exactly
     * once and in order, at full gain except for fades: no frame is silent and none changes gain by
     * more than one step of a [fadeFrames] fade. [fadesIn] says the trace starts from silence.
     * Returns the frames at the lowest gain, where each fade down ended and the next fade up began.
     */
    fun assertFadedStream(tag: Int, firstFrame: Long, fadeFrames: Int, fadesIn: Boolean = false): List<Int> {
        assertEquals(listOf(Run(tag, firstFrame, frames.toLong())), runs(envelopeTag = tag))
        val step = 1.0 / fadeFrames
        val floor = 0.5 * step
        var previous = if (fadesIn) 0.0 else 1.0
        val quietest = mutableListOf<Int>()
        for (frame in 0 until frames) {
            val gain = gain(frame, tag)
            assertTrue("frame $frame gain $gain is silent or above full scale", gain >= floor - 1e-6 && gain <= 1.0)
            assertTrue("frame $frame gain steps from $previous to $gain", kotlin.math.abs(gain - previous) <= step + 1e-6)
            if (kotlin.math.abs(gain - floor) < 1e-6) quietest += frame
            previous = gain
        }
        return quietest
    }
}

/**
 * Records every written sample and every transport operation of the one audible output. With
 * [capacityFrames] it also models an [android.media.AudioTrack]: written frames queue up to that
 * capacity, and [advance] plays them through the fades into [heard], one frame per frame of time.
 */
class RecordingSink(
    override val sampleRate: Int = RATE,
    var acceptFrames: Int = Int.MAX_VALUE,
    private val capacityFrames: Int? = null,
) : PcmSink {
    private val written = PcmTrace()
    val writtenFrames: Int get() = written.frames
    val operations = mutableListOf<String>()

    /** What the modelled output played, with the gain its fades gave each frame. */
    val heard = PcmTrace()

    /** Written frames the fake output has not played yet; the output model counts its own. */
    var pending = 0
    private var played = 0
    private var running = false

    /** The fade in frames; the fade level runs from 0, silence, to this, full gain. */
    val fadeFrames = (sampleRate * PcmSink.FADE_MS / 1000).toInt()
    private var fadeLevel = fadeFrames
    private var fadingDown = false
    private var pauseAtSilence = false

    /** Frames the model played at zero gain because the output had not paused yet: frames lost to the ear. */
    var silentlyPlayed = 0
        private set

    override fun pendingFrames() = if (capacityFrames != null) writtenFrames - played else minOf(pending, writtenFrames)

    override fun heardFrames() = (writtenFrames - pendingFrames()).toLong()

    /** Fails like an [android.media.AudioTrack] whose audio server died: every write answers `ERROR_DEAD_OBJECT`. */
    var dead = false

    override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        if (dead) return ERROR_DEAD_OBJECT
        val room = capacityFrames?.let { it - pendingFrames() } ?: Int.MAX_VALUE
        val accepted = minOf(frames, acceptFrames, room)
        written.append(samples, offsetSamples, accepted)
        if (operations.lastOrNull() != "write") operations += "write"
        return accepted
    }

    /** Written frames the output had not played yet at each [pause]. */
    val unplayedAtPause = mutableListOf<Int>()

    override fun play() {
        operations += "play"
        running = true
    }

    override fun pause() {
        operations += "pause"
        unplayedAtPause += pendingFrames()
        running = false
        pauseAtSilence = false
    }

    override fun fadeOutAndPause() {
        operations += "fade-out"
        fadingDown = true
        pauseAtSilence = true
    }

    /** Without the output model no time passes for the fade, so it is done at once. */
    override fun fadeOutSettled(): Boolean {
        if (!pauseAtSilence) return true
        if (capacityFrames != null && fadeLevel > 0) return false
        pause()
        return true
    }

    override fun resumeWithFadeIn() {
        operations += "fade-in"
        // Output stopped at full gain fades up anew; a fade down turns back from where it is.
        if (!fadingDown) fadeLevel = 0
        fadingDown = false
        pauseAtSilence = false
        running = true
    }

    override fun flush() {
        operations += "flush"
        played = writtenFrames
        fadeLevel = fadeFrames
        fadingDown = false
        pauseAtSilence = false
    }

    override fun release() {
        operations += "release"
    }

    /** The modelled output plays [frames] frames of time: queued frames through the fade, nothing while paused or empty. */
    fun advance(frames: Int) {
        checkNotNull(capacityFrames) { "only the output model plays" }
        repeat(frames) {
            if (!running || played == writtenFrames) return
            val gain = when {
                fadingDown && fadeLevel == 0 -> {
                    silentlyPlayed += 1
                    0f
                }
                fadingDown -> (fadeLevel - 0.5f).also { fadeLevel -= 1 } / fadeFrames
                fadeLevel < fadeFrames -> (fadeLevel + 0.5f).also { fadeLevel += 1 } / fadeFrames
                else -> 1f
            }
            heard.appendFrame(written, played, gain)
            played += 1
        }
    }

    fun runs(envelopeTag: Int? = null) = written.runs(envelopeTag)

    fun gain(frame: Int, tag: Int) = written.gain(frame, tag)

    private companion object {
        /** `AudioTrack.ERROR_DEAD_OBJECT`. */
        const val ERROR_DEAD_OBJECT = -6
    }
}

data class Run(val tag: Int, val start: Long, val length: Long)

/** `INITIAL_ENCODED_CREDIT_BYTES` and `MAX_ENCODED_CREDIT_BYTES` in music_app/services/playback_encoded.py. */
const val INITIAL_CREDIT_BYTES = 64 * 1024
const val MAX_ENCODED_CREDIT_BYTES = 1024 * 1024

class PcmHarness(
    vararg tracks: SyntheticTrack,
    config: PcmEngineConfig = PcmEngineConfig(RATE),
    chunkFrames: Int = 4_096,
    val sink: RecordingSink = RecordingSink(),
    /** Streams come encoded and decode through [decoders]. */
    encoded: Boolean = false,
) {
    val server = FakeAhpcServer(tracks.toList(), chunkFrames).also { it.encoded = encoded }
    val events = mutableListOf<PcmEngineEvent>()
    /** The engine's clock; it stands still unless a test moves it, so arrival counts as instant. */
    var nowMs = 0L
    val decoders = FakeDecoders()

    /** Whether the fake decoders decode during [deliver]; off, decoded audio waits as a slow decoder's would. */
    var decoding = true
    val engine = NativePcmEngine(
        config, sink, server, clockMs = { nowMs },
        decoders = decoders.takeIf { encoded },
        codecs = { setOf(AudioCodec.MP3) },
    ) { events += it }

    fun deliver() {
        do {
            while (server.outbox.isNotEmpty()) {
                when (val message = server.outbox.removeFirst()) {
                    is String -> engine.onServerText(message)
                    is ByteArray -> engine.onBinary(message)
                }
            }
        } while ((decoding && decoders.run()) || server.outbox.isNotEmpty())
    }

    fun step(frames: Int = 1_024): Int {
        deliver()
        val written = engine.render(frames)
        deliver()
        return written
    }

    fun playUntil(maxSteps: Int = 100_000, done: () -> Boolean) {
        repeat(maxSteps) {
            if (done()) return
            step()
        }
        error("playback did not reach the expected state")
    }

    fun playToEnd() = playUntil { events.any { it is PcmEngineEvent.Ended } || failure() != null }

    fun failure(): PcmEngineEvent.Failed? = events.filterIsInstance<PcmEngineEvent.Failed>().firstOrNull()

    inline fun <reified T : PcmClientControl> sent(): List<T> = server.controls.filterIsInstance<T>()

    inline fun <reified T : PcmEngineEvent> emitted(): List<T> = events.filterIsInstance<T>()
}
