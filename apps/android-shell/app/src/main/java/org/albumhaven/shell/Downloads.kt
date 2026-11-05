package org.albumhaven.shell

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
