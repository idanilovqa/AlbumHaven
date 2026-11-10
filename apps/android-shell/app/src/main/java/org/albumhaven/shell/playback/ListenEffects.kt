package org.albumhaven.shell.playback

import org.json.JSONObject
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

/** The claim-guarded `/playback/session/<effect>` listen writes. */
enum class ListenEffect(val wire: String) {
    NOW_PLAYING("now-playing"),
    SCROBBLE("scrobble"),
    COMPLETE("complete"),
}

sealed interface ListenEffectResult {
    /**
     * The server answered; [data] holds only the top-level scalar fields of its JSON body, and
     * [retryAfterMs] its `Retry-After`, in milliseconds from the answer.
     */
    data class Answered(val status: Int, val data: JSONObject, val retryAfterMs: Long? = null) : ListenEffectResult

    /** No usable answer arrived. */
    data object Unreachable : ListenEffectResult
}

/** What a listen write's answer means for sending it again, as the web's `noteListenWriteFailure` reads it. */
sealed interface ListenWriteOutcome {
    data object Accepted : ListenWriteOutcome

    /** This account has no Last.fm session: the listen sends no more now-playing or scrobble writes. */
    data object LastfmUnavailable : ListenWriteOutcome

    /** No answer, a timeout, 429 or 5xx: sent again after a backoff, or after [retryAfterMs]. */
    data class Transient(val retryAfterMs: Long? = null) : ListenWriteOutcome

    /** Any other answer: never sent again. */
    data object Refused : ListenWriteOutcome

    companion object {
        const val LASTFM_UNAVAILABLE_ERROR = "account_scoped_scrobble_unavailable"

        fun of(result: ListenEffectResult): ListenWriteOutcome = when {
            result !is ListenEffectResult.Answered -> Transient()
            result.status in 200..299 && result.data.optBoolean("ok") -> Accepted
            result.status == 409 && result.data.optString("error") == LASTFM_UNAVAILABLE_ERROR -> LastfmUnavailable
            result.status == 429 || result.status >= 500 -> Transient(result.retryAfterMs)
            else -> Refused
        }

        /** `Retry-After` as delay-seconds or an HTTP date; null when absent or invalid. */
        fun retryAfterMs(value: String?, nowMs: Long): Long? {
            val text = value?.trim().orEmpty()
            if (text.isEmpty()) return null
            if (text.all(Char::isDigit)) return text.toLongOrNull()?.let { it * 1000 }
            return try {
                (ZonedDateTime.parse(text, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() - nowMs)
                    .coerceAtLeast(0)
            } catch (_: DateTimeParseException) {
                null
            }
        }
    }
}

/** Blocking POST of one listen write with the owner's claim credentials (music_app/routes/api_wave_b_asgi_routes.py). */
fun interface ListenEffectApi {
    fun post(effect: ListenEffect, clientId: String, claimToken: String, body: JSONObject): ListenEffectResult
}

/** Opens the connections a first start needs, so its claim and socket skip the TCP and TLS handshakes. */
fun interface ConnectionWarmer {
    fun warm(socketConnection: Boolean)
}
