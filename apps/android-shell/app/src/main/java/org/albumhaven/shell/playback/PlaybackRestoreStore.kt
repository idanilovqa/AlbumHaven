package org.albumhaven.shell.playback

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * One queue entry as it may outlive the process: display metadata, the path-free identities a
 * listen needs, and the track's [resumeToken]; deliberately without its playback reference.
 */
data class RestorableItem(
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val durationMs: Long,
    val trackNumber: String = "",
    val listenKey: String = "",
    val queueGroup: Int = 0,
    val resumeToken: String? = null,
)

/**
 * The last queue the session showed, for the media card after process death. [clientId] is the
 * controller that played it, so a document that handed Android this queue can adopt it again.
 */
data class RestorableQueue(
    val origin: String,
    val clientId: String,
    val queueRevision: Long,
    val currentIndex: Int,
    val positionMs: Long,
    val items: List<RestorableItem>,
) {
    /** Playback can resume without the app only when the current item has a resume token. */
    val resumable: Boolean get() = items[currentIndex].resumeToken != null

    companion object {
        /** The controller's applied queue, or null when none is applied. */
        fun of(snapshot: NativePlaybackSnapshot, origin: String): RestorableQueue? {
            val index = snapshot.currentIndex ?: return null
            if (snapshot.items.isEmpty()) return null
            return RestorableQueue(
                origin, snapshot.clientId, snapshot.queueRevision, index, snapshot.positionMs,
                snapshot.items.map { item ->
                    RestorableItem(
                        item.title, item.artist, item.album, item.artworkUrl, item.durationMs,
                        item.trackNumber, item.listenKey, item.queueGroup, item.resumeToken,
                    )
                },
            )
        }
    }
}

/** One string value in private app storage. */
interface RestoreStorage {
    fun read(): String?
    fun write(value: String?)
}

/**
 * Persists only path-free display metadata, listen identities, resume tokens, the current index,
 * the position, the queue revision and the controller's client ID. Playback references are not
 * kept: they are short-lived access handles, and a resume token is exchanged for a fresh one with
 * the WebView session when playback resumes. Cookies, CSRF, claim tokens, passwords and paths never
 * reach the controller's snapshot, so they cannot be written.
 */
class PlaybackRestoreStore(private val storage: RestoreStorage) {

    fun save(snapshot: NativePlaybackSnapshot, origin: String) {
        val queue = RestorableQueue.of(snapshot, origin) ?: return
        val items = JSONArray()
        queue.items.forEach { item ->
            items.put(
                JSONObject()
                    .put("title", item.title)
                    .put("artist", item.artist)
                    .put("album", item.album)
                    .put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
                    .put("durationMs", item.durationMs)
                    .put("trackNumber", item.trackNumber)
                    .put("listenKey", item.listenKey)
                    .put("queueGroup", item.queueGroup)
                    .put("resumeToken", item.resumeToken ?: JSONObject.NULL),
            )
        }
        storage.write(
            JSONObject()
                .put("version", VERSION)
                .put("origin", origin)
                .put("clientId", queue.clientId)
                .put("queueRevision", queue.queueRevision)
                .put("currentIndex", queue.currentIndex)
                .put("positionMs", queue.positionMs)
                .put("items", items)
                .toString(),
        )
    }

    /** The saved queue of [origin], or null when none was saved for it or it does not validate. */
    fun load(origin: String): RestorableQueue? {
        val raw = storage.read() ?: return null
        return try {
            decode(JSONObject(raw))?.takeIf { it.origin == origin }
        } catch (_: JSONException) {
            null
        }
    }

    fun clear() = storage.write(null)

    private fun decode(json: JSONObject): RestorableQueue? {
        if (json.fieldNames() != KEYS || json.opt("version") != VERSION) return null
        val origin = json.opt("origin") as? String ?: return null
        val clientId = (json.opt("clientId") as? String)?.takeIf(CLIENT_ID::matches) ?: return null
        val revision = (json.opt("queueRevision") as? Number)?.toLong() ?: return null
        val index = json.opt("currentIndex") as? Int ?: return null
        val position = (json.opt("positionMs") as? Number)?.toLong()?.takeIf { it >= 0 } ?: return null
        val array = json.opt("items") as? JSONArray ?: return null
        if (array.length() !in 1..MAX_ITEMS || index !in 0 until array.length()) return null
        val items = (0 until array.length()).map { decodeItem(array.opt(it)) ?: return null }
        if (items.zipWithNext().any { (before, after) -> after.queueGroup < before.queueGroup }) return null
        return RestorableQueue(origin, clientId, revision, index, position, items)
    }

    private fun decodeItem(raw: Any?): RestorableItem? {
        val item = raw as? JSONObject ?: return null
        if (item.fieldNames() != ITEM_KEYS) return null
        val artwork = when (val value = item.opt("artworkUrl")) {
            JSONObject.NULL -> null
            is String -> value.takeIf(QueueItem::isArtworkPath) ?: return null
            else -> return null
        }
        val resumeToken = when (val value = item.opt("resumeToken")) {
            JSONObject.NULL -> null
            is String -> value.takeIf(QueueItem::isResumeToken) ?: return null
            else -> return null
        }
        return RestorableItem(
            title = text(item.opt("title")) ?: return null,
            artist = text(item.opt("artist")) ?: return null,
            album = text(item.opt("album")) ?: return null,
            artworkUrl = artwork,
            durationMs = (item.opt("durationMs") as? Number)?.toLong()?.takeIf { it >= 0 } ?: return null,
            trackNumber = text(item.opt("trackNumber")) ?: return null,
            listenKey = (item.opt("listenKey") as? String)?.takeIf(QueueItem::isListenKey) ?: return null,
            queueGroup = (item.opt("queueGroup") as? Int)?.takeIf { it in 0..MAX_ITEMS } ?: return null,
            resumeToken = resumeToken,
        )
    }

    private fun JSONObject.fieldNames(): Set<String> = keys().asSequence().toSet()

    private fun text(value: Any?): String? = (value as? String)?.takeIf(QueueItem::isDisplayText)

    private companion object {
        // Version 1 kept display metadata only; such a queue cannot resume, so it is not loaded.
        const val VERSION = 2
        const val MAX_ITEMS = 100
        val KEYS = setOf("version", "origin", "clientId", "queueRevision", "currentIndex", "positionMs", "items")
        val ITEM_KEYS = setOf(
            "title", "artist", "album", "artworkUrl", "durationMs", "trackNumber", "listenKey", "queueGroup", "resumeToken",
        )
        val CLIENT_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    }
}
