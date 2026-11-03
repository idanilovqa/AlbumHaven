package org.albumhaven.shell

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import okhttp3.OkHttpClient
import org.albumhaven.shell.playback.AudioFocusPolicy
import org.albumhaven.shell.playback.AudioTrackPcmSink
import org.albumhaven.shell.playback.CommandSource
import org.albumhaven.shell.playback.FocusChange
import org.albumhaven.shell.playback.FocusEffect
import org.albumhaven.shell.playback.HttpListenEffectApi
import org.albumhaven.shell.playback.HttpPlaybackClaimApi
import org.albumhaven.shell.playback.NativeMediaPlayer
import org.albumhaven.shell.playback.NativePlaybackController
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.OkHttpConnectionWarmer
import org.albumhaven.shell.playback.OkHttpPcmTransportFactory
import org.albumhaven.shell.playback.PlaybackRestoreStore
import org.albumhaven.shell.playback.RestoreStorage
import org.albumhaven.shell.playback.SessionArtworkLoader
import org.albumhaven.shell.playback.ShellSession
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
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {

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
    private lateinit var session: MediaSession
    private lateinit var artwork: SessionArtworkLoader
    private lateinit var restoreStore: PlaybackRestoreStore
    private lateinit var audioManager: AudioManager
    private lateinit var focusRequest: AudioFocusRequest
    private var noisyRegistered = false
    private var lastSavedMs = 0L

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

        controller = createController(origin)
        player = NativeMediaPlayer(Looper.getMainLooper(), { controller }, { origin })
        player.showRestored(restoreStore.load(origin))
        artwork = SessionArtworkLoader(client) { session(origin) }
        session = MediaSession.Builder(this, player)
            .setSessionActivity(
                PendingIntent.getActivity(
                    this,
                    0,
                    Intent(this, ShellActivity::class.java),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )
            .setBitmapLoader(CacheBitmapLoader(artwork))
            .build()
        // No controller binds through the service intent (it is not exported), so the notification
        // and foreground handling start from this explicit registration.
        addSession(session)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession = session

    override fun onBind(intent: Intent?): IBinder? {
        val media = super.onBind(intent)
        return if (intent?.action == ACTION_BIND_SHELL) binder else media
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
    }

    override fun onDestroy() {
        session.release()
        player.release()
        retireController()
        artwork.release()
        apply(focusPolicy.onState(NativePlaybackState.IDLE))
        main.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun session(target: String) =
        ShellSession({ target }) { url -> CookieManager.getInstance().getCookie(url) }

    private fun createController(target: String): NativePlaybackController {
        val shellSession = session(target)
        val clientId = UUID.randomUUID().toString()
        lateinit var created: NativePlaybackController
        created = NativePlaybackController(
            transports = OkHttpPcmTransportFactory(client, shellSession),
            claimApi = HttpPlaybackClaimApi(client, shellSession),
            listenApi = HttpListenEffectApi(client, shellSession),
            sinks = ::AudioTrackPcmSink,
            io = playbackIo,
            listenIo = listenIo,
            clock = SystemClock::elapsedRealtime,
            events = { event -> main.post { if (controller === created) onControllerEvent(event) } },
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
        controller.shutdown()
        // Pending claim releases finish on the old executors, against the old origin.
        playbackIo.shutdown()
        listenIo.shutdown()
        playbackIo = Executors.newSingleThreadExecutor()
        listenIo = Executors.newSingleThreadExecutor()
    }

    private fun onControllerEvent(event: NativePlaybackEvent) {
        player.onEvent(event)
        if (event is NativePlaybackEvent.State) apply(focusPolicy.onState(event.snapshot.state))
        saveRestorable(event)
        listeners.toList().forEach { it(event) }
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
        private const val RESTORE_PREFERENCES = "playback_restore"
        private const val KEY_QUEUE = "queue"
        private const val LISTEN_PREFERENCES = "listen"
        private const val KEY_DEVICE_ID = "device_id"
        private const val SAVE_INTERVAL_MS = 10_000L
    }
}
