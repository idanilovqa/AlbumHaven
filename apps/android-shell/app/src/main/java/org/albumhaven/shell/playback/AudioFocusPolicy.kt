package org.albumhaven.shell.playback

enum class FocusChange { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK }

/** What the focus policy asks the platform and the player to do, in order. */
sealed interface FocusEffect {
    data object Request : FocusEffect
    data object Abandon : FocusEffect
    data object Pause : FocusEffect
    data object Resume : FocusEffect
    data class WatchNoisy(val enabled: Boolean) : FocusEffect
}

/** What the controller asks before any start; called on the playback thread. */
interface StartGate {
    /** Whether a start may be heard now; one refused is the gate's to resume. */
    fun mayStart(): Boolean

    /** The user paused or stopped, so a start held for later is dropped. */
    fun dropHeldStart()

    companion object {
        val OPEN = object : StartGate {
            override fun mayStart() = true
            override fun dropHeldStart() = Unit
        }
    }
}

/**
 * Media3's audio-focus and becoming-noisy defaults for a music player, kept pure: focus is held
 * while playback is wanted; a permanent loss pauses; a transient loss (a call, an alarm) pauses
 * and resumes only when the platform gives focus back, and a start meanwhile waits for it too, so
 * nothing plays over a call; a may-duck loss is ducked by the platform itself because the request
 * does not pause when ducked; headphones unplugging or Bluetooth audio dropping pauses. The main
 * thread drives it, and the playback thread asks it as the controller's [StartGate].
 */
class AudioFocusPolicy : StartGate {
    private var held = false
    private var active = false
    private var resumeOnGain = false

    /** The request is held but another app has focus for a moment, so nothing may be heard until it returns. */
    private var transientlyLost = false

    @Synchronized
    fun onState(state: NativePlaybackState): List<FocusEffect> {
        val wasActive = active
        val wanted = state == NativePlaybackState.LOADING || state == NativePlaybackState.BUFFERING ||
            state == NativePlaybackState.PLAYING
        if (wanted && transientlyLost) {
            resumeOnGain = true
            return listOf(FocusEffect.Pause)
        }
        active = wanted
        val effects = mutableListOf<FocusEffect>()
        if (active) {
            // Any start, including the user's own, supersedes a pending resume.
            resumeOnGain = false
            if (!held) {
                held = true
                effects += FocusEffect.Request
            }
            if (!wasActive) effects += FocusEffect.WatchNoisy(true)
            return effects
        }
        if (wasActive) effects += FocusEffect.WatchNoisy(false)
        // A transiently interrupted player keeps its request so the platform can give focus back.
        if (state == NativePlaybackState.PAUSED && resumeOnGain) return effects
        resumeOnGain = false
        if (held) {
            held = false
            transientlyLost = false
            effects += FocusEffect.Abandon
        }
        return effects
    }

    /**
     * While another app has focus for a moment a start is remembered for the platform's gain
     * instead, so nothing claims or announces playback meanwhile.
     */
    @Synchronized
    override fun mayStart(): Boolean {
        if (!transientlyLost) return true
        resumeOnGain = true
        return false
    }

    @Synchronized
    override fun dropHeldStart() {
        resumeOnGain = false
    }

    /** A refused request (for example during a call) leaves playback paused. */
    @Synchronized
    fun onRequestResult(granted: Boolean): List<FocusEffect> {
        if (granted) return emptyList()
        held = false
        return if (active) listOf(FocusEffect.Pause) else emptyList()
    }

    @Synchronized
    fun onFocusChange(change: FocusChange): List<FocusEffect> = when (change) {
        FocusChange.LOSS -> {
            resumeOnGain = false
            held = false
            transientlyLost = false
            if (active) listOf(FocusEffect.Abandon, FocusEffect.Pause) else listOf(FocusEffect.Abandon)
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
                resumeOnGain = false
                listOf(FocusEffect.Resume)
            } else {
                emptyList()
            }
        }
    }

    @Synchronized
    fun onBecomingNoisy(): List<FocusEffect> = if (active) listOf(FocusEffect.Pause) else emptyList()
}
