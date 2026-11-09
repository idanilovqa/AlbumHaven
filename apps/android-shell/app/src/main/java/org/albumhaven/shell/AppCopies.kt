package org.albumhaven.shell

/** Where [AppCopies] keeps what each origin's page last reported; survives process death. */
interface AppCopyStore {
    fun copySavedAt(origin: String): Long?
    fun keepCopy(origin: String, savedAt: Long)
    fun dropCopy(origin: String)
    fun forgetPending(origin: String): Boolean
    fun setForgetPending(origin: String, pending: Boolean)
}

/**
 * Whether an origin's page has a copy of its last view (`app.copy.v1`; the web app's service worker
 * keeps it), so the shell opens it with no Connecting screen and no picture of the old screen.
 * Only the page knows: it reports after each change, and a copy older than its seven-day limit is
 * not shown there either. Leaving an origin by a sandbox switch asks its page to delete the copy;
 * until that page confirms, the next one on that origin is told to.
 */
internal class AppCopies(private val store: AppCopyStore, private val now: () -> Long = System::currentTimeMillis) {

    fun exists(origin: String): Boolean {
        val savedAt = store.copySavedAt(origin) ?: return false
        return !store.forgetPending(origin) && now() - savedAt in 0..MAX_AGE_MS
    }

    /** The page's report. Without a copy, nothing is left to forget. */
    fun reported(origin: String, stored: Boolean) {
        if (stored) {
            store.keepCopy(origin, now())
        } else {
            store.dropCopy(origin)
            store.setForgetPending(origin, false)
        }
    }

    /** Signing in again starts without the copy, which the page deleted as it left. */
    fun signedOut(origin: String) = reported(origin, stored = false)

    /** Leaving [origin] for another sandbox: its copy goes, at once if its page answers. */
    fun leaving(origin: String) {
        store.dropCopy(origin)
        store.setForgetPending(origin, true)
    }

    fun forgetPending(origin: String): Boolean = store.forgetPending(origin)

    companion object {
        /** The web app shows no copy older than this (app-copy-worker.js). */
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
    }
}
