package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMappingTest {
    private val origin = "https://sandbox2.albumhaven.org"
    private val items = listOf(
        QueueItem("ref-a", "Signal A", "Android Acceptance", "Playback Ownership", "/static/cover-a.jpg", 180_000),
        QueueItem("ref-b", "Signal B", "Android Acceptance", "Playback Ownership", null, 120_000),
        QueueItem("ref-c", "Signal C", "Android Acceptance", "Playback Ownership", null, 0),
    )

    private fun snapshot(state: NativePlaybackState, index: Int? = 1, revision: Long = 4, positionMs: Long = 2_500) =
        NativePlaybackSnapshot(TEST_CLIENT_ID, state, revision, index, positionMs, 120_000, items = items)

    @Test
    fun nativeStatesMapToMedia3StatesAndPlayWhenReady() {
        val expected = mapOf(
            NativePlaybackState.LOADING to (SessionPlaybackState.BUFFERING to true),
            NativePlaybackState.BUFFERING to (SessionPlaybackState.BUFFERING to true),
            NativePlaybackState.PLAYING to (SessionPlaybackState.READY to true),
            NativePlaybackState.PAUSED to (SessionPlaybackState.READY to false),
            NativePlaybackState.ENDED to (SessionPlaybackState.ENDED to false),
            NativePlaybackState.IDLE to (SessionPlaybackState.IDLE to false),
            NativePlaybackState.ERROR to (SessionPlaybackState.IDLE to false),
        )
        expected.forEach { (state, mapped) ->
            val view = SessionMapping.view(snapshot(state), origin)
            assertEquals(state.name, mapped, view.state to view.playWhenReady)
            assertEquals(state.name, state == NativePlaybackState.PLAYING, view.playing)
            assertEquals(state.name, state == NativePlaybackState.ERROR, view.failed)
        }
    }

    @Test
    fun theQueueBecomesAPlaylistWithAbsoluteSameOriginArtworkAndNoReferences() {
        val view = SessionMapping.view(snapshot(NativePlaybackState.PLAYING), origin)
        assertEquals(listOf("4:0", "4:1", "4:2"), view.items.map { it.uid })
        assertEquals(1, view.currentIndex)
        assertEquals(2_500, view.positionMs)
        assertEquals("$origin/static/cover-a.jpg", view.items[0].artworkUri)
        assertNull(view.items[1].artworkUri)
        assertEquals(
            Triple("Signal B", "Android Acceptance", "Playback Ownership"),
            view.items[1].let { Triple(it.title, it.artist, it.album) },
        )
        assertFalse(view.items.toString().contains("ref-"))
    }

    @Test
    fun controlsFollowThePositionInTheQueue() {
        val all = SystemControl.entries.toSet()
        assertEquals(all, SessionMapping.view(snapshot(NativePlaybackState.PLAYING), origin).controls)
        assertEquals(
            all - SystemControl.PREVIOUS_ITEM,
            SessionMapping.view(snapshot(NativePlaybackState.PAUSED, index = 0), origin).controls,
        )
        // An item of unknown length cannot be scrubbed and the last item has no next.
        assertEquals(
            setOf(SystemControl.PLAY_PAUSE, SystemControl.STOP, SystemControl.PREVIOUS_ITEM),
            SessionMapping.view(snapshot(NativePlaybackState.PLAYING, index = 2), origin).controls,
        )
        assertEquals(emptySet<SystemControl>(), SessionMapping.view(snapshot(NativePlaybackState.IDLE), origin).controls)
    }

    @Test
    fun noQueueIsAnEmptyIdlePlayer() {
        val view = SessionMapping.view(
            NativePlaybackSnapshot(TEST_CLIENT_ID, NativePlaybackState.IDLE, 0, null, 0, 0),
            origin,
        )
        assertTrue(view.items.isEmpty())
        assertEquals(SessionPlaybackState.IDLE, view.state)
        assertTrue(view.controls.isEmpty())
    }

    @Test
    fun aRestoredQueueIsShownPausedWithoutControls() {
        val restored = RestorableQueue(
            origin, 7, 1, 30_000,
            listOf(RestorableItem("Signal A", "A", "B", "/static/a.jpg", 1_000), RestorableItem("Signal B", "A", "B", null, 2_000)),
        )
        val view = SessionMapping.restoredView(restored)
        assertTrue(view.restored)
        assertEquals(SessionPlaybackState.READY, view.state)
        assertFalse(view.playWhenReady)
        assertTrue(view.controls.isEmpty())
        assertEquals(1, view.currentIndex)
        assertEquals(30_000, view.positionMs)
        assertEquals("$origin/static/a.jpg", view.items[0].artworkUri)
    }

    @Test
    fun requestsBecomeRevisionedControllerCommands() {
        val playing = snapshot(NativePlaybackState.PLAYING)
        val paused = snapshot(NativePlaybackState.PAUSED)
        assertEquals(SystemAction.Pause, SessionMapping.route(SystemRequest.SetPlayWhenReady(false), playing))
        assertNull(SessionMapping.route(SystemRequest.SetPlayWhenReady(true), playing))
        assertEquals(SystemAction.Play(4), SessionMapping.route(SystemRequest.SetPlayWhenReady(true), paused))
        assertEquals(
            SystemAction.Play(4),
            SessionMapping.route(SystemRequest.SetPlayWhenReady(true), snapshot(NativePlaybackState.ERROR)),
        )
        assertNull(SessionMapping.route(SystemRequest.SetPlayWhenReady(false), paused))
        // Media3 convention: an ended queue waits for a seek or a new queue.
        assertNull(SessionMapping.route(SystemRequest.SetPlayWhenReady(true), snapshot(NativePlaybackState.ENDED)))

        assertEquals(SystemAction.Seek(4, 9_000), SessionMapping.route(SystemRequest.Seek(1, 9_000), playing))
        assertEquals(SystemAction.Seek(4, 0), SessionMapping.route(SystemRequest.Seek(1, -5), playing))
        assertEquals(SystemAction.Next(4), SessionMapping.route(SystemRequest.Seek(2, 0), playing))
        assertEquals(SystemAction.Previous(4), SessionMapping.route(SystemRequest.Seek(0, 0), playing))
        assertNull(SessionMapping.route(SystemRequest.Seek(3, 0), snapshot(NativePlaybackState.PLAYING, index = 0)))
        assertEquals(SystemAction.Stop, SessionMapping.route(SystemRequest.Stop, playing))
    }

    @Test
    fun nothingRoutesWithoutAnAppliedQueue() {
        val none = NativePlaybackSnapshot(TEST_CLIENT_ID, NativePlaybackState.IDLE, 0, null, 0, 0)
        assertNull(SessionMapping.route(SystemRequest.SetPlayWhenReady(true), none))
        assertNull(SessionMapping.route(SystemRequest.Stop, none))
    }

    @Test
    fun onlyAPositionThePlaybackClockCannotExplainIsADiscontinuity() {
        assertFalse(SessionMapping.jumped(10_000, 1_000, wasPlaying = true, positionMs = 10_250, nowMs = 1_250))
        assertFalse(SessionMapping.jumped(10_000, 1_000, wasPlaying = false, positionMs = 10_000, nowMs = 9_000))
        assertTrue(SessionMapping.jumped(10_000, 1_000, wasPlaying = true, positionMs = 60_000, nowMs = 1_250))
        assertTrue(SessionMapping.jumped(10_000, 1_000, wasPlaying = false, positionMs = 0, nowMs = 1_250))
    }
}
