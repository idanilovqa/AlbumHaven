package org.albumhaven.shell.playback

/** Server-side decoder role; codes match `_ROLE_CODES` in music_app/services/playback_pcm.py. */
enum class PcmRole(val code: Int, val wire: String) {
    CURRENT(0, "current"),
    CONTINUITY(1, "continuity");

    companion object {
        fun fromCode(code: Int): PcmRole? = entries.firstOrNull { it.code == code }
    }
}

class AhpcProtocolException(message: String) : Exception(message)

/** One validated version-1 PCM frame; samples stay in [bytes] as interleaved f32le stereo. */
class AhpcPcmFrame(
    val role: PcmRole,
    val generation: Long,
    val streamId: Long,
    val sequence: Long,
    val frameCount: Int,
    val bytes: ByteArray,
) {
    val payloadOffset: Int get() = AhpcFrameCodec.HEADER_BYTES
}

/**
 * The `AHPC` binary frame from `pack_pcm_frame`: a 24-byte big-endian header
 * (`AHPC`, version, role, reserved u16, generation, stream id, sequence,
 * frame count as u32) followed by little-endian float32 stereo frames.
 */
object AhpcFrameCodec {
    const val HEADER_BYTES = 24
    const val BYTES_PER_FRAME = 8
    private const val PCM_VERSION = 1
    private const val ENCODED_VERSION = 2
    private val MAGIC = "AHPC".toByteArray(Charsets.US_ASCII)

    fun decode(bytes: ByteArray): AhpcPcmFrame {
        if (bytes.size < HEADER_BYTES) throw AhpcProtocolException("frame is shorter than the AHPC header")
        if ((0 until 4).any { bytes[it] != MAGIC[it] }) throw AhpcProtocolException("bad AHPC magic")
        val version = u8(bytes, 4)
        if (version != PCM_VERSION && version != ENCODED_VERSION) {
            throw AhpcProtocolException("unsupported AHPC version")
        }
        val role = PcmRole.fromCode(u8(bytes, 5)) ?: throw AhpcProtocolException("invalid stream role")
        if (u8(bytes, 6) != 0 || u8(bytes, 7) != 0) throw AhpcProtocolException("nonzero reserved flags")
        // Native playback never offers `codecs`, so the server must not send encoded frames.
        if (version == ENCODED_VERSION) throw AhpcProtocolException("encoded AHPC frames were not negotiated")
        val frameCount = u32(bytes, 20)
        if (frameCount <= 0 || bytes.size.toLong() != HEADER_BYTES + frameCount * BYTES_PER_FRAME) {
            throw AhpcProtocolException("declared frame length does not match payload")
        }
        return AhpcPcmFrame(
            role = role,
            generation = u32(bytes, 8),
            streamId = u32(bytes, 12),
            sequence = u32(bytes, 16),
            frameCount = frameCount.toInt(),
            bytes = bytes,
        )
    }

    private fun u8(bytes: ByteArray, offset: Int): Int = bytes[offset].toInt() and 0xFF

    private fun u32(bytes: ByteArray, offset: Int): Long =
        (0 until 4).fold(0L) { value, index -> (value shl 8) or u8(bytes, offset + index).toLong() }
}
