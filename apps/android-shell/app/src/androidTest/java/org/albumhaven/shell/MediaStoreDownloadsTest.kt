package org.albumhaven.shell

import android.content.ContentUris
import android.content.Context
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MediaStoreDownloadsTest {
    private val resolver = ApplicationProvider.getApplicationContext<Context>().contentResolver

    @Test
    fun aSavedFileIsACompleteDownloadOfThisApp() {
        val name = "album-haven-media-store-test-${System.nanoTime()}.json"
        val bytes = "{\"schema\":\"album-haven-log-history\"}\n".toByteArray()
        assertTrue(MediaStoreDownloads(resolver).save(name, "application/json", bytes))

        val projection = arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.IS_PENDING)
        val selection = "${MediaStore.Downloads.DISPLAY_NAME} = ?"
        val uri = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, projection, selection, arrayOf(name), null)!!.use {
            assertTrue(it.moveToFirst())
            assertEquals(0, it.getInt(1))
            ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, it.getLong(0))
        }
        try {
            assertArrayEquals(bytes, resolver.openInputStream(uri)!!.use { it.readBytes() })
        } finally {
            resolver.delete(uri, null, null)
        }
    }
}
