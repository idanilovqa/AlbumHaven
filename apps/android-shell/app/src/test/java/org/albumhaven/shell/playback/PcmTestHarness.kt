package org.albumhaven.shell.playback

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

const val RATE = 48_000

/** Every sample identifies itself: left is its source frame index, right is its track tag. */
class SyntheticTrack(val tag: Int, val frames: Long, val sampleRate: Int = RATE) {
    val pcm = PcmTrack("ref-$tag", frames.toDouble() / sampleRate)
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
    }

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
        streams[id] = ServerStream(generation, id, role, track, start)
        outbox += JSONObject().put("type", "metadata").put("generation", generation).put("streamId", id)
            .put("role", role.wire).put("sampleRate", track.sampleRate).put("channels", 2)
            .put("provisionalTotalFrames", track.frames).put("requestedStartFrame", start)
            .put("timelineStartFrame", start).toString()
    }

    private fun credit(id: Long, frames: Int) {
        val stream = streams[id]
        if (stream == null) {
            if (id !in completed) violations += "credit for unknown stream $id"
            return
        }
        stream.outstanding += frames
        maxOutstanding = maxOf(maxOutstanding, stream.outstanding)
        if (stream.outstanding > RATE) violations += "outstanding credit ${stream.outstanding} exceeds $RATE"
        if (decoding) drain(stream)
    }

    private fun drain(stream: ServerStream) {
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

/** Records every written sample and every transport operation of the one audible output. */
class RecordingSink(override val sampleRate: Int = RATE, var acceptFrames: Int = Int.MAX_VALUE) : PcmSink {
    private var trace = FloatArray(1 shl 20)
    var writtenFrames = 0
        private set
    val operations = mutableListOf<String>()

    /** Written frames the fake output has not played yet. */
    var pending = 0

    override fun pendingFrames() = minOf(pending, writtenFrames)

    override fun heardFrames() = (writtenFrames - pendingFrames()).toLong()

    /** Fails like an [android.media.AudioTrack] whose audio server died: every write and play throws. */
    var dead = false

    override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        check(!dead) { "AudioTrack write failed: -32" }
        val accepted = minOf(frames, acceptFrames)
        while ((writtenFrames + accepted) * 2 > trace.size) trace = trace.copyOf(trace.size * 2)
        System.arraycopy(samples, offsetSamples, trace, writtenFrames * 2, accepted * 2)
        writtenFrames += accepted
        if (operations.lastOrNull() != "write") operations += "write"
        return accepted
    }

    override fun play() {
        check(!dead) { "play() called on an uninitialized AudioTrack" }
        operations += "play"
    }
    override fun pause() { operations += "pause" }
    override fun flush() { operations += "flush" }
    override fun release() { operations += "release" }

    /** Contiguous runs of (tag, first source frame, length); any gap, repeat or insertion splits a run. */
    fun runs(): List<Run> {
        val runs = mutableListOf<Run>()
        for (frame in 0 until writtenFrames) {
            val index = trace[frame * 2].toLong()
            val tag = trace[frame * 2 + 1].toInt()
            val last = runs.lastOrNull()
            if (last != null && last.tag == tag && last.start + last.length == index) {
                runs[runs.lastIndex] = last.copy(length = last.length + 1)
            } else {
                runs += Run(tag, index, 1)
            }
        }
        return runs
    }
}

data class Run(val tag: Int, val start: Long, val length: Long)

class PcmHarness(
    vararg tracks: SyntheticTrack,
    config: PcmEngineConfig = PcmEngineConfig(RATE),
    chunkFrames: Int = 4_096,
) {
    val server = FakeAhpcServer(tracks.toList(), chunkFrames)
    val sink = RecordingSink()
    val events = mutableListOf<PcmEngineEvent>()
    val engine = NativePcmEngine(config, sink, server) { events += it }

    fun deliver() {
        while (server.outbox.isNotEmpty()) {
            when (val message = server.outbox.removeFirst()) {
                is String -> engine.onServerText(message)
                is ByteArray -> engine.onBinary(message)
            }
        }
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
