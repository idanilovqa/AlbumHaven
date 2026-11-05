package org.albumhaven.shell.playback

enum class FocusChange { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }

/** What the focus policy asks the platform and the player to do, in order. */
sealed interface FocusEffect {
    data object Pause : FocusEffect
    data object Resume : FocusEffect
    data class WatchNoisy(val enabled: Boolean) : FocusEffect
}

/** What the controller asks before any start; called on the playback thread. */
interface StartGate {
    /** Whether a start may be heard now; one refused is either dropped or held for the gate to resume. */
    fun mayStart(): Boolean

    /** The user paused or stopped, so a start held for later is dropped. */
    fun dropHeldStart()

    /** Playback stopped being wanted ([state] is not [NativePlaybackState.wanted]), told before any later start. */
    fun stopped(state: NativePlaybackState)

    companion object {
        val OPEN = object : StartGate {
            override fun mayStart() = true
            override fun dropHeldStart() = Unit
            override fun stopped(state: NativePlaybackState) = Unit
        }
    }
}

/**
 * Media3's audio-focus and becoming-noisy defaults for a music player, kept pure: focus is held
 * while playback is wanted; a permanent loss pauses; a transient loss (a call, an alarm) pauses
 * and resumes only when the platform gives focus back, and a start meanwhile waits for it too, so
 * nothing plays over a call; a start the platform refuses focus for does not start at all; a may-duck
 * loss is ducked by the platform itself because the request does not pause when ducked; headphones
 * unplugging or Bluetooth audio dropping pauses, and cancels a resume held for the end of a call.
 * The main thread drives it, and the playback thread asks it as the controller's [StartGate], so
 * each start and stop decides on focus in the order the controller made them. Focus is requested
 * through [requestFocus] (true when granted) and given up through [abandonFocus].
 */
class AudioFocusPolicy(
    private val requestFocus: () -> Boolean,
    private val abandonFocus: () -> Unit,
) : StartGate {
    private var held = false
    private var active = false
    private var resumeOnGain = false
    private var watchingNoisy = false

    /** The request is held but another app has focus for a moment, so nothing may be heard until it returns. */
    private var transientlyLost = false

    @Synchronized
    fun onState(state: NativePlaybackState): List<FocusEffect> {
        val wanted = state.wanted
        if (wanted && transientlyLost) {
            resumeOnGain = true
            return listOf(FocusEffect.Pause)
        }
        // Every start passes the gate holding focus, so focus lost since then pauses it.
        if (wanted && !held) return listOf(FocusEffect.Pause)
        active = wanted
        // Any start, including the user's own, supersedes a pending resume.
        if (active) resumeOnGain = false
        return watchNoisy()
    }

    /** Focus is given up, except by a transiently interrupted player, so the platform can give it back. */
    @Synchronized
    override fun stopped(state: NativePlaybackState) {
        if (state != NativePlaybackState.PAUSED) resumeOnGain = false
        if (!resumeOnGain) release()
    }

    private fun release() {
        transientlyLost = false
        if (!held) return
        held = false
        abandonFocus()
    }

    /** Output is watched while playback is wanted, including a resume held for focus to return. */
    private fun watchNoisy(): List<FocusEffect> {
        val wanted = active || resumeOnGain
        if (wanted == watchingNoisy) return emptyList()
        watchingNoisy = wanted
        return listOf(FocusEffect.WatchNoisy(wanted))
    }

    /**
     * Focus is requested before any start, so a refused one (for example during a call) neither
     * claims nor announces playback. While another app has the held request's focus for a moment,
     * a start is remembered for the platform's gain instead.
     */
    @Synchronized
    override fun mayStart(): Boolean {
        if (transientlyLost) {
            resumeOnGain = true
            return false
        }
        if (!held) held = requestFocus()
        return held
    }

    @Synchronized
    override fun dropHeldStart() {
        resumeOnGain = false
    }

    @Synchronized
    fun onFocusChange(change: FocusChange): List<FocusEffect> = when (change) {
        FocusChange.LOSS -> {
            resumeOnGain = false
            release()
            if (active) listOf(FocusEffect.Pause) else watchNoisy()
        }
        FocusChange.LOSS_TRANSIENT -> {
            transientlyLost = held
            if (active) {
                resumeOnGain = true
                listOf(FocusEffect.Pause)
            } else {
                emptyList()
            }
        }
        FocusChange.LOSS_TRANSIENT_CAN_DUCK -> emptyList()
        FocusChange.GAIN -> {
            transientlyLost = false
            if (resumeOnGain && !active) {
                // Output stays watched: the resume makes playback active again.
                resumeOnGain = false
                listOf(FocusEffect.Resume)
            } else {
                // A pause during the call left nothing to resume, so focus is given up now.
                if (!active) release()
                watchNoisy()
            }
        }
    }

    /** Output lost during a call drops the held resume, so the call's end does not play on the speaker. */
    @Synchronized
    fun onBecomingNoisy(): List<FocusEffect> {
        if (active) return listOf(FocusEffect.Pause)
        if (!resumeOnGain) return watchNoisy()
        resumeOnGain = false
        release()
        return watchNoisy()
    }
}
