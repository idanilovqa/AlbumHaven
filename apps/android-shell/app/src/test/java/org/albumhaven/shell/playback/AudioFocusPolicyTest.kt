package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
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
    fun aStartDuringTheInterruptionCancelsTheResume() {
        policy.onState(NativePlaybackState.PLAYING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        policy.onState(NativePlaybackState.PAUSED)
        policy.onState(NativePlaybackState.LOADING)
        policy.onState(NativePlaybackState.PAUSED)
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
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
    fun becomingNoisyPausesOnlyActivePlayback() {
        assertEquals(emptyList<FocusEffect>(), policy.onBecomingNoisy())
        policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Pause), policy.onBecomingNoisy())
    }
}
