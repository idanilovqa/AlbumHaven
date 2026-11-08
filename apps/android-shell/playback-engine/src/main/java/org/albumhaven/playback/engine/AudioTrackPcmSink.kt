package org.albumhaven.playback.engine

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.VolumeShaper

/** The single streaming float stereo [AudioTrack] behind [NativePcmEngine]. */
class AudioTrackPcmSink(override val sampleRate: Int) : PcmSink {
    private val track: AudioTrack = run {
        val format = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
            .setSampleRate(sampleRate)
            .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
            .build()
        val minimumBytes = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_FLOAT,
        )
        check(minimumBytes > 0) { "AudioTrack does not support $sampleRate Hz float stereo" }
        // The render thread wakes every few milliseconds; a quarter second absorbs its jitter.
        val cushionBytes = sampleRate / 4 * BYTES_PER_FRAME
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(format)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(maxOf(minimumBytes, cushionBytes))
            .build()
    }

    /** Frames written since the last flush; the playback head counts from the same point. */
    private var writtenFrames = 0L

    /** Frames heard before the last flush. */
    private var heardBeforeFlush = 0L

    /**
     * The platform's fade on what the track already holds, so a pause is heard at once rather than
     * after the queue. A fade down is reversed to come back up from wherever it is.
     */
    private var shaper: VolumeShaper? = null
    private var fadingDown = false
    private var pauseAtSilenceSinceNs: Long? = null

    /** A fade up waits for the first frames of an empty track, as the mixer starts only once it has them. */
    private var fadeInOnWrite = false

    override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        val written = track.write(
            samples,
            offsetSamples,
            frames * PcmRing.CHANNELS,
            AudioTrack.WRITE_NON_BLOCKING,
        )
        // The track's error, such as ERROR_DEAD_OBJECT once the audio server died, is the engine's to stop on.
        if (written < 0) return written
        check(written % PcmRing.CHANNELS == 0) { "AudioTrack accepted a partial stereo frame" }
        writtenFrames += written / PcmRing.CHANNELS
        if (fadeInOnWrite && written > 0) {
            fadeInOnWrite = false
            fade(down = false)
        }
        return written / PcmRing.CHANNELS
    }

    override fun pendingFrames(): Int {
        val played = track.playbackHeadPosition.toLong() and 0xFFFF_FFFFL
        return (writtenFrames - played).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
    }

    override fun heardFrames(): Long = heardBeforeFlush + writtenFrames - pendingFrames()

    override fun play() = track.play()

    override fun pause() {
        pauseAtSilenceSinceNs = null
        fadeInOnWrite = false
        track.pause()
    }

    override fun fadeOutAndPause() {
        fadeInOnWrite = false
        if (!fade(down = true)) return pause()
        if (pauseAtSilenceSinceNs == null) pauseAtSilenceSinceNs = System.nanoTime()
    }

    override fun fadeOutSettled(): Boolean {
        val since = pauseAtSilenceSinceNs ?: return true
        // The shaper's volume reads zero once the fade is done; a shaper that never says so is
        // given a few fade lengths before the track is paused anyway.
        val silent = runCatching { checkNotNull(shaper).volume <= 0f }.getOrDefault(true)
        if (!silent && System.nanoTime() - since < FADE_TIMEOUT_NS) return false
        pause()
        return true
    }

    override fun resumeWithFadeIn() {
        pauseAtSilenceSinceNs = null
        val reversing = shaper != null && fadingDown
        val queued = pendingFrames() > 0
        // The shaper runs on the clock, so a fade down turns up only once the track runs, or its fade
        // could pass before the mixer takes a frame. A held queue at full gain fades up from the start,
        // and an empty track from its first frames.
        if (!reversing && queued) fade(down = false)
        track.play()
        if (reversing) fade(down = false)
        fadeInOnWrite = !reversing && !queued
    }

    /** Starts or reverses the fade; false when the platform refused it. */
    private fun fade(down: Boolean): Boolean = try {
        // Output an immediate pause left at full gain starts a fade up anew.
        if (!down && !fadingDown) closeShaper()
        val current = shaper
        when {
            current == null -> {
                val curve = if (down) floatArrayOf(1f, 0f) else floatArrayOf(0f, 1f)
                val config = VolumeShaper.Configuration.Builder()
                    .setDuration(PcmSink.FADE_MS)
                    .setCurve(floatArrayOf(0f, 1f), curve)
                    .setInterpolatorType(VolumeShaper.Configuration.INTERPOLATOR_TYPE_LINEAR)
                    .build()
                shaper = track.createVolumeShaper(config).also { it.apply(VolumeShaper.Operation.PLAY) }
            }
            down != fadingDown -> current.apply(VolumeShaper.Operation.REVERSE)
        }
        fadingDown = down
        true
    } catch (refused: RuntimeException) {
        closeShaper()
        false
    }

    private fun closeShaper() {
        // A closed shaper no longer scales the track.
        runCatching { shaper?.close() }
        shaper = null
        fadingDown = false
    }

    override fun flush() {
        heardBeforeFlush = heardFrames()
        pauseAtSilenceSinceNs = null
        fadeInOnWrite = false
        // A new generation is heard at full gain from its first frame.
        closeShaper()
        track.flush()
        writtenFrames = 0
    }

    override fun release() {
        closeShaper()
        track.release()
    }

    private companion object {
        const val BYTES_PER_FRAME = PcmRing.CHANNELS * 4
        const val FADE_TIMEOUT_NS = 4 * PcmSink.FADE_MS * 1_000_000L
    }
}
