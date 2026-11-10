package org.albumhaven.shell

import android.content.ContentResolver
import android.content.ContentValues
import android.provider.MediaStore
import java.io.IOException

/**
 * The shared Downloads collection through `MediaStore` (API 29+), which needs no storage
 * permission. A file stays pending, hidden from other apps, until it is complete; a failed write
 * removes it.
 */
class MediaStoreDownloads(private val resolver: ContentResolver) : DownloadsCollection {
    override fun save(name: String, mimeType: String, bytes: ByteArray): Boolean {
        val pending = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, pending) ?: return false
        try {
            val output = resolver.openOutputStream(uri) ?: throw IOException("No output stream")
            output.use { it.write(bytes) }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
            return true
        } catch (_: Exception) {
            // An I/O failure, or the provider refusing the update; FileSaves reports it.
            resolver.delete(uri, null, null)
            return false
        }
    }
}
