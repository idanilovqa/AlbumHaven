package org.albumhaven.shell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import okhttp3.OkHttpClient
import org.albumhaven.shell.playback.AudioFocusPolicy
import org.albumhaven.shell.playback.AudioTrackPcmSink
import org.albumhaven.shell.playback.CommandResult
import org.albumhaven.shell.playback.CommandSource
import org.albumhaven.shell.playback.CurrentItemReason
import org.albumhaven.shell.playback.FocusChange
import org.albumhaven.shell.playback.FocusEffect
import org.albumhaven.shell.playback.HttpListenEffectApi
import org.albumhaven.shell.playback.HttpPlaybackClaimApi
import org.albumhaven.shell.playback.HttpResumeApi
import org.albumhaven.shell.playback.NativeMediaPlayer
import org.albumhaven.shell.playback.NativePlaybackController
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.OkHttpConnectionWarmer
import org.albumhaven.shell.playback.OkHttpPcmTransportFactory
import org.albumhaven.shell.playback.PlaybackRestoreStore
import org.albumhaven.shell.playback.RestorableQueue
import org.albumhaven.shell.playback.RestoreStorage
import org.albumhaven.shell.playback.ResumeAnswer
import org.albumhaven.shell.playback.Resumption
import org.albumhaven.shell.playback.SessionArtworkLoader
import org.albumhaven.shell.playback.ShellSession
import org.albumhaven.shell.playback.SystemRequest
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Owns native playback for as long as it may be heard: the controller, its Media3 session and
 * notification, audio focus and becoming-noisy handling, and the restorable queue. The Activity
 * binds to it in-process and its WebView bridge drives the same controller, so playback outlives
 * the Activity, the screen and document reloads. Media3's default task-removal rule applies:
 * a playing service keeps playing when the task is swiped away; otherwise it stops and the
 * controller releases its claim.
 *
 * Playback resumption: the service is a [MediaLibraryService] with Media3's `MediaButtonReceiver`,
 * so System UI keeps a resumable media card after the paused session's timeout, process death and
 * reboot, and Media3 answers its recent-item request with the restored queue. Play, previous or
 * next on that card, a media key or Bluetooth exchange the saved resume tokens for fresh references
 * with the WebView session and start playback without the app; a missing or expired sign-in shows
 * on the card instead, whose tap opens the app. Only trusted controllers (this app, System UI and
 * the platform's media-control holders) may connect.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {

    inner class LocalBinder : Binder() {
        val service: PlaybackService get() = this@PlaybackService
    }

    private val binder = LocalBinder()
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient()
    private val listeners = mutableSetOf<(NativePlaybackEvent) -> Unit>()
    private val focusPolicy = AudioFocusPolicy()

    // One executor per controller lifetime, so a retired controller's release reaches its own origin.
    private var playbackIo: ExecutorService = Executors.newSingleThreadExecutor()
    private var listenIo: ExecutorService = Executors.newSingleThreadExecutor()

    @Volatile private lateinit var origin: String
    lateinit var controller: NativePlaybackController
        private set

    private lateinit var player: NativeMediaPlayer
    private lateinit var session: MediaLibrarySession
    private lateinit var artwork: SessionArtworkLoader
    private lateinit var restoreStore: PlaybackRestoreStore
    private lateinit var audioManager: AudioManager
    private lateinit var focusRequest: AudioFocusRequest
    private var noisyRegistered = false
    private var lastSavedMs = 0L

    // When the applied queue's references were issued at the latest, and the last revision refreshed for a failure.
    private var queueLoadedAtMs = 0L
    private var refreshedRevision = 0L
    private val resumeIo: ExecutorService = Executors.newSingleThreadExecutor()

    // A retired controller may still finish its listen writes after the service is gone.
    private var destroyed = false

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) apply(focusPolicy.onBecomingNoisy())
        }
    }

    override fun onCreate() {
        super.onCreate()
        val channel = ShellChannel.fromWireName(BuildConfig.CHANNEL)
        origin = OriginPolicy(channel, BuildConfig.DEV_ORIGIN).initialOrigin(ShellPreferences(this).selectedSandboxSlot)
        val preferences = getSharedPreferences(RESTORE_PREFERENCES, MODE_PRIVATE)
        restoreStore = PlaybackRestoreStore(object : RestoreStorage {
            override fun read(): String? = preferences.getString(KEY_QUEUE, null)
            override fun write(value: String?) = preferences.edit { if (value == null) remove(KEY_QUEUE) else putString(KEY_QUEUE, value) }
        })
        audioManager = getSystemService(AudioManager::class.java)
        focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                android.media.AudioAttributes.Builder()
                    .setUsage(android.media.AudioAttributes.USAGE_MEDIA)
                    .setContentType(android.media.AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            // The platform ducks a may-duck loss itself.
            .setWillPauseWhenDucked(false)
            .setOnAudioFocusChangeListener(::onAudioFocusChange, main)
            .build()

        val restored = restoreStore.load(origin)
        // The restored queue's controller ID lets the document that handed Android that queue adopt it again.
        controller = createController(origin, restored?.clientId)
        player = NativeMediaPlayer(Looper.getMainLooper(), { controller }, { origin }, ::resumeFor)
        player.showRestored(restored)
        artwork = SessionArtworkLoader(client) { session(origin) }
        session = MediaLibrarySession.Builder(this, player, SessionCallback())
            .setSessionActivity(openApp())
            .setBitmapLoader(CacheBitmapLoader(artwork))
            .setMediaButtonPreferences(SessionControls.buttons())
            .build()
        // The Activity binds through its own intent, so the notification and foreground handling
        // start from this explicit registration rather than a controller's first bind.
        addSession(session)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession = session

    /** The shell binder goes only to this process's own bind intent; every other bind is Media3's. */
    override fun onBind(intent: Intent?): IBinder? {
        val media = super.onBind(intent)
        if (intent?.action != ACTION_BIND_SHELL) return media
        return binder.takeIf { intent.data == SHELL_BINDING }
    }

    /** Listeners run on the main thread for every controller event. */
    fun addListener(listener: (NativePlaybackEvent) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (NativePlaybackEvent) -> Unit) {
        listeners -= listener
    }

    /**
     * Another origin never inherits playback: the old controller stops, releases its claim to its
     * own origin and is discarded, and the saved queue is forgotten.
     */
    fun selectOrigin(selected: String) {
        if (selected == origin) return
        retireController()
        restoreStore.clear()
        origin = selected
        controller = createController(selected)
        player.showRestored(null)
        player.showResumption(false)
    }

    override fun onDestroy() {
        destroyed = true
        session.release()
        player.release()
        retireController()
        artwork.release()
        resumeIo.shutdownNow()
        apply(focusPolicy.onState(NativePlaybackState.IDLE))
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun session(target: String) =
        ShellSession({ target }) { url -> CookieManager.getInstance().getCookie(url) }

    private fun createController(target: String, restoredClientId: String? = null): NativePlaybackController {
        val shellSession = session(target)
        val clientId = restoredClientId ?: UUID.randomUUID().toString()
        lateinit var created: NativePlaybackController
        created = NativePlaybackController(
            transports = OkHttpPcmTransportFactory(client, shellSession),
            claimApi = HttpPlaybackClaimApi(client, shellSession),
            listenApi = HttpListenEffectApi(client, shellSession),
            sinks = ::AudioTrackPcmSink,
            io = playbackIo,
            listenIo = listenIo,
            clock = SystemClock::elapsedRealtime,
            events = { event -> main.post { if (!destroyed && controller === created) onControllerEvent(event) } },
            clientId = clientId,
            warmer = OkHttpConnectionWarmer(client, shellSession, clientId),
            deviceId = listenDeviceId(),
        )
        return created.also { it.start() }
    }

    /** A random, path-free installation ID that keeps listen sessions apart, as the browser's per-profile one does. */
    private fun listenDeviceId(): String {
        val preferences = getSharedPreferences(LISTEN_PREFERENCES, MODE_PRIVATE)
        preferences.getString(KEY_DEVICE_ID, null)?.let { return it }
        return UUID.randomUUID().toString().also { id -> preferences.edit { putString(KEY_DEVICE_ID, id) } }
    }

    private fun retireController() {
        // The old controller finishes its last listen writes and claim release on the old
        // executors, against the old origin, without holding up the main thread.
        val retiredPlaybackIo = playbackIo
        val retiredListenIo = listenIo
        controller.shutdown {
            retiredPlaybackIo.shutdown()
            retiredListenIo.shutdown()
        }
        playbackIo = Executors.newSingleThreadExecutor()
        listenIo = Executors.newSingleThreadExecutor()
    }

    private fun onControllerEvent(event: NativePlaybackEvent) {
        if (event is NativePlaybackEvent.CurrentItem && event.reason == CurrentItemReason.LOAD) {
            queueLoadedAtMs = SystemClock.elapsedRealtime()
        }
        if (event.snapshot.state == NativePlaybackState.PLAYING) player.showResumption(false)
        player.onEvent(event)
        if (event is NativePlaybackEvent.State) apply(focusPolicy.onState(event.snapshot.state))
        saveRestorable(event)
        listeners.toList().forEach { it(event) }
        refreshAfterFailure(event)
    }

    // ---- Resumption ----

    /**
     * Takes a system request that the applied queue cannot serve by itself: the restored queue of a
     * new process, or, with no document attached to refresh them, a queue whose references may
     * have expired. Null leaves the request to the controller.
     */
    private fun resumeFor(request: SystemRequest): ListenableFuture<*>? {
        val snapshot = controller.snapshot
        val queue = if (snapshot.items.isEmpty()) {
            restoreStore.load(origin)
        } else {
            RestorableQueue.of(snapshot, origin)?.takeIf { referencesMayHaveExpired() }
        } ?: return null
        val target = Resumption.target(request, queue) ?: return null
        val revision = if (snapshot.items.isEmpty()) maxOf(1, queue.queueRevision) else snapshot.queueRevision + 1
        return resume(queue, revision, target)
    }

    private fun referencesMayHaveExpired() =
        listeners.isEmpty() && SystemClock.elapsedRealtime() - queueLoadedAtMs > REFERENCE_REFRESH_MS

    /** A failure from an expired reference, with no document to refresh it, retries once with fresh ones. */
    private fun refreshAfterFailure(event: NativePlaybackEvent) {
        val failed = event is NativePlaybackEvent.ReferenceExpired ||
            (event is NativePlaybackEvent.Error && event.code == "ownership_unavailable")
        val snapshot = event.snapshot
        if (!failed || listeners.isNotEmpty() || refreshedRevision == snapshot.queueRevision) return
        val queue = RestorableQueue.of(snapshot, origin)?.takeIf { it.resumable } ?: return
        refreshedRevision = snapshot.queueRevision + 1
        resume(queue, refreshedRevision, queue.currentIndex to queue.positionMs)
    }

    /** Exchanges [queue]'s resume tokens off the main thread, then plays [target] of a fresh load. */
    private fun resume(queue: RestorableQueue, revision: Long, target: Pair<Int, Long>): ListenableFuture<*> {
        val done = SettableFuture.create<Unit>()
        val selected = origin
        val api = HttpResumeApi(client, session(selected))
        val tokens = Resumption.tokens(queue)
        player.showResumption(true)
        resumeIo.execute {
            val answer = api.exchange(tokens)
            main.post {
                if (destroyed || origin != selected) {
                    done.set(Unit)
                    return@post
                }
                val load = (answer as? ResumeAnswer.Refs)?.let { Resumption.load(queue, it.playbackRefs, revision, target) }
                if (load != null && controller.loadQueue(load) == CommandResult.ACCEPTED) {
                    controller.afterPendingCommands { main.post { done.set(Unit) } }
                    return@post
                }
                player.showResumption(false, resumeFailure(answer == ResumeAnswer.SignedOut))
                done.set(Unit)
            }
        }
        return done
    }

    /** Says why on the media card and offers the app, whose tap is the only way to sign in again. */
    private fun resumeFailure(signIn: Boolean): PlaybackException {
        val extras = Bundle().apply {
            putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT, getString(R.string.playback_resume_open_app))
            putParcelable(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT, openApp())
        }
        return PlaybackException(
            getString(if (signIn) R.string.playback_resume_sign_in else R.string.playback_resume_unavailable),
            null,
            if (signIn) PlaybackException.ERROR_CODE_AUTHENTICATION_EXPIRED else PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            extras,
        )
    }

    private fun openApp(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, ShellActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private inner class SessionCallback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            if (!controller.isTrusted && controller.packageName != packageName) return MediaSession.ConnectionResult.reject()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(SessionControls.sessionCommands())
                .setMediaButtonPreferences(SessionControls.buttons())
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> = SessionControls.handle(customCommand)

        /**
         * Media3 asks only while the player has no item; the restored queue is otherwise the
         * player's own playlist, and playing it goes through [resumeFor].
         */
        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val queue = restoreStore.load(origin)?.takeIf { it.resumable }
                ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
            val items = queue.items.mapIndexed { position, item ->
                MediaItem.Builder()
                    .setMediaId("restored:$position")
                    .setMediaMetadata(
                        MediaMetadata.Builder()
                            .setTitle(item.title)
                            .setArtist(item.artist)
                            .setAlbumTitle(item.album)
                            .setArtworkUri(item.artworkUrl?.let { Uri.parse(queue.origin + it) })
                            .setIsPlayable(true)
                            .setIsBrowsable(false)
                            .build(),
                    )
                    .build()
            }
            return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(items, queue.currentIndex, queue.positionMs))
        }
    }

    /** Saves on every change and at most every few seconds while the position only advances. */
    private fun saveRestorable(event: NativePlaybackEvent) {
        val now = SystemClock.elapsedRealtime()
        if (event is NativePlaybackEvent.Position && now - lastSavedMs < SAVE_INTERVAL_MS) return
        lastSavedMs = now
        restoreStore.save(event.snapshot, origin)
    }

    private fun onAudioFocusChange(change: Int) {
        val mapped = when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> FocusChange.GAIN
            AudioManager.AUDIOFOCUS_LOSS -> FocusChange.LOSS
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> FocusChange.LOSS_TRANSIENT
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> FocusChange.LOSS_TRANSIENT_CAN_DUCK
            else -> return
        }
        apply(focusPolicy.onFocusChange(mapped))
    }

    private fun apply(effects: List<FocusEffect>) {
        effects.forEach { effect ->
            when (effect) {
                FocusEffect.Request -> apply(
                    focusPolicy.onRequestResult(
                        audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED,
                    ),
                )
                FocusEffect.Abandon -> audioManager.abandonAudioFocusRequest(focusRequest)
                FocusEffect.Pause -> controller.pause(CommandSource.SYSTEM)
                FocusEffect.Resume -> controller.play(controller.snapshot.queueRevision, CommandSource.SYSTEM)
                is FocusEffect.WatchNoisy -> watchNoisy(effect.enabled)
            }
        }
    }

    private fun watchNoisy(enabled: Boolean) {
        if (enabled == noisyRegistered) return
        noisyRegistered = enabled
        if (enabled) {
            ContextCompat.registerReceiver(
                this,
                noisyReceiver,
                IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
        } else {
            unregisterReceiver(noisyReceiver)
        }
    }

    companion object {
        const val ACTION_BIND_SHELL = "org.albumhaven.shell.action.BIND_PLAYBACK"

        /**
         * The service is exported for System UI, so the in-process binder answers only this
         * process's own bind intent: its data names a random value no other app knows, and the
         * platform caches a binder per intent including its data.
         */
        private val SHELL_BINDING: Uri = Uri.parse("albumhaven-shell://playback/" + UUID.randomUUID())

        fun shellBindIntent(context: Context): Intent =
            Intent(context, PlaybackService::class.java).setAction(ACTION_BIND_SHELL).setData(SHELL_BINDING)

        /** The web reuses a reference only with at least an hour left, so one applied earlier than this may expire. */
        private const val REFERENCE_REFRESH_MS = 45L * 60 * 1000
        private const val RESTORE_PREFERENCES = "playback_restore"
        private const val KEY_QUEUE = "queue"
        private const val LISTEN_PREFERENCES = "listen"
        private const val KEY_DEVICE_ID = "device_id"
        private const val SAVE_INTERVAL_MS = 10_000L
    }
}
