package org.albumhaven.shell.playback

import java.util.concurrent.Executor

/** Path-free metadata `PUT /playback/state` mirrors to other clients. */
data class ClaimTrack(
    val playbackRef: String,
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
)

sealed interface ClaimResponse {
    /** [scrobblingAvailable] is the answer's `scrobbling.available`; null when it does not say. */
    data class Granted(val claimToken: String, val scrobblingAvailable: Boolean? = null) : ClaimResponse

    /** Another client holds the account's playback claim (HTTP 409). */
    data object Conflict : ClaimResponse

    /** The session, CSRF token, reference or claim token was refused. */
    data class Rejected(val status: Int) : ClaimResponse

    /** No answer; the lease may still be valid. */
    data object Unreachable : ClaimResponse
}

/** Blocking calls to the server-backed playback claim (music_app/routes/playback_control_asgi.py). */
interface PlaybackClaimApi {
    fun acquire(clientId: String, claimToken: String?, track: ClaimTrack): ClaimResponse
    fun release(clientId: String, claimToken: String)
}

enum class ClaimOutcome { GRANTED, BLOCKED, UNAVAILABLE }

sealed interface ClaimEvent {
    data object Owned : ClaimEvent
    data object Released : ClaimEvent
    data object Blocked : ClaimEvent
    data object Lost : ClaimEvent
}

/**
 * Acquires, heartbeats every ten seconds, and releases the native client's claim.
 * Every method runs on the playback thread; HTTP runs on [io] and its answers return
 * through [post]. The token stays in memory only.
 */
class PlaybackClaimOwner(
    private val api: PlaybackClaimApi,
    private val clientId: String,
    private val io: Executor,
    private val post: (Runnable) -> Unit,
    private val clock: () -> Long,
    private val events: (ClaimEvent) -> Unit,
) {
    private var token: String? = null
    private var track: ClaimTrack? = null
    private var epoch = 0L
    var acquiring = false
        private set
    private var renewing = false
    private var lastRenewSentMs = 0L
    private var leaseEndsMs = 0L
    private val waiters = mutableListOf<(ClaimOutcome) -> Unit>()

    val owned: Boolean get() = token != null

    /** Whether the held claim's latest answer says listens can reach Last.fm; null when unknown. */
    var scrobblingAvailable: Boolean? = null
        private set

    /** The held claim token, for the owner's own listen writes only; never leaves native memory. */
    val heldToken: String? get() = token

    /**
     * Answers once whether this client owns playback: at once when the claim is held or none is
     * being requested, otherwise when the pending acquisition settles.
     */
    fun awaitOwnership(onResult: (ClaimOutcome) -> Unit) {
        when {
            token != null -> onResult(ClaimOutcome.GRANTED)
            acquiring -> waiters += onResult
            else -> onResult(ClaimOutcome.UNAVAILABLE)
        }
    }

    /** Requests ownership for [claimTrack]; [onResult] runs once on the playback thread. */
    fun acquire(claimTrack: ClaimTrack, onResult: (ClaimOutcome) -> Unit) {
        track = claimTrack
        if (token != null) {
            onResult(ClaimOutcome.GRANTED)
            return
        }
        waiters += onResult
        if (acquiring) return
        acquiring = true
        val requestEpoch = epoch
        val sentMs = clock()
        io.execute {
            val response = api.acquire(clientId, null, claimTrack)
            post(Runnable { acquired(requestEpoch, sentMs, response) })
        }
    }

    /** The next heartbeat mirrors [claimTrack]. */
    fun updateTrack(claimTrack: ClaimTrack) {
        track = claimTrack
    }

    /** Heartbeats a held claim and gives it up locally once its lease can no longer be valid. */
    fun tick() {
        val held = token ?: return
        val now = clock()
        if (now >= leaseEndsMs) {
            drop()
            events(ClaimEvent.Lost)
            return
        }
        if (renewing || now - lastRenewSentMs < HEARTBEAT_MS) return
        val claimTrack = track ?: return
        renewing = true
        lastRenewSentMs = now
        val requestEpoch = epoch
        io.execute {
            val response = api.acquire(clientId, held, claimTrack)
            post(Runnable { renewed(requestEpoch, now, response) })
        }
    }

    /** Gives the claim back now; an expired claim needs no answer. The owner calls it once listen writes drain. */
    fun release() {
        val held = token
        val wasActive = held != null || acquiring
        drop()
        if (held != null) io.execute { api.release(clientId, held) }
        if (wasActive) events(ClaimEvent.Released)
    }

    private fun drop() {
        epoch += 1
        token = null
        scrobblingAvailable = null
        acquiring = false
        renewing = false
        settle(ClaimOutcome.UNAVAILABLE)
    }

    private fun acquired(requestEpoch: Long, sentMs: Long, response: ClaimResponse) {
        if (requestEpoch != epoch) {
            // Released while the acquisition was in flight: give the orphan back at once.
            if (response is ClaimResponse.Granted) io.execute { api.release(clientId, response.claimToken) }
            return
        }
        acquiring = false
        when (response) {
            is ClaimResponse.Granted -> {
                token = response.claimToken
                scrobblingAvailable = response.scrobblingAvailable
                lastRenewSentMs = sentMs
                leaseEndsMs = sentMs + LEASE_MS
                events(ClaimEvent.Owned)
                settle(ClaimOutcome.GRANTED)
            }
            ClaimResponse.Conflict -> {
                events(ClaimEvent.Blocked)
                settle(ClaimOutcome.BLOCKED)
            }
            is ClaimResponse.Rejected, ClaimResponse.Unreachable -> settle(ClaimOutcome.UNAVAILABLE)
        }
    }

    private fun renewed(requestEpoch: Long, sentMs: Long, response: ClaimResponse) {
        if (requestEpoch != epoch) return
        renewing = false
        when (response) {
            is ClaimResponse.Granted -> {
                token = response.claimToken
                scrobblingAvailable = response.scrobblingAvailable
                leaseEndsMs = sentMs + LEASE_MS
            }
            // The server no longer recognizes this claim: another client owns playback now.
            ClaimResponse.Conflict, is ClaimResponse.Rejected -> {
                drop()
                events(ClaimEvent.Lost)
            }
            // Retried on the next tick until the lease can no longer be valid.
            ClaimResponse.Unreachable -> lastRenewSentMs = sentMs - HEARTBEAT_MS + RETRY_MS
        }
    }

    private fun settle(outcome: ClaimOutcome) {
        val pending = waiters.toList()
        waiters.clear()
        pending.forEach { it(outcome) }
    }

    companion object {
        const val HEARTBEAT_MS = 10_000L

        /** The server's thirty-second lease, counted from when the request left this device. */
        const val LEASE_MS = 30_000L
        const val RETRY_MS = 2_000L
    }
}
