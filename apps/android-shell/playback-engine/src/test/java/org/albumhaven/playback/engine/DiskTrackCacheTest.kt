package org.albumhaven.playback.engine

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiskTrackCacheTest {
    private val directory: File = Files.createTempDirectory("tracks").toFile()
    private var quota = Long.MAX_VALUE
    private val cache = DiskTrackCache(directory, quotaBytes = { quota }, io = { it.run() })

    private fun track(size: Int) = CachedTrack("flac", 96_000, 0, 1234, ByteArray(size) { it.toByte() })

    @Test
    fun aKeptTrackComesBackExactlyUnderAnOpaqueName() {
        cache.store("lk1-0123abcd:241000", track(5000))
        val loaded = cache.load("lk1-0123abcd:241000")!!

        assertEquals("flac", loaded.codec)
        assertEquals(96_000, loaded.sampleRate)
        assertEquals(1234L, loaded.totalFrames)
        assertArrayEquals(track(5000).bytes, loaded.bytes)
        // Nothing of the key, let alone the library, names the file.
        assertTrue(directory.list()!!.none { it.contains("lk1") })
        assertNull(cache.load("lk1-other:1"))
    }

    @Test
    fun theOldestUsedTracksGoOnceTheQuotaIsExceeded() {
        quota = 25_000
        cache.store("a", track(10_000))
        File(directory, directory.list()!!.single()).setLastModified(1_000)
        cache.store("b", track(10_000))
        cache.store("c", track(10_000))

        assertNull(cache.load("a"))
        assertEquals(10_000, cache.load("b")?.bytes?.size)
        assertEquals(10_000, cache.load("c")?.bytes?.size)
    }

    @Test
    fun aDamagedFileIsDroppedAndStreamedAgain() {
        cache.store("a", track(100))
        val file = File(directory, directory.list()!!.single())
        file.writeBytes(file.readBytes().copyOf(20))

        assertNull(cache.load("a"))
        assertTrue(directory.list()!!.isEmpty())
    }
}
