package org.albumhaven.shell.net

import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URLDecoder

/**
 * The WebView session as request headers for one origin. Cookies are read when a request
 * starts and never stored by the native player.
 */
class ShellSession(private val origin: () -> String, private val cookies: (url: String) -> String?) {
    fun origin(): String = origin.invoke()

    /**
     * Applies the session cookie, its CSRF header and the page origin the server checks. A value
     * HTTP cannot carry, such as a cookie with non-ASCII text, is left out rather than thrown, so
     * the server answers as it does a signed-out request.
     */
    fun authorize(builder: Request.Builder, withCsrf: Boolean): Request.Builder {
        val selected = origin()
        val cookieHeader = cookies(selected).orEmpty().takeIf(::isHeaderValue).orEmpty()
        builder.header("Origin", selected)
        if (cookieHeader.isNotEmpty()) builder.header("Cookie", cookieHeader)
        if (withCsrf) csrfToken(cookieHeader)?.takeIf(::isHeaderValue)?.let { builder.header(CSRF_HEADER, it) }
        return builder
    }

    /** OkHttp's own rule for a header value: tabs and visible ASCII. */
    private fun isHeaderValue(value: String) = value.all { it == '\t' || it in ' '..'~' }

    companion object {
        const val CSRF_HEADER = "X-Album-Haven-CSRF"
        private const val CSRF_COOKIE = "__Host-album_haven_csrf"

        /**
         * The client every session request uses. It follows no redirect: OkHttp would carry the
         * cookie and CSRF headers [authorize] sets to whatever host a redirect names.
         */
        fun client(base: OkHttpClient = OkHttpClient()): OkHttpClient =
            base.newBuilder().followRedirects(false).build()

        /** Mirrors `readSessionCsrfCookie` in music_app/static/js/runtime/session-csrf-fetch.js. */
        fun csrfToken(cookieHeader: String): String? = cookieHeader.split(';').firstNotNullOfOrNull { part ->
            val separator = part.indexOf('=')
            if (separator < 0 || part.substring(0, separator).trim() != CSRF_COOKIE) {
                null
            } else {
                try {
                    URLDecoder.decode(part.substring(separator + 1), Charsets.UTF_8.name())
                } catch (_: IllegalArgumentException) {
                    null
                }
            }
        }
    }
}
