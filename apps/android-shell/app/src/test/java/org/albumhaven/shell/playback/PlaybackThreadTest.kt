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

        // The acquisition sent before the shutdown answers now, with a claim nobody wants.
        pending.drain()
        harness.step()
        assertEquals(NativePlaybackState.IDLE, harness.state())
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
        // Paused and released: only the next keep-warm read is due.
        assertEquals(NativePlaybackController.KEEP_WARM_MS - harness.now, harness.controller.runOnce())
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
