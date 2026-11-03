package org.albumhaven.shell.playback

import org.json.JSONObject

/** The claim-guarded `/playback/session/<effect>` writes the web listen session builds. */
enum class ListenEffect(val wire: String) {
    NOW_PLAYING("now-playing"),
    SCROBBLE("scrobble"),
    COMPLETE("complete"),
    ;

    companion object {
        fun fromWire(value: Any?): ListenEffect? = entries.firstOrNull { it.wire == value }
    }
}

sealed interface ListenEffectResult {
    /** The server answered; [data] holds only the top-level scalar fields of its JSON body. */
    data class Answered(val status: Int, val data: JSONObject) : ListenEffectResult

    /** This client does not hold the playback claim, so nothing was sent. */
    data object NotOwner : ListenEffectResult

    /** No usable answer arrived. */
    data object Unreachable : ListenEffectResult
}

/** Blocking POST of one listen write with the owner's claim credentials (music_app/routes/api_wave_b_asgi_routes.py). */
fun interface ListenEffectApi {
    fun post(effect: ListenEffect, clientId: String, claimToken: String, body: JSONObject): ListenEffectResult
}

/** Opens the connections a first start needs, so its claim and socket skip the TCP and TLS handshakes. */
fun interface ConnectionWarmer {
    fun warm(socketConnection: Boolean)
}
