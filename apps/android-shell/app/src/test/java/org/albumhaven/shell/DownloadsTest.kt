package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.concurrent.Executor

class DownloadsTest {
    @Test
    fun aDisabledOrRefusingDownloadManagerAnswersNullInsteadOfThrowing() {
        assertNull(downloadManagerOrNull<Long> { throw IllegalArgumentException("Unknown URL content://downloads/my_downloads") })
        assertNull(downloadManagerOrNull<Long> { throw IllegalStateException("Failed to get external storage files directory") })
        assertNull(downloadManagerOrNull<Long> { throw SecurityException("Unsupported path") })
        assertEquals(42L, downloadManagerOrNull { 42L })
    }

    @Test
    fun aDownloadIsBuiltAndEnqueuedOffTheMainThreadAndARefusalAnswersOnIt() {
        var thread = "main"
        val io = Executor { task ->
            thread = "io"
            task.run()
            thread = "main"
        }
        val mainQueue = ArrayDeque<Runnable>()
        val seen = mutableListOf<String>()

        // Building the request asks for external storage, which throws while it is unavailable.
        enqueueDownload(io, mainQueue::add, {
            seen += "build on $thread"
            throw IllegalStateException("Failed to get external storage files directory")
        }) { seen += "answer $it on $thread" }
        enqueueDownload(io, mainQueue::add, { 7L }) { seen += "answer $it on $thread" }
        while (mainQueue.isNotEmpty()) mainQueue.removeFirst().run()

        assertEquals(listOf("build on io", "answer null on main", "answer 7 on main"), seen)
    }

    @Test
    fun aDownloadNobodyWaitsForIsEnqueuedOffTheMainThreadAndARefusalIsDropped() {
        val ran = mutableListOf<String>()
        val io = Executor { task ->
            ran += "io"
            task.run()
        }

        // Nothing is posted back, and a refusing Download Manager does not throw on the io thread.
        enqueueDownload(io) { throw IllegalArgumentException("Unknown URL content://downloads/my_downloads") }
        enqueueDownload(io) { 7L.also { ran += "enqueued" } }

        assertEquals(listOf("io", "io", "enqueued"), ran)
    }
}
