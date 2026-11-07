package org.albumhaven.shell.playback

/**
 * The one audible output. Production uses [AudioTrackPcmSink]; JVM tests record writes.
 * Calls arrive on the engine's thread.
 */
interface PcmSink {
    val sampleRate: Int

    /**
     * Writes up to [frames] interleaved stereo frames without blocking; returns frames accepted, or
     * a negative error when the output can take no more, as a dead [android.media.AudioTrack] does.
     */
    fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int

    /** Frames written but not yet heard, so a position can name the audible frame. */
    fun pendingFrames(): Int = 0

    /** Frames actually played since this sink was created; flushed frames never count. */
    fun heardFrames(): Long

    fun play()

    /** Stops output at once; written PCM stays queued for the next play. */
    fun pause()

    /**
     * Fades the output down over [FADE_MS] from what is playing now, then pauses, keeping every frame
     * not yet played queued. Returns at once; [fadeOutSettled] says when the output has paused.
     */
    fun fadeOutAndPause()

    /** Whether a [fadeOutAndPause] has faded to silence and paused the output, pausing it if so. */
    fun fadeOutSettled(): Boolean

    /**
     * Plays the queued PCM from its next unplayed frame with a fade up over [FADE_MS]; a fade down
     * still running turns back up from where it is.
     */
    fun resumeWithFadeIn()

    /** Discards written but unplayed PCM. Only hard stops and new generations flush. */
    fun flush()

    fun release()

    companion object {
        /**
         * Long enough that the gain changes far too little per frame to be heard even on bass at full
         * scale, short enough that a pause still sounds immediate.
         */
        const val FADE_MS = 10L
    }
}
