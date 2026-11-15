package org.albumhaven.playback.engine

import org.json.JSONException
import org.json.JSONObject

/**
 * Path-free track identity; [playbackRef] is the signed reference `/playback/pcm` resolves, and
 * [cacheKey] an opaque, stable key the device may keep the track under.
 */
data class PcmTrack(val playbackRef: String, val durationSeconds: Double, val cacheKey: String? = null)

/** Client controls handled by `_handle_control` in music_app/routes/playback_stream_asgi.py. */
sealed interface PcmClientControl {
    val generation: Long
    val streamId: Long

    data class Open(
        override val generation: Long,
        override val streamId: Long,
        val role: PcmRole,
        val track: PcmTrack,
        val startFrame: Long,
        val sampleRate: Int,
        /** Codecs this client decodes itself; the server then sends their encoded bytes. */
        val codecs: List<String> = emptyList(),
        /** `320` asks for a 320 kbps MP3 of a FLAC file, for a weak connection. */
        val quality: String? = null,
        /** Asks for the stream's seek table, to seek inside the bytes it received. */
        val seekTable: Boolean = false,
    ) : PcmClientControl

    data class Credit(override val generation: Long, override val streamId: Long, val frames: Int) :
        PcmClientControl

    data class Promote(override val generation: Long, override val streamId: Long) : PcmClientControl

    data class Close(override val generation: Long, override val streamId: Long, val reason: String) :
        PcmClientControl
}

/** Server events; numeric fields are null when absent or not integral, as the web engine validates them. */
sealed interface PcmServerEvent {
    val generation: Long?
    val streamId: Long?

    data class Metadata(
        override val generation: Long?,
        override val streamId: Long?,
        val role: String?,
        val sampleRate: Long?,
        val channels: Long?,
        val provisionalTotalFrames: Long?,
        val requestedStartFrame: Long?,
        val timelineStartFrame: Long?,
        val codec: String?,
        /** For an encoded stream: decoded frames to drop first, then frames to keep. */
        val skipFrames: Long? = null,
        val totalFrames: Long? = null,
        /** Byte credit the server granted with the open, unasked. */
        val initialCreditBytes: Long? = null,
    ) : PcmServerEvent

    data class Eos(
        override val generation: Long?,
        override val streamId: Long?,
        val role: String?,
        val emittedFrames: Long?,
        val authoritativeTotalFrames: Long?,
    ) : PcmServerEvent

    data class Promoted(override val generation: Long?, override val streamId: Long?, val role: String?) :
        PcmServerEvent

    data class Error(
        override val generation: Long?,
        override val streamId: Long?,
        val code: String?,
        val message: String?,
    ) : PcmServerEvent

    data class RateMismatch(override val generation: Long?, override val streamId: Long?, val sampleRate: Long?) :
        PcmServerEvent

    /** Where the stream's positions can be decoded from its bytes; null when the event is malformed. */
    data class SeekTableEvent(override val generation: Long?, override val streamId: Long?, val table: SeekTable?) :
        PcmServerEvent

    /** Answer to a `probe` request; native playback does not probe, so the engine ignores it. */
    data object ProbeResult : PcmServerEvent {
        override val generation: Long? = null
        override val streamId: Long? = null
    }

    data class Unknown(val type: String?, override val generation: Long?, override val streamId: Long?) :
        PcmServerEvent
}

object AhpcControlCodec {
    fun encode(control: PcmClientControl): String {
        val json = JSONObject()
        when (control) {
            is PcmClientControl.Open -> json
                .put("type", "open")
                .put("role", control.role.wire)
                .put("playbackRef", control.track.playbackRef)
                .put("startFrame", control.startFrame)
                .put("sampleRate", control.sampleRate)
                .put("durationSeconds", control.track.durationSeconds)
                .apply {
                    if (control.codecs.isNotEmpty()) put("codecs", org.json.JSONArray(control.codecs))
                    control.quality?.let { put("quality", it) }
                    if (control.seekTable) put("seekTable", true)
                }
            // An encoded stream's credit counts bytes in the same field.
            is PcmClientControl.Credit -> json.put("type", "credit").put("frames", control.frames)
            is PcmClientControl.Promote -> json
                .put("type", "promote")
                .put("fromRole", PcmRole.CONTINUITY.wire)
                .put("toRole", PcmRole.CURRENT.wire)
            is PcmClientControl.Close -> json.put("type", "close").put("reason", control.reason)
        }
        return json
            .put("generation", control.generation)
            .put("streamId", control.streamId)
            .toString()
    }

    fun decode(text: String): PcmServerEvent {
        val json = try {
            JSONObject(text)
        } catch (_: JSONException) {
            throw AhpcProtocolException("control is not a JSON object")
        }
        val generation = json.integer("generation")
        val streamId = json.integer("streamId")
        return when (val type = json.opt("type") as? String) {
            "metadata" -> PcmServerEvent.Metadata(
                generation = generation,
                streamId = streamId,
                role = json.opt("role") as? String,
                sampleRate = json.integer("sampleRate"),
                channels = json.integer("channels"),
                provisionalTotalFrames = json.integer("provisionalTotalFrames"),
                requestedStartFrame = json.integer("requestedStartFrame"),
                timelineStartFrame = json.integer("timelineStartFrame"),
                codec = json.opt("codec") as? String,
                skipFrames = json.integer("skipFrames"),
                totalFrames = json.integer("totalFrames"),
                initialCreditBytes = json.integer("initialCreditBytes"),
            )
            "eos" -> PcmServerEvent.Eos(
                generation = generation,
                streamId = streamId,
                role = json.opt("role") as? String,
                emittedFrames = json.integer("emittedFrames"),
                authoritativeTotalFrames = json.integer("authoritativeTotalFrames"),
            )
            "promoted" -> PcmServerEvent.Promoted(generation, streamId, json.opt("role") as? String)
            "error" -> PcmServerEvent.Error(
                generation = generation,
                streamId = streamId,
                code = json.opt("code") as? String,
                message = json.opt("message") as? String,
            )
            "rate-mismatch" -> PcmServerEvent.RateMismatch(generation, streamId, json.integer("sampleRate"))
            "seek-table" -> PcmServerEvent.SeekTableEvent(generation, streamId, seekTable(json))
            "probe-result" -> PcmServerEvent.ProbeResult
            else -> PcmServerEvent.Unknown(type, generation, streamId)
        }
    }

    private fun seekTable(json: JSONObject): SeekTable? {
        val offsets = json.optJSONArray("offsets") ?: return null
        val samples = json.optJSONArray("samples") ?: return null
        val prefix = json.integer("prefixBytes") ?: return null
        val preroll = json.integer("prerollFrames") ?: return null
        if (offsets.length() == 0 || offsets.length() != samples.length() || prefix < 0 || preroll < 0) return null
        val offsetValues = IntArray(offsets.length())
        val sampleValues = LongArray(samples.length())
        for (index in 0 until offsets.length()) {
            offsetValues[index] = (offsets.opt(index) as? Number)?.toInt() ?: return null
            sampleValues[index] = (samples.opt(index) as? Number)?.toLong() ?: return null
            if (index > 0 && (offsetValues[index] < offsetValues[index - 1] || sampleValues[index] < sampleValues[index - 1])) return null
        }
        return SeekTable(prefix.toInt(), preroll, offsetValues, sampleValues)
    }

    private fun JSONObject.integer(name: String): Long? = when (val value = opt(name)) {
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }
}
