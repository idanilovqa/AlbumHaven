package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioFocusPolicyTest {
    private val policy = AudioFocusPolicy()

    @Test
    fun playbackRequestsFocusOnceAndWatchesForNoisyOutput() {
        assertEquals(listOf(FocusEffect.Request, FocusEffect.WatchNoisy(true)), policy.onState(NativePlaybackState.LOADING))
        assertEquals(emptyList<FocusEffect>(), policy.onRequestResult(granted = true))
        assertEquals(emptyList<FocusEffect>(), policy.onState(NativePlaybackState.PLAYING))
        assertEquals(listOf(FocusEffect.WatchNoisy(false), FocusEffect.Abandon), policy.onState(NativePlaybackState.PAUSED))
    }

    @Test
    fun aRefusedRequestPauses() {
        policy.onState(NativePlaybackState.LOADING)
        assertEquals(listOf(FocusEffect.Pause), policy.onRequestResult(granted = false))
        // The pause it causes has no focus left to abandon.
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onState(NativePlaybackState.PAUSED))
    }

    @Test
    fun aPermanentLossPausesAndNeverResumes() {
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Abandon, FocusEffect.Pause), policy.onFocusChange(FocusChange.LOSS))
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onState(NativePlaybackState.PAUSED))
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    @Test
    fun aTransientLossSuchAsACallPausesAndResumesOnlyWhenFocusReturns() {
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Pause), policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        // The request is kept so the platform can give focus back.
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onState(NativePlaybackState.PAUSED))
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(listOf(FocusEffect.WatchNoisy(true)), policy.onState(NativePlaybackState.LOADING))
    }

    @Test
    fun aStartDuringACallWaitsForFocusInsteadOfPlayingOverIt() {
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        // As Media3's player does, a play while another app holds focus waits for it to come back.
        assertEquals(listOf(FocusEffect.Pause), policy.onState(NativePlaybackState.LOADING))
        assertEquals(emptyList<FocusEffect>(), policy.onState(NativePlaybackState.PAUSED))
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(listOf(FocusEffect.WatchNoisy(true)), policy.onState(NativePlaybackState.LOADING))
    }

    @Test
    fun aStartDuringACallFromAPausedPlayerAlsoWaits() {
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        policy.onFocusChange(FocusChange.GAIN)
        policy.onState(NativePlaybackState.LOADING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        assertEquals(listOf(FocusEffect.Pause), policy.onState(NativePlaybackState.BUFFERING))
    }

    @Test
    fun aStopDuringTheInterruptionAbandonsFocus() {
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        assertEquals(listOf(FocusEffect.Abandon), policy.onState(NativePlaybackState.IDLE))
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    @Test
    fun aMayDuckLossIsDuckedByThePlatform() {
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.LOSS_TRANSIENT_CAN_DUCK))
    }

    @Test
    fun aPlayDuringACallIsHeldBackUntilFocusReturns() {
        assertTrue(policy.mayStart())
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        policy.onFocusChange(FocusChange.GAIN)
        policy.onState(NativePlaybackState.LOADING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)

        assertFalse(policy.mayStart())
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertTrue(policy.mayStart())
    }

    @Test
    fun aPauseOrStopDuringACallDropsTheHeldStart() {
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        assertFalse(policy.mayStart())
        policy.dropHeldStart()
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    private val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
    private val second = SyntheticTrack(tag = 2, frames = 2L * RATE)

    /** The controller with [policy] as its start gate; every state and effect is applied as the service applies them. */
    private inner class Focused(vararg tracks: SyntheticTrack) {
        val harness = ControllerHarness(*tracks, startGate = policy)
        val controller get() = harness.controller
        private var seen = 0

        fun apply(effects: List<FocusEffect>): Unit = effects.forEach { effect ->
            when (effect) {
                FocusEffect.Request -> apply(policy.onRequestResult(granted = true))
                FocusEffect.Pause -> controller.interrupt()
                FocusEffect.Resume -> controller.play(controller.snapshot.queueRevision, CommandSource.SYSTEM)
                else -> Unit
            }
        }

        fun step() {
            harness.step()
            val fresh = harness.events.drop(seen)
            seen = harness.events.size
            fresh.filterIsInstance<NativePlaybackEvent.State>().forEach { apply(policy.onState(it.snapshot.state)) }
        }

        fun runUntil(done: () -> Boolean) {
            repeat(100_000) {
                if (done()) return
                step()
            }
            error("playback did not reach the expected state; last ${harness.events.takeLast(3)}")
        }

        /** The first track plays, then a call takes focus and pauses it. */
        fun interruptedByACall() {
            harness.controller.loadQueue(QueueLoad(1, listOf(harness.item(first), harness.item(second)), 0, 0, null, autoplay = true))
            runUntil { harness.state() == NativePlaybackState.PLAYING && written() > 0 }
            apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
            runUntil { harness.state() == NativePlaybackState.PAUSED }
            repeat(5) { step() }
        }

        fun written() = harness.sinks.sumOf { it.writtenFrames }

        fun currentTitle() = controller.snapshot.let { it.items[it.currentIndex!!].title }

        fun nowPlaying() = harness.listen.posts.count { it.first == ListenEffect.NOW_PLAYING }

        fun acquires() = harness.claims.calls.count { it.startsWith("acquire") }
    }

    @Test
    fun aPlayDuringACallNeitherClaimsNorAnnouncesPlaybackUntilFocusReturns() {
        val focused = Focused(first)
        val harness = focused.harness
        harness.load(1, first, autoplay = false)
        focused.step()
        // A call takes focus from a player that held it, and the user (or the web) presses play.
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        assertEquals(CommandResult.ACCEPTED, ControllerPlaybackPort({ harness.controller }).play(1))
        repeat(5) { focused.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertTrue(harness.events.none { it.snapshot.state == NativePlaybackState.LOADING })
        assertEquals(emptyList<String>(), harness.claims.calls)
        assertTrue(harness.listen.posts.isEmpty())
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })

        // The call ends: the remembered play starts now, through the policy's resume.
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(listOf("acquire:null"), harness.claims.calls)
        assertEquals(ListenEffect.NOW_PLAYING, harness.listen.posts.first().first)
    }

    private fun assertHeldDuringTheCallThenStarted(start: (Focused) -> Unit) {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        val acquires = focused.acquires()
        val nowPlaying = focused.nowPlaying()
        val written = focused.written()

        start(focused)
        repeat(20) { focused.step() }
        // The new track is current but silent: nothing claims, announces or plays it over the call.
        assertEquals("Signal 2", focused.currentTitle())
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertEquals(nowPlaying, focused.nowPlaying())
        assertEquals(written, focused.written())

        // The call ends and the new track starts.
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING && focused.written() > written }
        assertEquals("Signal 2", focused.currentTitle())
        assertEquals(acquires + 1, focused.acquires())
        assertEquals(nowPlaying + 1, focused.nowPlaying())
    }

    @Test
    fun anAutoplayingLoadDuringACallWaitsForFocus() = assertHeldDuringTheCallThenStarted { focused ->
        // The web's normal start of another track, as a resumed queue also loads.
        val item = focused.harness.item(second)
        focused.controller.loadQueue(QueueLoad(2, listOf(item), 0, 0, null, autoplay = true))
    }

    @Test
    fun aNotificationNextDuringACallWaitsForFocus() = assertHeldDuringTheCallThenStarted { focused ->
        focused.controller.next(1, CommandSource.SYSTEM)
    }

    private fun assertNotResumedAfterTheCall(end: (NativePlaybackController) -> Unit) {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        // A play held for the call, then the user's pause or stop on the already paused controller.
        harness.controller.play(1, CommandSource.SYSTEM)
        focused.step()
        end(harness.controller)
        repeat(5) { focused.step() }
        val acquires = focused.acquires()

        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
        repeat(20) { focused.step() }
        assertTrue(harness.state() == NativePlaybackState.PAUSED || harness.state() == NativePlaybackState.IDLE)
        assertEquals(acquires, focused.acquires())
    }

    @Test
    fun aPauseDuringACallIsNotUndoneWhenFocusReturns() = assertNotResumedAfterTheCall { it.pause(CommandSource.SYSTEM) }

    @Test
    fun aStopDuringACallIsNotUndoneWhenFocusReturns() = assertNotResumedAfterTheCall { it.stop() }

    @Test
    fun becomingNoisyPausesOnlyActivePlayback() {
        assertEquals(emptyList<FocusEffect>(), policy.onBecomingNoisy())
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Pause), policy.onBecomingNoisy())
    }
}
