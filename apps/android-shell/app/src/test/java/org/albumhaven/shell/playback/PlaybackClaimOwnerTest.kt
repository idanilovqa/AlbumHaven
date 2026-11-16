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
    fun aHeldClaimIsDueAtItsNextHeartbeat() {
        assertNull(owner.nextDeadlineMs())
        owner.acquire(track) {}
        drain()
        assertEquals(PlaybackClaimOwner.HEARTBEAT_MS, owner.nextDeadlineMs())

        now = PlaybackClaimOwner.HEARTBEAT_MS
        owner.tick()
        // The heartbeat is in flight; its answer decides what is due next.
        assertNull(owner.nextDeadlineMs())
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
    fun aRenewalTheServerAnswersAfterTheLeaseKeepsTheClaim() {
        owner.acquire(track) {}
        drain()
        now = PlaybackClaimOwner.HEARTBEAT_MS
        owner.tick()
        // The server stalls past the lease; the renewal in flight decides, not the clock.
        now = PlaybackClaimOwner.LEASE_MS + 5_000
        owner.tick()
        assertTrue(owner.owned)
        assertNull(owner.nextDeadlineMs())

        drain()
        assertTrue(owner.owned)
        assertEquals(listOf<ClaimEvent>(ClaimEvent.Owned), events)
        assertEquals(listOf("acquire:null", "acquire:token-1"), api.calls)
    }

    @Test
    fun pastTheLeaseOneMoreRenewalIsAskedAndOnlyARefusalLosesTheClaim() {
        owner.acquire(track) {}
        drain()
        now = PlaybackClaimOwner.LEASE_MS
        owner.tick()
        drain()
        assertTrue(owner.owned)
        assertEquals(listOf("acquire:null", "acquire:token-1"), api.calls)

        // Owner decision 2026-11-15: losing the network never stops playback. With no answer the
        // claim outlives its lease, retried every two seconds; the server renews a lapsed token
        // until another device claims, and only that refusal loses it.
        api.renewResponse = { ClaimResponse.Unreachable }
        now = 2 * PlaybackClaimOwner.LEASE_MS
        owner.tick()
        drain()
        assertTrue(owner.owned)
        assertEquals(now + PlaybackClaimOwner.RETRY_MS, owner.nextDeadlineMs())
        now += PlaybackClaimOwner.RETRY_MS - 1
        owner.tick()
        drain()
        assertEquals("no renewal before the retry is due", 3, api.calls.size)
        now += 1
        owner.tick()
        drain()
        assertTrue(owner.owned)
        assertEquals(4, api.calls.size)

        api.renewResponse = { ClaimResponse.Conflict }
        now += PlaybackClaimOwner.RETRY_MS
        owner.tick()
        drain()
        assertFalse(owner.owned)
        assertEquals(listOf(ClaimEvent.Owned, ClaimEvent.Lost), events)
    }

    @Test
    fun aReleaseTheServerNeverAnsweredHandsItsTokenToTheNextAcquire() {
        owner.acquire(track) {}
        drain()
        api.releaseAnswered = false
        owner.release()
        drain()
        assertFalse(owner.owned)

        // Its lease may still run on the server, which refuses an anonymous acquire until it ends.
        val outcomes = mutableListOf<ClaimOutcome>()
        owner.acquire(track, outcomes::add)
        drain()
        assertEquals(listOf("acquire:null", "release:token-1", "acquire:token-1"), api.calls)
        assertEquals(listOf(ClaimOutcome.GRANTED), outcomes)
        assertEquals("token-1", owner.heldToken)
    }

    @Test
    fun aHandedOverTokenTheServerRefusesFallsBackToAnAnonymousAcquire() {
        owner.acquire(track) {}
        drain()
        api.releaseAnswered = false
        owner.release()
        drain()
        api.renewResponse = { ClaimResponse.Conflict }
        val outcomes = mutableListOf<ClaimOutcome>()
        owner.acquire(track, outcomes::add)
        drain()
        assertEquals(listOf("acquire:null", "release:token-1", "acquire:token-1", "acquire:null"), api.calls)
        assertEquals(listOf(ClaimOutcome.GRANTED), outcomes)
        assertEquals("token-2", owner.heldToken)
    }

    @Test
    fun aHandedOverTokenSurvivesAnUnansweredAcquire() {
        owner.acquire(track) {}
        drain()
        api.releaseAnswered = false
        owner.release()
        drain()
        api.renewResponse = { ClaimResponse.Unreachable }
        owner.acquire(track) {}
        drain()
        assertFalse(owner.owned)
        api.renewResponse = { ClaimResponse.Granted(it) }
        owner.acquire(track) {}
        drain()
        assertEquals(listOf("acquire:null", "release:token-1", "acquire:token-1", "acquire:token-1"), api.calls)
        assertEquals("token-1", owner.heldToken)
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
