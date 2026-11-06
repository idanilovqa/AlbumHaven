package org.albumhaven.shell

import org.albumhaven.shell.net.originOf
import org.albumhaven.shell.net.parseUri
import java.util.concurrent.Executor

/**
 * One `DownloadManager` call, or null when the system download service refuses it: a disabled
 * Download Manager throws IllegalArgumentException ("Unknown URL"), unavailable storage
 * IllegalStateException, and a restricted profile SecurityException.
 */
inline fun <T> downloadManagerOrNull(call: () -> T): T? = try {
    call()
} catch (_: IllegalArgumentException) {
    null
} catch (_: IllegalStateException) {
    null
} catch (_: SecurityException) {
    null
}

/**
 * Builds and enqueues one `DownloadManager` request on [io], since both touch storage and the
 * download provider, and answers its ID on [main], or null when the system refused it.
 */
fun enqueueDownload(io: Executor, main: (Runnable) -> Unit, enqueue: () -> Long, done: (Long?) -> Unit) = io.execute {
    val id = downloadManagerOrNull(enqueue)
    main(Runnable { done(id) })
}

/** Builds and enqueues one `DownloadManager` request on [io] when nothing waits for its answer. */
fun enqueueDownload(io: Executor, enqueue: () -> Long) = io.execute { downloadManagerOrNull(enqueue) }

/** The path and query of [url] on [origin], which the page exchanges for a link; null for any other URL. */
fun sameOriginPath(url: String, origin: String): String? {
    val uri = parseUri(url) ?: return null
    if (originOf(uri) != origin || uri.rawUserInfo != null || uri.rawPath.isNullOrEmpty()) return null
    return uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: "")
}

/**
 * One `DownloadManager` request for a cookie-less link (`downloads.link.v1`). The Download Manager
 * keeps its requests in its own database, so the WebView session never goes into one: the link
 * alone authorizes the file, for five minutes.
 */
class LinkDownload(val url: String, val headers: Map<String, String>, val mimeType: String?, val fileName: String) {
    companion object {
        /**
         * Null unless [linkPath] has the form of a link the server issues (`/downloads/<token>`), the
         * only path a download may fetch, so a refused or malformed answer requests nothing.
         */
        fun of(origin: String, linkPath: String?, userAgent: String, mimeType: String?, fileName: String): LinkDownload? =
            linkPath?.takeIf(DOWNLOAD_LINK::matches)?.let { LinkDownload("$origin$it", mapOf("User-Agent" to userAgent), mimeType, fileName) }
    }
}

private val DOWNLOAD_LINK = Regex("^/downloads/[A-Za-z0-9_-]{1,512}\\.[A-Za-z0-9_-]{43}$")
