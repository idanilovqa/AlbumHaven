package org.albumhaven.shell

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.media3.common.Player
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.albumhaven.playback.decode.AudioCodec
import org.albumhaven.playback.decode.DecodedAudio
import org.albumhaven.playback.decode.EncodedDecodeListener
import org.albumhaven.playback.decode.EncodedDecoders
import org.albumhaven.playback.decode.EncodedDecoding
import org.albumhaven.playback.engine.FakeAhpcServer
import org.albumhaven.playback.engine.PcmSink
import org.albumhaven.playback.engine.RATE
import org.albumhaven.playback.engine.Run
import org.albumhaven.playback.engine.SyntheticTrack
import org.albumhaven.shell.net.ShellSession
import org.albumhaven.shell.playback.HttpListenEffectApi
import org.albumhaven.shell.playback.HttpPlaybackClaimApi
import org.albumhaven.shell.playback.NativeMediaPlayer
import org.albumhaven.shell.playback.NativePlaybackController
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.playback.OkHttpPcmTransportFactory
import org.albumhaven.shell.playback.QueueItem
import org.albumhaven.shell.playback.QueueLoad
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Collections
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Owner report (2026-11-09): playback stopped briefly when the phone moved from Wi-Fi to mobile
 * data. The real controller, playback thread, OkHttp WebSocket and claim and listen requests run
 * against a local streaming server whose connections are cut mid-song, and the output is a
 * real-time audio clock that keeps every frame it will play.
 */
@RunWith(AndroidJUnit4::class)
class NetworkChangePlaybackTest {
    /** The fake codec is 384 KB/s, so two minutes ahead is more than the engine's 16 MiB cap: this song keeps arriving. */
    private val arriving = SyntheticTrack(tag = 3, frames = 90L * RATE)

    /** All of this one arrives in the first seconds. */
    private val arrived = SyntheticTrack(tag = 4, frames = 30L * RATE)
    private val ahpc = FakeAhpcServer(listOf(arriving, arrived)).also { it.encoded = true }
    private val origin = DeviceOrigin(ahpc).start()
    private val sinks = Collections.synchronizedList(mutableListOf<ClockedSink>())
    private val events = Collections.synchronizedList(mutableListOf<NativePlaybackEvent>())
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private val listenIo = Executors.newSingleThreadExecutor()
    private lateinit var player: NativeMediaPlayer

    private val session = ShellSession({ origin.origin }) { null }
    private val client = ShellSession.client()
    private val controller = NativePlaybackController(
        transports = OkHttpPcmTransportFactory(client, session),
        claimApi = HttpPlaybackClaimApi(client, session),
        listenApi = HttpListenEffectApi(client, session),
        sinks = { rate -> ClockedSink(rate).also(sinks::add) },
        io = io,
        listenIo = listenIo,
        clock = SystemClock::elapsedRealtime,
        events = { event ->
            events += event
            main.post { player.onEvent(event) }
        },
        decoders = { post -> ThreadedFakeDecoders(post) },
        codecs = { setOf(AudioCodec.MP3) },
    )

    @After
    fun tearDown() {
        controller.shutdown {
            io.shutdown()
            listenIo.shutdown()
        }
        InstrumentationRegistry.getInstrumentation().runOnMainSync { if (::player.isInitialized) player.release() }
        origin.close()
    }

    /** More of the song is still to come over the socket: the next one fetches it from where the received bytes end. */
    @Test
    fun aNetworkChangeWhileTheSongIsStillArrivingPlaysOnWithNoSilenceSkipOrRepeat() {
        val cut = switchNetworksWhilePlaying(arriving, wholeSongArrived = false)
        assertEquals(2, origin.pcmConnections)
        val resumedOpen = origin.inspect { it.texts.map(::JSONObject) }.last { it.getString("type") == "open" }
        assertTrue("the new socket reopened mid-song: $resumedOpen", resumedOpen.getLong("startFrame") > cut)
    }

    /**
     * The engine keeps two minutes of a song ahead, so in a song's last two minutes all of it has
     * already arrived when the network changes; it must play on just the same.
     */
    @Test
    fun aNetworkChangeOnceTheWholeSongHasArrivedPlaysOnWithNoSilenceSkipOrRepeat() {
        switchNetworksWhilePlaying(arrived, wholeSongArrived = true)
    }

    /**
     * Plays [track], cuts the connections three seconds in, or once all of it has arrived, and asserts
     * what the user hears and sees until fifteen seconds of it have played; returns the frame heard
     * at the cut.
     */
    private fun switchNetworksWhilePlaying(track: SyntheticTrack, wholeSongArrived: Boolean): Long {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            player = NativeMediaPlayer(Looper.getMainLooper(), { controller }, { origin.origin })
        }
        controller.start()
        val item = QueueItem(
            playbackRef = track.pcm.playbackRef,
            title = "Signal ${track.tag}",
            artist = "Android Acceptance",
            album = "Network Change",
            artworkUrl = null,
            durationMs = track.frames * 1000 / RATE,
            listenKey = "lk-${track.tag}",
        )
        controller.loadQueue(QueueLoad(1, listOf(item), 0, 0, null, autoplay = true))
        waitUntil("three seconds heard") { output()?.heardFrames()?.let { it >= 3L * RATE } == true }
        if (wholeSongArrived) {
            waitUntil("the whole song sent") { origin.streamsSentWhole == 1 }
            // Long enough for the last bytes on the loopback socket to reach the player.
            Thread.sleep(1_000)
        }
        val sink = output()!!
        val operationsBeforeCut = sink.operations().size

        // What the media card and lock screen show is sampled throughout the switch.
        val sessionStates = Collections.synchronizedList(mutableListOf<String>())
        val sampling = object : Runnable {
            override fun run() {
                sessionStates += "${player.playbackState}/${player.isPlaying}/${player.playerError?.errorCodeName}"
                main.postDelayed(this, 20)
            }
        }
        main.post(sampling)

        val cut = sink.heardFrames()
        assertEquals("the song had all arrived at the cut", if (wholeSongArrived) 1 else 0, origin.streamsSentWhole)
        assertTrue("the cut came $cut frames in, too late to hear what follows it", cut < 10L * RATE)
        origin.cutPcmSocket()
        waitUntil("fifteen seconds heard") { sink.heardFrames() >= 15L * RATE }
        main.removeCallbacks(sampling)
        val afterCut = sink.operations().drop(operationsBeforeCut)
        controller.pause()
        waitUntil("paused") { controller.snapshot.state == NativePlaybackState.PAUSED }

        // Heard: every frame from the first, once, in order; the output never ran dry, paused or flushed.
        val failures = events.filterIsInstance<NativePlaybackEvent.Error>()
        assertTrue("output operations after the cut: $afterCut; errors $failures", afterCut.none { it == "pause" || it == "flush" })
        assertTrue(sinks.last() === sink)
        assertEquals(listOf(Run(track.tag, 0, sink.keptFrames.toLong())), sink.runs())
        assertEquals("silences (heard frame to frames) from the cut on", emptyMap<Long, Long>(), sink.silences.filterKeys { it >= cut })
        // Playback stayed playing everywhere the user looks, with no error.
        assertEquals(emptyList<NativePlaybackEvent>(), failures)
        assertTrue(sessionStates.isNotEmpty())
        val playing = "${Player.STATE_READY}/true/null"
        assertEquals("media session states during the switch", listOf(playing), sessionStates.distinct())
        assertEquals(emptyList<String>(), origin.inspect { it.violations.toList() })
        return cut
    }

    private fun output(): ClockedSink? = sinks.lastOrNull()?.takeIf { it.sampleRate == RATE }
}

fun waitUntil(what: String, timeoutMs: Long = 60_000, condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
        if (condition()) return
        Thread.sleep(50)
    }
    throw AssertionError("Timed out waiting for $what")
}

/**
 * The fake codec of [FakeAhpcServer]'s encoded streams (f32le frames), decoded as
 * [org.albumhaven.playback.decode.ThreadedEncodedDecoders] decodes: on a thread of its own, as far
 * as requested, reporting each piece on the playback thread through [post].
 */
private class ThreadedFakeDecoders(private val post: (Runnable) -> Unit) : EncodedDecoders {
    override fun open(codec: AudioCodec, listener: EncodedDecodeListener): EncodedDecoding = object : EncodedDecoding {
        private val worker = Executors.newSingleThreadExecutor()
        private val buffered = AtomicInteger()

        // Decode-thread state.
        private val chunks = ArrayDeque<ByteArray>()
        private var available = 0
        private var headOffset = 0
        private var wanted = 0
        private var ended = false
        private var finished = false

        @Volatile private var closed = false

        override val bufferedBytes: Int get() = buffered.get()

        override fun write(bytes: ByteArray, offset: Int, length: Int) {
            val copy = bytes.copyOfRange(offset, offset + length)
            buffered.addAndGet(length)
            onWorker {
                chunks += copy
                available += length
                decode()
            }
        }

        override fun end() = onWorker {
            ended = true
            decode()
        }

        override fun request(frames: Int) = onWorker {
            wanted = frames
            decode()
        }

        override fun close() {
            closed = true
            worker.shutdown()
        }

        private fun onWorker(task: () -> Unit) {
            if (!closed) runCatching { worker.execute(task) }
        }

        private fun report(callback: () -> Unit) = post(Runnable { if (!closed) callback() })

        private fun decode() {
            while (!closed && wanted > 0 && available >= BYTES_PER_FRAME) {
                val frames = minOf(wanted, available / BYTES_PER_FRAME, DECODE_FRAMES)
                val bytes = ByteBuffer.wrap(take(frames * BYTES_PER_FRAME)).order(ByteOrder.LITTLE_ENDIAN)
                wanted -= frames
                val audio = DecodedAudio(FloatArray(frames * 2) { bytes.float }, RATE)
                report { listener.decoded(audio) }
            }
            if (!finished && ended && available < BYTES_PER_FRAME) {
                finished = true
                report { listener.finished() }
            }
        }

        private fun take(count: Int): ByteArray {
            val out = ByteArray(count)
            var filled = 0
            while (filled < count) {
                val head = chunks.first()
                val length = minOf(count - filled, head.size - headOffset)
                head.copyInto(out, filled, headOffset, headOffset + length)
                filled += length
                headOffset += length
                if (headOffset == head.size) {
                    chunks.removeFirst()
                    headOffset = 0
                }
            }
            available -= count
            buffered.addAndGet(-count)
            return out
        }
    }

    private companion object {
        const val BYTES_PER_FRAME = 8
        const val DECODE_FRAMES = 4_096
    }
}

/**
 * An audio output that plays in real time, as an [android.media.AudioTrack] with a quarter-second
 * buffer does, and keeps what it will play: every frame written and not flushed, by its source
 * frame and track tag. [silences] maps each heard frame the output ran dry at, while playing, to
 * how many frames of time it then played nothing.
 */
class ClockedSink(override val sampleRate: Int) : PcmSink {
    private val capacityFrames = sampleRate / 4
    private var sources = LongArray(1 shl 20)
    private var tags = IntArray(1 shl 20)
    private var frames = 0
    private val operations = mutableListOf<String>()
    private var played = 0
    private var running = false
    private var lastNanos = 0L
    private var carriedNanos = 0L

    private val silent = sortedMapOf<Long, Long>()
    val silences: Map<Long, Long> @Synchronized get() = silent.toMap()

    val keptFrames: Int @Synchronized get() = frames

    @Synchronized fun operations() = operations.toList()

    /** Contiguous runs of (tag, first source frame, length); a skip, repeat or other track splits a run. */
    @Synchronized fun runs(): List<Run> {
        val runs = mutableListOf<Run>()
        for (frame in 0 until frames) {
            val last = runs.lastOrNull()
            if (last != null && last.tag == tags[frame] && last.start + last.length == sources[frame]) {
                runs[runs.lastIndex] = last.copy(length = last.length + 1)
            } else {
                runs += Run(tags[frame], sources[frame], 1)
            }
        }
        return runs
    }

    /** Plays the time since the last call. */
    private fun advance() {
        val now = System.nanoTime()
        if (running) {
            val nanos = now - lastNanos + carriedNanos
            val elapsed = nanos * sampleRate / 1_000_000_000L
            carriedNanos = nanos - elapsed * 1_000_000_000L / sampleRate
            val available = (frames - played).toLong()
            if (elapsed > available && played > 0) silent.merge(frames.toLong(), elapsed - available, Long::plus)
            played += minOf(elapsed, available).toInt()
        }
        lastNanos = now
    }

    @Synchronized override fun write(samples: FloatArray, offsetSamples: Int, frames: Int): Int {
        advance()
        val accepted = minOf(frames, capacityFrames - (this.frames - played)).coerceAtLeast(0)
        if (this.frames + accepted > sources.size) {
            sources = sources.copyOf(sources.size * 2)
            tags = tags.copyOf(tags.size * 2)
        }
        for (frame in 0 until accepted) {
            // The synthetic signal: left is the source frame, right the track tag.
            sources[this.frames] = samples[offsetSamples + frame * 2].toLong()
            tags[this.frames] = samples[offsetSamples + frame * 2 + 1].toInt()
            this.frames += 1
        }
        if (operations.lastOrNull() != "write") operations += "write"
        return accepted
    }

    @Synchronized override fun pendingFrames(): Int {
        advance()
        return frames - played
    }

    @Synchronized override fun heardFrames(): Long {
        advance()
        return played.toLong()
    }

    @Synchronized override fun play() {
        advance()
        operations += "play"
        running = true
    }

    @Synchronized override fun pause() {
        advance()
        operations += "pause"
        running = false
    }

    @Synchronized override fun fadeOutAndPause() = pause()

    override fun fadeOutSettled() = true

    @Synchronized override fun resumeWithFadeIn() = play()

    /** Unplayed frames are discarded: never heard. */
    @Synchronized override fun flush() {
        advance()
        operations += "flush"
        frames = played
    }

    override fun release() = Unit
}
