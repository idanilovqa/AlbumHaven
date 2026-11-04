package org.albumhaven.shell.playback

import kotlin.math.abs

/** The Media3 playback states the native queue maps onto. */
enum class SessionPlaybackState { IDLE, BUFFERING, READY, ENDED }

/** Transport controls the notification, lock screen, media buttons and Bluetooth may use. */
enum class SystemControl { PLAY_PAUSE, STOP, SEEK_IN_ITEM, PREVIOUS_ITEM, NEXT_ITEM }

/** One playlist entry as system media controls show it; [artworkUri] is absolute and same-origin. */
data class SessionItem(
    val uid: String,
    val title: String,
    val artist: String,
    val album: String,
    val artworkUri: String?,
    val durationMs: Long,
)

/** What the media session reports. A [restored] view is the last queue shown after process death; it cannot play. */
data class SessionView(
    val items: List<SessionItem>,
    val currentIndex: Int,
    val positionMs: Long,
    val state: SessionPlaybackState,
    val playWhenReady: Boolean,
    val playing: Boolean,
    val controls: Set<SystemControl>,
    val failed: Boolean = false,
    val restored: Boolean = false,
)

/** A request from Android's media controls, as Media3 resolves it. */
sealed interface SystemRequest {
    data class SetPlayWhenReady(val playWhenReady: Boolean) : SystemRequest
    data class Seek(val itemIndex: Int, val positionMs: Long) : SystemRequest
    data object Stop : SystemRequest
}

/** The controller command a [SystemRequest] becomes, always naming the applied revision. */
sealed interface SystemAction {
    data class Play(val queueRevision: Long) : SystemAction
    data object Pause : SystemAction
    data class Seek(val queueRevision: Long, val positionMs: Long) : SystemAction
    data class Next(val queueRevision: Long) : SystemAction
    data class Previous(val queueRevision: Long) : SystemAction
    data object Stop : SystemAction
}

/** Maps native playback to Media3 and back. Pure, so the session adapter stays a thin shell. */
object SessionMapping {

    /** A reported position further than this from the extrapolated one is a seek, not drift. */
    const val DISCONTINUITY_MS = 1_000L

    fun view(snapshot: NativePlaybackSnapshot, origin: String): SessionView {
        val index = snapshot.currentIndex
        if (snapshot.items.isEmpty() || index == null) return empty()
        val items = snapshot.items.mapIndexed { position, item ->
            SessionItem(
                uid = "${snapshot.queueRevision}:$position",
                title = item.title,
                artist = item.artist,
                album = item.album,
                artworkUri = item.artworkUrl?.let { origin + it },
                durationMs = item.durationMs,
            )
        }
        val state = when (snapshot.state) {
            NativePlaybackState.LOADING, NativePlaybackState.BUFFERING -> SessionPlaybackState.BUFFERING
            NativePlaybackState.PLAYING, NativePlaybackState.PAUSED -> SessionPlaybackState.READY
            NativePlaybackState.ENDED -> SessionPlaybackState.ENDED
            NativePlaybackState.IDLE, NativePlaybackState.ERROR -> SessionPlaybackState.IDLE
        }
        val playWhenReady = snapshot.state == NativePlaybackState.LOADING ||
            snapshot.state == NativePlaybackState.BUFFERING || snapshot.state == NativePlaybackState.PLAYING
        val controls = if (snapshot.state == NativePlaybackState.IDLE) {
            emptySet()
        } else {
            buildSet {
                add(SystemControl.PLAY_PAUSE)
                add(SystemControl.STOP)
                if (items[index].durationMs > 0) add(SystemControl.SEEK_IN_ITEM)
                // The web's previous and next stay inside the album queue the item belongs to.
                val group = snapshot.items[index].queueGroup
                if (index > 0 && snapshot.items[index - 1].queueGroup == group) add(SystemControl.PREVIOUS_ITEM)
                if (index + 1 < items.size && snapshot.items[index + 1].queueGroup == group) add(SystemControl.NEXT_ITEM)
            }
        }
        return SessionView(
            items = items,
            currentIndex = index,
            positionMs = snapshot.positionMs,
            state = state,
            playWhenReady = playWhenReady,
            playing = snapshot.state == NativePlaybackState.PLAYING,
            controls = controls,
            failed = snapshot.state == NativePlaybackState.ERROR,
        )
    }

    /** The persisted last queue: shown paused with no controls, because nothing it holds can start playback. */
    fun restoredView(queue: RestorableQueue): SessionView = SessionView(
        items = queue.items.mapIndexed { position, item ->
            SessionItem(
                uid = "restored:$position",
                title = item.title,
                artist = item.artist,
                album = item.album,
                artworkUri = item.artworkUrl?.let { queue.origin + it },
                durationMs = item.durationMs,
            )
        },
        currentIndex = queue.currentIndex,
        positionMs = queue.positionMs,
        state = SessionPlaybackState.READY,
        playWhenReady = false,
        playing = false,
        controls = emptySet(),
        restored = true,
    )

    /** Returns null when the request does not apply to the native queue as it is now. */
    fun route(request: SystemRequest, snapshot: NativePlaybackSnapshot): SystemAction? {
        val revision = snapshot.queueRevision
        val index = snapshot.currentIndex ?: return null
        if (revision <= 0 || snapshot.items.isEmpty()) return null
        return when (request) {
            is SystemRequest.SetPlayWhenReady -> when (snapshot.state) {
                NativePlaybackState.PAUSED, NativePlaybackState.ERROR ->
                    if (request.playWhenReady) SystemAction.Play(revision) else null
                NativePlaybackState.LOADING, NativePlaybackState.BUFFERING, NativePlaybackState.PLAYING ->
                    if (request.playWhenReady) null else SystemAction.Pause
                // Media3 convention: an ended or stopped player waits for a seek or a new queue.
                NativePlaybackState.ENDED, NativePlaybackState.IDLE -> null
            }
            is SystemRequest.Seek -> when (request.itemIndex) {
                index -> SystemAction.Seek(revision, request.positionMs.coerceAtLeast(0))
                index + 1 -> SystemAction.Next(revision)
                index - 1 -> SystemAction.Previous(revision)
                else -> null
            }
            SystemRequest.Stop -> SystemAction.Stop
        }
    }

    /** True when [positionMs] cannot be explained by playing on from the last reported position. */
    fun jumped(lastPositionMs: Long, lastAtMs: Long, wasPlaying: Boolean, positionMs: Long, nowMs: Long): Boolean {
        val expected = lastPositionMs + if (wasPlaying) nowMs - lastAtMs else 0
        return abs(positionMs - expected) > DISCONTINUITY_MS
    }

    private fun empty() = SessionView(
        items = emptyList(),
        currentIndex = 0,
        positionMs = 0,
        state = SessionPlaybackState.IDLE,
        playWhenReady = false,
        playing = false,
        controls = emptySet(),
    )
}
