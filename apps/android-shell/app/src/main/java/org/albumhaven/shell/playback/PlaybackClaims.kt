package org.albumhaven.shell.playback

import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicReference

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

    /** No answer, or one from an overloaded server (5xx, 429); the lease may still be valid. */
    data object Unreachable : ClaimResponse
}

/** Blocking calls to the server-backed playback claim (music_app/routes/playback_control_asgi.py). */
interface PlaybackClaimApi {
    fun acquire(clientId: String, claimToken: String?, track: ClaimTrack): ClaimResponse
    /** Gives the claim back; false when the server never answered, so its lease may still run. */
    fun release(clientId: String, claimToken: String): Boolean
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
    private var nextRenewMs = 0L

    /** When an acquire nobody answered is sent again; null while none waits. */
    private var acquireRetryAtMs: Long? = null

    /** A token whose give-back the server never answered: its lease may still run there, so the next acquire renews it. */
    private var unansweredRelease: String? = null
    private val waiters = mutableListOf<(ClaimOutcome) -> Unit>()

    // Set by [close]; a grant answered after it is given back by its own request.
    @Volatile private var closed = false

    /** A granted token whose answer the playback thread has not read yet. */
    private val unreadGrant = AtomicReference<String?>(null)

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
        sendAcquire(claimTrack)
    }

    private fun sendAcquire(claimTrack: ClaimTrack) {
        val requestEpoch = epoch
        val sentMs = clock()
        val offered = unansweredRelease.also { unansweredRelease = null }
        io.execute {
            var response = call { api.acquire(clientId, offered, claimTrack) }
            // A refused token was taken over or its claim already ended; only an anonymous acquire says which.
            if (offered != null && (response is ClaimResponse.Conflict || response is ClaimResponse.Rejected)) {
                response = call { api.acquire(clientId, null, claimTrack) }
            }
            if (response is ClaimResponse.Granted) {
                unreadGrant.set(response.claimToken)
                // A closed owner never reads the answer, so the grant goes back from here.
                if (closed) unreadGrant.getAndSet(null)?.let(::giveBack)
            }
            post(Runnable { acquired(requestEpoch, sentMs, response, offered) })
        }
    }

    /** The next heartbeat mirrors [claimTrack]. */
    fun updateTrack(claimTrack: ClaimTrack) {
        track = claimTrack
    }

    /**
     * Heartbeats a held claim every ten seconds, and two seconds after a renewal the server did not
     * answer. Losing the network never stops playback (owner decision, 2026-11-15): the claim
     * outlives its lease, whose token the server renews until another device claims, so only a
     * refusal gives it up.
     */
    fun tick() {
        val now = clock()
        acquireRetryAtMs?.let { at ->
            if (now < at) return
            acquireRetryAtMs = null
            sendAcquire(track ?: return)
            return
        }
        val held = token ?: return
        if (renewing || now < nextRenewMs) return
        val claimTrack = track ?: return
        renewing = true
        nextRenewMs = now + HEARTBEAT_MS
        val requestEpoch = epoch
        io.execute {
            val response = call { api.acquire(clientId, held, claimTrack) }
            post(Runnable { renewed(requestEpoch, now, response) })
        }
    }

    /** When [tick] next has work: a held claim's next heartbeat or retry, or an unanswered acquire's retry; none while one is in flight. */
    fun nextDeadlineMs(): Long? = when {
        token == null -> acquireRetryAtMs
        // The renewal's answer wakes the playback thread.
        renewing -> null
        else -> nextRenewMs
    }

    /** Gives the claim back now; an expired claim needs no answer. The owner calls it once listen writes drain. */
    fun release() {
        val held = token
        val wasActive = held != null || acquiring
        drop()
        if (held != null) {
            io.execute {
                if (!giveBack(held)) post(Runnable { if (token == null && !acquiring && !closed) unansweredRelease = held })
            }
        }
        if (wasActive) events(ClaimEvent.Released)
    }

    /**
     * Releases the claim for good, as its retired owner stops: a grant still on its way back is
     * given back by whichever of this and its own request sees the other last.
     */
    fun close() {
        closed = true
        release()
        unreadGrant.getAndSet(null)?.let { token -> io.execute { giveBack(token) } }
    }

    /** A request that cannot even be built, such as one refused by OkHttp, is as unanswered as a lost one. */
    private inline fun call(request: () -> ClaimResponse): ClaimResponse = try {
        request()
    } catch (_: RuntimeException) {
        ClaimResponse.Unreachable
    }

    private fun giveBack(token: String): Boolean = try {
        api.release(clientId, token)
    } catch (_: RuntimeException) {
        // The server lease expires on its own.
        false
    }

    private fun drop() {
        epoch += 1
        token = null
        scrobblingAvailable = null
        acquiring = false
        acquireRetryAtMs = null
        renewing = false
        settle(ClaimOutcome.UNAVAILABLE)
    }

    private fun acquired(requestEpoch: Long, sentMs: Long, response: ClaimResponse, offered: String?) {
        // A grant [close] already gave back is not this owner's any more.
        if (response is ClaimResponse.Granted && !unreadGrant.compareAndSet(response.claimToken, null)) return
        if (requestEpoch != epoch) {
            // Released while the acquisition was in flight: give the orphan back at once.
            if (response is ClaimResponse.Granted) io.execute { giveBack(response.claimToken) }
            return
        }
        acquiring = false
        when (response) {
            is ClaimResponse.Granted -> {
                token = response.claimToken
                scrobblingAvailable = response.scrobblingAvailable
                nextRenewMs = sentMs + HEARTBEAT_MS
                events(ClaimEvent.Owned)
                settle(ClaimOutcome.GRANTED)
            }
            ClaimResponse.Conflict -> {
                events(ClaimEvent.Blocked)
                settle(ClaimOutcome.BLOCKED)
            }
            is ClaimResponse.Rejected -> settle(ClaimOutcome.UNAVAILABLE)
            ClaimResponse.Unreachable -> {
                // No answer is not a refusal (owner decision, 2026-11-15): playback goes on from what
                // is here while the acquire is sent again, the offered token still its best credential.
                if (offered != null) unansweredRelease = offered
                acquiring = true
                acquireRetryAtMs = sentMs + RETRY_MS
            }
        }
    }

    private fun renewed(requestEpoch: Long, sentMs: Long, response: ClaimResponse) {
        if (requestEpoch != epoch) return
        renewing = false
        when (response) {
            is ClaimResponse.Granted -> {
                token = response.claimToken
                scrobblingAvailable = response.scrobblingAvailable
            }
            // The server no longer recognizes this claim: another client owns playback now.
            ClaimResponse.Conflict, is ClaimResponse.Rejected -> {
                drop()
                events(ClaimEvent.Lost)
            }
            // No answer is not a refusal, however long it lasts: retried two seconds after it was sent.
            ClaimResponse.Unreachable -> nextRenewMs = sentMs + RETRY_MS
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
