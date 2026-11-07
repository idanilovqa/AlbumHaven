package org.albumhaven.shell.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackClaimOwnerTest {
    private val api = FakeClaimApi()
    private val io = ArrayDeque<Runnable>()
    private val posted = ArrayDeque<Runnable>()
    private val events = mutableListOf<ClaimEvent>()
    private var now = 0L
    private val owner = PlaybackClaimOwner(api, TEST_CLIENT_ID, io::addLast, posted::addLast, { now }, events::add)
    private val track = ClaimTrack("opaque-ref", "Signal A", "Android Acceptance", "Playback Ownership", null)

    private fun drain() {
        while (io.isNotEmpty() || posted.isNotEmpty()) {
            io.removeFirstOrNull()?.run()
            posted.removeFirstOrNull()?.run()
        }
    }

    @Test
    fun aHeldClaimIsDueAtItsNextHeartbeatThenAtTheEndOfItsLease() {
        assertNull(owner.nextDeadlineMs())
        owner.acquire(track) {}
        drain()
        assertEquals(PlaybackClaimOwner.HEARTBEAT_MS, owner.nextDeadlineMs())

        now = PlaybackClaimOwner.HEARTBEAT_MS
        owner.tick()
        // The heartbeat is in flight; only the lease can end before it answers.
        assertEquals(PlaybackClaimOwner.LEASE_MS, owner.nextDeadlineMs())
        drain()
        assertEquals(2 * PlaybackClaimOwner.HEARTBEAT_MS, owner.nextDeadlineMs())
    }

    @Test
    fun concurrentRequestsShareOneAcquisition() {
        val outcomes = mutableListOf<ClaimOutcome>()
        owner.acquire(track, outcomes::add)
        owner.acquire(track, outcomes::add)
        drain()

        assertEquals(listOf("acquire:null"), api.calls)
        assertEquals(listOf(ClaimOutcome.GRANTED, ClaimOutcome.GRANTED), outcomes)
        assertTrue(owner.owned)
        assertEquals(listOf<ClaimEvent>(ClaimEvent.Owned), events)
    }

    @Test
    fun aClaimGrantedAfterReleaseIsGivenBackAtOnce() {
        val outcomes = mutableListOf<ClaimOutcome>()
        owner.acquire(track, outcomes::add)
        owner.release()
        drain()

        assertEquals(listOf("acquire:null", "release:token-1"), api.calls)
        assertEquals(listOf(ClaimOutcome.UNAVAILABLE), outcomes)
        assertFalse(owner.owned)
        assertEquals(listOf<ClaimEvent>(ClaimEvent.Released), events)
    }

    @Test
    fun heartbeatRenewsEveryTenSecondsAndRetriesAnUnansweredOne() {
        owner.acquire(track) {}
        drain()
        now = 9_999
        owner.tick()
        drain()
        assertEquals(listOf("acquire:null"), api.calls)

        api.renewResponse = { ClaimResponse.Unreachable }
        now = 10_000
        owner.tick()
        drain()
        now = 11_000
        owner.tick()
        drain()
        api.renewResponse = { ClaimResponse.Granted(it) }
        now = 12_000
        owner.tick()
        drain()

        assertEquals(listOf("acquire:null", "acquire:token-1", "acquire:token-1"), api.calls)
        now = 12_000 + PlaybackClaimOwner.LEASE_MS - 1
        owner.tick()
        assertTrue(owner.owned)
    }

    @Test
    fun everyAcquireAndHeartbeatAnswerSaysAfreshWhetherListensReachLastfm() {
        assertNull(owner.scrobblingAvailable)
        api.acquireResponse = { ClaimResponse.Granted("token-1", scrobblingAvailable = false) }
        owner.acquire(track) {}
        drain()
        assertEquals(false, owner.scrobblingAvailable)

        api.renewResponse = { ClaimResponse.Granted(it, scrobblingAvailable = true) }
        now = 10_000
        owner.tick()
        drain()
        assertEquals(true, owner.scrobblingAvailable)

        // An answer that does not say is unknown, and a claim given up knows nothing.
        api.renewResponse = { ClaimResponse.Granted(it) }
        now = 20_000
        owner.tick()
        drain()
        assertNull(owner.scrobblingAvailable)
        api.renewResponse = { ClaimResponse.Granted(it, scrobblingAvailable = true) }
        now = 30_000
        owner.tick()
        drain()
        owner.release()
        assertNull(owner.scrobblingAvailable)
    }

    @Test
    fun releaseOfAnUnheldClaimSendsNothing() {
        owner.release()
        drain()

        assertTrue(api.calls.isEmpty())
        assertTrue(events.isEmpty())
    }
}
