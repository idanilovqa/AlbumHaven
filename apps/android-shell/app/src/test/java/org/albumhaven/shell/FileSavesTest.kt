package org.albumhaven.shell

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import java.util.concurrent.Executor

private const val TRANSFER = "3c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99"
private const val OTHER_TRANSFER = "7a1d3c2e-5b4f-4e6a-8c9d-0e1f2a3b4c5d"
private const val NAME = "album-haven-log-history-2026-11-05_10-00-00-000.json"

class FileSavesTest {
    private val saved = mutableListOf<Triple<String, String, ByteArray>>()
    private val log = mutableListOf<String>()
    private var thread = "main"
    private var stores = true
    private val io = Executor { task ->
        thread = "io"
        task.run()
        thread = "main"
    }
    private val mainQueue = ArrayDeque<Runnable>()
    private val files = FileSaves(
        { name, mimeType, bytes ->
            log += "save on $thread"
            saved += Triple(name, mimeType, bytes)
            stores
        },
        io,
        mainQueue::add,
    ) { log += "saved $it on $thread" }

    private fun chunk(data: ByteArray, offset: Int, size: Int, transfer: String = TRANSFER, name: String = NAME) =
        JSONObject()
            .put("transfer", transfer)
            .put("name", name)
            .put("mimeType", "application/json")
            .put("size", size)
            .put("offset", offset)
            .put("data", Base64.getEncoder().encodeToString(data))

    private fun send(payload: JSONObject): PlaybackBridge.Result? {
        var result: PlaybackBridge.Result? = null
        files.handle(payload) { result = it }
        while (mainQueue.isNotEmpty()) mainQueue.removeFirst().run()
        return result
    }

    private fun code(result: PlaybackBridge.Result?) = (result as PlaybackBridge.Result.Failed).code

    private fun assertOk(result: PlaybackBridge.Result?) = assertTrue(result.toString(), result is PlaybackBridge.Result.Ok)

    @Test
    fun aFileIsAssembledFromItsChunksAndWrittenOnceOffTheMainThread() {
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        assertOk(send(chunk(bytes.copyOfRange(0, 45_000), 0, bytes.size)))
        assertOk(send(chunk(bytes.copyOfRange(45_000, 90_000), 45_000, bytes.size)))
        assertEquals(emptyList<String>(), log)
        assertOk(send(chunk(bytes.copyOfRange(90_000, bytes.size), 90_000, bytes.size)))

        assertEquals(listOf("save on io", "saved true on main"), log)
        val (name, mimeType, written) = saved.single()
        assertEquals(NAME to "application/json", name to mimeType)
        assertArrayEquals(bytes, written)
    }

    @Test
    fun anOversizedFileIsRefusedBeforeAnythingIsKeptOrWritten() {
        val result = send(chunk(byteArrayOf(1), 0, FileSaves.MAX_BYTES + 1))
        assertEquals("too_large", code(result))
        // Nothing of it stays open either.
        assertEquals("invalid_payload", code(send(chunk(byteArrayOf(2), 1, FileSaves.MAX_BYTES))))
        assertTrue(saved.isEmpty())
        assertOk(send(chunk(byteArrayOf(3), 0, FileSaves.MAX_BYTES)))
    }

    @Test
    fun aChunkBeyondItsDeclaredSizeOrOutOfOrderEndsTheTransferUnsaved() {
        assertEquals("invalid_payload", code(send(chunk(ByteArray(5), 0, 4))))
        for (wrong in listOf(chunk(ByteArray(2), 1, 4), chunk(ByteArray(2), 2, 4, OTHER_TRANSFER), chunk(ByteArray(2), 2, 4, name = "other.json"))) {
            assertOk(send(chunk(ByteArray(2), 0, 4)))
            assertEquals(wrong.toString(), "invalid_payload", code(send(wrong)))
            assertEquals("invalid_payload", code(send(chunk(ByteArray(2), 2, 4))))
        }
        assertTrue(saved.isEmpty())
    }

    @Test
    fun malformedRequestsAreRefused() {
        val cases = listOf(
            chunk(ByteArray(1), 0, 1, transfer = "not-a-uuid"),
            chunk(ByteArray(1), 0, 1, name = "../escape.json"),
            chunk(ByteArray(1), 0, 1, name = ".hidden"),
            chunk(ByteArray(1), 0, 1, name = "dir/file.json"),
            chunk(ByteArray(1), 0, 1).put("mimeType", "application/json; charset=utf-8"),
            chunk(ByteArray(1), 0, 1).put("data", "not base64!"),
            chunk(ByteArray(1), 0, 1).put("data", ""),
            chunk(ByteArray(1), 0, 1).put("size", 0),
            chunk(ByteArray(1), 0, 1).put("size", "1"),
            chunk(ByteArray(1), 0, 1).put("extra", 1),
            chunk(ByteArray(1), 0, 1).apply { remove("offset") },
        )
        for (case in cases) assertEquals(case.toString(), "invalid_payload", code(send(case)))
        assertTrue(saved.isEmpty())
    }

    @Test
    fun aRefusedOrFailedWriteIsReportedAsUnsaved() {
        stores = false
        assertEquals("save_failed", code(send(chunk(byteArrayOf(1), 0, 1))))
        val throwing = FileSaves({ _, _, _ -> throw SecurityException("No storage") }, io, mainQueue::add) { log += "saved $it" }
        var result: PlaybackBridge.Result? = null
        throwing.handle(chunk(byteArrayOf(1), 0, 1)) { result = it }
        while (mainQueue.isNotEmpty()) mainQueue.removeFirst().run()
        assertEquals("save_failed", code(result))
        assertEquals(listOf("save on io", "saved false on main", "saved false"), log)
    }

    @Test
    fun aDocumentThatGoesLeavesItsUnfinishedFileUnsaved() {
        assertOk(send(chunk(ByteArray(2), 0, 4)))
        files.reset()
        assertEquals("invalid_payload", code(send(chunk(ByteArray(2), 2, 4))))
        assertTrue(saved.isEmpty())
    }
}
