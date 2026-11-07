package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException

/** The playback thread's own lifetime: failures stay inside the controller, and a retired one lets go of everything. */
class PlaybackThreadTest {
    private val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
    private val long = SyntheticTrack(tag = 3, frames = 30L * RATE)

    @Test
    fun aDeadOutputStopsPlaybackReadablyAndTheNextPlayOpensANewOne() {
        val harness = ControllerHarness(long)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        val dead = harness.sinks.last()
        dead.dead = true
        harness.step()
        harness.step()

        assertEquals(NativePlaybackState.ERROR, harness.state())
        assertEquals("output_failed", harness.events.filterIsInstance<NativePlaybackEvent.Error>().single().code)
        assertEquals("release", dead.operations.last())
        assertEquals("release:token-1", harness.claims.calls.last())

        assertEquals(CommandResult.ACCEPTED, harness.controller.play(1))
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        assertTrue(harness.sinks.last() !== dead)
        harness.runUntil { harness.sinks.last().writtenFrames > 0 }
    }

    @Test
    fun anOutputAndroidRefusesToCreateFailsReadably() {
        val harness = ControllerHarness(first)
        harness.outputUnavailable = true
        harness.load(1, first)
        repeat(5) { harness.step() }

        assertEquals(NativePlaybackState.ERROR, harness.state())
        assertEquals("output_failed", harness.events.filterIsInstance<NativePlaybackEvent.Error>().single().code)

        harness.outputUnavailable = false
        harness.controller.play(1)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
    }

    @Test
    fun anOutputAtARateThePcmSocketRefusesIsReleasedAndFailsReadably() {
        // Android opens 4 kHz, which the PCM socket's engine refuses.
        val low = SyntheticTrack(tag = 5, frames = 4_000L, sampleRate = 4_000)
        val harness = ControllerHarness(low)
        harness.load(1, low)
        repeat(10) { harness.step() }

        assertEquals(NativePlaybackState.ERROR, harness.state())
        assertEquals("output_failed", harness.events.filterIsInstance<NativePlaybackEvent.Error>().single().code)
        assertEquals(listOf(NativePlaybackController.DEFAULT_RATE, 4_000), harness.sinks.map { it.sampleRate })
        assertTrue(harness.sinks.all { it.operations.last() == "release" })
    }

    @Test
    fun theFailureThatStoppedPlaybackIsReported() {
        val failures = mutableListOf<RuntimeException>()
        val harness = ControllerHarness(long, failures = failures::add)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.sinks.last().dead = true
        harness.step()

        assertEquals(1, failures.size)
        assertTrue(failures.single() is IllegalStateException)
    }

    @Test
    fun aListenWriteThatCannotBeBuiltNeitherEscapesItsExecutorNorHoldsTheClaim() {
        val escaped = mutableListOf<Throwable>()
        val io = Executor { task ->
            try {
                task.run()
            } catch (failure: Throwable) {
                escaped += failure
            }
        }
        val harness = ControllerHarness(first, claimIo = io, listenIo = io)
        // As OkHttp refuses a cookie with non-ASCII text.
        harness.listen.answer = { throw IllegalArgumentException("Unexpected char 0xe9 at 3 in Cookie value") }
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        harness.runUntil { "release:token-1" in harness.claims.calls }

        assertEquals(emptyList<Throwable>(), escaped)
        assertTrue(harness.events.none { it is NativePlaybackEvent.Error })
        assertEquals(listOf(Run(1, 0, first.frames)), harness.sinks.last().runs())
    }

    @Test
    fun aClaimRequestThatCannotBeBuiltFailsReadablyInsideItsExecutor() {
        val escaped = mutableListOf<Throwable>()
        val io = Executor { task ->
            try {
                task.run()
            } catch (failure: Throwable) {
                escaped += failure
            }
        }
        val harness = ControllerHarness(first, claimIo = io)
        harness.claims.acquireResponse = { throw IllegalArgumentException("Unexpected char 0xe9 at 3 in Cookie value") }
        harness.load(1, first)
        repeat(5) { harness.step() }

        assertEquals(emptyList<Throwable>(), escaped)
        assertEquals(NativePlaybackState.ERROR, harness.state())
        assertEquals("ownership_unavailable", harness.events.filterIsInstance<NativePlaybackEvent.Error>().single().code)
        assertTrue(harness.sinks.all { it.writtenFrames == 0 })
    }

    @Test
    fun aSecondShutdownWaitsForTheFirstAndOneAfterRetirementAnswersAtOnce() {
        val listenIo = ManualExecutor()
        val harness = ControllerHarness(long, listenIo = listenIo)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        val finished = mutableListOf<String>()
        harness.controller.shutdown { finished += "update" }
        harness.step()
        harness.controller.shutdown { finished += "origin" }
        harness.step()
        // Both wait for the listen writes still in flight.
        assertEquals(emptyList<String>(), finished)

        harness.settleListening(listenIo)
        assertEquals(listOf("update", "origin"), finished)
        assertEquals(1, harness.claims.calls.count { it.startsWith("release:") })

        harness.controller.shutdown { finished += "destroy" }
        assertEquals(listOf("update", "origin", "destroy"), finished)
    }

    @Test
    fun aShutdownPostedWhileTheFirstFinishesAnswersAfterIt() {
        val finished = mutableListOf<String>()
        lateinit var harness: ControllerHarness
        var finishing = false
        // The claim is given back as the first shutdown finishes; another shutdown arrives meanwhile.
        val claimIo = Executor { task ->
            task.run()
            if (finishing) {
                finishing = false
                harness.controller.shutdown { finished += "origin" }
            }
        }
        harness = ControllerHarness(long, claimIo = claimIo)
        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.controller.shutdown { finished += "update" }
        finishing = true
        harness.runUntil(maxSteps = 100) { finished.size == 2 }

        assertEquals(listOf("update", "origin"), finished)
        assertEquals(1, harness.claims.calls.count { it.startsWith("release:") })
    }

    @Test
    fun aClaimAnswerArrivingAfterShutdownNeverReachesTheRetiredExecutors() {
        val pending = ManualExecutor()
        var retired = false
        val claimIo = Executor { task ->
            if (retired) throw RejectedExecutionException("executor is shut down")
            pending.execute(task)
        }
        val harness = ControllerHarness(first, claimIo = claimIo)
        harness.load(1, first)
        harness.step()
        var finished = false
        harness.controller.shutdown {
            finished = true
            retired = true
        }
        harness.step()
        assertTrue(finished)

        // The acquisition sent before the shutdown answers now, with a claim nobody wants: its own
        // request gives it back, so the server does not hold the old origin's claim for its lease.
        pending.drain()
        harness.step()
        assertEquals(NativePlaybackState.IDLE, harness.state())
        assertEquals(listOf("acquire:null", "release:token-1"), harness.claims.calls)

        // A media-session command waiting for the retired controller is answered, never left hanging.
        var answered = false
        harness.controller.afterPendingCommands { answered = true }
        assertTrue(answered)
    }

    @Test
    fun aRetiredControllerReleasesItsOutput() {
        val harness = ControllerHarness(first)
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        harness.controller.shutdown()
        harness.step()

        assertTrue(harness.sinks.all { it.operations.last() == "release" })
    }

    @Test
    fun anIdleThreadSleepsUntilItsNextDeadlineInsteadOfPolling() {
        val harness = ControllerHarness(long)
        assertEquals(Long.MAX_VALUE, harness.controller.runOnce())

        harness.controller.warmConnections()
        assertEquals(NativePlaybackController.KEEP_WARM_MS, harness.controller.runOnce())

        harness.load(1, long)
        harness.runUntil { harness.state() == NativePlaybackState.PLAYING }
        // Feeding the output: a render pass every few milliseconds at most.
        assertTrue(harness.controller.runOnce() <= NativePlaybackController.RENDER_WAIT_MS)

        harness.controller.pause()
        repeat(3) { harness.step() }
        assertEquals(listOf("owned", "released"), harness.ownership())
        // Paused and released: only the next keep-warm read is due, counted from when this client last owned playback.
        val wait = harness.controller.runOnce()
        assertTrue("waits $wait ms", wait in NativePlaybackController.KEEP_WARM_MS - harness.now..NativePlaybackController.KEEP_WARM_MS)
    }

    @Test
    fun anOwnerWaitingForItsListenWritesStillSleepsAfterOwningPlaybackForLong() {
        val listenIo = ManualExecutor()
        val harness = ControllerHarness(first, listenIo = listenIo)
        harness.controller.warmConnections()
        harness.load(1, first)
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        // The claim outlasts the keep-warm interval while the listen writes of the end are in flight.
        repeat((NativePlaybackController.KEEP_WARM_MS / 5_000 + 2).toInt()) { harness.step(5_000) }
        assertEquals(listOf("owned"), harness.ownership())

        // Nothing is loaded, so the thread waits for the next heartbeat instead of spinning.
        assertTrue(harness.controller.runOnce() > 1_000)
    }

    @Test
    fun keepingConnectionsWarmEndsAfterAnIdleHalfHour() {
        val harness = ControllerHarness(first)
        harness.controller.warmConnections()
        harness.step()
        harness.now += NativePlaybackController.KEEP_WARM_MS
        harness.step()
        assertEquals(2, harness.warms.size)

        harness.now += NativePlaybackController.KEEP_WARM_FOR_MS
        harness.step()
        harness.now += NativePlaybackController.KEEP_WARM_MS
        harness.step()
        assertEquals(2, harness.warms.size)
        assertEquals(Long.MAX_VALUE, harness.controller.runOnce())
    }

    @Test
    fun aShutdownKeepsThePositionTheRestoredQueueResumesFrom() {
        val harness = ControllerHarness(long)
        harness.load(1, long)
        harness.runUntil { harness.controller.snapshot.positionMs >= 2_000 }
        val heard = harness.controller.snapshot.positionMs
        harness.controller.shutdown()
        harness.step()

        val stopped = harness.controller.snapshot
        assertEquals(NativePlaybackState.IDLE, stopped.state)
        assertTrue("position $heard became ${stopped.positionMs}", stopped.positionMs in heard..heard + 1_000)
        assertEquals(stopped.positionMs, harness.events.last { it is NativePlaybackEvent.State }.snapshot.positionMs)
    }
}
