package org.albumhaven.shell.playback

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.URLDecoder
import java.util.concurrent.TimeUnit

/**
 * The WebView session as request headers for one origin. Cookies are read when a request
 * starts and never stored by the native player.
 */
class ShellSession(private val origin: () -> String, private val cookies: (url: String) -> String?) {
    fun origin(): String = origin.invoke()

    /** Applies the session cookie, its CSRF header and the page origin the server checks. */
    fun authorize(builder: Request.Builder, withCsrf: Boolean): Request.Builder {
        val selected = origin()
        val cookieHeader = cookies(selected).orEmpty()
        builder.header("Origin", selected)
        if (cookieHeader.isNotEmpty()) builder.header("Cookie", cookieHeader)
        if (withCsrf) csrfToken(cookieHeader)?.let { builder.header(CSRF_HEADER, it) }
        return builder
    }

    companion object {
        const val CSRF_HEADER = "X-Album-Haven-CSRF"
        private const val CSRF_COOKIE = "__Host-album_haven_csrf"

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

/** `PUT`/`DELETE /playback/state` as the `mobile` client surface. */
class HttpPlaybackClaimApi(private val client: OkHttpClient, private val session: ShellSession) : PlaybackClaimApi {
    override fun acquire(clientId: String, claimToken: String?, track: ClaimTrack): ClaimResponse {
        val body = JSONObject()
            .put("protocol", 1)
            .put("clientId", clientId)
            .put("clientSurface", "mobile")
            .put("claimToken", claimToken ?: JSONObject.NULL)
            .put("state", "playing")
            .put(
                "track",
                JSONObject()
                    .put("playbackRef", track.playbackRef)
                    .put("title", track.title)
                    .put("artist", track.artist)
                    .put("album", track.album)
                    .put("artworkUrl", track.artworkUrl ?: JSONObject.NULL),
            )
        return try {
            execute("PUT", body).use { response ->
                when {
                    response.code == 409 -> ClaimResponse.Conflict
                    !response.isSuccessful -> ClaimResponse.Rejected(response.code)
                    else -> {
                        val token = JSONObject(response.body.string()).optString("claimToken")
                        if (token.isEmpty()) ClaimResponse.Rejected(response.code) else ClaimResponse.Granted(token)
                    }
                }
            }
        } catch (_: IOException) {
            ClaimResponse.Unreachable
        } catch (_: JSONException) {
            ClaimResponse.Unreachable
        }
    }

    override fun release(clientId: String, claimToken: String) {
        val body = JSONObject().put("protocol", 1).put("clientId", clientId).put("claimToken", claimToken)
        try {
            execute("DELETE", body).close()
        } catch (_: IOException) {
            // The server lease expires on its own.
        }
    }

    private fun execute(method: String, body: JSONObject): Response {
        val request = session.authorize(Request.Builder(), withCsrf = true)
            .url("${session.origin()}/playback/state")
            .header("Cache-Control", "no-store")
            .method(method, body.toString().toRequestBody(JSON))
            .build()
        return client.newCall(request).execute()
    }

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}

/**
 * Listen writes as the active native owner: the web builds the payload exactly as it does in a
 * browser, and only this side adds the claim credentials, so the token never reaches the WebView.
 */
class HttpListenEffectApi(client: OkHttpClient, private val session: ShellSession) : ListenEffectApi {
    // The web listen session aborts these writes after ten seconds.
    private val client = client.newBuilder().callTimeout(LISTEN_TIMEOUT_SECONDS, TimeUnit.SECONDS).build()

    override fun post(effect: ListenEffect, clientId: String, claimToken: String, body: JSONObject): ListenEffectResult {
        val payload = JSONObject(body.toString()).put("clientId", clientId).put("claimToken", claimToken)
        val request = session.authorize(Request.Builder(), withCsrf = true)
            .url("${session.origin()}/playback/session/${effect.wire}")
            .header("Cache-Control", "no-store")
            .post(payload.toString().toRequestBody(JSON))
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                val text = response.body.source().let { source ->
                    if (!source.request(MAX_RESPONSE_BYTES + 1)) source.buffer.readUtf8() else null
                } ?: return ListenEffectResult.Unreachable
                ListenEffectResult.Answered(response.code, scalars(JSONObject(text)))
            }
        } catch (_: IOException) {
            ListenEffectResult.Unreachable
        } catch (_: JSONException) {
            ListenEffectResult.Unreachable
        }
    }

    /** The web reads only `ok` and `error`; nested listen entries stay on the server. */
    private fun scalars(json: JSONObject): JSONObject = JSONObject().also { copy ->
        json.keys().forEach { key ->
            val value = json.opt(key)
            if (value is String || value is Number || value is Boolean || value == JSONObject.NULL) copy.put(key, value)
        }
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        const val LISTEN_TIMEOUT_SECONDS = 10L
        const val MAX_RESPONSE_BYTES = 64L * 1024
    }
}

/**
 * Warms one HTTP/2 connection for claim and listen calls and, while no socket is open, one
 * HTTP/1.1 connection the `/playback/pcm` upgrade can reuse from the shared pool.
 */
class OkHttpConnectionWarmer(
    private val client: OkHttpClient,
    private val session: ShellSession,
    private val clientId: String,
) : ConnectionWarmer {
    private val socketClient = client.newBuilder().protocols(listOf(Protocol.HTTP_1_1)).build()

    override fun warm(socketConnection: Boolean) {
        get(client)
        if (socketConnection) get(socketClient)
    }

    // The same ownership read the web polls, sent on OkHttp's own threads; its answer is not needed.
    private fun get(target: OkHttpClient) {
        val request = session.authorize(Request.Builder(), withCsrf = false)
            .url("${session.origin()}/playback/state?client_id=$clientId")
            .header("Cache-Control", "no-store")
            .build()
        target.newCall(request).enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                // Reading the body to its end returns the connection to the pool.
                response.use { it.body.bytes() }
            }

            override fun onFailure(call: Call, e: IOException) {
                // A cold connection is only slower.
            }
        })
    }
}

/** `/playback/pcm` over OkHttp, authenticated like the page that selected the origin. */
class OkHttpPcmTransportFactory(private val client: OkHttpClient, private val session: ShellSession) :
    PcmTransportFactory {
    override fun connect(listener: PcmTransportListener): PcmTransport {
        val socketUrl = session.origin().replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")
        val request = session.authorize(Request.Builder(), withCsrf = false)
            .url("$socketUrl/playback/pcm")
            .build()
        val socket = client.newWebSocket(request, Adapter(listener))
        return object : PcmTransport {
            override fun send(text: String): Boolean = socket.send(text)
            override fun close() {
                if (!socket.close(NORMAL_CLOSURE, null)) socket.cancel()
            }
        }
    }

    private class Adapter(private val listener: PcmTransportListener) : WebSocketListener() {
        private var closed = false

        override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()

        override fun onMessage(webSocket: WebSocket, text: String) = listener.onText(text)

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) = listener.onBinary(bytes.toByteArray())

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSURE, null)
            closeOnce(code)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closeOnce(code)

        // The server refuses an unauthenticated or cross-origin upgrade before accepting it.
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = closeOnce(
            when (response?.code) {
                401 -> PcmCloseCodes.UNAUTHENTICATED
                403 -> PcmCloseCodes.FORBIDDEN
                else -> PcmTransportListener.ABNORMAL_CLOSURE
            },
        )

        @Synchronized
        private fun closeOnce(code: Int) {
            if (closed) return
            closed = true
            listener.onClosed(code)
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
    }
}
