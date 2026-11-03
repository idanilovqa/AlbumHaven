package org.albumhaven.shell.playback

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Display metadata of one queue entry; deliberately without its playback reference. */
data class RestorableItem(
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val durationMs: Long,
)

/** The last queue the session showed, for the notification after process death. */
data class RestorableQueue(
    val origin: String,
    val queueRevision: Long,
    val currentIndex: Int,
    val positionMs: Long,
    val items: List<RestorableItem>,
)

/** One string value in private app storage. */
interface RestoreStorage {
    fun read(): String?
    fun write(value: String?)
}

/**
 * Persists only path-free display metadata, the current index, the position and the queue
 * revision. Playback references are not kept: they are signed access handles to library files,
 * and a queue restored without the web document could not emit its listen effects, so the
 * restored queue is display-only and playback restarts through the app. Cookies, CSRF, claim
 * tokens, passwords and paths never reach the controller's snapshot, so they cannot be written.
 */
class PlaybackRestoreStore(private val storage: RestoreStorage) {

    fun save(snapshot: NativePlaybackSnapshot, origin: String) {
        val index = snapshot.currentIndex ?: return
        if (snapshot.items.isEmpty()) return
        val items = JSONArray()
        snapshot.items.forEach { item ->
            items.put(
                JSONObject()
                    .put("title", item.title)
                    .put("artist", item.artist)
                    .put("album", item.album)
                    .put("artworkUrl", item.artworkUrl ?: JSONObject.NULL)
                    .put("durationMs", item.durationMs),
            )
        }
        storage.write(
            JSONObject()
                .put("version", VERSION)
                .put("origin", origin)
                .put("queueRevision", snapshot.queueRevision)
                .put("currentIndex", index)
                .put("positionMs", snapshot.positionMs)
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
        val revision = (json.opt("queueRevision") as? Number)?.toLong() ?: return null
        val index = json.opt("currentIndex") as? Int ?: return null
        val position = (json.opt("positionMs") as? Number)?.toLong()?.takeIf { it >= 0 } ?: return null
        val array = json.opt("items") as? JSONArray ?: return null
        if (array.length() !in 1..MAX_ITEMS || index !in 0 until array.length()) return null
        val items = (0 until array.length()).map { decodeItem(array.opt(it)) ?: return null }
        return RestorableQueue(origin, revision, index, position, items)
    }

    private fun decodeItem(raw: Any?): RestorableItem? {
        val item = raw as? JSONObject ?: return null
        if (item.fieldNames() != ITEM_KEYS) return null
        val artwork = when (val value = item.opt("artworkUrl")) {
            JSONObject.NULL -> null
            is String -> value.takeIf(QueueItem::isArtworkPath) ?: return null
            else -> return null
        }
        return RestorableItem(
            title = text(item.opt("title")) ?: return null,
            artist = text(item.opt("artist")) ?: return null,
            album = text(item.opt("album")) ?: return null,
            artworkUrl = artwork,
            durationMs = (item.opt("durationMs") as? Number)?.toLong()?.takeIf { it >= 0 } ?: return null,
        )
    }

    private fun JSONObject.fieldNames(): Set<String> = keys().asSequence().toSet()

    private fun text(value: Any?): String? = (value as? String)?.takeIf(QueueItem::isDisplayText)

    private companion object {
        const val VERSION = 1
        const val MAX_ITEMS = 100
        val KEYS = setOf("version", "origin", "queueRevision", "currentIndex", "positionMs", "items")
        val ITEM_KEYS = setOf("title", "artist", "album", "artworkUrl", "durationMs")
    }
}
