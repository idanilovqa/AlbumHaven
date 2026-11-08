package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        QueueItem(
            "opaque-ref-secret-a", "Signal A", "Android Acceptance", "Playback Ownership", "/playback/artwork/rt1.a", 180_000,
            trackNumber = "1", listenKey = "lk-a", resumeToken = "rt1.a", year = "1999",
        ),
        QueueItem(
            "opaque-ref-secret-b", "Signal B", "Android Acceptance", "Playback Ownership", null, 120_000,
            trackNumber = "2", listenKey = "lk-b", queueGroup = 1,
        ),
    )

    private fun snapshot(index: Int? = 1, queue: List<QueueItem> = items) =
        NativePlaybackSnapshot(TEST_CLIENT_ID, NativePlaybackState.PLAYING, 6, index, 42_000, 120_000, items = queue)

    @Test
    fun savesResumeTokensAndListenIdentitiesButNeverReferences() {
        store.save(snapshot(), origin)
        val raw = storage.value!!
        assertFalse(raw.contains("opaque-ref"))
        assertFalse(raw.contains("playbackRef"))
        assertEquals(
            setOf("version", "origin", "clientId", "queueRevision", "currentIndex", "positionMs", "items"),
            JSONObject(raw).keys().asSequence().toSet(),
        )

        val loaded = store.load(origin)
        assertEquals(
            RestorableQueue(
                origin, TEST_CLIENT_ID, 6, 1, 42_000,
                listOf(
                    RestorableItem("Signal A", "Android Acceptance", "Playback Ownership", "/playback/artwork/rt1.a", 180_000, "1", "lk-a", 0, "rt1.a", "1999"),
                    RestorableItem("Signal B", "Android Acceptance", "Playback Ownership", null, 120_000, "2", "lk-b", 1, null),
                ),
            ),
            loaded,
        )
        assertFalse(loaded!!.resumable)
        assertTrue(loaded.copy(currentIndex = 0).resumable)
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
            JSONObject(valid.toString()).put("version", 1),
            JSONObject(valid.toString()).put("clientId", "not-a-uuid"),
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(0).put("resumeToken", "C:/Music/a.flac") },
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(1).put("queueGroup", 0).also { getJSONArray("items").getJSONObject(0).put("queueGroup", 2) } },
            JSONObject(valid.toString()).apply { getJSONArray("items").getJSONObject(0).remove("listenKey") },
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
