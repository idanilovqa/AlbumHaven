package org.albumhaven.shell.playback

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class ResumptionTest {
    private fun item(name: String, group: Int = 0, token: String? = "rt1.$name", durationMs: Long = 180_000) = RestorableItem(
        "Signal $name", "Android Acceptance", "Playback Ownership", token?.let { "/playback/artwork/$it" }, durationMs,
        trackNumber = name, listenKey = "lk-$name", queueGroup = group, resumeToken = token,
    )

    private val queue = RestorableQueue(
        "https://sandbox5.albumhaven.org", TEST_CLIENT_ID, 9, 1, 42_000,
        listOf(item("a"), item("b"), item("c", token = null), item("d", group = 1)),
    )

    @Test
    fun playResumesTheSavedItemAtItsPositionAndSkipsStartTheAlbumNeighbour() {
        assertEquals(1 to 42_000L, Resumption.target(SystemRequest.SetPlayWhenReady(true), queue))
        assertNull(Resumption.target(SystemRequest.SetPlayWhenReady(false), queue))
        assertEquals(0 to 0L, Resumption.target(SystemRequest.Seek(0, 7_000), queue))
        assertEquals(1 to 5_000L, Resumption.target(SystemRequest.Seek(1, 5_000), queue))
        // The next item has no token, and an item of another album is not a skip target.
        assertNull(Resumption.target(SystemRequest.Seek(2, 0), queue))
        assertNull(Resumption.target(SystemRequest.Seek(1, 0), queue.copy(currentIndex = 3)))
        assertNull(Resumption.target(SystemRequest.Stop, queue))
    }

    @Test
    fun aFreshLoadKeepsEveryIssuedItemWithItsListenIdentityAndAutoplays() {
        assertEquals(listOf("rt1.a", "rt1.b", "rt1.d"), Resumption.tokens(queue))
        val load = Resumption.load(queue, listOf("ref-a", "ref-b", "ref-d"), 9, 1 to 42_000L)!!
        assertEquals(listOf("ref-a", "ref-b", "ref-d"), load.items.map { it.playbackRef })
        assertEquals(listOf("lk-a", "lk-b", "lk-d"), load.items.map { it.listenKey })
        assertEquals(listOf(0, 0, 1), load.items.map { it.queueGroup })
        assertEquals("/playback/artwork/rt1.b", load.items[1].artworkUrl)
        assertEquals(Triple(1, 42_000L, true), Triple(load.currentIndex, load.positionMs, load.autoplay))
        assertEquals(9L, load.queueRevision)

        // A removed file drops out; the target keeps its place in what remains.
        val pruned = Resumption.load(queue, listOf(null, "ref-b", "ref-d"), 10, 1 to 42_000L)!!
        assertEquals(listOf("ref-b", "ref-d"), pruned.items.map { it.playbackRef })
        assertEquals(0, pruned.currentIndex)
        assertNull(Resumption.load(queue, listOf("ref-a", null, "ref-d"), 10, 1 to 42_000L))
        assertNull(Resumption.load(queue, listOf("ref-a"), 10, 1 to 42_000L))
        assertEquals(180_000L, Resumption.load(queue, listOf("ref-a", "ref-b", "ref-d"), 9, 1 to 999_999L)!!.positionMs)
    }

    @Test
    fun theResumptionItemsCarryTheCurrentItemsCompleteDescriptionAndCover() {
        val cover = byteArrayOf(1, 2, 3)
        val resumed = Resumption.mediaItems(queue, cover) { null }
        assertEquals(1 to 42_000L, resumed.startIndex to resumed.startPositionMs)
        assertEquals(listOf("restored:0", "restored:1", "restored:2", "restored:3"), resumed.mediaItems.map { it.mediaId })
        // System UI's boot-time browse keeps the start item: a playable, titled description with its cover.
        val current = resumed.mediaItems[resumed.startIndex].mediaMetadata
        assertEquals(
            listOf("Signal b", "Android Acceptance · Playback Ownership", "Playback Ownership"),
            listOf(current.title, current.artist, current.albumTitle).map { it.toString() },
        )
        assertEquals(true to false, current.isPlayable to current.isBrowsable)
        assertEquals(180_000L, current.durationMs)
        assertArrayEquals(cover, current.artworkData)
        assertNull(resumed.mediaItems[0].mediaMetadata.artworkData)
        assertNull(Resumption.mediaItems(queue, null) { null }.mediaItems[1].mediaMetadata.artworkData)
    }
}

class HttpResumeApiTest {
    private val server = MockWebServer()
    private lateinit var origin: String
    private var cookieHeader: String? = "__Host-album_haven_session=session-value; __Host-album_haven_csrf=csrf%2Bvalue"

    @Before
    fun startServer() {
        server.start()
        origin = server.url("/").toString().removeSuffix("/")
    }

    @After
    fun stopServer() {
        server.close()
    }

    private fun api() = HttpResumeApi(OkHttpClient(), ShellSession({ origin }) { url -> cookieHeader.takeIf { url == origin } })

    @Test
    fun exchangesTokensWithTheSessionAndCsrfAndReadsNullForARemovedFile() {
        server.enqueue(MockResponse.Builder().code(200).body(
            """{"protocol":1,"expiresAt":"2026-11-05T00:00:00+00:00","tracks":[{"clientKey":"0","playbackRef":"ref.a"},{"clientKey":"1","playbackRef":null}]}""",
        ).build())
        assertEquals(ResumeAnswer.Refs(listOf("ref.a", null)), api().exchange(listOf("rt1.a", "rt1.b")))
        val request = server.takeRequest()
        assertEquals("/playback/refs/resume", request.url.encodedPath)
        assertEquals("csrf+value", request.headers[ShellSession.CSRF_HEADER])
        assertEquals(origin, request.headers["Origin"])
        val body = JSONObject(request.body!!.utf8())
        assertEquals(1, body.getInt("protocol"))
        val tracks = body.getJSONArray("tracks")
        assertEquals(
            listOf("0" to "rt1.a", "1" to "rt1.b"),
            (0 until tracks.length()).map { tracks.getJSONObject(it).let { track -> track.getString("clientKey") to track.getString("resumeToken") } },
        )
    }

    @Test
    fun aMissingOrExpiredSignInIsSignedOutAndAnythingElseIsUnavailable() {
        cookieHeader = null
        assertEquals(ResumeAnswer.SignedOut, api().exchange(listOf("rt1.a")))
        assertEquals(0, server.requestCount)
        cookieHeader = "__Host-album_haven_session=expired"
        for ((code, body, expected) in listOf(
            Triple(401, """{"detail":"Authentication required."}""", ResumeAnswer.SignedOut),
            Triple(403, """{"detail":"Invalid or unavailable playback request."}""", ResumeAnswer.Unavailable),
            Triple(200, """{"protocol":1,"tracks":[{"clientKey":"7","playbackRef":"ref.a"}]}""", ResumeAnswer.Unavailable),
            Triple(200, """{"protocol":1,"tracks":[{"clientKey":"0","playbackRef":"C:/Music/a.flac"}]}""", ResumeAnswer.Unavailable),
            Triple(200, "not json", ResumeAnswer.Unavailable),
        )) {
            server.enqueue(MockResponse.Builder().code(code).body(body).build())
            assertEquals(body, expected, api().exchange(listOf("rt1.a")))
        }
    }
}

class ResumeProtocolFixtureTest {
    private val valid = JSONObject(java.io.File("../../../tests/fixtures/playback-protocol-v1.json").readText()).getJSONObject("valid")

    @Test
    fun theSharedResumeFixtureIsTheShapeTheNativeExchangeSendsAndReads() {
        val server = MockWebServer().apply { start() }
        try {
            val origin = server.url("/").toString().removeSuffix("/")
            server.enqueue(MockResponse.Builder().code(200).body(valid.getJSONObject("resumeResponse").toString()).build())
            val api = HttpResumeApi(OkHttpClient(), ShellSession({ origin }) { "__Host-album_haven_session=s; __Host-album_haven_csrf=c" })
            val token = valid.getJSONObject("resumeRequest").getJSONArray("tracks").getJSONObject(0).getString("resumeToken")
            assertEquals(ResumeAnswer.Refs(listOf("playback-ref-2")), api.exchange(listOf(token)))
            val sent = JSONObject(server.takeRequest().body!!.utf8())
            assertEquals(1, sent.getInt("protocol"))
            assertEquals(valid.getJSONObject("resumeRequest").keys().asSequence().toSet(), sent.keys().asSequence().toSet())
            assertEquals(
                valid.getJSONObject("resumeRequest").getJSONArray("tracks").getJSONObject(0).keys().asSequence().toSet(),
                sent.getJSONArray("tracks").getJSONObject(0).keys().asSequence().toSet(),
            )
        } finally {
            server.close()
        }
    }
}
