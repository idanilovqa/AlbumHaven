package org.albumhaven.playback.engine

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executor

/**
 * A whole track as the server streamed it encoded from its first frame: the file's own bytes and
 * the server's sample map, so it decodes exactly as the stream did.
 */
class CachedTrack(
    val codec: String,
    val sampleRate: Int,
    val skipFrames: Long,
    val totalFrames: Long,
    val bytes: ByteArray,
)

/** Recently played tracks kept on the device; [load] runs on the playback thread. */
interface TrackCache {
    fun load(key: String): CachedTrack?

    fun store(key: String, track: CachedTrack)
}

/**
 * Tracks as files in [directory], named by a digest of their opaque key so nothing of the library
 * is stored, and bounded by [quotaBytes]: the oldest-used go first. Android may also reclaim the
 * directory when storage runs low, which only costs a refetch. Writes run on [io].
 */
class DiskTrackCache(
    private val directory: File,
    private val quotaBytes: () -> Long,
    private val io: Executor,
) : TrackCache {
    override fun load(key: String): CachedTrack? {
        val file = fileFor(key)
        if (!file.isFile) return null
        return try {
            DataInputStream(file.inputStream().buffered()).use { input ->
                if (input.readInt() != FORMAT) return null
                val codec = input.readUTF()
                val sampleRate = input.readInt()
                val skipFrames = input.readLong()
                val totalFrames = input.readLong()
                val bytes = ByteArray(input.readInt())
                input.readFully(bytes)
                CachedTrack(codec, sampleRate, skipFrames, totalFrames, bytes)
            }.also { file.setLastModified(System.currentTimeMillis()) }
        } catch (_: IOException) {
            file.delete()
            null
        }
    }

    override fun store(key: String, track: CachedTrack) {
        io.execute {
            try {
                directory.mkdirs()
                val target = fileFor(key)
                val partial = File(directory, "${target.name}.partial")
                DataOutputStream(partial.outputStream().buffered()).use { output ->
                    output.writeInt(FORMAT)
                    output.writeUTF(track.codec)
                    output.writeInt(track.sampleRate)
                    output.writeLong(track.skipFrames)
                    output.writeLong(track.totalFrames)
                    output.writeInt(track.bytes.size)
                    output.write(track.bytes)
                }
                if (!partial.renameTo(target)) partial.delete()
                evictOverQuota()
            } catch (_: IOException) {
                // A track that cannot be kept is streamed again next time.
            }
        }
    }

    private fun evictOverQuota() {
        val files = directory.listFiles { file -> file.isFile && file.name.endsWith(SUFFIX) }?.sortedBy { it.lastModified() }
            ?: return
        var total = files.sumOf { it.length() }
        val quota = quotaBytes()
        for (file in files) {
            if (total <= quota) return
            total -= file.length()
            file.delete()
        }
    }

    private fun fileFor(key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
        return File(directory, digest.joinToString("") { "%02x".format(it) } + SUFFIX)
    }

    private companion object {
        const val FORMAT = 1
        const val SUFFIX = ".track"
    }
}
