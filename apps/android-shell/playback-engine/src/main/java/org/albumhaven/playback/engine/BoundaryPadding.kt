package org.albumhaven.playback.engine

import kotlin.math.abs
import kotlin.math.log10
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * Decoder padding at a natural consecutive-album boundary, as the worklet's `classifyBoundaryPadding`
 * judges it: an edge run of at most 64 ms whose every frame stays below -40 dBFS and whose RMS sits
 * at least 20 dB under the next 10 ms of content. Anything else keeps every frame.
 */
internal enum class BoundaryEdge { PREFIX, SUFFIX }

internal data class PaddingDecision(
    val removableFrames: Int,
    val edgeRmsDb: Double,
    val contentRmsDb: Double,
    val confident: Boolean,
)

internal object BoundaryPadding {
    private const val MAX_EDGE_SECONDS = 0.064
    private const val CONTENT_SECONDS = 0.010
    private const val ABSOLUTE_MAX_DBFS = -40.0
    private const val MIN_CONTENT_DELTA_DB = 20.0
    private val REJECTED = PaddingDecision(0, 0.0, 0.0, false)

    /** The frames nearest an edge that a decision needs: the longest removable run plus its content window. */
    fun windowFrames(sampleRate: Int): Int = (sampleRate * (MAX_EDGE_SECONDS + CONTENT_SECONDS)).roundToInt()

    /** [interleavedStereo] holds the frames nearest [edge] in playback order. */
    fun classify(interleavedStereo: FloatArray, sampleRate: Int, edge: BoundaryEdge): PaddingDecision {
        if (interleavedStereo.size % PcmRing.CHANNELS != 0 || !interleavedStereo.all(Float::isFinite)) return REJECTED
        val frameCount = interleavedStereo.size / PcmRing.CHANNELS
        val maxEdgeFrames = (sampleRate * MAX_EDGE_SECONDS).roundToInt()
        val contentFrames = (sampleRate * CONTENT_SECONDS).roundToInt()
        val threshold = 10.0.pow(ABSOLUTE_MAX_DBFS / 20)
        // Counts inward from the edge.
        fun sampleAt(frame: Int, channel: Int): Float {
            val playbackFrame = if (edge == BoundaryEdge.PREFIX) frame else frameCount - 1 - frame
            return interleavedStereo[playbackFrame * PcmRing.CHANNELS + channel]
        }
        fun rmsDb(startFrame: Int, frames: Int): Double {
            var sum = 0.0
            for (frame in startFrame until startFrame + frames) {
                for (channel in 0 until PcmRing.CHANNELS) sum += sampleAt(frame, channel).toDouble().pow(2)
            }
            return 10 * log10(sum / (frames * PcmRing.CHANNELS))
        }
        var quietFrames = 0
        while (quietFrames < frameCount && quietFrames <= maxEdgeFrames &&
            abs(sampleAt(quietFrames, 0)) < threshold && abs(sampleAt(quietFrames, 1)) < threshold
        ) {
            quietFrames += 1
        }
        if (quietFrames == 0 || quietFrames > maxEdgeFrames || quietFrames + contentFrames > frameCount) return REJECTED
        val edgeRmsDb = rmsDb(0, quietFrames)
        val contentRmsDb = rmsDb(quietFrames, contentFrames)
        val confident = contentRmsDb - edgeRmsDb >= MIN_CONTENT_DELTA_DB
        return PaddingDecision(if (confident) quietFrames else 0, edgeRmsDb, contentRmsDb, confident)
    }
}
