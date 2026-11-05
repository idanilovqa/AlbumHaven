package org.albumhaven.shell

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
