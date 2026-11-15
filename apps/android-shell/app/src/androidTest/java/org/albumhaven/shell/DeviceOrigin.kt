package org.albumhaven.shell

import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import org.albumhaven.playback.engine.FakeAhpcServer
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread

/**
 * A local Album Haven origin on the device, owned by one test: `PUT`/`DELETE /playback/state`
 * grants the claim, listen writes succeed, `/playback/pcm` upgrades to a real WebSocket that
 * [ahpc] answers, and [pages] serves everything else. Clients reach it through a TCP relay, so
 * [cutPcmSocket] drops the connections the way a network change does: reset, with no close frame,
 * and whatever was in flight lost.
 */
class DeviceOrigin(private val ahpc: FakeAhpcServer? = null, private val pages: (RecordedRequest) -> MockResponse? = { null }) :
    AutoCloseable {
    private val server = MockWebServer()
    private val relay = Relay()
    private val lock = Any()
    private var socket: WebSocket? = null

    /** `/playback/pcm` upgrades accepted so far. */
    @Volatile var pcmConnections = 0
        private set

    /** Streams whose last byte and end of stream the server has sent. */
    @Volatile var streamsSentWhole = 0
        private set

    val origin: String get() = "http://127.0.0.1:${relay.port}"

    /** [port] 0 picks a free one; the debug build's own origin is [DEV_PORT]. */
    fun start(port: Int = 0): DeviceOrigin {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.url.encodedPath
                return when {
                    path == "/playback/state" -> json("""{"protocol":1,"claimToken":"device-claim"}""")
                    path.startsWith("/playback/session/") -> json("""{"ok":true}""")
                    path == "/playback/pcm" && ahpc != null -> MockResponse.Builder().webSocketUpgrade(PcmSocket()).build()
                    else -> pages(request) ?: MockResponse.Builder().code(404).body("{}").build()
                }
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        relay.start(port, server.port)
        return this
    }

    /** Reads [ahpc] while no socket message is changing it. */
    fun <T> inspect(read: (FakeAhpcServer) -> T): T = synchronized(lock) { read(checkNotNull(ahpc)) }

    /** The phone moves from Wi-Fi to mobile data: the open socket is gone and the next one starts with no streams. */
    fun cutPcmSocket() = synchronized(lock) {
        val fake = checkNotNull(ahpc)
        fake.disconnect()
        socket = null
        relay.cut()
        fake.reconnect()
    }

    override fun close() {
        relay.close()
        server.close()
    }

    /** Relays one socket's controls to [ahpc] and sends back what it answers; a superseded socket is ignored. */
    private inner class PcmSocket : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = synchronized(lock) {
            socket = webSocket
            pcmConnections += 1
        }

        override fun onMessage(webSocket: WebSocket, text: String) = synchronized(lock) {
            if (webSocket !== socket) return@synchronized
            val fake = checkNotNull(ahpc)
            fake.receive(text)
            while (fake.outbox.isNotEmpty()) {
                when (val message = fake.outbox.removeFirst()) {
                    is String -> {
                        webSocket.send(message)
                        if (JSONObject(message).getString("type") == "eos") streamsSentWhole += 1
                    }
                    is ByteArray -> webSocket.send(message.toByteString())
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, null)
        }
    }

    /** Copies bytes both ways between each client and the server until [cut]. */
    private class Relay : AutoCloseable {
        private val listener = ServerSocket()
        private val open = Collections.synchronizedSet(mutableSetOf<Socket>())
        val port: Int get() = listener.localPort

        fun start(port: Int, target: Int) {
            listener.reuseAddress = true
            listener.bind(InetSocketAddress("127.0.0.1", port))
            thread(isDaemon = true, name = "DeviceOriginRelay") {
                while (!listener.isClosed) {
                    val client = try {
                        listener.accept()
                    } catch (_: IOException) {
                        break
                    }
                    val upstream = Socket("127.0.0.1", target)
                    open += client
                    open += upstream
                    pipe(client, upstream)
                    pipe(upstream, client)
                }
            }
        }

        private fun pipe(from: Socket, to: Socket) = thread(isDaemon = true, name = "DeviceOriginPipe") {
            try {
                from.getInputStream().copyTo(to.getOutputStream(), 64 * 1024)
                to.shutdownOutput()
            } catch (_: IOException) {
                // Cut, or the other side went.
            }
        }

        /** Resets every connection open now; new ones still connect. */
        fun cut() = open.toList().forEach { socket ->
            open -= socket
            runCatching {
                socket.setSoLinger(true, 0)
                socket.close()
            }
        }

        override fun close() {
            listener.close()
            cut()
        }
    }

    companion object {
        /** `-PalbumHavenDevOrigin=http://127.0.0.1:18765`, the debug build's origin in CI. */
        const val DEV_PORT = 18765

        fun json(body: String): MockResponse =
            MockResponse.Builder().code(200).addHeader("Content-Type", "application/json").body(body).build()

        fun html(body: String): MockResponse =
            MockResponse.Builder().code(200).addHeader("Content-Type", "text/html").addHeader("Cache-Control", "no-store").body(body).build()
    }
}
