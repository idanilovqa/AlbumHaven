package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.util.concurrent.Executor

private const val ORIGIN = "https://sandbox2.albumhaven.org"
private const val LINK = "/downloads/eyJ2IjoxfQ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

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

    @Test
    fun theDownloadedPathIsTheSameOriginPathAndQuery() {
        val asset = "/utilities/integrations/foobar/assets/text-tools-standard-preset?download=1"
        assertEquals(asset, sameOriginPath("$ORIGIN$asset", ORIGIN))
        assertEquals(asset, sameOriginPath("$ORIGIN:443$asset#part", ORIGIN))
        for (other in listOf("https://albumhaven.org$asset", "http://sandbox2.albumhaven.org$asset", "https://user@sandbox2.albumhaven.org$asset",
            "blob:$ORIGIN/6f0e2a5c", "data:text/plain,hi", "$ORIGIN", "not a url")) {
            assertNull(other, sameOriginPath(other, ORIGIN))
        }
    }

    @Test
    fun aLinkDownloadNeverCarriesACookie() {
        val download = LinkDownload.of(ORIGIN, LINK, "AlbumHaven/1", "text/plain", "preset.txt")!!
        assertEquals("$ORIGIN$LINK", download.url)
        assertEquals(mapOf("User-Agent" to "AlbumHaven/1"), download.headers)
        assertFalse(download.headers.keys.any { it.equals("Cookie", ignoreCase = true) })
        // The shell reads no cookie for any download, and sets none on a request.
        for (file in listOf("ShellActivity.kt", "Downloads.kt")) {
            val source = File("src/main/java/org/albumhaven/shell/$file").readText()
            assertFalse(file, source.contains("getCookie("))
            assertFalse(file, Regex("""addRequestHeader\(\s*["']Cookie""", RegexOption.IGNORE_CASE).containsMatchIn(source))
        }
    }

    @Test
    fun aRefusedOrMalformedLinkRequestsNothing() {
        val answers = listOf(
            null, "", "/utilities/integrations/foobar/assets/text-tools-standard-preset?download=1",
            "https://evil.example$LINK", "//evil.example$LINK", "$LINK/../../admin", "/downloads/links", "/artifacts/android/download/a.b",
        )
        for (answer in answers) assertNull(answer, LinkDownload.of(ORIGIN, answer, "AlbumHaven/1", null, "file"))
    }
}
