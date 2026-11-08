package org.albumhaven.shell

import org.albumhaven.shell.playback.CommandResult
import org.albumhaven.shell.playback.CommandSource
import org.albumhaven.shell.playback.LoopKind
import org.albumhaven.shell.playback.LoopRange
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackPort
import org.albumhaven.shell.playback.NativePlaybackSnapshot
import org.albumhaven.shell.playback.QueueItem
import org.albumhaven.shell.playback.QueueLoad
import org.json.JSONArray
import org.json.JSONObject

/** Validates `playback.*` commands and encodes native playback events (Web/Native Bridge v1). */
class PlaybackBridge(private val port: NativePlaybackPort) {

    /** Returns the response payload, or null when [name] is not a playback command. */
    fun handle(name: String, payload: JSONObject): Result? = when (name) {
        LOAD_QUEUE -> parseLoad(payload)?.let { result(port.loadQueue(it), it.queueRevision) } ?: invalid()
        PLAY -> revision(payload)?.let { result(port.play(it)) } ?: invalid()
        PAUSE -> empty(payload) { port.pause() }
        STOP -> empty(payload) { port.stop() }
        NEXT -> revision(payload)?.let { result(port.next(it)) } ?: invalid()
        PREVIOUS -> revision(payload)?.let { result(port.previous(it)) } ?: invalid()
        SEEK -> seek(payload)
        SET_LOOP -> setLoop(payload)
        CLEAR_LOOP -> revision(payload)?.let { result(port.setLoop(it, null)) } ?: invalid()
        SNAPSHOT -> if (payload.length() == 0) Result.Ok(snapshotJson(port.snapshot)) else invalid()
        else -> null
    }

    sealed interface Result {
        data class Ok(val payload: JSONObject = JSONObject()) : Result
        data class Failed(val code: String, val message: String) : Result
    }

    private fun seek(payload: JSONObject): Result {
        if (payload.fieldNames() != setOf("queueRevision", "positionMs")) return invalid()
        val revision = positiveLong(payload.opt("queueRevision"))
        val position = nonNegativeLong(payload.opt("positionMs"))
        if (revision == null || position == null) return invalid()
        return result(port.seek(revision, position))
    }

    /** `kind` is the web's loop kind; without it the worklet's own five-second rule decides. */
    private fun setLoop(payload: JSONObject): Result {
        val fields = payload.fieldNames()
        if (fields != SET_LOOP_KEYS && fields != SET_LOOP_KEYS + "kind") return invalid()
        val revision = positiveLong(payload.opt("queueRevision")) ?: return invalid()
        val range = loopRange(payload) ?: return invalid()
        val kind = if ("kind" in fields) (payload.opt("kind") as? String)?.let(LoopKind::of) ?: return invalid() else null
        return result(port.setLoop(revision, range.copy(kind = kind)))
    }

    private fun revision(payload: JSONObject): Long? =
        if (payload.fieldNames() == setOf("queueRevision")) positiveLong(payload.opt("queueRevision")) else null

    private inline fun empty(payload: JSONObject, action: () -> Unit): Result {
        if (payload.length() != 0) return invalid()
        action()
        return Result.Ok()
    }

    private fun result(outcome: CommandResult, queueRevision: Long? = null): Result = when (outcome) {
        CommandResult.ACCEPTED ->
            Result.Ok(JSONObject().apply { queueRevision?.let { put("queueRevision", it) } })
        CommandResult.STALE_REVISION -> Result.Failed("stale_revision", "A newer queue revision is applied")
        CommandResult.NO_QUEUE -> Result.Failed("no_queue", "No queue is loaded")
    }

    private fun invalid(): Result = Result.Failed("invalid_payload", "Invalid playback command")

    private fun parseLoad(payload: JSONObject): QueueLoad? {
        val fields = payload.fieldNames()
        if (fields != LOAD_KEYS && fields != LOAD_KEYS + "keepCurrent") return null
        val revision = positiveLong(payload.opt("queueRevision")) ?: return null
        val array = payload.opt("items") as? JSONArray ?: return null
        if (array.length() !in 1..MAX_QUEUE_ITEMS) return null
        val items = (0 until array.length()).map { parseItem(array.opt(it)) ?: return null }
        if (items.zipWithNext().any { (before, after) -> after.queueGroup < before.queueGroup }) return null
        val currentIndex = nonNegativeLong(payload.opt("currentIndex"))?.toInt() ?: return null
        if (currentIndex !in items.indices) return null
        val position = nonNegativeLong(payload.opt("positionMs")) ?: return null
        val loop = when (val raw = payload.opt("loop")) {
            JSONObject.NULL -> null
            is JSONObject -> if (raw.fieldNames() == LOOP_KEYS) loopRange(raw) ?: return null else return null
            else -> return null
        }
        val autoplay = payload.opt("autoplay") as? Boolean ?: return null
        val keepCurrent = if ("keepCurrent" in fields) payload.opt("keepCurrent") as? Boolean ?: return null else false
        return QueueLoad(revision, items, currentIndex, position, loop, autoplay, keepCurrent)
    }

    private fun parseItem(raw: Any?): QueueItem? {
        val item = raw as? JSONObject ?: return null
        val fields = item.fieldNames()
        if (!fields.containsAll(ITEM_KEYS) || !OPTIONAL_ITEM_KEYS.containsAll(fields - ITEM_KEYS)) return null
        val ref = item.opt("playbackRef") as? String ?: return null
        if (!QueueItem.isPlaybackRef(ref)) return null
        val title = text(item.opt("title")) ?: return null
        val artist = text(item.opt("artist")) ?: return null
        val album = text(item.opt("album")) ?: return null
        val artwork = when (val value = item.opt("artworkUrl")) {
            JSONObject.NULL -> null
            is String -> value.takeIf(QueueItem::isArtworkPath) ?: return null
            else -> return null
        }
        val duration = nonNegativeLong(item.opt("durationMs")) ?: return null
        if (duration > MAX_DURATION_MS) return null
        val trackNumber = text(item.opt("trackNumber")) ?: return null
        val listenKey = (item.opt("listenKey") as? String)?.takeIf(QueueItem::isListenKey) ?: return null
        val queueGroup = nonNegativeLong(item.opt("queueGroup"))?.takeIf { it <= MAX_QUEUE_ITEMS }?.toInt() ?: return null
        val resumeToken = if ("resumeToken" in fields) {
            (item.opt("resumeToken") as? String)?.takeIf(QueueItem::isResumeToken) ?: return null
        } else {
            null
        }
        val year = if ("year" in fields) text(item.opt("year"))?.takeIf { it.length <= MAX_YEAR_CHARS } ?: return null else ""
        val rating = if ("rating" in fields) (item.opt("rating") as? Int)?.takeIf { it in 1..MAX_RATING } ?: return null else null
        return QueueItem(ref, title, artist, album, artwork, duration, trackNumber, listenKey, queueGroup, resumeToken, year, rating)
    }

    private fun loopRange(json: JSONObject): LoopRange? {
        val start = nonNegativeLong(json.opt("startFrame")) ?: return null
        val end = nonNegativeLong(json.opt("endFrame")) ?: return null
        val rate = positiveLong(json.opt("sampleRate"))?.takeIf { it <= MAX_SAMPLE_RATE }?.toInt() ?: return null
        return if (end > start) LoopRange(start, end, rate) else null
    }

    private fun text(value: Any?): String? = (value as? String)?.takeIf(QueueItem::isDisplayText)

    private fun nonNegativeLong(value: Any?): Long? = when (value) {
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }?.takeIf { it >= 0 }

    private fun positiveLong(value: Any?): Long? = nonNegativeLong(value)?.takeIf { it > 0 }

    companion object {
        /** Android plays, holds the claim and sends every listen write; the web sends none. */
        const val NATIVE_CAPABILITY = "playback.native.v1"
        const val QUEUE_CAPABILITY = "playback.queue.v1"
        /** Loop points are frames of the track at the `sampleRate` Android reported for it. */
        const val LOOPS_CAPABILITY = "playback.loops.v2"

        /**
         * Playback lives in a media session that outlasts the document: a same-origin reload
         * re-attaches to the running queue, and Android's own controls send `initiator: "system"`.
         */
        const val MEDIA_SESSION_CAPABILITY = "playback.media_session.v1"

        /**
         * Queue items may carry a `resumeToken`, which Android persists instead of the reference, so
         * the system media card can resume playback after the session, the process or the device ended.
         */
        const val RESUMPTION_CAPABILITY = "playback.resumption.v1"

        /** Queue items may carry the album's `year` and `rating` (1-10), which the media card shows after the album. */
        const val ALBUM_DETAILS_CAPABILITY = "playback.album_details.v1"
        val CAPABILITIES = listOf(
            NATIVE_CAPABILITY, QUEUE_CAPABILITY, LOOPS_CAPABILITY, MEDIA_SESSION_CAPABILITY, RESUMPTION_CAPABILITY,
            ALBUM_DETAILS_CAPABILITY,
        )

        private const val LOAD_QUEUE = "playback.loadQueue"
        private const val PLAY = "playback.play"
        private const val PAUSE = "playback.pause"
        private const val STOP = "playback.stop"
        private const val NEXT = "playback.next"
        private const val PREVIOUS = "playback.previous"
        private const val SEEK = "playback.seek"
        private const val SET_LOOP = "playback.setLoop"
        private const val CLEAR_LOOP = "playback.clearLoop"
        private const val SNAPSHOT = "playback.snapshot"

        /** `POST /playback/refs` issues at most this many references per batch. */
        const val MAX_QUEUE_ITEMS = 100
        private const val MAX_DURATION_MS = 7L * 24 * 60 * 60 * 1000

        private val LOAD_KEYS = setOf("queueRevision", "items", "currentIndex", "positionMs", "loop", "autoplay")
        private val LOOP_KEYS = setOf("startFrame", "endFrame", "sampleRate")
        private val SET_LOOP_KEYS = LOOP_KEYS + "queueRevision"
        private const val MAX_SAMPLE_RATE = 192_000L

        /** `queueGroup` numbers the web playback queues (albums) in order; it never decreases along the queue. */
        private val ITEM_KEYS = setOf(
            "playbackRef", "listenKey", "title", "artist", "album", "artworkUrl", "durationMs", "trackNumber", "queueGroup",
        )
        private val OPTIONAL_ITEM_KEYS = setOf("resumeToken", "year", "rating")
        private const val MAX_RATING = 10
        private const val MAX_YEAR_CHARS = 32

        fun snapshotJson(snapshot: NativePlaybackSnapshot): JSONObject = JSONObject()
            .put("state", snapshot.state.wire)
            .put("clientId", snapshot.clientId)
            .put("queueRevision", snapshot.queueRevision)
            .put("currentIndex", snapshot.currentIndex ?: JSONObject.NULL)
            .put("positionMs", snapshot.positionMs)
            .put("durationMs", snapshot.durationMs)
            .apply { snapshot.sampleRate?.let { put("sampleRate", it) } }

        /** The bridge event name and payload; every payload echoes the applied queue revision. */
        fun encode(event: NativePlaybackEvent): Pair<String, JSONObject> {
            val payload = snapshotJson(event.snapshot)
            val name = when (event) {
                is NativePlaybackEvent.State -> {
                    payload.putInitiator(event.source)
                    "playback.state"
                }
                is NativePlaybackEvent.Position -> "playback.position"
                is NativePlaybackEvent.CurrentItem -> {
                    payload.put("reason", event.reason.wire)
                    payload.putInitiator(event.source)
                    "playback.currentItem"
                }
                is NativePlaybackEvent.LoopWrapped -> "playback.loopWrapped"
                is NativePlaybackEvent.Ownership -> {
                    payload.put("ownership", event.ownership)
                    "playback.ownership"
                }
                is NativePlaybackEvent.Error -> {
                    payload.put("error", JSONObject().put("code", event.code).put("message", event.message))
                    "playback.error"
                }
                is NativePlaybackEvent.ReferenceExpired -> "playback.referenceExpired"
            }
            return name to payload
        }

        /** Only changes Android's own controls made are marked; the web already knows its own. */
        private fun JSONObject.putInitiator(source: CommandSource) {
            if (source == CommandSource.SYSTEM) put("initiator", "system")
        }

        private fun JSONObject.fieldNames(): Set<String> = keys().asSequence().toSet()
    }
}
