package org.albumhaven.playback.engine

/** Server-side decoder role; codes match `_ROLE_CODES` in music_app/services/playback_pcm.py. */
enum class PcmRole(val code: Int, val wire: String) {
    CURRENT(0, "current"),
    CONTINUITY(1, "continuity");

    companion object {
        fun fromCode(code: Int): PcmRole? = entries.firstOrNull { it.code == code }
    }
}

class AhpcProtocolException(message: String) : Exception(message)

/** One validated `AHPC` frame: decoded PCM (version 1) or encoded audio bytes (version 2). */
sealed class AhpcFrame(
    val role: PcmRole,
    val generation: Long,
    val streamId: Long,
    val sequence: Long,
    val bytes: ByteArray,
) {
    val payloadOffset: Int get() = AhpcFrameCodec.HEADER_BYTES
}

/** Interleaved f32le stereo samples in [bytes]. */
class AhpcPcmFrame(role: PcmRole, generation: Long, streamId: Long, sequence: Long, val frameCount: Int, bytes: ByteArray) :
    AhpcFrame(role, generation, streamId, sequence, bytes)

/** [payloadLength] encoded bytes in [bytes]; the server's credit for them counted bytes. */
class AhpcEncodedFrame(role: PcmRole, generation: Long, streamId: Long, sequence: Long, val payloadLength: Int, bytes: ByteArray) :
    AhpcFrame(role, generation, streamId, sequence, bytes)

/**
 * The `AHPC` binary frame from `pack_pcm_frame` and `pack_encoded_frame`: a 24-byte big-endian
 * header (`AHPC`, version, role, reserved u16, generation, stream id, sequence, count as u32)
 * followed by little-endian float32 stereo frames (version 1) or that many encoded bytes (version 2).
 */
object AhpcFrameCodec {
    const val HEADER_BYTES = 24
    const val BYTES_PER_FRAME = 8
    private const val PCM_VERSION = 1
    private const val ENCODED_VERSION = 2
    private val MAGIC = "AHPC".toByteArray(Charsets.US_ASCII)

    fun decode(bytes: ByteArray): AhpcFrame {
        if (bytes.size < HEADER_BYTES) throw AhpcProtocolException("frame is shorter than the AHPC header")
        if ((0 until 4).any { bytes[it] != MAGIC[it] }) throw AhpcProtocolException("bad AHPC magic")
        val version = u8(bytes, 4)
        if (version != PCM_VERSION && version != ENCODED_VERSION) {
            throw AhpcProtocolException("unsupported AHPC version")
        }
        val role = PcmRole.fromCode(u8(bytes, 5)) ?: throw AhpcProtocolException("invalid stream role")
        if (u8(bytes, 6) != 0 || u8(bytes, 7) != 0) throw AhpcProtocolException("nonzero reserved flags")
        val count = u32(bytes, 20)
        val unit = if (version == PCM_VERSION) BYTES_PER_FRAME else 1
        if (count <= 0 || bytes.size.toLong() != HEADER_BYTES + count * unit) {
            throw AhpcProtocolException("declared frame length does not match payload")
        }
        val generation = u32(bytes, 8)
        val streamId = u32(bytes, 12)
        val sequence = u32(bytes, 16)
        return if (version == PCM_VERSION) {
            AhpcPcmFrame(role, generation, streamId, sequence, count.toInt(), bytes)
        } else {
            AhpcEncodedFrame(role, generation, streamId, sequence, count.toInt(), bytes)
        }
    }

    private fun u8(bytes: ByteArray, offset: Int): Int = bytes[offset].toInt() and 0xFF

    private fun u32(bytes: ByteArray, offset: Int): Long =
        (0 until 4).fold(0L) { value, index -> (value shl 8) or u8(bytes, offset + index).toLong() }
}
