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
        assertTrue(policy.mayPlay())
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        policy.onFocusChange(FocusChange.GAIN)
        policy.onState(NativePlaybackState.LOADING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)

        assertFalse(policy.mayPlay())
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertTrue(policy.mayPlay())
    }

    @Test
    fun aPlayDuringACallNeitherClaimsNorAnnouncesPlaybackUntilFocusReturns() {
        val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
        val harness = ControllerHarness(first)
        val port = ControllerPlaybackPort({ harness.controller }, policy::mayPlay)
        harness.load(1, first, autoplay = false)
        harness.step()
        // A call takes focus from a player that held it, and the user (or the web) presses play.
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        assertEquals(CommandResult.ACCEPTED, port.play(1))
        repeat(5) { harness.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(emptyList<String>(), harness.claims.calls)
        assertTrue(harness.listen.posts.isEmpty())
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })

        // The call ends: the remembered play starts now, as the service applies the policy's resume.
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        harness.controller.play(harness.controller.snapshot.queueRevision, CommandSource.SYSTEM)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(listOf("acquire:null"), harness.claims.calls)
        assertEquals(ListenEffect.NOW_PLAYING, harness.listen.posts.first().first)
    }

    @Test
    fun becomingNoisyPausesOnlyActivePlayback() {
        assertEquals(emptyList<FocusEffect>(), policy.onBecomingNoisy())
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Pause), policy.onBecomingNoisy())
    }
}
