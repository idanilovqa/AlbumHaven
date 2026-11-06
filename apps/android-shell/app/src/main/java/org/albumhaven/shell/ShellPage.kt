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

    fun visited(url: String?, origin: String) {
        this.url = sameOrigin(url, origin)
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
