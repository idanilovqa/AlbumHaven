package org.albumhaven.shell

import org.albumhaven.shell.net.isCanonicalUuid
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.Executor

/** The device's shared Downloads collection. [save] touches storage, so it runs off the main thread. */
fun interface DownloadsCollection {
    /** Whether [bytes] were stored as one new file named [name]. */
    fun save(name: String, mimeType: String, bytes: ByteArray): Boolean
}

/**
 * Saves files the page builds itself, such as the Log History export (`files.save.v1`). The
 * Download Manager cannot fetch a page's `blob:` URLs, so the page sends the bytes instead. Each
 * bridge message holds at most 64 KiB, so a file of up to [MAX_BYTES] arrives as base64 chunks of
 * one transfer, in order, each naming the whole file. The finished file is written on [io], and
 * its reply and [onSaved] come back through [main]. Main-thread confined.
 */
class FileSaves(
    private val collection: DownloadsCollection,
    private val io: Executor,
    private val main: (Runnable) -> Unit,
    private val onSaved: (saved: Boolean) -> Unit,
) {
    private class Transfer(val id: String, val name: String, val mimeType: String, val size: Int) {
        val bytes = ByteArray(size)
        var received = 0
    }

    private var open: Transfer? = null

    /** A page that goes leaves its unfinished file unsaved. */
    fun reset() {
        open = null
    }

    fun handle(payload: JSONObject, reply: (PlaybackBridge.Result) -> Unit) {
        if (payload.keys().asSequence().toSet() != KEYS) return reply(invalid())
        val id = (payload.opt("transfer") as? String)?.takeIf(::isCanonicalUuid)
        val name = payload.opt("name") as? String
        val mimeType = payload.opt("mimeType") as? String
        val size = payload.opt("size") as? Int
        val offset = payload.opt("offset") as? Int
        val chunk = (payload.opt("data") as? String)?.let(::decode)
        if (id == null || name == null || !NAME.matches(name) || mimeType == null || !MIME_TYPE.matches(mimeType) ||
            size == null || size < 1 || offset == null || chunk == null || chunk.isEmpty()
        ) {
            return reply(invalid())
        }
        if (size > MAX_BYTES) {
            open = null
            return reply(PlaybackBridge.Result.Failed("too_large", "Files are limited to 10 MB"))
        }
        if (offset == 0) open = Transfer(id, name, mimeType, size)
        val transfer = open
        if (transfer == null || transfer.id != id || transfer.name != name || transfer.mimeType != mimeType ||
            transfer.size != size || transfer.received != offset || chunk.size > size - offset
        ) {
            open = null
            return reply(invalid())
        }
        chunk.copyInto(transfer.bytes, offset)
        transfer.received += chunk.size
        if (transfer.received < size) return reply(PlaybackBridge.Result.Ok())
        open = null
        io.execute {
            val saved = try {
                collection.save(name, mimeType, transfer.bytes)
            } catch (_: RuntimeException) {
                false
            }
            main(
                Runnable {
                    onSaved(saved)
                    reply(if (saved) PlaybackBridge.Result.Ok() else PlaybackBridge.Result.Failed("save_failed", "The file was not saved"))
                },
            )
        }
    }

    private fun decode(data: String): ByteArray? = try {
        Base64.getDecoder().decode(data)
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun invalid() = PlaybackBridge.Result.Failed("invalid_payload", "Invalid file")

    companion object {
        const val MAX_BYTES = 10 * 1024 * 1024
        private val KEYS = setOf("transfer", "name", "mimeType", "size", "offset", "data")

        /** A plain file name: no directories, no leading dot, at most 128 characters. */
        private val NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$")
        private val MIME_TYPE = Regex("^[a-z]+/[a-z0-9][a-z0-9.+-]{0,63}$")
    }
}
