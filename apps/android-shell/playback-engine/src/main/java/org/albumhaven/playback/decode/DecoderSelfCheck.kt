package org.albumhaven.playback.decode

import kotlin.math.abs

/**
 * The web player's `streamingDecoderPassesSelfCheck`: each decoder must turn its clip into the
 * exact frame count and left-channel magnitude the web build produces. A codec that fails is
 * not offered to the server, so only that codec falls back to server decoding.
 */
object DecoderSelfCheck {
    /** `STREAMING_DECODER_SELF_CHECK_CLIPS` in music_app/static/js/runtime/player-streaming-decoders.js. */
    class Expected(val frames: Int, val magnitude: Double)

    val EXPECTED = mapOf(
        AudioCodec.MP3 to Expected(frames = 5760, magnitude = 189.017),
        AudioCodec.FLAC to Expected(frames = 3528, magnitude = 198.443),
    )
    const val MAGNITUDE_TOLERANCE = 0.01

    /** The clip each check decodes, as an asset of this module. */
    fun clipAsset(codec: AudioCodec): String = "decoder-self-check/${codec.wire}.bin"

    /** The codecs whose decoder passes; a decoder that cannot even open fails its codec. */
    fun verifiedCodecs(
        clip: (AudioCodec) -> ByteArray,
        open: (AudioCodec) -> AudioDecoder = StreamDecoder::open,
    ): Set<AudioCodec> = AudioCodec.entries.filterTo(LinkedHashSet()) { codec ->
        runCatching { passes(codec, clip(codec), open) }.getOrDefault(false)
    }

    private fun passes(codec: AudioCodec, clip: ByteArray, open: (AudioCodec) -> AudioDecoder): Boolean =
        open(codec).use { decoder ->
            decoder.write(clip)
            decoder.end()
            var frames = 0
            var magnitude = 0.0
            while (true) {
                val decoded = decoder.decode() ?: break
                frames += decoded.frames
                for (frame in 0 until decoded.frames) magnitude += abs(decoded.samples[frame * 2])
            }
            val expected = EXPECTED.getValue(codec)
            frames == expected.frames && abs(magnitude - expected.magnitude) <= MAGNITUDE_TOLERANCE
        }
}
