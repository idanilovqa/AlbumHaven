package org.albumhaven.shell.playback

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack

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

    override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        val written = track.write(
            samples,
            offsetSamples,
            frames * PcmRing.CHANNELS,
            AudioTrack.WRITE_NON_BLOCKING,
        )
        check(written >= 0) { "AudioTrack write failed: $written" }
        check(written % PcmRing.CHANNELS == 0) { "AudioTrack accepted a partial stereo frame" }
        writtenFrames += written / PcmRing.CHANNELS
        return written / PcmRing.CHANNELS
    }

    override fun pendingFrames(): Int {
        val played = track.playbackHeadPosition.toLong() and 0xFFFF_FFFFL
        return (writtenFrames - played).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
    }

    override fun heardFrames(): Long = heardBeforeFlush + writtenFrames - pendingFrames()

    override fun play() = track.play()

    override fun pause() = track.pause()

    override fun flush() {
        heardBeforeFlush = heardFrames()
        track.flush()
        writtenFrames = 0
    }

    override fun release() = track.release()

    private companion object {
        const val BYTES_PER_FRAME = PcmRing.CHANNELS * 4
    }
}
