package org.albumhaven.shell.playback

import kotlin.math.abs

/** The Media3 playback states the native queue maps onto. */
enum class SessionPlaybackState { IDLE, BUFFERING, READY, ENDED }

/** Transport controls the notification, lock screen, media buttons and Bluetooth may use. */
enum class SystemControl { PLAY_PAUSE, STOP, SEEK_IN_ITEM, PREVIOUS_ITEM, NEXT_ITEM }

/**
 * The line under the title on system media cards. Android's card has no album line, so the
 * album joins the artist ("Artist · Album") unless it is blank or the same as the artist.
 */
fun mediaCardArtistLine(artist: String, album: String, year: String = ""): String =
    listOf(artist, album.takeUnless { it.equals(artist, ignoreCase = true) }.orEmpty(), year)
        .filter(String::isNotBlank).joinToString(" · ")

/**
 * One playlist entry as system media controls show it; [artist] is the card's line under the
 * title (see [mediaCardArtistLine]) and [artworkUri] is absolute and same-origin.
 */
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
                artist = mediaCardArtistLine(item.artist, item.album, item.year),
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
        val playWhenReady = snapshot.state.wanted
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

    /**
     * The persisted last queue. A resumable one offers play, and previous and next inside its
     * album, which [Resumption] turns into a fresh load; [resuming] shows it buffering while that
     * load's references are requested. Nothing else it holds can start playback.
     *
     * Until then it is idle, not paused: Media3 posts no notification for an idle player, so a
     * process started by System UI's boot-time resumption browse shows no second, short-lived
     * card, and Media3 answers that browse from `onPlaybackResumption` with the item's full
     * metadata instead of a title-less placeholder. A [failed] resumption stays idle with its
     * error, the only state a Media3 player may report an error in; having buffered, it keeps its
     * card, which says why.
     */
    fun restoredView(queue: RestorableQueue, resuming: Boolean = false, failed: Boolean = false): SessionView {
        val index = queue.currentIndex
        val group = queue.items[index].queueGroup
        fun resumable(position: Int) = queue.items.getOrNull(position)?.let { it.queueGroup == group && it.resumeToken != null } == true
        return SessionView(
            items = queue.items.mapIndexed { position, item ->
                SessionItem(
                    uid = "restored:$position",
                    title = item.title,
                    artist = mediaCardArtistLine(item.artist, item.album, item.year),
                    album = item.album,
                    artworkUri = item.artworkUrl?.let { queue.origin + it },
                    durationMs = item.durationMs,
                )
            },
            currentIndex = index,
            positionMs = queue.positionMs,
            state = if (resuming) SessionPlaybackState.BUFFERING else SessionPlaybackState.IDLE,
            playWhenReady = resuming,
            playing = false,
            controls = if (!queue.resumable) {
                emptySet()
            } else {
                buildSet {
                    add(SystemControl.PLAY_PAUSE)
                    if (resumable(index - 1)) add(SystemControl.PREVIOUS_ITEM)
                    if (resumable(index + 1)) add(SystemControl.NEXT_ITEM)
                }
            },
            failed = failed,
            restored = true,
        )
    }

    /** [notice] replaces the current item's artist line, so the media card says why playback did not resume. */
    fun withNotice(view: SessionView, notice: String?): SessionView {
        if (notice == null || view.items.isEmpty()) return view
        return view.copy(items = view.items.mapIndexed { position, item -> if (position == view.currentIndex) item.copy(artist = notice) else item })
    }

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
            // Media3 resolves a repeated skip against the item its previous one is still moving to,
            // so a press that arrives before the snapshot follows names an item further along.
            // Every press is one step from wherever the controller stands when it applies it.
            is SystemRequest.Seek -> when {
                request.itemIndex !in snapshot.items.indices -> null
                request.itemIndex > index -> SystemAction.Next(revision)
                request.itemIndex < index -> SystemAction.Previous(revision)
                else -> SystemAction.Seek(revision, request.positionMs.coerceAtLeast(0))
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
