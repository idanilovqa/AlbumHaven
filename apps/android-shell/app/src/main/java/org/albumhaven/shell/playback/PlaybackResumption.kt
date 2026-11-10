package org.albumhaven.shell.playback

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.albumhaven.shell.net.ShellSession
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/** `POST /playback/refs/resume`'s answer for one batch of resume tokens. */
sealed interface ResumeAnswer {
    /** One fresh reference per token, in order; null where the track's file is no longer current. */
    data class Refs(val playbackRefs: List<String?>) : ResumeAnswer

    /** The WebView session is missing or no longer signed in: only the app can fix that. */
    data object SignedOut : ResumeAnswer

    /** Refused for any other reason (another account, a rotated key, no access) or unreachable. */
    data object Unavailable : ResumeAnswer
}

fun interface ResumeApi {
    fun exchange(resumeTokens: List<String>): ResumeAnswer
}

/** The exchange with the WebView session's cookies and CSRF header, read for this request only. */
class HttpResumeApi(client: OkHttpClient, private val session: ShellSession) : ResumeApi {
    private val client = client.newBuilder().callTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS).build()

    override fun exchange(resumeTokens: List<String>): ResumeAnswer {
        val tracks = JSONArray()
        resumeTokens.forEachIndexed { index, token -> tracks.put(JSONObject().put("clientKey", "$index").put("resumeToken", token)) }
        val request = session.authorize(Request.Builder(), withCsrf = true)
            .url("${session.origin()}/playback/refs/resume")
            .header("Cache-Control", "no-store")
            .post(JSONObject().put("protocol", 1).put("tracks", tracks).toString().toRequestBody(JSON))
            .build()
        // Without a session cookie the server could only refuse; signing in to the app is the answer.
        if (request.header("Cookie")?.contains(SESSION_COOKIE) != true) return ResumeAnswer.SignedOut
        return try {
            client.newCall(request).execute().use { response ->
                when {
                    response.code == 401 -> ResumeAnswer.SignedOut
                    !response.isSuccessful -> ResumeAnswer.Unavailable
                    else -> parse(response.body.string(), resumeTokens.size)
                }
            }
        } catch (_: IOException) {
            ResumeAnswer.Unavailable
        }
    }

    private fun parse(text: String, count: Int): ResumeAnswer = try {
        val answer = JSONObject(text)
        val tracks = answer.opt("tracks") as? JSONArray
        if (answer.opt("protocol") != 1 || tracks == null || tracks.length() != count) {
            ResumeAnswer.Unavailable
        } else {
            ResumeAnswer.Refs(
                (0 until count).map { index ->
                    val track = tracks.optJSONObject(index) ?: return ResumeAnswer.Unavailable
                    if (track.opt("clientKey") != "$index") return ResumeAnswer.Unavailable
                    when (val ref = track.opt("playbackRef")) {
                        JSONObject.NULL -> null
                        is String -> ref.takeIf(QueueItem::isPlaybackRef) ?: return ResumeAnswer.Unavailable
                        else -> return ResumeAnswer.Unavailable
                    }
                },
            )
        }
    } catch (_: JSONException) {
        ResumeAnswer.Unavailable
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        const val SESSION_COOKIE = "__Host-album_haven_session="
        const val TIMEOUT_SECONDS = 10L
    }
}

/**
 * Starts one exchange of resume tokens for the media session. A media key or Bluetooth play may
 * have started the service with `startForegroundService`, and Media3 enters the foreground only
 * once its player reports a buffering or playing item; until a command's future completes,
 * `SimpleBasePlayer` reports its placeholder, the idle restored queue. So [start] shows the queue
 * resuming and completes at once: a slow or stalled server cannot hold back the notification, and
 * playback still waits for fresh references, which [exchange] requests on [io] and hands to
 * [answered] on [main].
 */
class ResumeRunner(private val io: Executor, private val main: Executor) {
    fun start(
        exchange: () -> ResumeAnswer,
        showResuming: () -> Unit,
        answered: (ResumeAnswer) -> Unit,
    ): ListenableFuture<*> {
        showResuming()
        io.execute {
            // A request that cannot even be built, such as one OkHttp refuses, resumes nothing.
            val answer = try {
                exchange()
            } catch (_: RuntimeException) {
                ResumeAnswer.Unavailable
            }
            main.execute { answered(answer) }
        }
        return Futures.immediateVoidFuture()
    }
}

/**
 * Turns a restorable queue back into a playable one. Pure, so the media session only decides when
 * to resume: after process death from the saved queue, or when a long-paused queue's references
 * may have expired with no web document left to refresh them.
 */
object Resumption {

    /**
     * [queue] as Media3's playback resumption hands it to System UI: every item with its title,
     * artist, album and artwork, the current one at its saved position. System UI's boot-time
     * resumption browse keeps only the current item and builds a card only from a playable item
     * with a title; it draws a card's artwork only from the item's own bitmap, so [artworkData] is
     * the current item's cover. [artworkUri] makes a saved artwork path absolute.
     */
    @OptIn(UnstableApi::class)
    fun mediaItems(
        queue: RestorableQueue,
        artworkData: ByteArray?,
        artworkUri: (String) -> Uri?,
    ): MediaSession.MediaItemsWithStartPosition {
        val items = queue.items.mapIndexed { position, item ->
            val metadata = MediaMetadata.Builder()
                .setTitle(item.title)
                .setArtist(mediaCardArtistLine(item.artist, item.album, item.year))
                .setAlbumTitle(item.album)
                .setArtworkUri(item.artworkUrl?.let(artworkUri))
                .setDurationMs(item.durationMs.takeIf { it > 0 })
                .setIsPlayable(true)
                .setIsBrowsable(false)
            if (position == queue.currentIndex && artworkData != null) {
                metadata.setArtworkData(artworkData, MediaMetadata.PICTURE_TYPE_FRONT_COVER)
            }
            MediaItem.Builder().setMediaId("restored:$position").setMediaMetadata(metadata.build()).build()
        }
        return MediaSession.MediaItemsWithStartPosition(items, queue.currentIndex, queue.positionMs)
    }

    /** The tokens to exchange, in queue order; items without one cannot be resumed. */
    fun tokens(queue: RestorableQueue): List<String> = queue.items.mapNotNull { it.resumeToken }

    /**
     * Where a system request on [queue] resumes: its item and position. Previous and next step
     * inside the current album and start the neighbour from its beginning, as the web's skips do.
     */
    fun target(request: SystemRequest, queue: RestorableQueue): Pair<Int, Long>? {
        val index = queue.currentIndex
        val group = queue.items[index].queueGroup
        return when (request) {
            is SystemRequest.SetPlayWhenReady -> if (request.playWhenReady) index to queue.positionMs else null
            is SystemRequest.Seek -> when (val target = request.itemIndex) {
                index -> index to request.positionMs.coerceAtLeast(0)
                index - 1, index + 1 -> (target to 0L).takeIf { target in queue.items.indices && queue.items[target].queueGroup == group }
                else -> null
            }
            SystemRequest.Stop -> null
        }?.takeIf { (item, _) -> queue.items[item].resumeToken != null }
    }

    /**
     * The autoplaying load for [queue] with the [refs] issued for its [tokens], starting [target].
     * Items whose file is gone are left out; null when the target itself is one of them.
     */
    fun load(queue: RestorableQueue, refs: List<String?>, revision: Long, target: Pair<Int, Long>): QueueLoad? {
        val (targetIndex, positionMs) = target
        if (refs.size != tokens(queue).size) return null
        val issued = refs.iterator()
        val kept = queue.items.mapIndexedNotNull { position, item ->
            val ref = item.resumeToken?.let { issued.next() } ?: return@mapIndexedNotNull null
            position to QueueItem(
                ref, item.title, item.artist, item.album, item.artworkUrl, item.durationMs,
                item.trackNumber, item.listenKey, item.queueGroup, item.resumeToken, item.year,
            )
        }
        val currentIndex = kept.indexOfFirst { (position, _) -> position == targetIndex }
        if (currentIndex < 0) return null
        val start = positionMs.coerceIn(0, maxOf(0, queue.items[targetIndex].durationMs))
        return QueueLoad(revision, kept.map { it.second }, currentIndex, start, null, autoplay = true)
    }
}
