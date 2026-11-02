package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

const val TEST_CLIENT_ID = "0c8f5a54-2d1e-4b7a-9a43-6f2d8b1c3e70"

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

/**
 * Drives [NativePlaybackController] on the test thread against the fake socket server and sink.
 * With [realTime], each five-millisecond step lets the sink take only five milliseconds of audio.
 */
class ControllerHarness(vararg tracks: SyntheticTrack, realTime: Boolean = false) {
    var now = 0L
    val server = FakeAhpcServer(tracks.toList())
    val claims = FakeClaimApi()
    val sinks = mutableListOf<RecordingSink>()
    val events = mutableListOf<NativePlaybackEvent>()
    var listener: PcmTransportListener? = null
    var connects = 0
    var closes = 0

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
        sinks = { rate ->
            RecordingSink(rate, if (realTime) rate * STEP_MS.toInt() / 1000 else Int.MAX_VALUE).also(sinks::add)
        },
        io = Executor { it.run() },
        clock = { now },
        events = { events += it },
        clientId = TEST_CLIENT_ID,
    )

    fun item(track: SyntheticTrack) = QueueItem(
        playbackRef = track.pcm.playbackRef,
        title = "Signal ${track.tag}",
        artist = "Android Acceptance",
        album = "Playback Ownership",
        artworkUrl = null,
        durationMs = track.frames * 1000 / track.sampleRate,
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
        controller.runOnce(0)
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
        assertEquals(listOf("owned", "released"), harness.ownership())
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)
        assertEquals(1, harness.connects)
        assertTrue(harness.server.texts.none { JSONObject(it).has("path") })
        assertTrue(harness.server.texts.filter { it.contains("\"open\"") }.all { it.contains("playbackRef") })
        assertEquals(emptyList<String>(), harness.server.violations)
        assertEquals(1, harness.controller.snapshot.currentIndex)
    }

    @Test
    fun noStreamOpensBeforeTheClaimIsGranted() {
        val harness = ControllerHarness(first)
        harness.claims.acquireResponse = { ClaimResponse.Conflict }
        harness.load(1, first)
        repeat(20) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(listOf("blocked"), harness.ownership())
        assertTrue(harness.server.texts.none { it.contains("\"open\"") })
        assertTrue(harness.sinks.isEmpty())
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
        assertTrue(harness.server.texts.none { it.contains("\"open\"") })
    }

    @Test
    fun pauseReleasesTheClaimAndPlayReacquiresAndResumesInPlace() {
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
    fun aRefusedReferenceIsReportedAsExpired() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.listener!!.onClosed(PcmCloseCodes.MEDIA_NOT_FOUND)
        harness.runUntil { harness.state() == NativePlaybackState.ERROR }

        assertTrue(harness.events.any { it is NativePlaybackEvent.ReferenceExpired })
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
}
