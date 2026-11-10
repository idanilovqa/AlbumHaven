package org.albumhaven.shell.playback

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.core.net.toUri
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture

/**
 * The native queue as a Media3 player, so the session, its notification, the lock screen, media
 * buttons and Bluetooth see one ordinary player. Every request becomes a [SystemAction] sent to
 * the controller as [CommandSource.SYSTEM]; state comes only from the controller's snapshot.
 * [resume] may take a request first, to resume a restored or long-paused queue with fresh
 * references; it answers null to leave the request to the controller. Runs on the main looper.
 */
@OptIn(UnstableApi::class)
class NativeMediaPlayer(
    looper: Looper,
    private val controller: () -> NativePlaybackController,
    private val origin: () -> String,
    private val resume: (SystemRequest) -> ListenableFuture<*>? = { null },
) : SimpleBasePlayer(looper) {

    private val handler = Handler(looper)
    private var restored: RestorableQueue? = null
    private var resuming = false
    private var resumeFailure: PlaybackException? = null
    private var playlistKey: List<SessionItem>? = null
    private var playlist: List<MediaItemData> = emptyList()
    private var lastPositionMs = 0L
    private var lastPositionAtMs = 0L
    private var lastPlaying = false
    private var discontinuityMs: Long? = null

    /** Shows the queue saved before process death until a real queue is applied. */
    fun showRestored(queue: RestorableQueue?) {
        restored = queue
        invalidateState()
    }

    /**
     * While [resuming], a restored queue shows as buffering. Until the next attempt a [failure]'s
     * message replaces the current item's artist line, so the media card says why playback did not
     * resume, and it is the player error of a failed, idle view.
     */
    fun showResumption(resuming: Boolean, failure: PlaybackException? = null) {
        this.resuming = resuming
        resumeFailure = failure
        invalidateState()
    }

    /** Follows one controller event; regular position ticks are extrapolated, not republished. */
    fun onEvent(event: NativePlaybackEvent) {
        val snapshot = event.snapshot
        if (snapshot.items.isNotEmpty()) restored = null
        val now = SystemClock.elapsedRealtime()
        val jumped = SessionMapping.jumped(lastPositionMs, lastPositionAtMs, lastPlaying, snapshot.positionMs, now)
        val playing = snapshot.state == NativePlaybackState.PLAYING
        lastPositionMs = snapshot.positionMs
        lastPositionAtMs = now
        val playingChanged = playing != lastPlaying
        lastPlaying = playing
        if (event is NativePlaybackEvent.Position && !jumped && !playingChanged) return
        if (jumped && event !is NativePlaybackEvent.CurrentItem) discontinuityMs = snapshot.positionMs
        invalidateState()
        discontinuityMs = null
    }

    override fun getState(): State {
        val snapshot = controller().snapshot
        val view = SessionMapping.withNotice(
            restored?.takeIf { snapshot.items.isEmpty() }?.let { SessionMapping.restoredView(it, resuming, failed = resumeFailure != null) }
                ?: SessionMapping.view(snapshot, origin()),
            resumeFailure?.message,
        )
        val builder = State.Builder()
            .setAvailableCommands(commands(view))
            .setAudioAttributes(MUSIC)
            .setPlaylist(playlistFor(view.items))
            .setPlayWhenReady(view.playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
            .setPlaybackState(playbackState(view.state))
            // No restart threshold: the web's previous never restarts the current track.
            .setMaxSeekToPreviousPositionMs(Long.MAX_VALUE)
        if (view.items.isNotEmpty()) {
            builder.setCurrentMediaItemIndex(view.currentIndex)
                .setContentPositionMs(
                    if (view.playing) {
                        PositionSupplier.getExtrapolating(view.positionMs, 1f)
                    } else {
                        PositionSupplier.getConstant(view.positionMs)
                    },
                )
        }
        // Media3 accepts a player error only while idle; a failure beside a paused queue shows as its notice alone.
        if (view.failed) builder.setPlayerError(resumeFailure ?: PlaybackException("Playback failed", null, PlaybackException.ERROR_CODE_UNSPECIFIED))
        discontinuityMs?.let { builder.setPositionDiscontinuity(Player.DISCONTINUITY_REASON_INTERNAL, it) }
        return builder.build()
    }

    override fun handleSetPlayWhenReady(playWhenReady: Boolean) =
        dispatch(SystemRequest.SetPlayWhenReady(playWhenReady))

    override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int) =
        dispatch(SystemRequest.Seek(mediaItemIndex, if (positionMs == C.TIME_UNSET) 0 else positionMs))

    override fun handleStop() = dispatch(SystemRequest.Stop)

    // The service owns the controller's lifetime; releasing the session only detaches it.
    override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

    /** Completes once the controller applied the command, so the next [getState] already reflects it. */
    private fun dispatch(request: SystemRequest): ListenableFuture<*> {
        resume(request)?.let { return it }
        val target = controller()
        val action = SessionMapping.route(request, target.snapshot) ?: return Futures.immediateVoidFuture()
        val from = CommandSource.SYSTEM
        when (action) {
            is SystemAction.Play -> target.play(action.queueRevision, from)
            SystemAction.Pause -> target.pause(from)
            is SystemAction.Seek -> target.seek(action.queueRevision, action.positionMs, from)
            is SystemAction.Next -> target.next(action.queueRevision, from)
            is SystemAction.Previous -> target.previous(action.queueRevision, from)
            SystemAction.Stop -> target.stop(from)
        }
        val applied = SettableFuture.create<Unit>()
        target.afterPendingCommands { handler.post { applied.set(Unit) } }
        return applied
    }

    private fun playlistFor(items: List<SessionItem>): List<MediaItemData> {
        if (items == playlistKey) return playlist
        playlistKey = items
        playlist = items.map { item ->
            val metadata = MediaMetadata.Builder()
                .setTitle(item.title)
                .setArtist(item.artist)
                .setAlbumTitle(item.album)
                .setArtworkUri(item.artworkUri?.toUri())
                .setDurationMs(item.durationMs.takeIf { it > 0 })
                .setIsPlayable(true)
                .setIsBrowsable(false)
                .build()
            MediaItemData.Builder(item.uid)
                .setMediaItem(MediaItem.Builder().setMediaId(item.uid).setMediaMetadata(metadata).build())
                .setDurationUs(if (item.durationMs > 0) item.durationMs * 1000 else C.TIME_UNSET)
                .setIsSeekable(item.durationMs > 0)
                .build()
        }
        return playlist
    }

    private fun commands(view: SessionView): Player.Commands {
        val builder = Player.Commands.Builder().addAll(
            Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
            Player.COMMAND_GET_TIMELINE,
            Player.COMMAND_GET_METADATA,
            Player.COMMAND_GET_AUDIO_ATTRIBUTES,
        )
        view.controls.forEach { control ->
            when (control) {
                SystemControl.PLAY_PAUSE -> builder.add(Player.COMMAND_PLAY_PAUSE)
                SystemControl.STOP -> builder.add(Player.COMMAND_STOP)
                SystemControl.SEEK_IN_ITEM -> builder.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
                SystemControl.PREVIOUS_ITEM -> builder.add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                SystemControl.NEXT_ITEM ->
                    builder.addAll(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM, Player.COMMAND_SEEK_TO_NEXT)
            }
        }
        // Previous always steps back, as the web's does, and only where the web's is enabled.
        if (SystemControl.PREVIOUS_ITEM in view.controls) builder.add(Player.COMMAND_SEEK_TO_PREVIOUS)
        return builder.build()
    }

    private fun playbackState(state: SessionPlaybackState): Int = when (state) {
        SessionPlaybackState.IDLE -> Player.STATE_IDLE
        SessionPlaybackState.BUFFERING -> Player.STATE_BUFFERING
        SessionPlaybackState.READY -> Player.STATE_READY
        SessionPlaybackState.ENDED -> Player.STATE_ENDED
    }

    private companion object {
        val MUSIC: AudioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()
    }
}
