package org.albumhaven.shell.playback

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Fixed-capacity interleaved stereo float ring, as in gapless-playback-processor.js. */
class PcmRing(val capacityFrames: Int) {
    init {
        require(capacityFrames > 0) { "capacity must be positive" }
    }

    val samples = FloatArray(capacityFrames * CHANNELS)
    var readFrame = 0
        private set
    var bufferedFrames = 0
        private set
    private var writeFrame = 0

    val freeFrames: Int get() = capacityFrames - bufferedFrames

    fun appendLittleEndian(bytes: ByteArray, offset: Int, frames: Int) {
        require(frames in 0..freeFrames) { "frames exceed free ring capacity" }
        val source = ByteBuffer.wrap(bytes, offset, frames * AhpcFrameCodec.BYTES_PER_FRAME)
            .slice()
            .order(ByteOrder.LITTLE_ENDIAN)
            .asFloatBuffer()
        var remaining = frames
        while (remaining > 0) {
            val run = minOf(remaining, capacityFrames - writeFrame)
            source.get(samples, writeFrame * CHANNELS, run * CHANNELS)
            writeFrame = (writeFrame + run) % capacityFrames
            remaining -= run
        }
        bufferedFrames += frames
    }

    /** Appends [frames] interleaved stereo frames of [source] from sample [offsetSamples], as decoded audio arrives. */
    fun appendFloats(source: FloatArray, offsetSamples: Int, frames: Int) {
        require(frames in 0..freeFrames) { "frames exceed free ring capacity" }
        var copied = 0
        while (copied < frames) {
            val run = minOf(frames - copied, capacityFrames - writeFrame)
            System.arraycopy(source, offsetSamples + copied * CHANNELS, samples, writeFrame * CHANNELS, run * CHANNELS)
            writeFrame = (writeFrame + run) % capacityFrames
            copied += run
        }
        bufferedFrames += frames
    }

    /** Frames readable from [readFrame] without wrapping. */
    fun contiguousFrames(): Int = minOf(bufferedFrames, capacityFrames - readFrame)

    fun consume(frames: Int) {
        require(frames in 0..contiguousFrames()) { "frames exceed contiguous buffered PCM" }
        readFrame = (readFrame + frames) % capacityFrames
        bufferedFrames -= frames
    }

    /** Discards buffered frames, wrapping like the worklet's buffered-seek cursor advance. */
    fun skip(frames: Int) {
        require(frames in 0..bufferedFrames) { "frames exceed buffered PCM" }
        readFrame = (readFrame + frames) % capacityFrames
        bufferedFrames -= frames
    }

    /** Copies [frames] buffered frames starting [offsetFrames] after [readFrame] into [target] at [targetFrame]. */
    fun copyTo(offsetFrames: Int, frames: Int, target: FloatArray, targetFrame: Int) {
        require(offsetFrames >= 0 && frames >= 0 && offsetFrames + frames <= bufferedFrames) {
            "frames exceed buffered PCM"
        }
        var copied = 0
        while (copied < frames) {
            val source = (readFrame + offsetFrames + copied) % capacityFrames
            val run = minOf(frames - copied, capacityFrames - source)
            System.arraycopy(samples, source * CHANNELS, target, (targetFrame + copied) * CHANNELS, run * CHANNELS)
            copied += run
        }
    }

    fun clear() {
        readFrame = 0
        writeFrame = 0
        bufferedFrames = 0
    }

    companion object {
        const val CHANNELS = 2
    }
}
