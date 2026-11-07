package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StartTimingTest {
    private val first = SyntheticTrack(tag = 1, frames = 3L * RATE)
    private val second = SyntheticTrack(tag = 2, frames = 3L * RATE)

    private val keys = listOf(
        "start", "kind", "source", "index", "outcome",
        "ref", "gate", "claim", "socket", "open", "metadata", "first_pcm", "first_write", "audible",
        "socket_reused", "reopens", "total",
    )

    /** The line's fields in order; it must carry exactly the fixed keys, each once. */
    private fun fields(line: String): Map<String, String> {
        val pairs = line.split(' ').map { field ->
            val (key, value) = field.split('=', limit = 2)
            key to value
        }
        assertEquals(keys, pairs.map { it.first })
        return pairs.toMap()
    }

    private fun ms(fields: Map<String, String>, key: String) = checkNotNull(fields[key]?.toLongOrNull()) { "$key is ${fields[key]}" }

    /** Nothing in the line can name a track, a file or a credential. */
    private fun assertPathFree(harness: ControllerHarness, line: String, vararg tracks: SyntheticTrack) {
        val identifying = tracks.flatMap { track ->
            val item = harness.item(track)
            listOf(item.playbackRef, item.title, item.artist, item.album, item.listenKey)
        } + listOf(TEST_CLIENT_ID, TEST_DEVICE_ID, "token-", "/")
        identifying.forEach { assertFalse("line names $it: $line", line.contains(it)) }
    }

    @Test
    fun aSelectedTrackReportsOneLineWithEveryStageInOrderOnceItIsHeard() {
        val claimIo = ManualExecutor()
        val harness = ControllerHarness(first, claimIo = claimIo, outputModel = true)
        harness.load(1, first)
        repeat(20) { harness.step() }
        // Nothing is heard while the claim is requested, so nothing is reported yet.
        assertEquals(emptyList<String>(), harness.timings)

        claimIo.drain()
        harness.runUntil { harness.timings.isNotEmpty() }
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }

        val line = harness.timings.single()
        val timing = fields(line)
        assertEquals("1", timing["start"])
        assertEquals("select", timing["kind"])
        assertEquals("web", timing["source"])
        assertEquals("0", timing["index"])
        assertEquals("audible", timing["outcome"])
        assertEquals("-", timing["ref"])
        assertEquals("false", timing["socket_reused"])
        // The first open guesses CD rate; the refusal reopens the track at its own rate.
        assertEquals("1", timing["reopens"])
        val chain = listOf("gate", "open", "metadata", "first_pcm", "first_write", "audible").map { ms(timing, it) }
        assertEquals(chain.sorted(), chain)
        assertTrue(chain.first() >= 0)
        // The claim answered after the twenty steps it was held, and nothing was written before it.
        assertTrue(ms(timing, "claim") >= 100)
        assertTrue(ms(timing, "first_write") >= ms(timing, "claim"))
        assertTrue(ms(timing, "socket") <= ms(timing, "open"))
        // The output plays what was written only on its next period.
        assertTrue(ms(timing, "audible") > ms(timing, "first_write"))
        assertEquals(ms(timing, "audible"), ms(timing, "total"))
        assertPathFree(harness, line, first)
    }

    @Test
    fun aSkipBeforeTheFirstSoundSupersedesItsStartAndIsTimedOnItsOwn() {
        val claimIo = ManualExecutor()
        val harness = ControllerHarness(first, second, claimIo = claimIo)
        harness.load(1, first, second)
        repeat(4) { harness.step() }
        assertEquals(CommandResult.ACCEPTED, harness.controller.next(1))
        harness.step()

        assertEquals(1, harness.timings.size)
        val superseded = fields(harness.timings[0])
        assertEquals("superseded", superseded["outcome"])
        assertEquals("-", superseded["claim"])
        assertEquals("-", superseded["audible"])

        claimIo.drain()
        harness.runUntil { harness.timings.size == 2 }
        val skipped = fields(harness.timings[1])
        assertEquals("2", skipped["start"])
        assertEquals("next", skipped["kind"])
        assertEquals("1", skipped["index"])
        assertEquals("audible", skipped["outcome"])
        // The skip found the socket its predecessor opened.
        assertEquals("true", skipped["socket_reused"])
        assertEquals(skipped["gate"], skipped["socket"])
        harness.runUntil { harness.state() == NativePlaybackState.ENDED }
        assertEquals(2, harness.timings.size)
        harness.timings.forEach { assertPathFree(harness, it, first, second) }
    }

    @Test
    fun aPauseBeforeTheFirstSoundEndsTheStartOnceAndAResumeIsTimedFromTheQueuedOutput() {
        val claimIo = ManualExecutor()
        val harness = ControllerHarness(first, claimIo = claimIo)
        harness.load(1, first)
        repeat(4) { harness.step() }
        harness.controller.pause()
        repeat(4) { harness.step() }
        assertEquals(listOf("paused"), harness.timings.map { fields(it)["outcome"] })

        claimIo.drain()
        harness.controller.play(1)
        harness.runUntil {
            claimIo.drain()
            harness.timings.size == 2
        }
        assertEquals("audible", fields(harness.timings[1])["outcome"])
        repeat(10) { harness.step() }

        // A heard track that resumes plays the PCM its output still holds: no new write is awaited.
        harness.controller.pause()
        repeat(4) { harness.step() }
        harness.controller.play(1)
        harness.runUntil {
            claimIo.drain()
            harness.timings.size == 3
        }
        val resumed = fields(harness.timings[2])
        assertEquals("play", resumed["kind"])
        assertEquals("audible", resumed["outcome"])
        assertEquals("-", resumed["open"])
        assertEquals("-", resumed["first_write"])
        assertEquals("true", resumed["socket_reused"])
        assertTrue(ms(resumed, "audible") >= ms(resumed, "claim"))

        // Play while already playing starts nothing new.
        harness.controller.play(1)
        repeat(10) { harness.step() }
        assertEquals(3, harness.timings.size)
    }

    @Test
    fun aStartFocusRefusesIsReportedAsRefused() {
        val refusing = object : StartGate by StartGate.OPEN {
            override fun mayStart() = false
        }
        val harness = ControllerHarness(first, startGate = refusing)
        harness.load(1, first)
        repeat(4) { harness.step() }

        val timing = fields(harness.timings.single())
        assertEquals("focus_refused", timing["outcome"])
        assertEquals("-", timing["gate"])
    }

    @Test
    fun theShellsOwnResumeCountsFromItsRequestAndNamesWhenItsReferencesCame() {
        val harness = ControllerHarness(first)
        harness.now = 1_000
        val start = StartCommand(StartKind.PLAY, CommandSource.SYSTEM, atMs = 600, refsAnsweredAtMs = 950)
        harness.controller.loadQueue(QueueLoad(1, listOf(harness.item(first)), 0, 0, null, autoplay = true), start)
        harness.runUntil { harness.timings.isNotEmpty() }

        val timing = fields(harness.timings.single())
        assertEquals("system", timing["source"])
        assertEquals("350", timing["ref"])
        assertTrue(ms(timing, "gate") >= 400)
    }
}
