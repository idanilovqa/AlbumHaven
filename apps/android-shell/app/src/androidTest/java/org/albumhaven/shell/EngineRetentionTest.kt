package org.albumhaven.shell

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Debug
import android.os.IBinder
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.albumhaven.playback.engine.FakeAhpcServer
import org.albumhaven.playback.engine.NativePcmEngine
import org.albumhaven.playback.engine.PcmRing
import org.albumhaven.playback.engine.SyntheticTrack
import org.albumhaven.shell.playback.NativePlaybackController
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.PlaybackServiceBinder
import org.albumhaven.shell.playback.PlaybackServiceHandle
import org.albumhaven.shell.playback.QueueItem
import org.albumhaven.shell.playback.QueueLoad
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Runs 44483610670 and 44930900662 (API 29, 16 MB heap): a new engine's second PCM ring found no
 * memory, so an engine the controller had let go still held its rings. An engine holds two 12-second
 * rings, about 9 MB at 48 kHz, so two never fit that heap. The rings of an engine let go must be
 * collectable at once, whatever still refers to the engine: after a rate change replaces it, and
 * once the service that held it has ended. Retained rings are written as a heap dump to the run's
 * additional test output; a pass notes whether the engine object itself was collected too.
 */
@RunWith(AndroidJUnit4::class)
class EngineRetentionTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val low = SyntheticTrack(tag = 11, frames = 60L * LOW_RATE, sampleRate = LOW_RATE)
    private val high = SyntheticTrack(tag = 12, frames = 60L * HIGH_RATE, sampleRate = HIGH_RATE)
    private val origin = DeviceOrigin(FakeAhpcServer(listOf(low, high))).start(DeviceOrigin.DEV_PORT)
    private var connection: ServiceConnection? = null
    private lateinit var handle: PlaybackServiceHandle

    @After
    fun tearDown() {
        connection?.let { bound ->
            onMain { handle.port.stop() }
            context.unbindService(bound)
        }
        context.stopService(Intent(context, PlaybackService::class.java))
        waitUntil("service stopped") { !serviceRunning() }
        origin.close()
        context.getSharedPreferences("playback_restore", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun theRingsOfAnEngineARateChangeReplacedCanBeCollected() {
        bind()
        play(revision = 1, low)
        val replaced = engineRef()
        play(revision = 2, high)
        waitUntil("a 48 kHz engine in place of the 44.1 kHz one") { currentEngineIsNot(replaced) }
        assertCollected(replaced, "rate-change")
    }

    @Test
    fun theRingsOfTheLastEngineCanBeCollectedOnceTheServiceEnds() {
        bind()
        play(revision = 1, high)
        val last = engineRef()
        onMain { handle.port.stop() }
        connection?.let(context::unbindService)
        connection = null
        context.stopService(Intent(context, PlaybackService::class.java))
        // As between two device tests: the next service starts as soon as Android lists this one as gone.
        waitUntil("service stopped") { !serviceRunning() }
        assertCollected(last, "service-ended")
    }

    @Suppress("DEPRECATION") // Still lists the caller's own services, which is all this needs.
    private fun serviceRunning(): Boolean =
        context.getSystemService(ActivityManager::class.java).getRunningServices(Int.MAX_VALUE)
            .any { it.service.className == PlaybackService::class.java.name && it.service.packageName == context.packageName }

    private fun bind() {
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
    }

    private fun play(revision: Long, track: SyntheticTrack) {
        val item = QueueItem(
            playbackRef = track.pcm.playbackRef,
            title = "Signal ${track.tag}",
            artist = "Device Artist",
            album = "Device Album",
            artworkUrl = null,
            durationMs = track.frames * 1000 / track.sampleRate,
            listenKey = "lk-${track.tag}",
        )
        onMain { handle.port.loadQueue(QueueLoad(revision, listOf(item), 0, 0, null, autoplay = true)) }
        waitUntil("playing ${track.sampleRate} Hz") {
            handle.port.snapshot.state == NativePlaybackState.PLAYING && handle.port.snapshot.queueRevision == revision
        }
    }

    private class LetGo(val engine: WeakReference<Any>, val rings: List<WeakReference<FloatArray>>)

    // Each read of the engine stays inside its own frame, so the test itself never holds one.
    private fun engineRef(): LetGo {
        val engine = checkNotNull(ENGINE.get(controller()))
        return LetGo(WeakReference(engine), RINGS.map { WeakReference((it.get(engine) as PcmRing).samples) })
    }

    private fun currentEngineIsNot(letGo: LetGo): Boolean {
        val current = ENGINE.get(controller()) ?: return false
        return current !== letGo.engine.get()
    }

    private fun controller(): NativePlaybackController {
        val owner = handle.javaClass.declaredFields.first { it.type == PlaybackService::class.java }
        val service = owner.apply { isAccessible = true }.get(handle) as PlaybackService
        return CONTROLLER.get(service) as NativePlaybackController
    }

    /** The rings are collected within [COLLECT_MS] of being let go; otherwise the heap is dumped for the run's artifacts. */
    private fun assertCollected(letGo: LetGo, name: String) {
        val startedAt = SystemClock.elapsedRealtime()
        while (SystemClock.elapsedRealtime() - startedAt < COLLECT_MS) {
            Runtime.getRuntime().gc()
            System.runFinalization()
            if (letGo.rings.all { it.get() == null }) {
                // Kept with the run's reports. An unwritable note never fails the pass.
                runCatching {
                    File(outputDirectory(), "engine-retention-$name.txt").writeText(
                        "rings collected after ${SystemClock.elapsedRealtime() - startedAt} ms; " +
                            "engine object collected: ${letGo.engine.get() == null}\n",
                    )
                }
                return
            }
            SystemClock.sleep(50)
        }
        val dump = heapDump(name)
        fail("The $name engine's rings were still reachable ${COLLECT_MS} ms after it was let go; heap dump: $dump")
    }

    private fun outputDirectory(): File =
        (InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")?.let(::File)
            ?: File(context.filesDir, "engine-retention")).apply { mkdirs() }

    private fun heapDump(name: String): String {
        val file = File(outputDirectory(), "engine-retention-$name.hprof")
        return try {
            Debug.dumpHprofData(file.path)
            file.path
        } catch (failure: Exception) {
            "not written (${failure.message})"
        }
    }

    private fun onMain(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private companion object {
        const val LOW_RATE = 44_100
        const val HIGH_RATE = 48_000
        const val COLLECT_MS = 2_000L
        val CONTROLLER = PlaybackService::class.java.getDeclaredField("controller").apply { isAccessible = true }
        val ENGINE = NativePlaybackController::class.java.getDeclaredField("engine").apply { isAccessible = true }
        val RINGS = listOf("currentRing", "continuityRing")
            .map { NativePcmEngine::class.java.getDeclaredField(it).apply { isAccessible = true } }
    }
}
