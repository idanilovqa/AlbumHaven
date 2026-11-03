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

/**
 * Media3's audio-focus and becoming-noisy defaults for a music player, kept pure: focus is held
 * while playback is wanted; a permanent loss pauses; a transient loss (a call, an alarm) pauses
 * and resumes only when the platform gives focus back; a may-duck loss is ducked by the platform
 * itself because the request does not pause when ducked; headphones unplugging or Bluetooth
 * audio dropping pauses.
 */
class AudioFocusPolicy {
    private var held = false
    private var active = false
    private var resumeOnGain = false

    fun onState(state: NativePlaybackState): List<FocusEffect> {
        val wasActive = active
        active = state == NativePlaybackState.LOADING || state == NativePlaybackState.BUFFERING ||
            state == NativePlaybackState.PLAYING
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
            effects += FocusEffect.Abandon
        }
        return effects
    }

    /** A refused request (for example during a call) leaves playback paused. */
    fun onRequestResult(granted: Boolean): List<FocusEffect> {
        if (granted) return emptyList()
        held = false
        return if (active) listOf(FocusEffect.Pause) else emptyList()
    }

    fun onFocusChange(change: FocusChange): List<FocusEffect> = when (change) {
        FocusChange.LOSS -> {
            resumeOnGain = false
            held = false
            if (active) listOf(FocusEffect.Abandon, FocusEffect.Pause) else listOf(FocusEffect.Abandon)
        }
        FocusChange.LOSS_TRANSIENT -> if (active) {
            resumeOnGain = true
            listOf(FocusEffect.Pause)
        } else {
            emptyList()
        }
        FocusChange.LOSS_TRANSIENT_CAN_DUCK -> emptyList()
        FocusChange.GAIN -> if (resumeOnGain && !active) {
            resumeOnGain = false
            listOf(FocusEffect.Resume)
        } else {
            emptyList()
        }
    }

    fun onBecomingNoisy(): List<FocusEffect> = if (active) listOf(FocusEffect.Pause) else emptyList()
}
