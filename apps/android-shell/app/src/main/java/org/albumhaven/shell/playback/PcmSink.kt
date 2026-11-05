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

    fun pause()

    /** Discards written but unplayed PCM. Only hard stops and new generations flush. */
    fun flush()

    fun release()
}
