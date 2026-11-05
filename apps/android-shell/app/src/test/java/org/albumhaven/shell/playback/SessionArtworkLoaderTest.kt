package org.albumhaven.shell.playback

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okio.Buffer
import org.albumhaven.shell.net.ShellSession
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.util.concurrent.ExecutionException

class SessionArtworkLoaderTest {
    private val server = MockWebServer()
    private lateinit var origin: String
    private lateinit var loader: SessionArtworkLoader

    @Before
    fun start() {
        server.start()
        origin = server.url("/").toString().removeSuffix("/")
        loader = SessionArtworkLoader(ShellSession.client()) {
            ShellSession({ origin }) { url -> "__Host-album_haven_session=session-value".takeIf { url == origin } }
        }
    }

    @After
    fun stop() {
        loader.release()
        server.close()
    }

    @Test
    fun fetchesTheResumptionCoverWithTheSessionFromTheSelectedOriginOnly() {
        val cover = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2)
        server.enqueue(MockResponse.Builder().code(200).body(Buffer().write(cover)).build())
        assertArrayEquals(cover, loader.fetch("$origin/playback/artwork/rt1.b").get())
        val request = server.takeRequest()
        assertEquals("/playback/artwork/rt1.b", request.url.encodedPath)
        assertEquals("__Host-album_haven_session=session-value", request.headers["Cookie"])

        server.enqueue(MockResponse.Builder().code(401).build())
        assertFailsWithIo { loader.fetch("$origin/playback/artwork/rt1.b").get() }
        assertFailsWithIo { loader.fetch("https://elsewhere.example/playback/artwork/rt1.b").get() }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun aRedirectToAnotherHostNeverReceivesTheSession() {
        MockWebServer().use { elsewhere ->
            elsewhere.start()
            elsewhere.enqueue(MockResponse.Builder().code(200).body(Buffer().write(byteArrayOf(1))).build())
            server.enqueue(MockResponse.Builder().code(302).addHeader("Location", elsewhere.url("/cover").toString()).build())

            assertFailsWithIo { loader.fetch("$origin/playback/artwork/rt1.b").get() }
            assertEquals(0, elsewhere.requestCount)
        }
    }

    private fun assertFailsWithIo(block: () -> Unit) {
        try {
            block()
        } catch (failure: ExecutionException) {
            assertTrue(failure.cause is IOException)
            return
        }
        throw AssertionError("Expected an IOException")
    }
}
