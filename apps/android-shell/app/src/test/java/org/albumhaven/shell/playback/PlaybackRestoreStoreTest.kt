package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class PlaybackRestoreStoreTest {
    private val origin = "https://sandbox2.albumhaven.org"

    private class MemoryStorage : RestoreStorage {
        var value: String? = null
        override fun read() = value
        override fun write(value: String?) {
            this.value = value
        }
    }

    private val storage = MemoryStorage()
    private val store = PlaybackRestoreStore(storage)
    private val items = listOf(
        QueueItem("opaque-ref-secret-a", "Signal A", "Android Acceptance", "Playback Ownership", "/static/a.jpg", 180_000, listenKey = "lk-a"),
        QueueItem("opaque-ref-secret-b", "Signal B", "Android Acceptance", "Playback Ownership", null, 120_000, listenKey = "lk-b"),
    )

    private fun snapshot(index: Int? = 1, queue: List<QueueItem> = items) =
        NativePlaybackSnapshot(TEST_CLIENT_ID, NativePlaybackState.PLAYING, 6, index, 42_000, 120_000, items = queue)

    @Test
    fun savesOnlyDisplayMetadataIndexPositionAndRevision() {
        store.save(snapshot(), origin)
        val raw = storage.value!!
        assertFalse(raw.contains("opaque-ref"))
        assertFalse(raw.contains(TEST_CLIENT_ID))
        assertFalse(raw.contains("playbackRef"))
        assertEquals(
            setOf("version", "origin", "queueRevision", "currentIndex", "positionMs", "items"),
            JSONObject(raw).keys().asSequence().toSet(),
        )

        assertEquals(
            RestorableQueue(
                origin, 6, 1, 42_000,
                listOf(
                    RestorableItem("Signal A", "Android Acceptance", "Playback Ownership", "/static/a.jpg", 180_000),
                    RestorableItem("Signal B", "Android Acceptance", "Playback Ownership", null, 120_000),
                ),
            ),
            store.load(origin),
        )
    }

    @Test
    fun anotherOriginNeverSeesTheSavedQueue() {
        store.save(snapshot(), origin)
        assertNull(store.load("https://sandbox3.albumhaven.org"))
    }

    @Test
    fun nothingIsSavedWithoutAQueueAndClearForgetsIt() {
        store.save(snapshot(index = null), origin)
        store.save(snapshot(queue = emptyList()), origin)
        assertNull(storage.value)
        store.save(snapshot(), origin)
        store.clear()
        assertNull(storage.value)
        assertNull(store.load(origin))
    }

    @Test
    fun storedDataThatDoesNotValidateIsIgnored() {
        store.save(snapshot(), origin)
        val valid = JSONObject(storage.value!!)
        val tampered = listOf(
            JSONObject(valid.toString()).put("playbackRef", "x"),
            JSONObject(valid.toString()).put("currentIndex", 5),
            JSONObject(valid.toString()).put("version", 2),
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(0).put("artworkUrl", "/cover?path=C:/Music") },
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(0).put("path", "C:/Music/a.flac") },
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(1).put("title", "a\u0000b") },
        )
        tampered.forEach { json ->
            storage.value = json.toString()
            assertNull(json.toString(), store.load(origin))
        }
        storage.value = "not json"
        assertNull(store.load(origin))
    }
}
