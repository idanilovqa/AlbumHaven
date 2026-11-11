package org.albumhaven.shell.playback

import org.albumhaven.playback.engine.RATE
import org.albumhaven.playback.engine.SyntheticTrack

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor

class AudioFocusPolicyTest {
    /** What the platform answers a focus request; a call refuses it. */
    private var granted = true
    private var requests = 0
    private var abandons = 0
    private val policy = AudioFocusPolicy({
        requests++
        granted
    }) { abandons++ }

    /** A state the controller reports: a stop is told to the gate first, on the playback thread. */
    private fun report(state: NativePlaybackState): List<FocusEffect> {
        if (!state.wanted) policy.stopped(state)
        return policy.onState(state)
    }

    /** A start through the gate, as the controller makes every start. */
    private fun startPlaying() {
        assertTrue(policy.mayStart())
        report(NativePlaybackState.PLAYING)
    }

    @Test
    fun playbackRequestsFocusOnceAndWatchesForNoisyOutput() {
        assertTrue(policy.mayStart())
        assertEquals(listOf(FocusEffect.WatchNoisy(true)), report(NativePlaybackState.LOADING))
        assertEquals(emptyList<FocusEffect>(), report(NativePlaybackState.PLAYING))
        assertEquals(1, requests)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.PAUSED))
        assertEquals(1, abandons)
    }

    @Test
    fun focusLostAfterTheGatePausesWithoutAskingForItAgain() {
        assertTrue(policy.mayStart())
        report(NativePlaybackState.BUFFERING)
        // Another music app takes focus while the start is buffering.
        assertEquals(listOf(FocusEffect.Pause), policy.onFocusChange(FocusChange.LOSS))
        assertEquals(1, abandons)
        // A state reported before the pause lands pauses again instead of taking focus back.
        assertEquals(listOf(FocusEffect.Pause), report(NativePlaybackState.PLAYING))
        assertEquals(1, requests)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.PAUSED))
        assertEquals(1, abandons)
    }

    @Test
    fun aPauseAndPlayReportedLateKeepTheFocusThePlayTook() {
        startPlaying()
        // The playback thread pauses and plays again before the main thread hears of either.
        policy.stopped(NativePlaybackState.PAUSED)
        assertTrue(policy.mayStart())
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onState(NativePlaybackState.PAUSED))
        assertEquals(listOf(FocusEffect.WatchNoisy(true)), policy.onState(NativePlaybackState.LOADING))
        assertEquals(2, requests)
        assertEquals(1, abandons)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.PAUSED))
        assertEquals(2, abandons)
    }

    @Test
    fun aPermanentLossPausesAndNeverResumes() {
        startPlaying()
        assertEquals(listOf(FocusEffect.Pause), policy.onFocusChange(FocusChange.LOSS))
        assertEquals(1, abandons)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.PAUSED))
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(1, abandons)
    }

    @Test
    fun aTransientLossSuchAsACallPausesAndResumesOnlyWhenFocusReturns() {
        startPlaying()
        assertEquals(listOf(FocusEffect.Pause), policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        // The request is kept so the platform can give focus back, and output stays watched meanwhile.
        assertEquals(emptyList<FocusEffect>(), report(NativePlaybackState.PAUSED))
        assertEquals(0, abandons)
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(emptyList<FocusEffect>(), report(NativePlaybackState.LOADING))
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.PAUSED))
        assertEquals(1, abandons)
    }

    @Test
    fun headphonesRemovedDuringACallCancelTheResume() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onBecomingNoisy())
        assertEquals(1, abandons)
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    @Test
    fun aStartDuringACallWaitsForFocusInsteadOfPlayingOverIt() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        // As Media3's player does, a play while another app holds focus waits for it to come back.
        assertEquals(listOf(FocusEffect.Pause), report(NativePlaybackState.LOADING))
        assertEquals(emptyList<FocusEffect>(), report(NativePlaybackState.PAUSED))
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(emptyList<FocusEffect>(), report(NativePlaybackState.LOADING))
        assertEquals(0, abandons)
    }

    @Test
    fun aStartDuringACallFromAPausedPlayerAlsoWaits() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        policy.onFocusChange(FocusChange.GAIN)
        report(NativePlaybackState.LOADING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        assertEquals(listOf(FocusEffect.Pause), report(NativePlaybackState.BUFFERING))
    }

    @Test
    fun aStopDuringTheInterruptionAbandonsFocus() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), report(NativePlaybackState.IDLE))
        assertEquals(1, abandons)
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    @Test
    fun aMayDuckLossIsDuckedByThePlatform() {
        startPlaying()
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.LOSS_TRANSIENT_CAN_DUCK))
    }

    @Test
    fun aPlayDuringACallIsHeldBackUntilFocusReturns() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        policy.onFocusChange(FocusChange.GAIN)
        report(NativePlaybackState.LOADING)
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)

        assertFalse(policy.mayStart())
        assertEquals(listOf(FocusEffect.Resume), policy.onFocusChange(FocusChange.GAIN))
        assertTrue(policy.mayStart())
    }

    @Test
    fun aStartTheCallRefusesFocusForIsNotHeld() {
        granted = false
        assertFalse(policy.mayStart())
        // Nothing is held, so the call's end resumes nothing; a later start asks again.
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
        granted = true
        assertTrue(policy.mayStart())
        assertEquals(listOf(FocusEffect.WatchNoisy(true)), report(NativePlaybackState.LOADING))
    }

    @Test
    fun aPauseOrStopDuringACallDropsTheHeldStart() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        assertFalse(policy.mayStart())
        policy.dropHeldStart()
        // Nothing resumes, so output stops being watched and focus is given up.
        assertEquals(listOf(FocusEffect.WatchNoisy(false)), policy.onFocusChange(FocusChange.GAIN))
        assertEquals(1, abandons)
    }

    @Test
    fun aSecondCallAfterAPauseDuringTheFirstFindsNoFocusHeld() {
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
        policy.dropHeldStart()
        policy.onFocusChange(FocusChange.GAIN)
        // The second call: a play during it asks for focus, is refused and holds nothing.
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        granted = false
        assertFalse(policy.mayStart())
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
    }

    private val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
    private val second = SyntheticTrack(tag = 2, frames = 2L * RATE)

    /** The controller with [policy] as its start gate; every state and effect is applied as the service applies them. */
    private inner class Focused(
        vararg tracks: SyntheticTrack,
        claimIo: Executor = Executor { it.run() },
        realTime: Boolean = false,
    ) {
        val harness = ControllerHarness(*tracks, realTime = realTime, claimIo = claimIo, startGate = policy)
        val controller get() = harness.controller
        private var seen = 0

        /** Whether the becoming-noisy receiver is registered, so an unplug is seen at all. */
        private var watchingNoisy = false

        fun apply(effects: List<FocusEffect>): Unit = effects.forEach { effect ->
            when (effect) {
                FocusEffect.Pause -> controller.interrupt()
                FocusEffect.PauseForUnplug -> controller.pause(CommandSource.SYSTEM)
                FocusEffect.Resume -> controller.resumeHeldStart()
                is FocusEffect.WatchNoisy -> watchingNoisy = effect.enabled
            }
        }

        /** Headphones unplugged or Bluetooth audio dropped. */
        fun unplug() {
            if (watchingNoisy) apply(policy.onBecomingNoisy())
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
        startPlaying()
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        report(NativePlaybackState.PAUSED)
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

    @Test
    fun aPlayDuringACallFromAnAlreadyPausedPlayerNeitherClaimsNorAnnouncesPlayback() {
        val focused = Focused(first)
        val harness = focused.harness
        harness.load(1, first, autoplay = false)
        focused.step()
        // The player was paused and holds no focus, so it never hears the call; the call refuses focus.
        granted = false
        assertEquals(CommandResult.ACCEPTED, ControllerPlaybackPort({ harness.controller }).play(1))
        repeat(5) { focused.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertTrue(harness.events.none { it.snapshot.state == NativePlaybackState.LOADING })
        assertEquals(emptyList<String>(), harness.claims.calls)
        assertTrue(harness.listen.posts.isEmpty())
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })

        // After the call a play starts normally.
        granted = true
        harness.controller.play(1)
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertEquals(listOf("acquire:null"), harness.claims.calls)
        assertEquals(ListenEffect.NOW_PLAYING, harness.listen.posts.first().first)
    }

    @Test
    fun headphonesRemovedDuringACallKeepPlaybackFromResumingOnTheSpeaker() {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        val acquires = focused.acquires()
        val written = focused.written()

        focused.unplug()
        assertEquals(emptyList<FocusEffect>(), policy.onFocusChange(FocusChange.GAIN))
        repeat(20) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertEquals(written, focused.written())
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

    private fun assertNotResumedAfterTheCall(onGain: List<FocusEffect>, abandonedOnGain: Int, end: (NativePlaybackController) -> Unit) {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        // A play held for the call, then the user's pause or stop on the already paused controller.
        harness.controller.play(1, CommandSource.SYSTEM)
        focused.step()
        end(harness.controller)
        repeat(5) { focused.step() }
        val acquires = focused.acquires()
        val abandoned = abandons

        // Nothing resumes.
        assertEquals(onGain, policy.onFocusChange(FocusChange.GAIN))
        assertEquals(abandoned + abandonedOnGain, abandons)
        repeat(20) { focused.step() }
        assertTrue(harness.state() == NativePlaybackState.PAUSED || harness.state() == NativePlaybackState.IDLE)
        assertEquals(acquires, focused.acquires())
    }

    @Test
    fun aPauseDuringACallIsNotUndoneWhenFocusReturns() =
        // The already paused controller reports nothing, so the call's end gives focus up.
        assertNotResumedAfterTheCall(listOf(FocusEffect.WatchNoisy(false)), abandonedOnGain = 1) { it.pause(CommandSource.SYSTEM) }

    @Test
    fun headphonesRemovedDuringASecondCallAfterAPauseKeepPlaybackFromResumingOnTheSpeaker() {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        harness.controller.pause(CommandSource.SYSTEM)
        repeat(5) { focused.step() }
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        val acquires = focused.acquires()
        val written = focused.written()

        // A second call; the user presses play from the notification, then unplugs headphones.
        focused.apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        granted = false
        harness.controller.play(1, CommandSource.SYSTEM)
        repeat(5) { focused.step() }
        focused.unplug()
        granted = true
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        repeat(20) { focused.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertEquals(written, focused.written())
    }

    @Test
    fun aStopDuringACallIsNotUndoneWhenFocusReturns() = assertNotResumedAfterTheCall(emptyList(), abandonedOnGain = 0) { it.stop() }

    @Test
    fun aBlockedClaimAfterASkipWhileLoadingGivesFocusUpSoASecondCallCannotResumeOnTheSpeaker() {
        val claimsAnswered = ManualExecutor()
        val focused = Focused(first, second, claimIo = claimsAnswered)
        val harness = focused.harness
        // The socket is still connecting and the claim unanswered, so the player stays loading.
        harness.openOnConnect = false
        harness.load(1, first, second)
        repeat(5) { focused.step() }
        assertEquals(NativePlaybackState.LOADING, harness.state())
        // Next while loading reports nothing new; then another client blocks the claim.
        harness.controller.next(1, CommandSource.SYSTEM)
        repeat(5) { focused.step() }
        assertEquals(NativePlaybackState.LOADING, harness.state())
        assertEquals("Signal 2", focused.currentTitle())
        harness.claims.acquireResponse = { ClaimResponse.Conflict }
        claimsAnswered.drain()
        repeat(5) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(1, abandons)

        // A call; the user presses play from the notification, then unplugs headphones.
        harness.claims.acquireResponse = { ClaimResponse.Granted("token") }
        val acquires = focused.acquires()
        focused.apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        granted = false
        harness.controller.play(1, CommandSource.SYSTEM)
        repeat(5) { focused.step() }
        focused.unplug()
        granted = true
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        repeat(20) {
            claimsAnswered.drain()
            focused.step()
        }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })
    }

    @Test
    fun aFastPausePlayPausePlayEndsPlaying() {
        val focused = Focused(first)
        val harness = focused.harness
        harness.load(1, first)
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING && focused.written() > 0 }
        // All four reach the playback thread before the main thread hears of any of their states.
        harness.controller.pause()
        harness.controller.play(1)
        harness.controller.pause()
        harness.controller.play(1)
        harness.step()
        val written = focused.written()
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING && focused.written() > written }
        repeat(20) { focused.step() }

        assertEquals(NativePlaybackState.PLAYING, harness.state())
        assertEquals(3, requests)
        assertEquals(2, abandons)
    }

    @Test
    fun becomingNoisyPausesOnlyActivePlayback() {
        assertEquals(emptyList<FocusEffect>(), policy.onBecomingNoisy())
        startPlaying()
        assertEquals(listOf(FocusEffect.PauseForUnplug), policy.onBecomingNoisy())
    }

    @Test
    fun holdsFocusOnlyWhileTheRequestIsHeldAndHeard() {
        assertFalse(policy.holdsFocus())
        startPlaying()
        assertTrue(policy.holdsFocus())
        policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        assertFalse(policy.holdsFocus())
        policy.onFocusChange(FocusChange.GAIN)
        assertTrue(policy.holdsFocus())
        policy.onFocusChange(FocusChange.LOSS)
        assertFalse(policy.holdsFocus())
    }

    /** The first track plays and is heard. */
    private fun Focused.playing() {
        harness.load(1, first)
        runUntil { harness.state() == NativePlaybackState.PLAYING && written() > 0 }
    }

    @Test
    fun unpluggingHeadphonesPausesPlaybackThatHoldsFocus() {
        val focused = Focused(first)
        val harness = focused.harness
        focused.playing()
        focused.unplug()
        focused.runUntil { harness.state() == NativePlaybackState.PAUSED }
        val written = focused.written()
        repeat(20) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(written, focused.written())
        assertEquals(1, abandons)
    }

    @Test
    fun aStaleFocusPauseAfterAStartThatTookFocusBackLeavesItPlaying() {
        val focused = Focused(first)
        val harness = focused.harness
        focused.playing()
        // The playback thread pauses while the main thread still holds an older playing report.
        harness.controller.pause()
        harness.step()
        val stale = policy.onState(NativePlaybackState.PLAYING)
        assertEquals(listOf(FocusEffect.Pause), stale)
        // The user's play takes focus back before the pause that report asked for runs.
        harness.controller.play(1)
        harness.step()
        focused.apply(stale)
        val written = focused.written()
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING && focused.written() > written }
        repeat(20) { focused.step() }

        assertEquals(NativePlaybackState.PLAYING, harness.state())
        assertEquals(2, requests)
    }

    @Test
    fun aPlayQueuedBeforeAPermanentLossPausesWhenItTookNoFocus() {
        val focused = Focused(first)
        val harness = focused.harness
        focused.playing()
        // Another music app takes focus; a play already queued finds the player playing and asks nothing.
        val loss = policy.onFocusChange(FocusChange.LOSS)
        harness.controller.play(1)
        focused.apply(loss)
        focused.runUntil { harness.state() == NativePlaybackState.PAUSED }
        val written = focused.written()
        repeat(20) { focused.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(written, focused.written())
        assertEquals(1, requests)
        assertEquals(1, abandons)
    }

    private fun assertPauseAndPlayQueuedBeforeAPermanentLoss(regained: Boolean) {
        val focused = Focused(first)
        val harness = focused.harness
        focused.playing()
        val loss = policy.onFocusChange(FocusChange.LOSS)
        harness.controller.pause()
        harness.controller.play(1)
        granted = regained
        focused.apply(loss)
        val written = focused.written()
        val expected = if (regained) NativePlaybackState.PLAYING else NativePlaybackState.PAUSED
        focused.runUntil { harness.state() == expected && (!regained || focused.written() > written) }
        repeat(20) { focused.step() }

        assertEquals(expected, harness.state())
        assertEquals(regained, policy.holdsFocus())
    }

    @Test
    fun aPauseAndPlayQueuedBeforeAPermanentLossEndPausedWhenThePlayIsRefusedFocus() =
        assertPauseAndPlayQueuedBeforeAPermanentLoss(regained = false)

    @Test
    fun aPauseAndPlayQueuedBeforeAPermanentLossEndPlayingWhenThePlayRegainsFocus() =
        assertPauseAndPlayQueuedBeforeAPermanentLoss(regained = true)

    private val long = SyntheticTrack(tag = 3, frames = 60L * RATE)

    /** A long track plays in real time, so a claim renewal comes while it is heard. */
    private fun Focused.playingLong() {
        harness.load(1, long)
        runUntil { harness.state() == NativePlaybackState.PLAYING && written() > 0 }
    }

    @Test
    fun aShortInterruptionWhosePauseRanBeforeFocusReturnedResumes() {
        val focused = Focused(long, realTime = true)
        val harness = focused.harness
        focused.playingLong()
        // Focus goes and comes back while the main thread lags: the pause runs, its report waits.
        focused.apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        harness.step()
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        val written = focused.written()
        focused.runUntil { harness.state() == NativePlaybackState.PLAYING && focused.written() > written }
        assertEquals(0, abandons)
    }

    @Test
    fun aShortInterruptionWhosePauseHadNotRunKeepsPlayingAndALaterLostClaimIsNeverRestarted() {
        val focused = Focused(long, realTime = true)
        val harness = focused.harness
        focused.playingLong()
        // Focus goes and comes back before the playback thread runs the pause.
        focused.apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        val written = focused.written()
        repeat(20) { focused.step() }
        assertEquals(NativePlaybackState.PLAYING, harness.state())
        assertTrue(focused.written() > written)

        // Another device takes playback over; focus is given up and nothing restarts it.
        harness.claims.renewResponse = { ClaimResponse.Conflict }
        focused.runUntil { harness.ownership().contains("lost") }
        repeat(5) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(1, abandons)
        val acquires = focused.acquires()
        val silent = focused.written()
        focused.apply(policy.onFocusChange(FocusChange.LOSS_TRANSIENT))
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        repeat(20) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertEquals(silent, focused.written())
    }

    @Test
    fun aClaimLostDuringACallIsNotRestartedWhenTheCallEnds() {
        val focused = Focused(long, realTime = true)
        val harness = focused.harness
        focused.playingLong()
        // The call's pause is still queued when another device takes playback over.
        val call = policy.onFocusChange(FocusChange.LOSS_TRANSIENT)
        harness.claims.renewResponse = { ClaimResponse.Conflict }
        harness.runUntil { harness.ownership().contains("lost") }
        focused.apply(call)
        repeat(5) { focused.step() }
        val acquires = focused.acquires()
        val silent = focused.written()

        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        repeat(20) { focused.step() }
        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        assertEquals(silent, focused.written())
        assertEquals(1, abandons)
    }

    @Test
    fun aPauseQueuedBeforeTheCallEndsIsNotUndoneByTheResume() {
        val focused = Focused(first, second)
        val harness = focused.harness
        focused.interruptedByACall()
        harness.controller.play(1, CommandSource.SYSTEM)
        repeat(5) { focused.step() }
        // The user pauses, and the call ends before the playback thread runs that pause.
        harness.controller.pause(CommandSource.SYSTEM)
        focused.apply(policy.onFocusChange(FocusChange.GAIN))
        val acquires = focused.acquires()
        repeat(20) { focused.step() }

        assertEquals(NativePlaybackState.PAUSED, harness.state())
        assertEquals(acquires, focused.acquires())
        // Nothing waits for focus any more, so it is given up.
        assertEquals(1, abandons)
        assertFalse(policy.holdsFocus())
    }
}
