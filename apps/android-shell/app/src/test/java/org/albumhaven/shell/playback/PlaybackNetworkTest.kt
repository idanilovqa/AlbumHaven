package org.albumhaven.shell.playback

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.albumhaven.shell.net.ShellSession
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class PlaybackNetworkTest {
    private val server = MockWebServer()
    private val client = OkHttpClient()
    private lateinit var origin: String
    private val cookieHeader = "__Host-album_haven_session=session-value; __Host-album_haven_csrf=csrf%2Bvalue"
    private val track = ClaimTrack("opaque-ref", "Signal A", "Android Acceptance", "Playback Ownership", null)

    @Before
    fun startServer() {
        server.start()
        origin = server.url("/").toString().removeSuffix("/")
    }

    @After
    fun stopServer() {
        server.close()
    }

    private fun session() = ShellSession({ origin }) { url -> cookieHeader.takeIf { url == origin } }

    @Test
    fun csrfTokenIsReadFromTheSessionCookieLikeTheWebFetchWrapper() {
        assertEquals("csrf+value", ShellSession.csrfToken(cookieHeader))
        assertNull(ShellSession.csrfToken("__Host-album_haven_session=session-value"))
    }

    @Test
    fun acquireReadsWhetherTheClaimsListensReachLastfm() {
        for ((answer, expected) in listOf(
            """{"protocol":1,"claimToken":"claim-token","scrobbling":{"available":false}}""" to false,
            """{"protocol":1,"claimToken":"claim-token","scrobbling":{"available":true}}""" to true,
            """{"protocol":1,"claimToken":"claim-token","scrobbling":{"available":"no"}}""" to null,
        )) {
            server.enqueue(MockResponse.Builder().code(200).body(answer).build())
            assertEquals(
                ClaimResponse.Granted("claim-token", expected),
                HttpPlaybackClaimApi(client, session()).acquire(TEST_CLIENT_ID, null, track),
            )
        }
    }

    @Test
    fun acquireClaimsAsTheMobileSurfaceWithTheWebViewSession() {
        server.enqueue(MockResponse.Builder().code(200).body("""{"protocol":1,"claimToken":"claim-token"}""").build())
        val response = HttpPlaybackClaimApi(client, session()).acquire(TEST_CLIENT_ID, null, track)

        assertEquals(ClaimResponse.Granted("claim-token"), response)
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("PUT", request.method)
        assertEquals("/playback/state", request.url.encodedPath)
        assertEquals(origin, request.headers["Origin"])
        assertEquals(cookieHeader, request.headers["Cookie"])
        assertEquals("csrf+value", request.headers[ShellSession.CSRF_HEADER])
        val body = JSONObject(request.body!!.utf8())
        assertEquals(setOf("protocol", "clientId", "clientSurface", "claimToken", "state", "track"), body.keys().asSequence().toSet())
        assertEquals("mobile", body.getString("clientSurface"))
        assertTrue(body.isNull("claimToken"))
        assertEquals("playing", body.getString("state"))
        assertEquals(
            setOf("playbackRef", "title", "artist", "album", "artworkUrl"),
            body.getJSONObject("track").keys().asSequence().toSet(),
        )
        assertFalse(request.body!!.utf8().contains("path"))
    }

    @Test
    fun heartbeatSendsTheHeldTokenAndMapsRefusals() {
        val api = HttpPlaybackClaimApi(client, session())
        server.enqueue(MockResponse.Builder().code(409).body("{}").build())
        server.enqueue(MockResponse.Builder().code(403).body("{}").build())

        assertEquals(ClaimResponse.Conflict, api.acquire(TEST_CLIENT_ID, "held", track))
        assertEquals(ClaimResponse.Rejected(403), api.acquire(TEST_CLIENT_ID, "held", track))
        assertEquals("held", JSONObject(server.takeRequest(5, TimeUnit.SECONDS)!!.body!!.utf8()).getString("claimToken"))
    }

    @Test
    fun anOverloadedServerKeepsTheClaimForRetriesWithinItsLease() {
        val api = HttpPlaybackClaimApi(client, session())
        server.enqueue(MockResponse.Builder().code(503).body("<html>unavailable</html>").build())
        server.enqueue(MockResponse.Builder().code(502).body("bad gateway").build())
        server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "5").body("{}").build())
        server.enqueue(MockResponse.Builder().code(401).body("{}").build())

        repeat(3) { assertEquals(ClaimResponse.Unreachable, api.acquire(TEST_CLIENT_ID, "held", track)) }
        assertEquals(ClaimResponse.Rejected(401), api.acquire(TEST_CLIENT_ID, "held", track))
    }

    @Test
    fun releaseDeletesOnlyTheCallersClaim() {
        server.enqueue(MockResponse.Builder().code(200).body("""{"protocol":1}""").build())
        HttpPlaybackClaimApi(client, session()).release(TEST_CLIENT_ID, "held")

        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("DELETE", request.method)
        assertEquals("csrf+value", request.headers[ShellSession.CSRF_HEADER])
        val body = JSONObject(request.body!!.utf8())
        assertEquals(TEST_CLIENT_ID, body.getString("clientId"))
        assertEquals("held", body.getString("claimToken"))
        assertEquals(1, body.getInt("protocol"))
    }

    @Test
    fun listenWritesCarryTheOwnersClaimAndReturnOnlyTopLevelScalars() {
        server.enqueue(
            MockResponse.Builder().code(409)
                .body("""{"ok":false,"error":"account_scoped_scrobble_unavailable","retryable":false,"entry":{"path":"x"}}""")
                .build(),
        )
        val body = JSONObject().put("title", "Signal A").put("measurement_version", "rendered-pcm-v1")
        val result = HttpListenEffectApi(client, session()).post(ListenEffect.NOW_PLAYING, TEST_CLIENT_ID, "held", body)

        assertTrue(result is ListenEffectResult.Answered)
        result as ListenEffectResult.Answered
        assertEquals(409, result.status)
        assertEquals(setOf("ok", "error", "retryable"), result.data.keys().asSequence().toSet())
        assertEquals("account_scoped_scrobble_unavailable", result.data.getString("error"))
        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("POST", request.method)
        assertEquals("/playback/session/now-playing", request.url.encodedPath)
        assertEquals(origin, request.headers["Origin"])
        assertEquals(cookieHeader, request.headers["Cookie"])
        assertEquals("csrf+value", request.headers[ShellSession.CSRF_HEADER])
        val sent = JSONObject(request.body!!.utf8())
        assertEquals("Signal A", sent.getString("title"))
        assertEquals(TEST_CLIENT_ID, sent.getString("clientId"))
        assertEquals("held", sent.getString("claimToken"))
        assertFalse(body.has("claimToken"))
    }

    @Test
    fun aListenWriteWithoutAJsonAnswerKeepsItsStatusAndRetryAfter() {
        server.enqueue(MockResponse.Builder().code(502).body("<html>bad gateway</html>").build())
        server.enqueue(MockResponse.Builder().code(429).addHeader("Retry-After", "30").body("slow down").build())
        val api = HttpListenEffectApi(client, session())

        val gateway = api.post(ListenEffect.COMPLETE, TEST_CLIENT_ID, "held", JSONObject()) as ListenEffectResult.Answered
        assertEquals(502, gateway.status)
        assertEquals(0, gateway.data.length())
        assertNull(gateway.retryAfterMs)
        val limited = api.post(ListenEffect.SCROBBLE, TEST_CLIENT_ID, "held", JSONObject()) as ListenEffectResult.Answered
        assertEquals(429, limited.status)
        assertEquals(30_000L, limited.retryAfterMs)
    }

    @Test
    fun warmingReadsTheOwnershipStateOncePerNeededConnection() {
        repeat(3) { server.enqueue(MockResponse.Builder().code(200).body("{}").build()) }
        val warmer = OkHttpConnectionWarmer(client, session(), TEST_CLIENT_ID)
        warmer.warm(socketConnection = true)
        val warmed = listOf(server.takeRequest(5, TimeUnit.SECONDS)!!, server.takeRequest(5, TimeUnit.SECONDS)!!)
        warmer.warm(socketConnection = false)
        val rewarmed = server.takeRequest(5, TimeUnit.SECONDS)!!

        (warmed + rewarmed).forEach { request ->
            assertEquals("GET", request.method)
            assertEquals("/playback/state", request.url.encodedPath)
            assertEquals(TEST_CLIENT_ID, request.url.queryParameter("client_id"))
            assertEquals(cookieHeader, request.headers["Cookie"])
        }
        assertNull(server.takeRequest(200, TimeUnit.MILLISECONDS))
    }

    @Test
    fun thePcmUpgradeReusesTheWarmedConnection() {
        server.enqueue(MockResponse.Builder().code(200).body("{}").build())
        server.enqueue(MockResponse.Builder().code(200).body("{}").build())
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, null)
                }
            }).build(),
        )
        OkHttpConnectionWarmer(client, session(), TEST_CLIENT_ID).warm(socketConnection = true)
        val warmed = setOf(server.takeRequest(5, TimeUnit.SECONDS)!!.connectionIndex, server.takeRequest(5, TimeUnit.SECONDS)!!.connectionIndex)
        // Let both warm calls return their connections to the pool.
        Thread.sleep(200)

        val listener = RecordingListener()
        val socket = OkHttpPcmTransportFactory(client, session()).connect(listener)
        assertEquals("open", listener.next())
        val upgrade = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/playback/pcm", upgrade.url.encodedPath)
        assertTrue(upgrade.connectionIndex in warmed)
        socket.close()
        assertEquals(1000, listener.next())
    }

    @Test
    fun anUnreachableServerIsNotARefusal() {
        server.close()
        assertEquals(ClaimResponse.Unreachable, HttpPlaybackClaimApi(client, session()).acquire(TEST_CLIENT_ID, null, track))
    }

    private class RecordingListener : PcmTransportListener {
        val received = LinkedBlockingQueue<Any>()
        override fun onOpen() {
            received += "open"
        }
        override fun onText(text: String) {
            received += text
        }
        override fun onBinary(bytes: ByteArray) {
            received += bytes
        }
        override fun onClosed(code: Int) {
            received += code
        }

        fun next(): Any = received.poll(5, TimeUnit.SECONDS) ?: error("no socket callback")
    }

    @Test
    fun socketCarriesTheSessionAndRelaysTextBinaryAndCloseCode() {
        val fromClient = LinkedBlockingQueue<String>()
        server.enqueue(
            MockResponse.Builder().webSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.send("""{"type":"metadata"}""")
                    webSocket.send(byteArrayOf(65, 72, 80, 67).toByteString())
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    fromClient += text
                    webSocket.close(PcmCloseCodes.MEDIA_NOT_FOUND, null)
                }

                override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit
            }).build(),
        )
        val listener = RecordingListener()
        val transport = OkHttpPcmTransportFactory(client, session()).connect(listener)

        assertEquals("open", listener.next())
        assertEquals("""{"type":"metadata"}""", listener.next())
        assertArrayEquals(byteArrayOf(65, 72, 80, 67), listener.next() as ByteArray)
        assertTrue(transport.send("""{"type":"open","playbackRef":"opaque-ref"}"""))
        assertEquals("""{"type":"open","playbackRef":"opaque-ref"}""", fromClient.poll(5, TimeUnit.SECONDS))
        assertEquals(PcmCloseCodes.MEDIA_NOT_FOUND, listener.next())

        val request = server.takeRequest(5, TimeUnit.SECONDS)!!
        assertEquals("/playback/pcm", request.url.encodedPath)
        assertEquals(origin, request.headers["Origin"])
        assertEquals(cookieHeader, request.headers["Cookie"])
        assertNull(request.headers[ShellSession.CSRF_HEADER])
    }

    @Test
    fun aRefusedUpgradeReportsTheRefusal() {
        server.enqueue(MockResponse.Builder().code(403).body("{}").build())
        val listener = RecordingListener()
        OkHttpPcmTransportFactory(client, session()).connect(listener)

        assertEquals(PcmCloseCodes.FORBIDDEN, listener.next())
    }
}
