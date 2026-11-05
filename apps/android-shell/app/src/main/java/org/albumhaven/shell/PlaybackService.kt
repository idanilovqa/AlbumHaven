package org.albumhaven.shell

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.albumhaven.shell.net.ShellSession
import org.albumhaven.shell.playback.AudioFocusPolicy
import org.albumhaven.shell.playback.AudioTrackPcmSink
import org.albumhaven.shell.playback.CommandResult
import org.albumhaven.shell.playback.CommandSource
import org.albumhaven.shell.playback.ControllerPlaybackPort
import org.albumhaven.shell.playback.CurrentItemReason
import org.albumhaven.shell.playback.FocusChange
import org.albumhaven.shell.playback.FocusEffect
import org.albumhaven.shell.playback.HttpListenEffectApi
import org.albumhaven.shell.playback.HttpPlaybackClaimApi
import org.albumhaven.shell.playback.HttpResumeApi
import org.albumhaven.shell.playback.NativeMediaPlayer
import org.albumhaven.shell.playback.NativePlaybackController
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackPort
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.OkHttpConnectionWarmer
import org.albumhaven.shell.playback.OkHttpPcmTransportFactory
import org.albumhaven.shell.playback.PlaybackHost
import org.albumhaven.shell.playback.PlaybackRestoreStore
import org.albumhaven.shell.playback.PlaybackServiceBinder
import org.albumhaven.shell.playback.PlaybackServiceHandle
import org.albumhaven.shell.playback.RestorableQueue
import org.albumhaven.shell.playback.RestoreStorage
import org.albumhaven.shell.playback.ResumeAnswer
import org.albumhaven.shell.playback.ResumeRunner
import org.albumhaven.shell.playback.Resumption
import org.albumhaven.shell.playback.SessionArtworkLoader
import org.albumhaven.shell.playback.SystemRequest
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Owns native playback for as long as it may be heard: the controller, its Media3 session and
 * notification, audio focus and becoming-noisy handling, and the restorable queue. The Activity
 * binds to it in-process through [PlaybackServiceHandle] and its WebView bridge drives the same
 * controller, so playback outlives the Activity, the screen and document reloads. The app's
 * [PlaybackHost] supplies the origin, the session cookies and the Activity to open. Media3's
 * default task-removal rule applies: a playing service keeps playing when the task is swiped
 * away; otherwise it stops and the controller releases its claim.
 *
 * Playback resumption: the service is a [MediaLibraryService] with Media3's `MediaButtonReceiver`,
 * so System UI keeps a resumable media card after the paused session's timeout, process death and
 * reboot, and Media3 answers its recent-item request with the restored queue. Play, previous or
 * next on that card, a media key or Bluetooth exchange the saved resume tokens for fresh references
 * with the WebView session and start playback without the app; a missing or expired sign-in shows
 * on the card instead, whose tap opens the app. Only trusted controllers (this app, System UI and
 * the platform's media-control holders) may connect.
 *
 * A restored queue stays idle until it is played, so after a reboot System UI's resumption browse
 * builds the card from [MediaLibrarySession.Callback.onPlaybackResumption]'s full metadata and
 * cover. A force-stop is the platform's: it removes the app's notification and System UI drops the
 * card until the app's next media session or a reboot; a media key still restarts and resumes playback.
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaLibraryService() {

    private val binder = PlaybackServiceBinder(Handle())
    private val main = Handler(Looper.getMainLooper())
    private val host: PlaybackHost get() = application as PlaybackHost
    private val client get() = host.client
    private var eventListener: ((NativePlaybackEvent) -> Unit)? = null

    /** Whether a document negotiated the bridge, so it refreshes the references it handed over. */
    private var documentAttached = false
    private val focusPolicy = AudioFocusPolicy(::requestFocus) { audioManager.abandonAudioFocusRequest(focusRequest) }
    private val port = ControllerPlaybackPort({ controller }) { attached -> documentAttached = attached }

    // One executor per controller lifetime, so a retired controller's release reaches its own origin.
    private var playbackIo: ExecutorService = Executors.newSingleThreadExecutor()
    private var listenIo: ExecutorService = Executors.newSingleThreadExecutor()

    /** A package-replacement preparation still waiting for its controller; a destroyed service answers it at once. */
    private var pendingReplacement: Runnable? = null

    @Volatile private lateinit var origin: String
    private lateinit var controller: NativePlaybackController

    private lateinit var player: NativeMediaPlayer
    private lateinit var session: MediaLibrarySession
    private lateinit var artwork: SessionArtworkLoader
    private lateinit var restoreStore: PlaybackRestoreStore
    private lateinit var audioManager: AudioManager
    private lateinit var focusRequest: AudioFocusRequest
    private var lastSavedMs = 0L

    // When the applied queue's references were issued at the latest, and the last revision refreshed for a failure.
    private var queueLoadedAtMs = 0L
    private var refreshedRevision = 0L
    private val resumeIo: ExecutorService = Executors.newSingleThreadExecutor()
    private val resumeRunner = ResumeRunner(resumeIo) { task -> main.post(task) }

    // A retired controller may still finish its listen writes after the service is gone.
    private var destroyed = false

    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) apply(focusPolicy.onBecomingNoisy())
        }
    }

    override fun onCreate() {
        super.onCreate()
        origin = host.initialOrigin()
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
            .setSessionActivity(host.sessionActivity())
            .setBitmapLoader(CacheBitmapLoader(artwork))
            .build()
        // The Activity binds through its own intent, so the notification and foreground handling
        // start from this explicit registration rather than a controller's first bind.
        addSession(session)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession = session

    /**
     * Android starts the service for a media key or Bluetooth play with `startForegroundService`.
     * A play that resumes shows buffering at once, so Media3 enters the foreground; one that cannot
     * (nothing saved, nothing resumable) leaves Media3 idle, and the service then meets the start
     * itself so Android does not end the process.
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val result = super.onStartCommand(intent, flags, startId)
        if (intent?.action == Intent.ACTION_MEDIA_BUTTON && foregroundServiceType == ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE) {
            main.removeCallbacks(meetForegroundStart)
            main.postDelayed(meetForegroundStart, FOREGROUND_START_CHECK_MS)
        }
        return result
    }

    /** As Media3 stops a service it cannot serve: briefly in the foreground with a hidden notification, then out. */
    private val meetForegroundStart = Runnable {
        if (destroyed || foregroundServiceType != ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE) return@Runnable
        val notifications = getSystemService(NotificationManager::class.java)
        Util.ensureNotificationChannel(
            notifications,
            DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID,
            getString(DefaultMediaNotificationProvider.DEFAULT_CHANNEL_NAME_RESOURCE_ID),
        )
        val notification = NotificationCompat.Builder(this, DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID)
            .setSmallIcon(androidx.media3.session.R.drawable.media3_notification_small_icon)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
        try {
            Util.setForegroundServiceNotification(
                this, UNSERVED_START_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK, "mediaPlayback",
            )
            Util.stopForeground(this, true)
        } catch (_: IllegalStateException) {
            // The media key's foreground allowance has lapsed; Android then no longer expects the start.
        }
    }

    /** The shell binder goes only to this process's own bind intent; every other bind is Media3's. */
    override fun onBind(intent: Intent?): IBinder? {
        val media = super.onBind(intent)
        if (intent?.action != ACTION_BIND_SHELL) return media
        return binder.takeIf { intent.data == SHELL_BINDING }
    }

    private inner class Handle : PlaybackServiceHandle {
        override val port: NativePlaybackPort get() = this@PlaybackService.port

        /**
         * Another origin never inherits playback: the old controller stops, releases its claim to
         * its own origin and is discarded, and the saved queue is forgotten.
         */
        override fun selectOrigin(origin: String) {
            if (origin == this@PlaybackService.origin) return
            retireController()
            newExecutors()
            restoreStore.clear()
            this@PlaybackService.origin = origin
            controller = createController(origin)
            player.showRestored(null)
            player.showResumption(false)
        }

        override fun setEventListener(listener: ((NativePlaybackEvent) -> Unit)?) {
            eventListener = listener
        }

        override fun prepareForPackageReplacement(done: () -> Unit) = this@PlaybackService.prepareForPackageReplacement(done)
    }

    /**
     * Before Android replaces the package: the origin's shutdown path stops playback, writes the
     * final listen checkpoint and releases the claim, and [done] runs on the main thread once those
     * requests have finished, or after [REPLACEMENT_WAIT_MS]. The stopped controller keeps reporting,
     * at the position it stopped, until then, so the document sees playback stop and the saved queue
     * resumes there; a fresh idle one with the same client ID then takes over in case the
     * installation is cancelled. The saved queue and the origin stay.
     */
    private fun prepareForPackageReplacement(done: () -> Unit) {
        val retiring = controller
        val retiredIo = listOf(playbackIo, listenIo)
        lateinit var finish: Runnable
        finish = Runnable {
            if (pendingReplacement !== finish) return@Runnable
            pendingReplacement = null
            main.removeCallbacks(finish)
            if (!destroyed && controller === retiring) {
                newExecutors()
                controller = createController(origin, retiring.snapshot.clientId)
            }
            done()
        }
        pendingReplacement = finish
        main.postDelayed(finish, REPLACEMENT_WAIT_MS)
        // Each executor's last task runs after the requests queued before it, then the executor stops.
        retiring.shutdown {
            val remaining = AtomicInteger(retiredIo.size)
            val drained = Runnable { if (remaining.decrementAndGet() == 0) main.post(finish) }
            retiredIo.forEach { executor ->
                executor.execute(drained)
                executor.shutdown()
            }
        }
    }

    override fun onDestroy() {
        destroyed = true
        session.release()
        player.release()
        retireController()
        // An update waiting for playback to stop is not left waiting for a service that is gone.
        pendingReplacement?.run()
        artwork.release()
        resumeIo.shutdownNow()
        focusPolicy.stopped(NativePlaybackState.IDLE)
        apply(focusPolicy.onState(NativePlaybackState.IDLE))
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun session(target: String) = ShellSession({ target }, host::cookies)

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
            startThread = { loop ->
                Thread({
                    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
                    loop.run()
                }, "AlbumHavenPlayback").start()
            },
            failures = { failure -> if (BuildConfig.DEBUG) Log.w(TAG, "Playback stopped", failure) },
            startGate = focusPolicy,
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
        val retiredIo = listOf(playbackIo, listenIo)
        controller.shutdown { retiredIo.forEach(ExecutorService::shutdown) }
    }

    /** The next controller's own executors. */
    private fun newExecutors() {
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
        eventListener?.invoke(event)
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
        !documentAttached && SystemClock.elapsedRealtime() - queueLoadedAtMs > REFERENCE_REFRESH_MS

    /** A failure from an expired reference, with no document to refresh it, retries once with fresh ones. */
    private fun refreshAfterFailure(event: NativePlaybackEvent) {
        val failed = event is NativePlaybackEvent.ReferenceExpired ||
            (event is NativePlaybackEvent.Error && event.code == "ownership_unavailable")
        val snapshot = event.snapshot
        if (!failed || documentAttached || refreshedRevision == snapshot.queueRevision) return
        val queue = RestorableQueue.of(snapshot, origin)?.takeIf { it.resumable } ?: return
        refreshedRevision = snapshot.queueRevision + 1
        resume(queue, refreshedRevision, queue.currentIndex to queue.positionMs)
    }

    /** Shows [queue] resuming at once, exchanges its resume tokens off the main thread, then plays [target] of a fresh load. */
    private fun resume(queue: RestorableQueue, revision: Long, target: Pair<Int, Long>): ListenableFuture<*> {
        val selected = origin
        val api = HttpResumeApi(client, session(selected))
        val tokens = Resumption.tokens(queue)
        return resumeRunner.start({ api.exchange(tokens) }, { player.showResumption(true) }) { answer ->
            if (destroyed || origin != selected) return@start
            val load = (answer as? ResumeAnswer.Refs)?.let { Resumption.load(queue, it.playbackRefs, revision, target) }
            if (load == null || controller.loadQueue(load) != CommandResult.ACCEPTED) {
                player.showResumption(false, resumeFailure(answer == ResumeAnswer.SignedOut))
            }
        }
    }

    /** Says why on the media card and offers the app, whose tap is the only way to sign in again. */
    private fun resumeFailure(signIn: Boolean): PlaybackException {
        val extras = Bundle().apply {
            putString(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_LABEL_COMPAT, getString(R.string.playback_resume_open_app))
            putParcelable(MediaConstants.EXTRAS_KEY_ERROR_RESOLUTION_ACTION_INTENT_COMPAT, host.sessionActivity())
        }
        return PlaybackException(
            getString(if (signIn) R.string.playback_resume_sign_in else R.string.playback_resume_unavailable),
            null,
            if (signIn) PlaybackException.ERROR_CODE_AUTHENTICATION_EXPIRED else PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
            extras,
        )
    }

    private inner class SessionCallback : MediaLibrarySession.Callback {
        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
            if (!controller.isTrusted && controller.packageName != packageName) return MediaSession.ConnectionResult.reject()
            // Media3's default commands and buttons. A Love button adds its SessionCommand and
            // CommandButton to this result, and its answer in onCustomCommand.
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session).build()
        }

        /**
         * Media3 asks while the player has no item, and for System UI's resumption browse while
         * the restored queue is idle, as after a reboot: that card is built from the current
         * item's metadata alone, so it carries the cover, loaded with the WebView session. A
         * missing cover leaves the card without artwork. Playing the restored queue goes through
         * [resumeFor].
         */
        override fun onPlaybackResumption(
            mediaSession: MediaSession,
            controller: MediaSession.ControllerInfo,
            isForPlayback: Boolean,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            val queue = restoreStore.load(origin)?.takeIf { it.resumable }
                ?: return Futures.immediateFailedFuture(UnsupportedOperationException("Nothing to resume"))
            val coverPath = queue.items[queue.currentIndex].artworkUrl.takeUnless { isForPlayback }
            val cover: ListenableFuture<ByteArray?> = if (coverPath == null) {
                Futures.immediateFuture(null)
            } else {
                Futures.catching(artwork.fetch(queue.origin + coverPath), Exception::class.java, { null }, MoreExecutors.directExecutor())
            }
            return Futures.transform(
                cover,
                { data -> Resumption.mediaItems(queue, data) { path -> Uri.parse(queue.origin + path) } },
                MoreExecutors.directExecutor(),
            )
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
                FocusEffect.Pause -> controller.interrupt()
                FocusEffect.Resume -> controller.play(controller.snapshot.queueRevision, CommandSource.SYSTEM)
                is FocusEffect.WatchNoisy -> watchNoisy(effect.enabled)
            }
        }
    }

    /** Asked by the playback thread before every start; the listener answers on the main thread. */
    private fun requestFocus() = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED

    private fun watchNoisy(enabled: Boolean) {
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

        /** Well inside Android's ten-second start deadline, and after Media3 has handled the key. */
        private const val FOREGROUND_START_CHECK_MS = 3_000L
        private const val UNSERVED_START_NOTIFICATION_ID = 1002

        /** The controller's own checkpoint wait is three seconds; this bounds the requests after it. */
        private const val REPLACEMENT_WAIT_MS = 8_000L
        private const val TAG = "AlbumHavenPlayback"
    }
}
