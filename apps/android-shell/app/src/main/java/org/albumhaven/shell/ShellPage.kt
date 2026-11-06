package org.albumhaven.shell

/**
 * The page the shell shows, kept free of Android types. An Activity recreation or a process death
 * keeps only its same-origin URL, which the web app restores its view from. The WebView's own saved
 * state grows with every history entry until it outgrows Android's transaction limit, which crashed
 * the app in the background when it stopped (TransactionTooLargeException).
 */
internal class ShellPage(private val policy: OriginPolicy) {
    /** The page on [origin][visited] last shown, including history the page pushed; null for none or another origin. */
    var url: String? = null
        private set

    /** The main-frame page that failed to load, which Retry loads again. */
    private var failedUrl: String? = null

    /** The renderer went while the Activity was stopped, so the page loads again when it starts. */
    private var reopenOnStart = false

    fun visited(url: String?, origin: String) {
        this.url = sameOrigin(url, origin)
    }

    fun failed(url: String?, origin: String) {
        failedUrl = sameOrigin(url, origin)
    }

    /** Retry loads the page that failed, not the site root. */
    fun retryUrl(origin: String): String = failedUrl ?: url ?: origin

    /**
     * The renderer is gone, with the document it ran: returns the page to load again now when
     * [started], or null to wait for [onStart], so nothing loads while the app is in the background.
     */
    fun rendererGone(started: Boolean, origin: String): String? {
        reopenOnStart = !started
        return if (started) url ?: origin else null
    }

    /** The page to load again as the Activity starts, if its renderer went while stopped. */
    fun onStart(origin: String): String? {
        if (!reopenOnStart) return null
        reopenOnStart = false
        return url ?: origin
    }

    /** Another origin keeps nothing of this one's pages. */
    fun switched() {
        url = null
        failedUrl = null
        reopenOnStart = false
    }

    /** The page a new Activity opens: the saved one when it belongs to [origin], else the site root. */
    fun restore(savedOrigin: String?, savedUrl: String?, origin: String): String {
        url = sameOrigin(savedUrl, origin).takeIf { savedOrigin == origin }
        return url ?: origin
    }

    private fun sameOrigin(url: String?, origin: String): String? =
        url?.takeIf { it.length <= MAX_URL_LENGTH && policy.isSameOrigin(it, origin) }

    companion object {
        /** Longer URLs are not kept, so the saved state stays a few kilobytes at most. */
        const val MAX_URL_LENGTH = 2048
    }
}
