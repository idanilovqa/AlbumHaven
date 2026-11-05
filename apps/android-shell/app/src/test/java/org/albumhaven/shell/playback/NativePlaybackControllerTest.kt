package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

const val TEST_CLIENT_ID = "0c8f5a54-2d1e-4b7a-9a43-6f2d8b1c3e70"
const val TEST_DEVICE_ID = "6f1c8a51-2a2c-4d2f-9a61-0d4f1f2b6a01"

class FakeClaimApi : PlaybackClaimApi {
    val calls = mutableListOf<String>()
    val tracks = mutableListOf<ClaimTrack>()
    var acquireResponse: () -> ClaimResponse = { ClaimResponse.Granted("token-${++issued}") }
    var renewResponse: (String) -> ClaimResponse = { ClaimResponse.Granted(it) }
    private var issued = 0

    override fun acquire(clientId: String, claimToken: String?, track: ClaimTrack): ClaimResponse {
        check(clientId == TEST_CLIENT_ID)
        calls += "acquire:$claimToken"
        tracks += track
        return if (claimToken == null) acquireResponse() else renewResponse(claimToken)
    }

    override fun release(clientId: String, claimToken: String) {
        calls += "release:$claimToken"
    }
}

/** Records listen writes and answers each with [answer]. */
class FakeListenApi : ListenEffectApi {
    val posts = mutableListOf<Triple<ListenEffect, String, JSONObject>>()
    var answer: () -> ListenEffectResult = { ListenEffectResult.Answered(200, JSONObject().put("ok", true)) }

    override fun post(effect: ListenEffect, clientId: String, claimToken: String, body: JSONObject): ListenEffectResult {
        check(clientId == TEST_CLIENT_ID)
        posts += Triple(effect, claimToken, body)
        return answer()
    }
}

/** Runs queued work only when [drain] is called, like a busy network thread. */
class ManualExecutor : Executor {
    private val queued = ArrayDeque<Runnable>()
    override fun execute(command: Runnable) {
        queued += command
    }

    fun drain() {
        while (queued.isNotEmpty()) queued.removeFirst().run()
    }
}

/**
 * Drives [NativePlaybackController] on the test thread against the fake socket server and sink.
 * With [realTime], each five-millisecond step lets the sink take only five milliseconds of audio.
 */
class ControllerHarness(
    vararg tracks: SyntheticTrack,
    realTime: Boolean = false,
    claimIo: Executor = Executor { it.run() },
    listenIo: Executor = Executor { it.run() },
    failures: (RuntimeException) -> Unit = {},
) {
    var now = 0L
    val server = FakeAhpcServer(tracks.toList())
    val claims = FakeClaimApi()
    val listen = FakeListenApi()
    val sinks = mutableListOf<RecordingSink>()
    val events = mutableListOf<NativePlaybackEvent>()
    val warms = mutableListOf<Boolean>()
    var listener: PcmTransportListener? = null
    var connects = 0
    var closes = 0

    /** Android refuses every new output, as `AudioTrack.Builder.build()` can. */
    var outputUnavailable = false

    val controller = NativePlaybackController(
        transports = { socketListener ->
            connects += 1
            listener = socketListener
            socketListener.onOpen()
            object : PcmTransport {
                override fun send(text: String) = server.receive(text)
                override fun close() {
                    closes += 1
                }
            }
        },
        claimApi = claims,
        listenApi = listen,
        sinks = { rate ->
            if (outputUnavailable) throw UnsupportedOperationException("Cannot create AudioTrack")
            RecordingSink(rate, if (realTime) rate * STEP_MS.toInt() / 1000 else Int.MAX_VALUE).also(sinks::add)
        },
        io = claimIo,
        listenIo = listenIo,
        clock = { now },
        events = { events += it },
        clientId = TEST_CLIENT_ID,
        warmer = { socketConnection -> warms += socketConnection },
        deviceId = TEST_DEVICE_ID,
        wallClockMs = { 1_793_613_600_000L + now },
        failures = failures,
    )

    fun item(track: SyntheticTrack) = QueueItem(
        playbackRef = track.pcm.playbackRef,
        title = "Signal ${track.tag}",
        artist = "Android Acceptance",
        album = "Playback Ownership",
        artworkUrl = null,
        durationMs = track.frames * 1000 / track.sampleRate,
        trackNumber = track.tag.toString(),
        listenKey = "lk-${track.tag}",
    )

    fun load(revision: Long, vararg queue: SyntheticTrack, autoplay: Boolean = true, positionMs: Long = 0) =
        controller.loadQueue(QueueLoad(revision, queue.map(::item), 0, positionMs, null, autoplay))

    fun deliver() {
        val socket = listener ?: return
        while (server.outbox.isNotEmpty()) {
            when (val message = server.outbox.removeFirst()) {
                is String -> socket.onText(message)
                is ByteArray -> socket.onBinary(message)
            }
        }
    }

    fun step(ms: Long = STEP_MS) {
        now += ms
        deliver()
        controller.runOnce()
        deliver()
    }

    fun runUntil(maxSteps: Int = 100_000, done: () -> Boolean) {
        repeat(maxSteps) {
            if (done()) return
            step()
        }
        error("playback did not reach the expected state; last ${events.takeLast(3)}")
    }

    fun state() = controller.snapshot.state

    fun ownership() = events.filterIsInstance<NativePlaybackEvent.Ownership>().map { it.ownership }

    fun writes() = listen.posts.map { (effect, _, body) -> effect to body }

    /** Runs listen writes and their follow-ups until none is left, as the network would. */
    fun settleListening(listenIo: ManualExecutor) {
        repeat(20) {
            listenIo.drain()
            step()
        }
    }

    fun reasons() = events.filterIsInstance<NativePlaybackEvent.CurrentItem>().map { it.reason to it.snapshot.currentIndex }

    companion object {
        const val STEP_MS = 5L
    }
}

class NativePlaybackControllerTest {
    private val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
    private val second = SyntheticTrack(tag = 2, frames = 2L * RATE)

    @Test
    fun claimsThenPlaysTheQueueGaplesslyAndReleasesAtTheEnd() {
        val harness = ControllerHarness(first, second)
        assertEquals(CommandResult.ACCEPTED, harness.load(1, first, second))
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }

        // The first open guesses CD rate; the refusal restarts the track on a 48 kHz engine.
        assertEquals(listOf(44_100, RATE), harness.sinks.map { it.sampleRate })
        assertEquals(emptyList<Run>(), harness.sinks[0].runs())
        assertEquals(listOf(Run(1, 0, first.frames), Run(2, 0, second.frames)), harness.sinks[1].runs())
        assertEquals(
            listOf(CurrentItemReason.LOAD to 0, CurrentItemReason.ADVANCE to 1),
            harness.reasons(),
        )
        // The claim goes once the listen writes for the end are done.
        harness.step()
        assertEquals(listOf("owned", "released"), harness.ownership())
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
        assertEquals(1, harness.connects)
        assertTrue(harness.server.texts.none { JSONObject(it).has("path") })
        assertTrue(harness.server.texts.filter { it.contains("\"open\"") }.all { it.contains("playbackRef") })
        assertEquals(emptyList<String>(), harness.server.violations)
        assertEquals(1, harness.controller.snapshot.currentIndex)
    }

    @Test
    fun nothingIsHeardBeforeTheClaimAndARefusalClosesThePrefetchedStream() {
        val harness = ControllerHarness(first)
        harness.claims.acquireResponse = { ClaimResponse.Conflict }
        harness.load(1, first)
        repeat(20) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(listOf("blocked"), harness.ownership())
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })
        assertNull(harness.server.streamPosition(1))
        assertEquals(emptyList<String>(), harness.server.violations)

        // A prefetch the server accepted is closed once its open is confirmed.
        val cdAudio = SyntheticTrack(tag = 4, frames = 3L * 44_100, sampleRate = 44_100)
        val accepted = ControllerHarness(cdAudio)
        accepted.claims.acquireResponse = { ClaimResponse.Conflict }
        accepted.load(1, cdAudio)
        repeat(20) { accepted.step() }
        assertTrue(accepted.sinks.all { it.writtenFrames == 0 })
        assertEquals(1, accepted.server.texts.count { JSONObject(it).getString("type") == "close" })
        assertNull(accepted.server.streamPosition(1))
        assertEquals(emptyList<String>(), accepted.server.violations)
    }

    @Test
    fun theStreamFillsItsCushionWhileTheClaimIsRequestedAndPlaysOnlyOnceGranted() {
        val claimIo = ManualExecutor()
        val harness = ControllerHarness(first, claimIo = claimIo)
        harness.load(1, first)
        repeat(20) { harness.step() }

        val open = harness.sinks.last()
        assertTrue(harness.controller.snapshot.state != NativePlaybackState.PLAYING)
        assertEquals(0, open.writtenFrames)
        assertTrue(harness.server.texts.count { it.contains("\"credit\"") } > 0)

        claimIo.drain()
        harness.step()
        assertTrue(open.writtenFrames > 0)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(listOf(Run(1, 0, first.frames)), harness.sinks.last().runs())
    }

    @Test
    fun aResumeWhileThePauseCheckpointIsInFlightKeepsTheSameClaim() {
        val listenIo = ManualExecutor()
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        harness.controller.pause()
        harness.step()
        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }

        assertEquals(listOf("acquire:null"), harness.claims.calls)
        assertEquals(listOf("owned"), harness.ownership())
    }

    @Test
    fun listenWritesNameTheTrackByReferenceAndWaitForAPendingClaim() {
        val claimIo = ManualExecutor()
        val harness = ControllerHarness(first, claimIo = claimIo)
        harness.load(1, first)
        repeat(5) { harness.step() }
        assertTrue(harness.listen.posts.isEmpty())

        claimIo.drain()
        harness.step()
        val (effect, token, body) = harness.listen.posts.first()
        assertEquals(ListenEffect.NOW_PLAYING, effect)
        assertEquals("token-1", token)
        assertEquals(first.pcm.playbackRef, body.getString("playbackRef"))
        assertEquals("Signal 1", body.getString("title"))
        assertEquals("1", body.getString("track_number"))
        assertEquals(TEST_DEVICE_ID, body.getString("device_id"))
        assertEquals(TEST_CLIENT_ID, body.getJSONObject("request_origin").getString("origin_id"))
        assertTrue(harness.listen.posts.none { (_, _, sent) -> sent.has("path") || sent.has("cover_path") || sent.has("claimToken") })
    }

    @Test
    fun aListenWriteWithoutTheClaimIsNotSent() {
        val harness = ControllerHarness(first)
        harness.claims.acquireResponse = { ClaimResponse.Conflict }
        harness.load(1, first)
        repeat(20) { harness.step() }
        assertTrue(harness.listen.posts.isEmpty())
    }

    @Test
    fun aClaimReportingScrobblingUnavailableSendsOnlyTheCompletion() {
        val claimIo = ManualExecutor()
        val a = SyntheticTrack(tag = 1, frames = 12L * RATE)
        val harness = ControllerHarness(a, claimIo = claimIo)
        harness.claims.acquireResponse = { ClaimResponse.Granted("token-1", scrobblingAvailable = false) }
        harness.claims.renewResponse = { ClaimResponse.Granted(it, scrobblingAvailable = false) }
        harness.load(1, a)
        // The now-playing is built while the claim is requested and dropped once its answer arrives.
        repeat(5) { harness.step() }
        harness.runUntil {
            claimIo.drain()
            harness.state() == NativePlaybackState.ENDED
        }
        harness.step()

        assertEquals(listOf(ListenEffect.COMPLETE), harness.writes().map { it.first })
        assertTrue(harness.writes().single().second.getBoolean("scrobble_eligible"))
    }

    @Test
    fun theClaimIsReleasedOnlyAfterThePauseCheckpointFinishes() {
        val listenIo = ManualExecutor()
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        harness.controller.pause()
        repeat(5) { harness.step() }
        assertEquals(listOf("acquire:null"), harness.claims.calls)

        harness.settleListening(listenIo)
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
        val complete = harness.writes().last()
        assertEquals(ListenEffect.COMPLETE, complete.first)
        assertEquals("paused", complete.second.getString("completion_reason"))
        assertTrue(complete.second.getBoolean("finalized"))
    }

    @Test
    fun aGaplessAdvanceCompletesTheOutgoingListenWithExactlyItsHeardFrames() {
        val a = SyntheticTrack(tag = 1, frames = 12L * RATE)
        val b = SyntheticTrack(tag = 2, frames = 11L * RATE)
        val harness = ControllerHarness(a, b)
        harness.load(1, a, b)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.step()

        val writes = harness.writes()
        val completes = writes.filter { it.first == ListenEffect.COMPLETE }.map { it.second }
        assertEquals(listOf(a.pcm.playbackRef, b.pcm.playbackRef), completes.map { it.getString("playbackRef") })
        assertEquals(listOf(12.0, 11.0), completes.map { it.getDouble("measured_listened_seconds") })
        assertTrue(completes.all { it.getString("completion_reason") == "ended" && it.getBoolean("finished_fully") })
        assertEquals(2, completes.map { it.getString("session_id") }.distinct().size)
        assertEquals(
            listOf(ListenEffect.NOW_PLAYING, ListenEffect.SCROBBLE, ListenEffect.COMPLETE),
            writes.filter { it.second.getString("playbackRef") == b.pcm.playbackRef }.map { it.first },
        )
        // Every listen's sequences only increase.
        writes.groupBy { it.second.getString("session_id") }.values.forEach { session ->
            val sequences = session.map { it.second.getLong("sequence") }
            assertEquals(sequences.sorted(), sequences)
        }
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
    }

    @Test
    fun anotherTrackEndsTheListenAsSkippedAndTheSameTrackKeepsIt() {
        val long = SyntheticTrack(tag = 3, frames = 40L * RATE)
        val harness = ControllerHarness(long, first)
        harness.load(1, long, first)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        // A reload of the same track continues its listen.
        harness.load(2, long, first, positionMs = harness.controller.snapshot.positionMs)
        repeat(10) { harness.step() }
        assertTrue(harness.writes().none { it.first == ListenEffect.COMPLETE })

        harness.controller.loadQueue(QueueLoad(3, listOf(harness.item(first)), 0, 0, null, true))
        repeat(10) { harness.step() }
        val complete = harness.writes().single { it.first == ListenEffect.COMPLETE }.second
        assertEquals("track-change", complete.getString("completion_reason"))
        assertTrue(complete.getBoolean("skipped"))
        assertEquals(long.pcm.playbackRef, complete.getString("playbackRef"))
        assertEquals(1, harness.writes().count { it.first == ListenEffect.NOW_PLAYING && it.second.getString("playbackRef") == long.pcm.playbackRef })
    }

    @Test
    fun aRefreshedReferenceContinuesTheSameListenAndLaterWritesNameIt() {
        val long = SyntheticTrack(tag = 3, frames = 40L * RATE)
        // The same track under a fresh reference, as a reference retry or expiry reload sends it.
        val refreshed = SyntheticTrack(tag = 4, frames = 40L * RATE)
        val harness = ControllerHarness(long, refreshed)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        val item = harness.item(refreshed).copy(listenKey = harness.item(long).listenKey)
        harness.controller.loadQueue(QueueLoad(2, listOf(item), 0, harness.controller.snapshot.positionMs, null, true))
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 24 * RATE }
        harness.controller.pause()
        repeat(10) { harness.step() }

        val writes = harness.writes()
        assertEquals(listOf(ListenEffect.NOW_PLAYING, ListenEffect.SCROBBLE, ListenEffect.COMPLETE), writes.map { it.first })
        assertEquals(1, writes.map { it.second.getString("session_id") }.distinct().size)
        assertEquals(long.pcm.playbackRef, writes.first().second.getString("playbackRef"))
        assertTrue(writes.drop(1).all { it.second.getString("playbackRef") == refreshed.pcm.playbackRef })
        assertEquals("paused", writes.last().second.getString("completion_reason"))
    }

    @Test
    fun aShutdownMidPlaySendsTheUnloadCheckpointBeforeReleasingTheClaim() {
        val listenIo = ManualExecutor()
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        harness.settleListening(listenIo)
        var finished = false
        harness.controller.shutdown { finished = true }
        repeat(5) { harness.step() }
        assertEquals(listOf("acquire:null"), harness.claims.calls)
        assertFalse(finished)

        listenIo.drain()
        harness.step()
        val (effect, token, body) = harness.listen.posts.last()
        assertEquals(ListenEffect.COMPLETE, effect)
        assertEquals("token-1", token)
        assertEquals("pagehide", body.getString("completion_reason"))
        assertTrue(body.getBoolean("finalized") && body.getBoolean("skipped") && !body.getBoolean("finished_fully"))
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
        assertTrue(finished)
        assertEquals(NativePlaybackState.IDLE, harness.state())
    }

    @Test
    fun aShutdownReleasesTheClaimAfterItsBoundEvenWhenTheCheckpointIsStuck() {
        val listenIo = ManualExecutor()
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        harness.settleListening(listenIo)
        var finished = false
        harness.controller.shutdown { finished = true }
        harness.step()
        harness.step(NativePlaybackController.SHUTDOWN_CHECKPOINT_MS - 10)
        assertFalse(finished)
        harness.step(10)
        assertTrue(finished)
        assertEquals("release:token-1", harness.claims.calls.last())

        // The checkpoint is sent once, late, or lost; never twice.
        listenIo.drain()
        assertEquals(1, harness.listen.posts.count { it.third.optString("completion_reason") == "pagehide" })
    }

    @Test
    fun aShutdownWhilePausedSendsNoUnloadCheckpoint() {
        val listenIo = ManualExecutor()
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        harness.controller.pause()
        harness.step()
        harness.controller.shutdown()
        harness.settleListening(listenIo)

        val reasons = harness.writes().filter { it.first == ListenEffect.COMPLETE }.map { it.second.getString("completion_reason") }
        assertEquals(listOf("paused"), reasons)
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
    }

    @Test
    fun theQueueEndsOnlyAfterTheOutputHasPlayedItsLastFrame() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.sinks.last().pending = RATE / 4
        harness.runUntil { harness.sinks.last().writtenFrames.toLong() == first.frames }
        repeat(10) { harness.step() }
        assertEquals(NativePlaybackState.PLAYING, harness.state())

        harness.sinks.last().pending = 0
        harness.step()
        assertEquals(NativePlaybackState.ENDED, harness.state())
    }

    @Test
    fun theHandshakeWarmsBothConnectionsAndIdleTimeKeepsThemWarm() {
        val harness = ControllerHarness(first)
        harness.controller.warmConnections()
        harness.step()
        assertEquals(listOf(true), harness.warms)

        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.step()
        harness.now += NativePlaybackController.KEEP_WARM_MS
        harness.step()
        // The socket stays open after a play, so only the HTTP connection needs warming.
        assertEquals(listOf(true, false), harness.warms)
    }

    @Test
    fun anUnavailableClaimReportsAnErrorInsteadOfPlaying() {
        val harness = ControllerHarness(first)
        harness.claims.acquireResponse = { ClaimResponse.Rejected(403) }
        harness.load(1, first)
        repeat(5) { harness.step() }

        assertEquals(NativePlaybackState.ERROR, harness.state())
        val error = harness.events.filterIsInstance<NativePlaybackEvent.Error>().single()
        assertEquals("ownership_unavailable", error.code)
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })
    }

    @Test
    fun pauseReleasesTheClaimOnceItsListenWritesAreDoneAndPlayReacquiresAndResumesInPlace() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long)
        harness.load(1, long)
        harness.runUntil { harness.sinks.lastOrNull()?.writtenFrames ?: 0 >= RATE }

        harness.controller.pause()
        harness.step()
        val writtenAtPause = harness.sinks.last().writtenFrames
        repeat(20) { harness.step() }
        assertEquals(writtenAtPause, harness.sinks.last().writtenFrames)
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)

        assertEquals(CommandResult.ACCEPTED, harness.controller.play(1))
        harness.runUntil { harness.sinks.last().writtenFrames > writtenAtPause }
        assertEquals(listOf("acquire:null", "release:token-1", "acquire:null"), harness.claims.calls)
        assertEquals(listOf(Run(3, 0, harness.sinks.last().writtenFrames.toLong())), harness.sinks.last().runs())
        assertEquals(listOf("owned", "released", "owned"), harness.ownership())
    }

    @Test
    fun heartbeatsEveryTenSecondsWithTheCurrentTrack() {
        val long = SyntheticTrack(tag = 3, frames = 60L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.load(1, long)
        harness.runUntil { harness.now >= 25_000 }

        assertEquals(listOf("acquire:null", "acquire:token-1", "acquire:token-1"), harness.claims.calls)
        assertTrue(harness.claims.tracks.all { it.playbackRef == long.pcm.playbackRef && it.title == "Signal 3" })
    }

    @Test
    fun aLostClaimSilencesPlaybackAtOnce() {
        val long = SyntheticTrack(tag = 3, frames = 60L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.claims.renewResponse = { ClaimResponse.Conflict }
        harness.load(1, long)
        harness.runUntil { harness.ownership().contains("lost") }
        val written = harness.sinks.last().writtenFrames
        repeat(50) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(written, harness.sinks.last().writtenFrames)
        assertEquals("pause", harness.sinks.last().operations.last())
    }

    @Test
    fun anUnreachableServerLosesTheClaimWhenTheLeaseRunsOut() {
        val long = SyntheticTrack(tag = 3, frames = 60L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.claims.renewResponse = { ClaimResponse.Unreachable }
        harness.load(1, long)
        harness.runUntil { harness.ownership().contains("lost") }

        assertTrue(harness.now in PlaybackClaimOwner.LEASE_MS..PlaybackClaimOwner.LEASE_MS + 100)
        assertEquals(NativePlaybackState.PAUSED, harness.state())
    }

    @Test
    fun staleRevisionsAreRejectedAndNewerLoadsReplaceTheQueue() {
        val harness = ControllerHarness(first, second)
        assertEquals(CommandResult.NO_QUEUE, harness.controller.play(1))
        assertEquals(CommandResult.ACCEPTED, harness.load(2, first))
        assertEquals(CommandResult.STALE_REVISION, harness.load(2, second))
        assertEquals(CommandResult.STALE_REVISION, harness.load(1, second))
        assertEquals(CommandResult.STALE_REVISION, harness.controller.seek(1, 0))
        assertEquals(CommandResult.ACCEPTED, harness.controller.seek(2, 0))
        harness.runUntil { harness.sinks.lastOrNull()?.writtenFrames ?: 0 > 0 }

        assertEquals(CommandResult.ACCEPTED, harness.load(3, second))
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        val replacementStates = harness.events.filterIsInstance<NativePlaybackEvent.State>()
            .filter { it.snapshot.queueRevision == 3L }.map { it.snapshot.state }
        assertEquals(NativePlaybackState.LOADING, replacementStates.first())
        assertTrue(NativePlaybackState.PLAYING in replacementStates)
        assertEquals(3, harness.controller.snapshot.queueRevision)
        assertEquals(2, harness.sinks.last().runs().last().tag)
        assertEquals(Run(2, 0, second.frames), harness.sinks.last().runs().last())
    }

    @Test
    fun aPausedLoadHoldsItsPlaceWithoutClaimOrStream() {
        val harness = ControllerHarness(first)
        harness.load(1, first, autoplay = false, positionMs = 1_500)
        repeat(5) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(1_500, harness.controller.snapshot.positionMs)
        assertTrue(harness.claims.calls.isEmpty())
        assertEquals(0, harness.connects)

        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(Run(1, RATE * 3 / 2L, first.frames - RATE * 3 / 2L), harness.sinks.last().runs().single())
    }

    @Test
    fun seekWhilePlayingCutsOverToTheRequestedFrame() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }

        harness.controller.seek(1, 10_000)
        harness.runUntil { harness.sinks.last().runs().size == 2 }
        val runs = harness.sinks.last().runs()
        assertEquals(10L * RATE, runs[1].start)
        assertTrue(harness.events.any { it is NativePlaybackEvent.Position && it.snapshot.positionMs >= 10_000 })
    }

    @Test
    fun nextAndPreviousMoveWithinTheQueue() {
        val harness = ControllerHarness(first, second)
        harness.load(1, first, second, autoplay = false)
        harness.step()
        harness.controller.next(1)
        harness.step()
        assertEquals(1, harness.controller.snapshot.currentIndex)
        harness.controller.next(1)
        harness.step()
        assertEquals(1, harness.controller.snapshot.currentIndex)
        harness.controller.previous(1)
        harness.step()
        assertEquals(0, harness.controller.snapshot.currentIndex)
        assertEquals(
            listOf(CurrentItemReason.LOAD to 0, CurrentItemReason.NEXT to 1, CurrentItemReason.PREVIOUS to 0),
            harness.reasons(),
        )
    }

    @Test
    fun previousAndNextStayInsideTheirAlbumAndANaturalEndContinuesIntoTheNext() {
        val third = SyntheticTrack(tag = 4, frames = 2L * RATE)
        val harness = ControllerHarness(first, second, third)
        val items = listOf(harness.item(first), harness.item(second), harness.item(third).copy(queueGroup = 1))
        harness.controller.loadQueue(QueueLoad(1, items, 1, 0, null, autoplay = false))
        harness.step()
        harness.controller.previous(1)
        harness.step()
        // The web's previous is disabled on an album's first track: no restart, no event.
        harness.controller.previous(1)
        harness.step()
        harness.controller.next(1)
        harness.step()
        // Nor does its next leave the album.
        harness.controller.next(1)
        harness.step()
        assertEquals(
            listOf(CurrentItemReason.LOAD to 1, CurrentItemReason.PREVIOUS to 0, CurrentItemReason.NEXT to 1),
            harness.reasons(),
        )

        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(CurrentItemReason.ADVANCE to 2, harness.reasons().last())
        assertEquals(listOf(Run(2, 0, second.frames), Run(4, 0, third.frames)), harness.sinks.last().runs())
    }

    /** The sink operations from the step that applied [command], and what the snapshot said right after it. */
    private fun ControllerHarness.applyNow(command: () -> Unit): Pair<List<String>, NativePlaybackSnapshot> {
        val before = sinks.last().operations.size
        val writtenBefore = sinks.last().writtenFrames
        command()
        controller.runOnce()
        // Nothing of the outgoing track may be written in the pass that applied the change.
        assertEquals(writtenBefore, sinks.last().writtenFrames)
        return sinks.last().operations.drop(before) to controller.snapshot
    }

    @Test
    fun aTrackChangeWhilePlayingSilencesTheOutgoingTrackAtOnceAndNamesTheNewOne() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val second = SyntheticTrack(tag = 2, frames = 11L * RATE)
        val harness = ControllerHarness(long, second, realTime = true)
        harness.load(1, long)
        // Long enough to count as a listen, so the skip completes it as a track change.
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 12 * RATE }
        val heard = harness.sinks.last().writtenFrames.toLong()
        // The new start's decoder is slow: the outgoing track must not bridge the wait.
        harness.server.decoding = false

        val (operations, snapshot) = harness.applyNow {
            harness.controller.loadQueue(QueueLoad(2, listOf(harness.item(second)), 0, 0, null, true))
        }
        assertEquals(listOf("pause", "flush"), operations.take(2))
        assertEquals("Signal 2", snapshot.items[snapshot.currentIndex!!].title)
        assertTrue(snapshot.state == NativePlaybackState.LOADING || snapshot.state == NativePlaybackState.BUFFERING)
        repeat(200) { harness.step() }
        assertEquals(heard, harness.sinks.last().runs().single { it.tag == 3 }.length)
        assertEquals(NativePlaybackState.BUFFERING, harness.state())

        harness.server.decoding = true
        harness.server.decodeAll()
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.step()
        assertEquals(listOf(Run(3, 0, heard), Run(2, 0, second.frames)), harness.sinks.last().runs())
        val completes = harness.writes().filter { it.first == ListenEffect.COMPLETE }.map { it.second }
        assertEquals("track-change", completes.first().getString("completion_reason"))
        assertEquals(second.pcm.playbackRef, completes.last().getString("playbackRef"))
        assertEquals(11.0, completes.last().getDouble("measured_listened_seconds"), 0.0)
    }

    @Test
    fun aSystemSkipWhilePlayingSilencesTheOutgoingTrackAtOnceAndNamesTheNewOne() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, second, realTime = true)
        harness.load(1, long, second)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 3 * RATE }
        val heard = harness.sinks.last().writtenFrames.toLong()
        harness.server.decoding = false

        val (operations, snapshot) = harness.applyNow { harness.controller.next(1, CommandSource.SYSTEM) }
        assertEquals(listOf("pause", "flush"), operations.take(2))
        assertEquals(1, snapshot.currentIndex)
        assertTrue(snapshot.state != NativePlaybackState.PLAYING)
        val step = harness.events.filterIsInstance<NativePlaybackEvent.CurrentItem>().last()
        assertEquals(CurrentItemReason.NEXT to 1, step.reason to step.snapshot.currentIndex)

        harness.server.decoding = true
        harness.server.decodeAll()
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(listOf(Run(3, 0, heard), Run(2, 0, second.frames)), harness.sinks.last().runs())
    }

    @Test
    fun rapidRepeatedNextCommandsLandOnTheLastRequestedItemAndOnlyItIsHeard() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val third = SyntheticTrack(tag = 4, frames = 2L * RATE)
        val harness = ControllerHarness(long, second, third, realTime = true)
        harness.load(1, long, second, third)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= RATE }
        val heard = harness.sinks.last().writtenFrames.toLong()

        // A headset double press repeated: both arrive before the playback thread runs.
        harness.controller.next(1, CommandSource.SYSTEM)
        harness.controller.next(1, CommandSource.SYSTEM)
        harness.step()
        assertEquals(2, harness.controller.snapshot.currentIndex)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }

        assertEquals(
            listOf(CurrentItemReason.LOAD to 0, CurrentItemReason.NEXT to 1, CurrentItemReason.NEXT to 2),
            harness.reasons(),
        )
        // The skipped-over track is never heard.
        assertEquals(listOf(Run(3, 0, heard), Run(4, 0, third.frames)), harness.sinks.last().runs())
    }

    @Test
    fun aStartTheServerNeverFeedsIsReopenedOnceThenFailsReadablyAndPlayRetries() {
        val long = SyntheticTrack(tag = 3, frames = 30L * RATE)
        val harness = ControllerHarness(long, second, realTime = true)
        harness.load(1, long, second)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.server.decoding = false
        harness.controller.next(1, CommandSource.SYSTEM)
        harness.step()
        val skippedAt = harness.now

        val opens = { harness.server.texts.map(::JSONObject).count { it.getString("type") == "open" && it.getString("role") == "current" } }
        val startOpens = opens()
        harness.runUntil { opens() == startOpens + 1 }
        assertTrue(harness.now - skippedAt >= NativePlaybackController.START_STALL_MS)
        // Still the selected track, still buffering: never the previous title, never "playing".
        assertEquals(NativePlaybackState.BUFFERING, harness.state())
        assertEquals(1, harness.controller.snapshot.currentIndex)

        harness.runUntil { harness.state() == NativePlaybackState.ERROR }
        val error = harness.events.filterIsInstance<NativePlaybackEvent.Error>().single()
        assertEquals("start_stalled", error.code)
        assertEquals(1, error.snapshot.currentIndex)
        assertTrue(
            harness.events.filterIsInstance<NativePlaybackEvent.State>()
                .none { it.snapshot.state == NativePlaybackState.PLAYING && it.snapshot.currentIndex == 1 },
        )

        harness.server.decoding = true
        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(Run(2, 0, second.frames), harness.sinks.last().runs().last())
    }

    @Test
    fun playOfAStreamPreparedWhilePausedReportsPlayingOnlyFromItsFirstFrame() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.controller.pause()
        harness.step()
        // A paused seek prepares the new position; the server is slow to feed it.
        harness.server.decoding = false
        harness.controller.seek(1, 8_000)
        repeat(5) { harness.step() }

        harness.controller.play(1)
        repeat(200) { harness.step() }
        assertEquals(NativePlaybackState.BUFFERING, harness.state())
        harness.server.decoding = true
        harness.server.decodeAll()
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(8L * RATE, harness.sinks.last().runs().last().start)
    }

    @Test
    fun aPauseBeforeTheNewTrackIsHeardHoldsItsPlaceAndPlayStartsIt() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long, second)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 3 * RATE }
        harness.server.decoding = false
        harness.controller.loadQueue(QueueLoad(2, listOf(harness.item(second)), 0, 500, null, true))
        harness.step()
        harness.controller.pause()
        harness.step()
        harness.server.decoding = true
        harness.server.decodeAll()
        repeat(10) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(500, harness.controller.snapshot.positionMs)
        assertTrue(harness.sinks.flatMap { it.runs() }.none { it.tag == 2 })
        harness.controller.play(2)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(Run(2, RATE / 2L, second.frames - RATE / 2), harness.sinks.last().runs().last())
    }

    @Test
    fun aQueueChangeUnderThePlayingTrackKeepsItsAudioListenAndNamesTheNewSuccessor() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val second = SyntheticTrack(tag = 2, frames = 11L * RATE)
        val harness = ControllerHarness(long, first, second)
        harness.load(1, long, first)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 3 * RATE }

        val queue = listOf(harness.item(long), harness.item(second))
        val position = harness.controller.snapshot.positionMs
        harness.controller.loadQueue(QueueLoad(2, queue, 0, position, null, true, keepCurrent = true))
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.step()

        assertEquals(listOf(Run(3, 0, long.frames), Run(2, 0, second.frames)), harness.sinks.last().runs())
        val completes = harness.writes().filter { it.first == ListenEffect.COMPLETE }.map { it.second }
        assertEquals(listOf(long.pcm.playbackRef, second.pcm.playbackRef), completes.map { it.getString("playbackRef") })
        assertTrue(completes.all { it.getString("completion_reason") == "ended" })
        assertEquals(listOf(CurrentItemReason.LOAD to 0, CurrentItemReason.LOAD to 0, CurrentItemReason.ADVANCE to 1), harness.reasons())
    }

    @Test
    fun aShortLoopReplaysRetainedSamplesAndALongOneReopensItsDecoder() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        // 0.5 s to 3.5 s at 48 kHz, named short by the web.
        harness.controller.setLoop(1, LoopRange48k(24_000, 168_000, LoopKind.SHORT))
        harness.runUntil { harness.events.count { it is NativePlaybackEvent.LoopWrapped } == 2 }
        val sent = harness.server.texts.map(::JSONObject)
        val loopOpens = sent.filter { it.getString("type") == "open" && it.getString("role") == "continuity" }
        assertEquals(listOf(24_000L), loopOpens.map { it.getLong("startFrame") })
        val runs = harness.sinks.last().runs()
        assertEquals(listOf(Run(3, 0, 168_000), Run(3, 24_000, 144_000)), runs.take(2))
        assertTrue(sent.none { it.getString("type") == "promote" })
    }

    @Test
    fun aRefusedReferenceIsReportedAsExpired() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.listener!!.onClosed(PcmCloseCodes.MEDIA_NOT_FOUND)
        harness.runUntil { harness.state() == NativePlaybackState.ERROR }

        assertTrue(harness.events.any { it is NativePlaybackEvent.ReferenceExpired })
        // The error releases the claim once no listen write is in flight.
        harness.step()
        assertEquals("released", harness.ownership().last())
    }

    @Test
    fun anUnexpectedSocketCloseReconnectsOnceAtTheHeardPosition() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.load(1, long)
        harness.runUntil { (harness.sinks.lastOrNull()?.writtenFrames ?: 0) >= 3 * RATE }
        val writtenAtClose = harness.sinks.last().writtenFrames
        harness.listener!!.onClosed(PcmTransportListener.ABNORMAL_CLOSURE)
        harness.runUntil { harness.connects == 2 && harness.sinks.last().writtenFrames > writtenAtClose + RATE }

        assertEquals(NativePlaybackState.PLAYING, harness.state())
        assertFalse(harness.events.any { it is NativePlaybackEvent.Error })
    }

    @Test
    fun aNewDocumentReattachesToTheRunningQueueWithItsClaimAndRevision() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long, realTime = true)
        harness.load(3, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        val written = harness.sinks.last().writtenFrames

        harness.controller.documentDetached()
        harness.runUntil { harness.sinks.last().writtenFrames > written + RATE }
        assertEquals(NativePlaybackState.PLAYING, harness.state())
        assertEquals(3, harness.controller.snapshot.queueRevision)
        assertEquals(listOf("acquire:null"), harness.claims.calls.filter { !it.startsWith("acquire:token") })
        assertEquals(listOf("owned"), harness.ownership())

        // The adopting document drives the live revision; a document that starts its own queue counts from one.
        harness.controller.pause()
        harness.step()
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(CommandResult.ACCEPTED, harness.controller.play(3))
        harness.controller.documentDetached()
        assertEquals(CommandResult.ACCEPTED, harness.load(1, long))
        assertEquals(CommandResult.STALE_REVISION, harness.load(1, long))
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING && harness.controller.snapshot.queueRevision == 1L }
    }

    @Test
    fun systemCommandsNameTheirSourceAndWebCommandsDoNot() {
        val long = SyntheticTrack(tag = 3, frames = 20L * RATE)
        val harness = ControllerHarness(long, second, realTime = true)
        harness.load(1, long, second)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }

        harness.controller.pause(CommandSource.SYSTEM)
        harness.step()
        val paused = harness.events.filterIsInstance<NativePlaybackEvent.State>().last()
        assertEquals(NativePlaybackState.PAUSED to CommandSource.SYSTEM, paused.snapshot.state to paused.source)

        harness.controller.next(1, CommandSource.SYSTEM)
        harness.step()
        val next = harness.events.filterIsInstance<NativePlaybackEvent.CurrentItem>().last()
        assertEquals(Triple(CurrentItemReason.NEXT, 1, CommandSource.SYSTEM), Triple(next.reason, next.snapshot.currentIndex, next.source))
        assertEquals(listOf(long.pcm.playbackRef, second.pcm.playbackRef), next.snapshot.items.map { it.playbackRef })
        // Like the web's skip, a system skip while paused starts the neighbour.
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }

        harness.controller.pause()
        harness.step()
        val webPause = harness.events.filterIsInstance<NativePlaybackEvent.State>().last()
        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        val resumed = harness.events.filterIsInstance<NativePlaybackEvent.State>().dropWhile { it !== webPause }
        assertTrue(resumed.size > 1 && resumed.all { it.source == CommandSource.WEB })
    }

    @Test
    fun aSkipWhilePausedOrEndedStartsPlayingTheNeighbour() {
        val harness = ControllerHarness(first, second)
        harness.load(1, first, second, autoplay = false)
        harness.step()
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        harness.controller.next(1, CommandSource.SYSTEM)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(1, harness.controller.snapshot.currentIndex)
        assertEquals(listOf("acquire:null"), harness.claims.calls.take(1))

        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.controller.previous(1, CommandSource.SYSTEM)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(0, harness.controller.snapshot.currentIndex)
    }

    @Test
    fun aCallbackAfterPendingCommandsSeesThemApplied() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        var observed: NativePlaybackState? = null
        harness.controller.pause(CommandSource.SYSTEM)
        harness.controller.afterPendingCommands { observed = harness.controller.snapshot.state }
        harness.step()
        assertEquals(NativePlaybackState.PAUSED, observed)
    }

    @Test
    fun shutdownStopsReleasesAndClosesTheSocket() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.controller.shutdown()
        harness.step()

        assertEquals(NativePlaybackState.IDLE, harness.state())
        assertEquals("release:token-1", harness.claims.calls.last())
        assertEquals(1, harness.closes)
    }

    /** The order the listen parity fixture's `refresh` step replays: a reloaded queue selects, then begins, the same listen. */
    @Test
    fun aRefreshedReferenceContinuesTheSameListen() {
        val a = SyntheticTrack(tag = 1, frames = 12L * RATE)
        val fresh = SyntheticTrack(tag = 6, frames = 12L * RATE)
        val harness = ControllerHarness(a, fresh)
        harness.load(1, a)
        harness.runUntil { harness.controller.snapshot.positionMs >= 2_000 }
        val refreshed = harness.item(fresh).copy(listenKey = harness.item(a).listenKey)
        harness.controller.loadQueue(QueueLoad(2, listOf(refreshed), 0, harness.controller.snapshot.positionMs, null, autoplay = true))
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.step()

        val writes = harness.writes()
        assertEquals(1, writes.map { it.second.getString("session_id") }.distinct().size)
        assertEquals(1, writes.count { it.first == ListenEffect.NOW_PLAYING })
        val complete = writes.single { it.first == ListenEffect.COMPLETE }.second
        assertEquals(fresh.pcm.playbackRef, complete.getString("playbackRef"))
        assertEquals("ended", complete.getString("completion_reason"))
    }
}
