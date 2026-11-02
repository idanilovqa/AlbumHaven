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
        AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setAudioFormat(format)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setBufferSizeInBytes(minimumBytes)
            .build()
    }

    override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        val written = track.write(
            samples,
            offsetSamples,
            frames * PcmRing.CHANNELS,
            AudioTrack.WRITE_NON_BLOCKING,
        )
        check(written >= 0) { "AudioTrack write failed: $written" }
        check(written % PcmRing.CHANNELS == 0) { "AudioTrack accepted a partial stereo frame" }
        return written / PcmRing.CHANNELS
    }

    override fun play() = track.play()

    override fun pause() = track.pause()

    override fun flush() = track.flush()

    override fun release() = track.release()
}
