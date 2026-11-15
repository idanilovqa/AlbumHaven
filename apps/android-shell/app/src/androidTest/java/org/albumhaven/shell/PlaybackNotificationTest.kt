package org.albumhaven.shell

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.os.IBinder
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.albumhaven.playback.engine.FakeAhpcServer
import org.albumhaven.playback.engine.RATE
import org.albumhaven.playback.engine.SyntheticTrack
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.PlaybackServiceBinder
import org.albumhaven.shell.playback.PlaybackServiceHandle
import org.albumhaven.shell.playback.QueueItem
import org.albumhaven.shell.playback.QueueLoad
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Owner reports (2026-11-09) on the real playback service, its Media3 session and notification,
 * playing from a local origin at the debug build's address: the paused media card disappeared
 * after about a minute, and the notification's artist line lacked the album's year.
 */
@RunWith(AndroidJUnit4::class)
class PlaybackNotificationTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val track = SyntheticTrack(tag = 5, frames = 120L * RATE)
    private val short = SyntheticTrack(tag = 6, frames = 3L * RATE)
    private val origin = DeviceOrigin(FakeAhpcServer(listOf(track, short))).start(DeviceOrigin.DEV_PORT)
    private var connection: ServiceConnection? = null
    private lateinit var handle: PlaybackServiceHandle
    private val item = item(track)

    private fun item(of: SyntheticTrack) = QueueItem(
        playbackRef = of.pcm.playbackRef,
        title = "Signal ${of.tag}",
        artist = "Device Artist",
        album = "Device Album",
        artworkUrl = null,
        durationMs = of.frames * 1000 / RATE,
        listenKey = "lk-${of.tag}",
        year = "1999",
    )

    @After
    fun tearDown() {
        connection?.let { bound ->
            onMain { handle.port.stop() }
            context.unbindService(bound)
        }
        context.stopService(Intent(context, PlaybackService::class.java))
        waitUntil("service stopped") { playbackService() == null }
        origin.close()
        context.getSharedPreferences("playback_restore", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun theNotificationShowsArtistAlbumAndYearAndNoRating() {
        play()
        val card = mediaNotification()!!
        assertEquals("Signal 5", card.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals("Device Artist · Device Album · 1999", card.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        // Android 13 and later build the card from the session's metadata.
        val metadata = sessionMetadata(card)
        assertEquals("Device Artist · Device Album · 1999", metadata.getString(MediaMetadata.METADATA_KEY_ARTIST))
        assertNull(metadata.getRating(MediaMetadata.METADATA_KEY_RATING))
        assertNull(metadata.getRating(MediaMetadata.METADATA_KEY_USER_RATING))
        val shown = listOf(Notification.EXTRA_TITLE, Notification.EXTRA_TEXT, Notification.EXTRA_SUB_TEXT, Notification.EXTRA_INFO_TEXT)
            .mapNotNull { card.extras.getCharSequence(it)?.toString() }
        assertTrue("a rating shows on the card: $shown", shown.none { text -> text.any { it in "★☆⭐" } })
    }

    @Test
    fun thePausedMediaCardStaysWithTheServiceInTheForeground() {
        play()
        onMain { handle.port.pause() }
        waitUntil("paused") { handle.port.snapshot.state == NativePlaybackState.PAUSED }

        // The card disappeared about a minute after a pause; it must outlast that, still paused.
        val pausedAt = System.currentTimeMillis()
        while (System.currentTimeMillis() - pausedAt < PAUSED_WATCH_MS) {
            assertTrue("the paused card is gone", mediaNotification() != null)
            assertEquals("the service left the foreground", true, playbackService()?.foreground)
            Thread.sleep(1_000)
        }
        assertEquals(NativePlaybackState.PAUSED, handle.port.snapshot.state)
        val card = mediaNotification()!!
        assertEquals("Signal 5", card.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
    }

    /** Media3 leaves the foreground at most ten minutes after a pause; here its timeout is two seconds. */
    @Test
    fun thePausedCardOutlastsMedia3sForegroundTimeoutAndAStopStillLeavesTheForeground() {
        play()
        onMain { playbackServiceInstance().setForegroundServiceTimeoutMs(SHORT_TIMEOUT_MS) }
        onMain { handle.port.pause() }
        waitUntil("paused") { handle.port.snapshot.state == NativePlaybackState.PAUSED }

        val pausedAt = System.currentTimeMillis()
        while (System.currentTimeMillis() - pausedAt < SHORT_TIMEOUT_MS * 5) {
            assertTrue("the paused card is gone", mediaNotification() != null)
            assertEquals("the service left the foreground", true, playbackService()?.foreground)
            Thread.sleep(500)
        }
        onMain { handle.port.stop() }
        waitUntil("the stopped service out of the foreground") { playbackService()?.foreground != true }
    }

    @Test
    fun anEndedQueueLeavesTheForeground() {
        play(item(short))
        onMain { playbackServiceInstance().setForegroundServiceTimeoutMs(SHORT_TIMEOUT_MS) }
        waitUntil("the queue ended") { handle.port.snapshot.state == NativePlaybackState.ENDED }
        waitUntil("the ended service out of the foreground") { playbackService()?.foreground != true }
    }

    private fun play(queued: QueueItem = item) {
        val bound = CountDownLatch(1)
        val serviceConnection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, binder: IBinder) {
                handle = (binder as PlaybackServiceBinder).handle
                bound.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName) = Unit
        }
        assertTrue(context.bindService(PlaybackService.shellBindIntent(context), serviceConnection, Context.BIND_AUTO_CREATE))
        connection = serviceConnection
        assertTrue(bound.await(10, TimeUnit.SECONDS))
        onMain { handle.port.loadQueue(QueueLoad(1, listOf(queued), 0, 0, null, autoplay = true)) }
        waitUntil("playing") { handle.port.snapshot.state == NativePlaybackState.PLAYING }
        waitUntil("the media notification") { mediaNotification() != null && playbackService()?.foreground == true }
    }

    private fun mediaNotification(): Notification? =
        context.getSystemService(NotificationManager::class.java).activeNotifications
            .map { it.notification }
            .firstOrNull { it.extras.containsKey(Notification.EXTRA_MEDIA_SESSION) }

    private fun sessionMetadata(card: Notification): MediaMetadata {
        val token = card.extras.getParcelable<MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION)!!
        return MediaController(context, token).metadata!!
    }

    @Suppress("DEPRECATION") // Still lists the caller's own services, which is all this needs.
    private fun playbackService(): ActivityManager.RunningServiceInfo? =
        context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE)
            .firstOrNull { it.service.className == PlaybackService::class.java.name && it.service.packageName == context.packageName }

    /** The service this test bound, to shorten Media3's timeout through its public setter. */
    private fun playbackServiceInstance(): PlaybackService {
        val owner = handle.javaClass.declaredFields.first { it.type == PlaybackService::class.java }
        return owner.apply { isAccessible = true }.get(handle) as PlaybackService
    }

    private fun onMain(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private companion object {
        /** Longer than the "about a minute" after which the owner's paused card disappeared. */
        const val PAUSED_WATCH_MS = 75_000L
        const val SHORT_TIMEOUT_MS = 2_000L
    }
}
