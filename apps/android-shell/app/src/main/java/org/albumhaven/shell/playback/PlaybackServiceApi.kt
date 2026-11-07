package org.albumhaven.shell.playback

import android.app.PendingIntent
import android.os.Binder
import okhttp3.OkHttpClient

/** The native player as the web bridge drives it. */
interface NativePlaybackPort {
    val snapshot: NativePlaybackSnapshot
    fun loadQueue(load: QueueLoad): CommandResult
    fun play(queueRevision: Long): CommandResult
    fun pause()
    fun stop()
    fun next(queueRevision: Long): CommandResult
    fun previous(queueRevision: Long): CommandResult
    fun seek(queueRevision: Long, positionMs: Long): CommandResult
    fun setLoop(queueRevision: Long, range: LoopRange48k?): CommandResult

    /** A document negotiated the bridge: it refreshes expiring references, and its first start finds warm connections. */
    fun documentAttached()

    /** The negotiated document is gone (a page started, or the Activity went); the next one counts revisions from one. */
    fun documentDetached()
}

/** [controller] names the current origin's controller, which a sandbox switch replaces. */
class ControllerPlaybackPort(
    private val controller: () -> NativePlaybackController,
    private val attachment: (attached: Boolean) -> Unit = {},
) : NativePlaybackPort {
    override val snapshot get() = controller().snapshot
    override fun loadQueue(load: QueueLoad) = controller().loadQueue(load)
    override fun play(queueRevision: Long) = controller().play(queueRevision)
    override fun pause() = controller().pause()
    override fun stop() = controller().stop()
    override fun next(queueRevision: Long) = controller().next(queueRevision)
    override fun previous(queueRevision: Long) = controller().previous(queueRevision)
    override fun seek(queueRevision: Long, positionMs: Long) = controller().seek(queueRevision, positionMs)
    override fun setLoop(queueRevision: Long, range: LoopRange48k?) = controller().setLoop(queueRevision, range)

    override fun documentAttached() {
        attachment(true)
        controller().warmConnections()
    }

    override fun documentDetached() {
        attachment(false)
        controller().documentDetached()
    }
}

/** What the app's own UI uses of the playback service it binds in-process. Main thread only. */
interface PlaybackServiceHandle {
    /** Always the selected origin's player. */
    val port: NativePlaybackPort

    /** Another origin never inherits playback: the old one stops and releases its claim. */
    fun selectOrigin(origin: String)

    /** Receives every controller event on the main thread; null stops them. */
    fun setEventListener(listener: ((NativePlaybackEvent) -> Unit)?)

    /** Stops, checkpoints and releases playback before Android replaces the package, then runs [done]. */
    fun prepareForPackageReplacement(done: () -> Unit)
}

/** The in-process binder the service hands only to the app's own bind intent. */
class PlaybackServiceBinder(val handle: PlaybackServiceHandle) : Binder()

/** What the app hosting the playback service provides it; the app's `Application` implements it. */
interface PlaybackHost {
    /** The session client ([org.albumhaven.shell.net.ShellSession.client]) every playback request uses. */
    val client: OkHttpClient

    /** The origin playback belongs to when a new process starts. */
    fun initialOrigin(): String

    /** The signed-in session's cookie header for [url], read per request and never stored. */
    fun cookies(url: String): String?

    /** Opens the app, from the notification and from the media card's sign-in prompt. */
    fun sessionActivity(): PendingIntent
}
