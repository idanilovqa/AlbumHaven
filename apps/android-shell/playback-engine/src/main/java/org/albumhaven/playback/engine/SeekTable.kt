package org.albumhaven.playback.engine

/** The bytes of an encoded stream from its first byte, as they arrive. */
class ByteStore(initialCapacity: Int = 64 * 1024) {
    var bytes = ByteArray(initialCapacity)
        private set
    var size = 0
        private set

    fun append(source: ByteArray, offset: Int, length: Int) {
        if (size + length > bytes.size) {
            var capacity = bytes.size
            while (capacity < size + length) capacity *= 2
            bytes = bytes.copyOf(capacity)
        }
        System.arraycopy(source, offset, bytes, size, length)
        size += length
    }

    fun copyOfRange(from: Int, to: Int): ByteArray = bytes.copyOfRange(from, to)
}

/**
 * The server's seek table of a stream (`seek-table`, music_app/services/playback_seek_table.py):
 * decoding the stream's bytes from offsets[i] yields decoder output from samples[i] on. The last
 * entry is the stream's end. The server reads the file; the device only looks positions up.
 */
class SeekTable(val prefixBytes: Int, val prerollFrames: Long, val offsets: IntArray, val samples: LongArray) {
    init {
        require(offsets.isNotEmpty() && offsets.size == samples.size) { "a seek table pairs every offset with a sample" }
    }
}

/**
 * Where a seek inside the received bytes starts decoding: the stream's first [prefixBytes], then
 * the bytes from [byteOffset], dropping [skipFrames] decoded frames and keeping [totalFrames].
 */
data class LocalSeekWindow(val prefixBytes: Int, val byteOffset: Int, val skipFrames: Long, val totalFrames: Long)

/**
 * `playback_seek_table.lookup`, which tests/fixtures/playback-seek-table-v1.json pins: the window for
 * [target] of a stream that started at [streamStart] with metadata [initialSkip] and [initialTotal],
 * or null while the bytes holding the target have not all arrived.
 */
fun SeekTable.lookup(
    initialSkip: Long,
    initialTotal: Long,
    streamStart: Long,
    target: Long,
    receivedBytes: Int,
    ended: Boolean,
): LocalSeekWindow? {
    val offsetInStream = target - streamStart
    if (offsetInStream < 0 || offsetInStream >= initialTotal) return null
    val kept = initialSkip + offsetInStream
    val entry = maxOf(0, upperBound(maxOf(0, kept - prerollFrames)) - 1)
    val after = upperBound(kept)
    if (after >= samples.size || (offsets[after] > receivedBytes && !ended)) return null
    return LocalSeekWindow(prefixBytes, offsets[entry], kept - samples[entry], initialTotal - offsetInStream)
}

/** The index of the first sample above [value], as Python's `bisect_right`. */
private fun SeekTable.upperBound(value: Long): Int {
    var low = 0
    var high = samples.size
    while (low < high) {
        val middle = (low + high) ushr 1
        if (samples[middle] <= value) low = middle + 1 else high = middle
    }
    return low
}
