package org.albumhaven.shell

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import java.io.File
import java.util.Properties
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/**
 * A picture of the page as the user left it, shown instead of the Connecting screen while that same
 * page loads again after Android ended the app or its renderer in the background. A full restart
 * opens Home, which never shows it. Kept in the app's private cache.
 */
internal class LastScreen(private val directory: File, private val io: Executor) {
    private val image get() = File(directory, "last-screen.jpg")
    private val about get() = File(directory, "last-screen.properties")

    /** Copies what [view] shows now; saving runs on [io]. */
    fun capture(activity: Activity, view: View, origin: String, url: String) {
        if (view.width == 0 || view.height == 0 || !view.isShown) return
        val at = IntArray(2).also(view::getLocationInWindow)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val orientation = activity.resources.configuration.orientation
        val area = Rect(at[0], at[1], at[0] + view.width, at[1] + view.height)
        PixelCopy.request(activity.window, area, bitmap, { result ->
            if (result != PixelCopy.SUCCESS) return@request bitmap.recycle()
            try {
                io.execute { save(bitmap, Properties().apply {
                    setProperty(ORIGIN, origin)
                    setProperty(URL, url)
                    setProperty(ORIENTATION, orientation.toString())
                }) }
            } catch (_: RejectedExecutionException) {
                bitmap.recycle()
            }
        }, Handler(Looper.getMainLooper()))
    }

    /** The picture of exactly [url] on [origin] in this [orientation], or null. */
    fun load(origin: String, url: String, orientation: Int): Bitmap? = try {
        val saved = Properties().apply { about.inputStream().use(::load) }
        val matches = saved.getProperty(ORIGIN) == origin && saved.getProperty(URL) == url &&
            saved.getProperty(ORIENTATION) == orientation.toString()
        if (matches) BitmapFactory.decodeFile(image.path) else null
    } catch (_: java.io.IOException) {
        null
    }

    private fun save(bitmap: Bitmap, saved: Properties) {
        try {
            // The description goes last, so a half-written picture is never taken for this page.
            about.delete()
            val written = File(directory, "last-screen.jpg.tmp")
            written.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
            if (!written.renameTo(image)) return
            about.outputStream().use { saved.store(it, null) }
        } catch (_: java.io.IOException) {
            // No picture: the Connecting screen shows instead.
        } finally {
            bitmap.recycle()
        }
    }

    private companion object {
        const val ORIGIN = "origin"
        const val URL = "url"
        const val ORIENTATION = "orientation"
        const val JPEG_QUALITY = 85
    }
}
