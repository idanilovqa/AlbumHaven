package org.albumhaven.shell.playback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.ListeningExecutorService
import com.google.common.util.concurrent.MoreExecutors
import okhttp3.OkHttpClient
import okhttp3.Request
import org.albumhaven.shell.net.ShellSession
import java.io.IOException
import java.util.concurrent.Executors
import kotlin.math.roundToInt

/**
 * Loads notification and lock-screen artwork with the WebView session, from the selected origin
 * only: the queue carries same-origin artwork paths, never another host.
 */
@OptIn(UnstableApi::class)
class SessionArtworkLoader(private val client: OkHttpClient, private val session: () -> ShellSession) : BitmapLoader {
    private val executor: ListeningExecutorService = MoreExecutors.listeningDecorator(Executors.newSingleThreadExecutor())

    override fun supportsMimeType(mimeType: String): Boolean = mimeType.startsWith("image/")

    /**
     * Artwork bytes come only from the resumption items System UI browses, whose bitmap crosses
     * a binder transaction inside the item's description, so they decode at most card-sized.
     */
    override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> = executor.submit<Bitmap> {
        val bitmap = decode(data)
        val scale = MAX_BROWSE_ARTWORK_PX.toFloat() / maxOf(bitmap.width, bitmap.height)
        if (scale >= 1f) {
            bitmap
        } else {
            Bitmap.createScaledBitmap(
                bitmap,
                (bitmap.width * scale).roundToInt().coerceAtLeast(1),
                (bitmap.height * scale).roundToInt().coerceAtLeast(1),
                true,
            )
        }
    }

    override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> = executor.submit<Bitmap> { decode(read(uri.toString())) }

    /** The artwork at [url], undecoded. */
    fun fetch(url: String): ListenableFuture<ByteArray> = executor.submit<ByteArray> { read(url) }

    fun release() = executor.shutdownNow()

    private fun read(url: String): ByteArray {
        val current = session()
        if (!url.startsWith(current.origin() + "/")) throw IOException("Artwork must be same-origin")
        val request = current.authorize(Request.Builder(), withCsrf = false).url(url).build()
        return client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Artwork unavailable")
            response.body.source().let { source ->
                if (source.request(MAX_ARTWORK_BYTES + 1)) throw IOException("Artwork too large")
                source.buffer.readByteArray()
            }
        }
    }

    private fun decode(data: ByteArray): Bitmap =
        BitmapFactory.decodeByteArray(data, 0, data.size) ?: throw IOException("Artwork could not be decoded")

    private companion object {
        const val MAX_ARTWORK_BYTES = 8L * 1024 * 1024
        const val MAX_BROWSE_ARTWORK_PX = 320
    }
}
