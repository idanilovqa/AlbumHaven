package org.albumhaven.shell.playback

import org.albumhaven.playback.engine.PcmCloseCodes
import org.albumhaven.playback.engine.PcmTransport
import org.albumhaven.playback.engine.PcmTransportFactory
import org.albumhaven.playback.engine.PcmTransportListener

import org.albumhaven.playback.engine.AhpcControlCodec
import org.albumhaven.playback.engine.NativePcmEngine
import org.albumhaven.playback.engine.PcmBoundaryKind
import org.albumhaven.playback.engine.PcmControlSender
import org.albumhaven.playback.engine.PcmEngineConfig
import org.albumhaven.playback.engine.PcmEngineEvent
import org.albumhaven.playback.engine.PcmSink
import org.albumhaven.playback.engine.PcmTrack

import org.albumhaven.playback.decode.AudioCodec
import org.albumhaven.playback.decode.EncodedDecoders
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/**
 * One `playback.loadQueue` entry; [playbackRef] and [listenKey] are opaque and path-free. A
 * refreshed reference keeps the track's [listenKey], so it continues the same listen. Items of one
 * [queueGroup] are one web playback queue (an album): previous and next stay inside it, as the
 * web's own skips do, while a natural end continues into the next group. [resumeToken] is the
 * track's non-expiring, account-bound identity, the only handle the restorable queue keeps, from
 * which `POST /playback/refs/resume` issues a fresh reference.
 */
data class QueueItem(
    val playbackRef: String,
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val durationMs: Long,
    val trackNumber: String = "",
    val listenKey: String,
    val queueGroup: Int = 0,
    val resumeToken: String? = null,
) {
    fun pcmTrack() = PcmTrack(playbackRef, durationMs / 1000.0)

    fun claimTrack() = ClaimTrack(playbackRef, title, artist, album, artworkUrl)

    fun listenTrack() = ListenTrack(listenKey, playbackRef, title, artist, album, trackNumber)

    companion object {
        private const val MAX_TEXT_CHARS = 512
        private const val MAX_URL_CHARS = 2_048

        /** Same bounds `PUT /playback/state` applies to mirrored track text. */
        fun isDisplayText(value: String): Boolean = value.length <= MAX_TEXT_CHARS && value.none { it.code < 32 }

        /** `POST /playback/refs` resume tokens: unpadded base64url fields joined by dots. */
        fun isResumeToken(value: String): Boolean = RESUME_TOKEN.matches(value)

        /** The web's opaque, path-free track identity, which stays the same when a reference is refreshed. */
        fun isListenKey(value: String): Boolean = LISTEN_KEY.matches(value)

        /** A `POST /playback/refs` reference: opaque base64url text with dots and padding. */
        fun isPlaybackRef(value: String): Boolean = PLAYBACK_REF.matches(value)

        private val PLAYBACK_REF = Regex("^[A-Za-z0-9_.=-]{1,2048}$")
        private val RESUME_TOKEN = Regex("^[A-Za-z0-9_.-]{1,512}$")
        private val LISTEN_KEY = Regex("^[A-Za-z0-9_.-]{1,128}$")

        /** A same-origin absolute path without query, which is all the claim mirror accepts. */
        fun isArtworkPath(value: String): Boolean =
            value.length <= MAX_URL_CHARS && value.startsWith("/") && !value.startsWith("//") &&
                value.none { it.code < 33 || it == '\\' || it == '?' || it == '#' }
    }
}

/** The web's loop kinds (`dispatchActiveStreamingLoop`). */
enum class LoopKind(val wire: String) {
    SHORT("short-loop"),
    LONG("long-loop"),
    WHOLE_TRACK("whole-track-repeat"),
    ;

    companion object {
        fun of(wire: String): LoopKind? = entries.firstOrNull { it.wire == wire }
    }
}

/**
 * A loop range in frames of the track at [sampleRate], the rate Android reported for it, so every
 * loop point lands on the exact sample the web chose; [kind] is the web's when it names one.
 */
data class LoopRange(val startFrame: Long, val endFrame: Long, val sampleRate: Int, val kind: LoopKind? = null) {
    /** Replayed from retained PCM: the web's kind, or the worklet's own rule of at most five seconds. */
    val short: Boolean
        get() = kind?.let { it == LoopKind.SHORT }
            ?: (endFrame - startFrame <= PcmEngineConfig.SHORT_LOOP_MAX_SECONDS.toLong() * sampleRate)
}

/**
 * [keepCurrent] says the current item is the one already playing: only the queue around it
 * changes, as when the web's queue changes under the playing track.
 */
data class QueueLoad(
    val queueRevision: Long,
    val items: List<QueueItem>,
    val currentIndex: Int,
    val positionMs: Long,
    val loop: LoopRange?,
    val autoplay: Boolean,
    val keepCurrent: Boolean = false,
)

enum class NativePlaybackState(val wire: String) {
    IDLE("idle"),
    LOADING("loading"),
    BUFFERING("buffering"),
    PLAYING("playing"),
    PAUSED("paused"),
    ENDED("ended"),
    ERROR("error"),
    ;

    /** Playback is wanted: starting, waiting for audio or heard. */
    val wanted: Boolean get() = this == LOADING || this == BUFFERING || this == PLAYING
}

/** Path-free state reported by the handshake, `playback.snapshot` and every event. */
data class NativePlaybackSnapshot(
    val clientId: String,
    val state: NativePlaybackState,
    val queueRevision: Long,
    val currentIndex: Int?,
    val positionMs: Long,
    val durationMs: Long,
    /** The applied queue's display metadata, for system media controls; never sent to the web. */
    val items: List<QueueItem> = emptyList(),
    /** The current item's own sample rate once Android knows it; loop points are counted in it. */
    val sampleRate: Int? = null,
)

/** Who asked for a change: the web document, or Android's own media controls, focus and routes. */
enum class CommandSource { WEB, SYSTEM }

enum class CurrentItemReason(val wire: String) {
    LOAD("load"),
    ADVANCE("advance"),
    NEXT("next"),
    PREVIOUS("previous"),
}

sealed interface NativePlaybackEvent {
    val snapshot: NativePlaybackSnapshot

    /** [source] is [CommandSource.SYSTEM] when Android's media controls changed the state, so the web can follow. */
    data class State(
        override val snapshot: NativePlaybackSnapshot,
        val source: CommandSource = CommandSource.WEB,
    ) : NativePlaybackEvent
    data class Position(override val snapshot: NativePlaybackSnapshot) : NativePlaybackEvent
    data class CurrentItem(
        override val snapshot: NativePlaybackSnapshot,
        val reason: CurrentItemReason,
        val source: CommandSource = CommandSource.WEB,
    ) : NativePlaybackEvent
    data class LoopWrapped(override val snapshot: NativePlaybackSnapshot) : NativePlaybackEvent
    data class Ownership(override val snapshot: NativePlaybackSnapshot, val ownership: String) : NativePlaybackEvent
    data class Error(override val snapshot: NativePlaybackSnapshot, val code: String, val message: String) :
        NativePlaybackEvent
    data class ReferenceExpired(override val snapshot: NativePlaybackSnapshot) : NativePlaybackEvent
}

enum class CommandResult { ACCEPTED, STALE_REVISION, NO_QUEUE }

/**
 * The native playback owner: one queue, one [NativePcmEngine] per native rate, one PCM
 * socket and the server claim. Commands may come from any thread; all state lives on the
 * playback thread, which [start] runs and tests drive through [runOnce]. It knows nothing
 * of the WebView, so a Media3 player can adapt it unchanged. As the claim owner it also sends
 * the listen writes ([ListenSessions]), whether or not a web document is attached.
 */
class NativePlaybackController(
    private val transports: PcmTransportFactory,
    claimApi: PlaybackClaimApi,
    private val listenApi: ListenEffectApi,
    private val sinks: (sampleRate: Int) -> PcmSink,
    io: Executor,
    private val listenIo: Executor,
    private val clock: () -> Long,
    private val events: (NativePlaybackEvent) -> Unit,
    val clientId: String = UUID.randomUUID().toString(),
    private val warmer: ConnectionWarmer = ConnectionWarmer {},
    /** This installation's listen device, kept like the browser's per-profile one. */
    deviceId: String = UUID.randomUUID().toString(),
    wallClockMs: () -> Long = System::currentTimeMillis,
    /** Starts the playback thread; the Android service runs it at audio priority. */
    private val startThread: (Runnable) -> Unit = { Thread(it, "AlbumHavenPlayback").start() },
    /** Hears each failure that stopped playback on the playback thread, so it can be logged. */
    private val failures: (RuntimeException) -> Unit = {},
    /** Audio focus: every start asks it, so nothing claims, announces or plays over a call. */
    private val startGate: StartGate = StartGate.OPEN,
    /** Hears one path-free [StartTiming] line per user-initiated start, on the playback thread, once it is heard or given up. */
    startTimings: (String) -> Unit = {},
    /** Builds the decoders for encoded streams around the playback thread's task queue; null keeps server PCM. */
    decoders: ((post: (Runnable) -> Unit) -> EncodedDecoders)? = null,
    /** The codecs whose decoders passed their self-check; the server streams these encoded. */
    private val codecs: () -> Set<AudioCodec> = { emptySet() },
) {
    private val decoders: EncodedDecoders? = decoders?.invoke { task -> post(task) }

    /** Codecs whose decoder failed in this session; their streams fall back to server PCM. */
    private val failedCodecs = mutableSetOf<AudioCodec>()

    /** When the output last ran dry while playing, on [clock]; a recent stall asks for 320 kbps FLAC. */
    private var lastStallAtMs: Long? = null

    private val tasks = LinkedBlockingQueue<Runnable>()
    private val timing = StartTiming(startTimings)

    @Volatile private var running = false

    /** Set once [shutdown] let go of everything; later work, such as a late claim answer, is dropped. */
    @Volatile private var retired = false

    private val revisionLock = Any()
    private var acceptedRevision = 0L

    /** A new document counts revisions from one; its first queue replaces the running one whatever its revision. */
    private var documentRestarted = false

    // Set while a command task runs, so the events it causes name who asked for them.
    private var source = CommandSource.WEB

    @Volatile var snapshot = NativePlaybackSnapshot(clientId, NativePlaybackState.IDLE, 0, null, 0, 0)
        private set

    private val claims = PlaybackClaimOwner(claimApi, clientId, io, ::post, clock, ::onClaimEvent)

    private val listens = ListenSessions(
        deviceId = deviceId,
        originId = clientId,
        writer = ::sendListen,
        canEmit = { claims.owned || claims.acquiring },
        playingDurationSeconds = { (queue.getOrNull(index)?.durationMs ?: 0) / 1000.0 },
        wallClockMs = wallClockMs,
        elapsedMs = clock,
        scrobblingUnavailable = { claims.scrobblingAvailable == false },
    )

    // Frames and underruns of the current item already handed to [listens].
    private var listenedFrames = 0L
    private var listenedUnderruns = 0

    // Playback-thread state.
    private var queue: List<QueueItem> = emptyList()
    private var revision = 0L
    private var index = -1
    private var state = NativePlaybackState.IDLE
    private var heldPositionMs = 0L

    /** The exact frame a paused stream lapsed at, so the stream reopened for [heldPositionMs] resumes on it. */
    private var heldFrame: HeldFrame? = null
    private var loop: LoopRange? = null
    private var wantPlay = false

    private var engine: NativePcmEngine? = null
    private var sink: PcmSink? = null
    private var lastGeneration = 0L
    private var loaded = false
    private var pendingRateChange = false
    private var recoveryAttempted = false
    private val rates = LinkedHashMap<String, Int>()
    private var preferredRate = DEFAULT_RATE

    private var transport: PcmTransport? = null
    private var transportEpoch = 0L
    private var transportOpen = false
    private var lastCloseCode: Int? = null
    private var lastPositionEventMs = 0L

    /** Set once the engine drained the queue; [ended] waits until the output has played it. */
    private var endDrainUntilMs: Long? = null

    // Ownership is kept after pause, stop and end until the listen writes for them drain.
    private var releasePending = false
    private var effectsInFlight = 0

    // Set once [shutdown] stopped playback; the claim goes when the listen writes drain or this passes.
    private var shutdownDeadlineMs: Long? = null
    private var shutdownFinished: () -> Unit = {}

    // Connections stay warm for a while after the handshake and after this client last owned playback.
    private var warmUntilMs: Long? = null
    private var lastWarmMs = 0L

    // Measured listening of the current item, in the sink's accepted-frame coordinates.
    private var measuring = false
    private var itemMarker = 0L
    private var itemHeardBase = 0L
    private var itemUnderruns = 0

    /** Accepted frame where a queued successor took over; [advanced] has not applied it yet. */
    private var boundaryFrame: Long? = null

    /** A skip promotes the prepared successor itself; its boundary is not a natural advance. */
    private var skippingToPrepared = false

    /**
     * While a started item waits for its first frame as the owner: since when, and whether it was
     * already reopened once. A start the server never feeds is retried once, then fails readably.
     */
    private var startWaitSinceMs: Long? = null
    private var startRetried = false

    /** Whether the loaded stream has rendered its first frame, so resuming it is heard at once. */
    private var firstFrameHeard = false

    // ---- Commands (any thread) ----

    /**
     * [start] is timed if the load autoplays: by default the web's track selection, arriving now;
     * the shell's own resume names when it asked for the queue's references and when they came.
     */
    fun loadQueue(load: QueueLoad, start: StartCommand = StartCommand(StartKind.SELECT, CommandSource.WEB, clock())): CommandResult {
        synchronized(revisionLock) {
            if (load.queueRevision <= acceptedRevision && !documentRestarted) return CommandResult.STALE_REVISION
            acceptedRevision = load.queueRevision
            documentRestarted = false
        }
        post { applyLoad(load, start) }
        return CommandResult.ACCEPTED
    }

    fun play(queueRevision: Long, from: CommandSource = CommandSource.WEB): CommandResult {
        val start = StartCommand(StartKind.PLAY, from, clock())
        return revisioned(queueRevision, from) { requestPlay(start) }
    }

    fun seek(queueRevision: Long, positionMs: Long, from: CommandSource = CommandSource.WEB) =
        revisioned(queueRevision, from) { seekTo(positionMs) }

    fun next(queueRevision: Long, from: CommandSource = CommandSource.WEB): CommandResult {
        val start = StartCommand(StartKind.NEXT, from, clock())
        return revisioned(queueRevision, from) { step(+1, start) }
    }

    fun previous(queueRevision: Long, from: CommandSource = CommandSource.WEB): CommandResult {
        val start = StartCommand(StartKind.PREVIOUS, from, clock())
        return revisioned(queueRevision, from) { step(-1, start) }
    }

    fun setLoop(queueRevision: Long, range: LoopRange?) = revisioned(queueRevision) { applyLoop(range) }

    /**
     * Fades the output out at once and pauses on the next frame it holds; [silenceAtOnce] cuts it
     * at once instead, as output that went to the speaker when headphones were removed must be.
     */
    fun pause(from: CommandSource = CommandSource.WEB, silenceAtOnce: Boolean = false) = post(from) {
        startGate.dropHeldStart()
        pauseNow(silenceAtOnce)
    }

    fun stop(from: CommandSource = CommandSource.WEB) = post(from) {
        startGate.dropHeldStart()
        stopNow()
    }

    /**
     * Audio focus pauses playback for a moment; unlike [pause], a start held for its return stays.
     * It pauses only if the gate no longer holds focus when it runs, so a start that took focus back
     * after it was posted keeps playing.
     */
    fun interrupt() = post(CommandSource.SYSTEM) { if (!startGate.holdsFocus()) pauseNow() }

    /**
     * Focus came back: the start the gate held for it plays. If a pause, stop or loss dropped it,
     * a player already stopped reported nothing new, so the gate hears of the stop now.
     */
    fun resumeHeldStart() = post(CommandSource.SYSTEM) {
        if (startGate.takeResume()) requestPlay() else if (!state.wanted) startGate.stopped(state)
    }

    /**
     * A new document of the same origin re-attaches to the running queue: playback, the claim and
     * the applied revision continue, so the document can adopt them from its handshake snapshot.
     * A document counts revisions from one, so its first queue replaces this one whatever its revision.
     */
    fun documentDetached() {
        synchronized(revisionLock) { documentRestarted = true }
    }

    /**
     * Runs [callback] on the playback thread once every command sent before it has been applied; a
     * retired controller applies none, so it answers at once.
     */
    fun afterPendingCommands(callback: Runnable) = post(Barrier(callback))

    /** Warms the connections a first start needs, then keeps them warm while nothing plays. */
    fun warmConnections() = post {
        warmUntilMs = clock() + KEEP_WARM_FOR_MS
        warm()
    }

    fun start() {
        if (running) return
        running = true
        startThread(
            Runnable {
                while (!retired) {
                    val waitMs = runOnce()
                    if (waitMs > 0 && !retired) tasks.poll(waitMs, TimeUnit.MILLISECONDS)?.let(::guarded)
                }
            },
        )
    }

    /**
     * Stops playback without waiting: a listen heard mid-play ends with the web's unload checkpoint,
     * and the claim, the socket and the playback thread go once the listen writes drain, or after
     * [SHUTDOWN_CHECKPOINT_MS], so none is refused for a released claim. [finished] then runs on the
     * playback thread, after the claim release has been handed to its executor. A later shutdown
     * waits for the same moment, and once the controller is retired its [finished] runs at once.
     */
    fun shutdown(finished: () -> Unit = {}) = post(Barrier {
        if (retired) return@Barrier finished()
        val earlier = shutdownFinished
        shutdownFinished = {
            earlier()
            finished()
        }
        if (shutdownDeadlineMs != null) return@Barrier
        measureListening()
        if (wantPlay && claims.owned) {
            listens.unload(positionMs() / 1000.0, (queue.getOrNull(index)?.durationMs ?: 0) / 1000.0)
        }
        stopNow(keepPosition = true)
        releasePending = false
        warmUntilMs = null
        shutdownDeadlineMs = clock() + SHUTDOWN_CHECKPOINT_MS
    })

    // ---- Playback thread ----

    /**
     * Runs queued work and one render pass, then returns how long the thread may wait for new
     * work: not at all after a render, briefly while it feeds the output, otherwise until the next
     * heartbeat, keep-warm or shutdown deadline.
     */
    fun runOnce(): Long {
        var task: Runnable? = tasks.poll()
        while (task != null && !retired) {
            guarded(task)
            task = tasks.poll()
        }
        if (retired) {
            dropRetiredWork()
            return Long.MAX_VALUE
        }
        var written = 0
        guarded {
            claims.tick()
            maybeRecoverStalledStart()
            // A stream may buffer while the claim is requested; only an owner is heard, and a pause
            // the owner made finishes its fade even once the claim is given back.
            val wasPausing = pausing()
            written = if (loaded && (mayBeHeard() || pausing())) engine?.render(RENDER_CHUNK_FRAMES) ?: 0 else 0
            if (wasPausing && !pausing()) pauseSettled()
            if (timing.awaitingAudible) sink?.let { timing.heard(clock(), it.heardFrames()) }
            maybeFinishDrainedQueue()
            maybeEmitPosition()
            maybeRelease()
            maybeKeepWarm()
            maybeFinishShutdown()
        }
        return if (written > 0) 0 else waitMs()
    }

    private fun waitMs(): Long {
        if (retired) return Long.MAX_VALUE
        // A fading pause is polled closely, so the output pauses soon after its fade reaches silence.
        if (loaded && pausing()) return PAUSE_POLL_MS
        if (loaded && mayBeHeard()) return RENDER_WAIT_MS
        val next = listOfNotNull(
            claims.nextDeadlineMs(),
            shutdownDeadlineMs,
            warmUntilMs?.let { minOf(it, lastWarmMs + KEEP_WARM_MS) },
        ).minOrNull() ?: return Long.MAX_VALUE
        return (next - clock()).coerceAtLeast(1)
    }

    private fun pausing() = engine?.pausing == true

    /** The output faded out and stopped: the paused position is now the frame its playback head stopped on. */
    private fun pauseSettled() {
        if (!loaded || wantPlay) return
        heldPositionMs = positionMs()
        emit { NativePlaybackEvent.Position(it) }
    }

    /** A failure on the playback thread, such as a dead audio output, stops playback rather than the process. */
    private fun guarded(task: Runnable) {
        try {
            task.run()
        } catch (failure: RuntimeException) {
            failures(failure)
            outputFailed()
        }
    }

    private fun post(task: Runnable) {
        tasks.offer(task)
        if (retired) dropRetiredWork()
    }

    private class Barrier(callback: Runnable) : Runnable by callback

    /** A retired controller runs nothing more; only the barriers callers wait on still answer. */
    private fun dropRetiredWork() {
        while (true) {
            val task = tasks.poll() ?: return
            if (task is Barrier) task.run()
        }
    }

    private fun post(task: () -> Unit) = post(Runnable(task))

    private fun post(from: CommandSource, task: () -> Unit) = post {
        source = from
        try {
            task()
        } finally {
            source = CommandSource.WEB
        }
    }

    private fun revisioned(queueRevision: Long, from: CommandSource = CommandSource.WEB, task: () -> Unit): CommandResult {
        synchronized(revisionLock) {
            if (acceptedRevision == 0L) return CommandResult.NO_QUEUE
            if (queueRevision != acceptedRevision) return CommandResult.STALE_REVISION
        }
        post(from) { if (queueRevision == revision) task() }
        return CommandResult.ACCEPTED
    }

    private fun applyLoad(load: QueueLoad, start: StartCommand) {
        if (load.keepCurrent && keepCurrent(load)) return
        measureListening()
        val outgoing = queue.getOrNull(index)
        val outgoingPositionMs = positionMs()
        // An explicit selection silences the outgoing track at once; only a natural end is gapless.
        unload("replacement")
        resetItemMeasurement()
        wantPlay = false
        queue = load.items
        revision = load.queueRevision
        index = load.currentIndex
        loop = load.loop
        heldPositionMs = load.positionMs
        recoveryAttempted = false
        changeListenTrack(outgoing, outgoingPositionMs)
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.LOAD) }
        if (load.autoplay) {
            requestPlay(start)
        } else {
            retireClaim()
            setState(NativePlaybackState.PAUSED)
        }
    }

    /** The web keeps playing a track whose queue changed under it; only the queue around it is replaced. */
    private fun keepCurrent(load: QueueLoad): Boolean {
        val playingItem = queue.getOrNull(index) ?: return false
        val incoming = load.items[load.currentIndex]
        val current = engine?.takeIf { loaded } ?: return false
        if (incoming.listenKey != playingItem.listenKey) return false
        queue = load.items
        revision = load.queueRevision
        index = load.currentIndex
        claims.updateTrack(incoming.claimTrack())
        val successor = queue.getOrNull(index + 1)?.pcmTrack()
        // A successor prepared for the old queue is not heard yet; what plays next must be the one this queue names.
        if (current.preparedSuccessor.let { it != null && it != successor }) current.setQueuedNext(null)
        current.setQueuedNext(successor)
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.LOAD) }
        return true
    }

    /**
     * A started item the server has not fed while this client owned playback for
     * [START_STALL_MS] is reopened once; a second such stall ends in a readable error, from which
     * play tries again. Time spent waiting for the claim does not count.
     */
    private fun maybeRecoverStalledStart() {
        val since = startWaitSinceMs ?: return
        if (!loaded || !wantPlay) {
            startWaitSinceMs = null
            return
        }
        val now = clock()
        if (!claims.owned) {
            startWaitSinceMs = now
            return
        }
        if (now - since < START_STALL_MS) return
        if (!startRetried) {
            startRetried = true
            unload("start-stalled")
            startEngineAt(index, heldPositionMs)
            return
        }
        unload("start-stalled")
        wantPlay = false
        retireClaim()
        setState(NativePlaybackState.ERROR)
        emit { NativePlaybackEvent.Error(it, "start_stalled", "The track did not start. Press play to try again.") }
    }

    /** [start] is the user's command being timed; a start focus held back resumes untimed. */
    private fun requestPlay(start: StartCommand? = null) {
        val item = queue.getOrNull(index) ?: return
        if (wantPlay && state != NativePlaybackState.PAUSED) return
        start?.let { timing.begin(it, index, clock()) }
        // Held for the gate, the queue waits paused; a skip has already silenced the old track.
        if (!startGate.mayStart()) {
            timing.finish("focus_refused", clock())
            retireClaim()
            setState(NativePlaybackState.PAUSED)
            return
        }
        timing.mark(StartTiming.Stage.GATE, clock())
        wantPlay = true
        releasePending = false
        startRetried = false
        // A replaced or resumed item reports loading, so its first frame is a fresh `playing`.
        setState(NativePlaybackState.LOADING)
        ensureTransport()
        if (transportOpen) timing.socketOpen(clock(), reused = true)
        // The stream fills its cushion while the claim is requested; nothing plays before it is granted.
        if (transportOpen && !loaded) startEngineAt(index, heldPositionMs)
        val requestRevision = revision
        val requestIndex = index
        claims.acquire(item.claimTrack()) { outcome ->
            if (!wantPlay || revision != requestRevision || index != requestIndex) return@acquire
            when (outcome) {
                ClaimOutcome.GRANTED -> {
                    timing.mark(StartTiming.Stage.CLAIM, clock())
                    startWhenReady()
                }
                ClaimOutcome.BLOCKED -> {
                    wantPlay = false
                    // Unloading silences an instant start at once: another client owns playback.
                    unload("ownership-blocked")
                    setState(NativePlaybackState.PAUSED)
                }
                ClaimOutcome.UNAVAILABLE -> {
                    wantPlay = false
                    unload("ownership-unavailable")
                    setState(NativePlaybackState.ERROR)
                    emit { NativePlaybackEvent.Error(it, "ownership_unavailable", "Playback ownership is unavailable.") }
                }
            }
        }
        // Sound starts from what is buffered now; the claim's answer arrives meanwhile.
        startWhenReady()
        listens.begin(item.listenTrack(), heldPositionMs / 1000.0)
    }

    /**
     * Playback is heard while it owns the claim, and also while a play asks for it: the owner chose
     * an instant start from the buffer (2026-11-08). A refused claim silences it on its answer.
     */
    private fun mayBeHeard(): Boolean = claims.owned || (wantPlay && claims.acquiring)

    /** Starts or resumes once the socket is ready and the claim is held or being asked for. */
    private fun startWhenReady() {
        if (!wantPlay || !mayBeHeard() || !transportOpen) return
        val current = engine
        if (loaded && current != null) {
            heldFrame = null
            // Read while the output is still paused: a stream that already rendered is heard without a new write.
            if (timing.active) sink?.let { timing.outputReady(it.heardFrames(), queued = firstFrameHeard) }
            current.play()
            if (state == NativePlaybackState.LOADING || state == NativePlaybackState.PAUSED) {
                // A stream prepared while paused is heard only from its first frame.
                if (firstFrameHeard) {
                    setState(NativePlaybackState.PLAYING)
                } else {
                    startWaitSinceMs = clock()
                    setState(NativePlaybackState.BUFFERING)
                }
            }
        } else {
            startEngineAt(index, heldPositionMs)
        }
    }

    private fun startEngineAt(itemIndex: Int, positionMs: Long, playWhenReady: Boolean = true) {
        val item = queue.getOrNull(itemIndex) ?: return
        val rate = rates[item.playbackRef] ?: preferredRate
        // A restart of the same item keeps what was already heard of it.
        if (measuring) itemHeardBase = itemRenderedFrames()
        val current = engineFor(rate)
        heldPositionMs = positionMs
        // A stream that lapsed while paused reopens on the very frame it stopped at, fading up.
        val paused = heldFrame?.takeIf {
            it.playbackRef == item.playbackRef && it.sampleRate == rate && it.frame * 1000 / rate == positionMs
        }
        heldFrame = null
        pendingRateChange = false
        loaded = true
        firstFrameHeard = false
        endDrainUntilMs = null
        current.start(item.pcmTrack(), paused?.frame ?: msToFrames(positionMs, rate), playWhenReady, fadeIn = paused != null)
        if (timing.active) {
            timing.streamOpened(clock())
            sink?.let { timing.outputReady(it.heardFrames(), queued = false) }
        }
        startMeasuring()
        queue.getOrNull(itemIndex + 1)?.let { current.setQueuedNext(it.pcmTrack()) }
        loop?.let { applyEngineLoop(current, it, rate) }
        if (playWhenReady) {
            startWaitSinceMs = clock()
            if (state != NativePlaybackState.PLAYING) setState(NativePlaybackState.BUFFERING)
        }
    }

    private fun engineFor(rate: Int): NativePcmEngine {
        val current = engine
        if (current != null && sink?.sampleRate == rate) return current
        releaseOutput()
        val sender = PcmControlSender { control ->
            val open = transport
            transportOpen && open != null && open.send(AhpcControlCodec.encode(control))
        }
        val newSink = sinks(rate)
        // Android opens rates the PCM socket refuses; such an output is let go before it is ever used.
        val created = try {
            NativePcmEngine(
                PcmEngineConfig(rate), newSink, sender, lastGeneration, clock,
                decoders = decoders,
                codecs = { codecs() - failedCodecs },
                quality = { lowBitrateWanted(rate) },
                events = ::onEngineEvent,
            )
        } catch (refused: RuntimeException) {
            newSink.release()
            throw refused
        }
        sink = newSink
        engine = created
        preferredRate = rate
        return created
    }

    /**
     * `chooseStreamingQuality`: within a minute of a stall a FLAC stream comes as 320 kbps MP3. Its
     * rate is the FLAC's own only up to 48 kHz, so higher-rate engines keep the original.
     */
    private fun lowBitrateWanted(rate: Int): String? {
        val stall = lastStallAtMs ?: return null
        return if (rate <= LOW_BITRATE_MAX_RATE && clock() - stall < RECENT_STALL_MS) "320" else null
    }

    private fun onEngineEvent(event: PcmEngineEvent) {
        when (event) {
            is PcmEngineEvent.StartAccepted -> timing.mark(StartTiming.Stage.METADATA, clock())
            is PcmEngineEvent.StartPcmReceived -> timing.mark(StartTiming.Stage.FIRST_PCM, clock())
            is PcmEngineEvent.FirstFrame -> {
                recoveryAttempted = false
                startWaitSinceMs = null
                firstFrameHeard = true
                timing.written(clock())
                setState(NativePlaybackState.PLAYING)
            }
            is PcmEngineEvent.Buffering ->
                if (wantPlay) setState(if (event.active) NativePlaybackState.BUFFERING else NativePlaybackState.PLAYING)
            is PcmEngineEvent.Boundary -> when (event.kind) {
                // A skip to the prepared successor moves to it itself.
                PcmBoundaryKind.QUEUED_NEXT -> if (!skippingToPrepared) {
                    // Nothing of the successor is written yet, so this frame splits the two listens.
                    boundaryFrame = sink?.let(::acceptedFrames)
                    post { advanced() }
                }
                PcmBoundaryKind.SEEK -> emit { NativePlaybackEvent.Position(it) }
                PcmBoundaryKind.LOOP -> emit { NativePlaybackEvent.LoopWrapped(it) }
            }
            is PcmEngineEvent.Ended -> {
                val output = sink
                val queuedMs = if (output == null) 0 else output.pendingFrames() * 1000L / output.sampleRate
                endDrainUntilMs = clock() + queuedMs + END_DRAIN_MARGIN_MS
            }
            is PcmEngineEvent.RateChangeRequired -> {
                remember(event.track.playbackRef, event.sampleRate)
                pendingRateChange = true
            }
            is PcmEngineEvent.StartRateRequired -> {
                remember(event.track.playbackRef, event.sampleRate)
                val requested = heldPositionMs
                val requestRevision = revision
                val requestIndex = index
                post {
                    if (loaded && revision == requestRevision && index == requestIndex) {
                        startEngineAt(index, requested, wantPlay)
                    }
                }
            }
            is PcmEngineEvent.Failed -> post { failed(event) }
            is PcmEngineEvent.DecoderFailed -> failedCodecs += event.codec
            is PcmEngineEvent.Underrun -> {
                if (measuring) itemUnderruns += 1
                if (firstFrameHeard) lastStallAtMs = clock()
            }
        }
    }

    private fun advanced() {
        if (index + 1 >= queue.size) {
            boundaryFrame = null
            return
        }
        val boundary = boundaryFrame
        // Everything written before the boundary is the outgoing item's, played or still queued.
        measureListening(itemHeardBase + ((boundary ?: itemMarker) - itemMarker).coerceAtLeast(0))
        val outgoing = queue[index]
        index += 1
        heldPositionMs = 0
        resetItemMeasurement()
        if (boundary != null) {
            measuring = true
            itemMarker = boundary
        }
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        queue.getOrNull(index + 1)?.let { engine?.setQueuedNext(it.pcmTrack()) }
        advanceListen(outgoing)
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.ADVANCE) }
    }

    /** Ends the queue once the output has played its last frame, so neither ear nor listen loses the tail. */
    private fun maybeFinishDrainedQueue() {
        val until = endDrainUntilMs ?: return
        if (!wantPlay) return
        if ((sink?.pendingFrames() ?: 0) > 0 && clock() < until) return
        endDrainUntilMs = null
        ended()
    }

    private fun ended() {
        val hasNext = index + 1 < queue.size
        measureListening()
        if (hasNext && (pendingRateChange || wantPlay)) {
            // A successor at another native rate starts on a new engine after this one drains.
            val outgoing = queue[index]
            index += 1
            resetItemMeasurement()
            queue[index].let { claims.updateTrack(it.claimTrack()) }
            advanceListen(outgoing)
            emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.ADVANCE) }
            startEngineAt(index, 0)
            return
        }
        // The server already completed the drained stream, so nothing is closed.
        if (measuring) itemHeardBase = itemRenderedFrames()
        measuring = false
        loaded = false
        wantPlay = false
        heldPositionMs = queue.getOrNull(index)?.durationMs ?: 0
        sink?.pause()
        listens.ended(heldPositionMs / 1000.0, heldPositionMs / 1000.0)
        retireClaim()
        setState(NativePlaybackState.ENDED)
    }

    private fun failed(event: PcmEngineEvent.Failed) {
        if (!loaded) return
        val position = positionMs()
        loaded = false
        heldPositionMs = position
        val closeCode = lastCloseCode
        val socketClosed = event.code == "socket-closed"
        // A paused player keeps its place, to the frame its stopped engine names; the next play reconnects.
        if (socketClosed && !wantPlay) {
            val stopped = engine
            val item = queue.getOrNull(index)
            heldFrame = if (stopped != null && item != null) HeldFrame(item.playbackRef, preferredRate, stopped.timelineFrame) else null
            return
        }
        // A failed decoder's codec is no longer offered, so the stream reopens as server PCM where it stopped.
        if (event.code == "decoder-failed" && wantPlay && !recoveryAttempted) {
            recoveryAttempted = true
            startEngineAt(index, position)
            return
        }
        val recoverable = socketClosed && closeCode !in REFUSED_CLOSE_CODES && !recoveryAttempted
        if (recoverable) {
            recoveryAttempted = true
            setState(NativePlaybackState.BUFFERING)
            ensureTransport()
            return
        }
        wantPlay = false
        retireClaim()
        setState(NativePlaybackState.ERROR)
        when (closeCode) {
            PcmCloseCodes.MEDIA_NOT_FOUND -> emit { NativePlaybackEvent.ReferenceExpired(it) }
            PcmCloseCodes.UNAUTHENTICATED, PcmCloseCodes.FORBIDDEN ->
                emit { NativePlaybackEvent.Error(it, "authentication_required", "Sign in again to play.") }
            else -> emit { NativePlaybackEvent.Error(it, event.code, event.message) }
        }
    }

    private fun pauseNow(silenceAtOnce: Boolean = false) {
        if (state == NativePlaybackState.IDLE || state == NativePlaybackState.ENDED) return
        measureListening()
        engine?.takeIf { loaded }?.pause(immediate = silenceAtOnce)
        if (loaded) heldPositionMs = positionMs()
        if (wantPlay) listens.pause(heldPositionMs / 1000.0)
        wantPlay = false
        // A drained queue still plays its tail; the next play resumes it and ends the queue.
        if (endDrainUntilMs != null) {
            endDrainUntilMs = null
            sink?.pause()
        }
        retireClaim()
        setState(NativePlaybackState.PAUSED)
    }

    /** [keepPosition] holds the heard position, so the queue a shutdown leaves resumes there. */
    private fun stopNow(keepPosition: Boolean = false) {
        val position = if (keepPosition) positionMs() else 0
        unload("stopped")
        wantPlay = false
        heldPositionMs = position
        retireClaim()
        setState(NativePlaybackState.IDLE)
    }

    /** The output failed: it is let go at the heard position, and the next play opens a new one. */
    private fun outputFailed() {
        // What the failed output already played still counts, if it can still say.
        runCatching {
            measureListening()
            if (loaded) heldPositionMs = positionMs()
            if (measuring) itemHeardBase = itemRenderedFrames()
        }
        measuring = false
        loaded = false
        releaseOutput()
        if (retired) return
        wantPlay = false
        retireClaim()
        setState(NativePlaybackState.ERROR)
        emit { NativePlaybackEvent.Error(it, "output_failed", "Playback stopped unexpectedly. Press play to try again.") }
    }

    /** Frees the engine's PCM rings and its sink; a later engine continues the same socket's generations. */
    private fun releaseOutput() {
        val current = engine ?: return
        engine = null
        sink = null
        lastGeneration = maxOf(lastGeneration, current.generation)
        try {
            current.release()
        } catch (_: RuntimeException) {
            // A dead output may refuse even its release; nothing more can be done with it.
        }
    }

    private fun seekTo(positionMs: Long) {
        val item = queue.getOrNull(index) ?: return
        val target = positionMs.coerceIn(0, maxOf(0, item.durationMs))
        measureListening()
        listens.seek(item.listenTrack(), positionMs() / 1000.0, target / 1000.0, wantPlay)
        heldPositionMs = target
        val current = engine
        if (loaded && current != null) {
            val rate = sink?.sampleRate ?: preferredRate
            if (wantPlay) {
                current.seek(msToFrames(target, rate))
                loop?.let { applyEngineLoop(current, it, rate) }
            } else if (transportOpen) {
                startEngineAt(index, target, playWhenReady = false)
            } else {
                unload("seek-paused")
            }
        }
        if (state == NativePlaybackState.ENDED) setState(NativePlaybackState.PAUSED)
        emit { NativePlaybackEvent.Position(it) }
    }

    /**
     * The web's previous and next (`playCompactQueueOffset`): the neighbouring item of the same
     * queue group, with no restart of the current item and no step past the group's ends. Like the
     * web's, a skip always plays, also from a paused, ended or failed player.
     */
    private fun step(direction: Int, start: StartCommand) {
        val target = index + direction
        val reason = if (direction > 0) CurrentItemReason.NEXT else CurrentItemReason.PREVIOUS
        if (target !in queue.indices || index !in queue.indices || queue[target].queueGroup != queue[index].queueGroup) return
        if (direction > 0 && skipToPrepared()) return
        measureListening()
        val outgoing = queue.getOrNull(index)
        val outgoingPositionMs = positionMs()
        // A skip silences the outgoing track at once and names the new one before any of it is heard.
        unload("replacement")
        index = target
        heldPositionMs = 0
        resetItemMeasurement()
        recoveryAttempted = false
        changeListenTrack(outgoing, outgoingPositionMs)
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        emit { NativePlaybackEvent.CurrentItem(it, reason, source = source) }
        wantPlay = false
        requestPlay(start)
    }

    /**
     * Next while playing with the successor already prepared: it is heard at once, on the same
     * stream and claim, instead of after a new stream opens and fills.
     */
    private fun skipToPrepared(): Boolean {
        val current = engine?.takeIf { loaded && wantPlay && claims.owned && state == NativePlaybackState.PLAYING } ?: return false
        val outgoing = queue[index]
        if (current.preparedSuccessor != queue[index + 1].pcmTrack()) return false
        val outgoingPositionMs = positionMs()
        measureListening()
        skippingToPrepared = true
        val skipped = try {
            current.skipToPrepared()
        } finally {
            skippingToPrepared = false
        }
        if (!skipped) return false
        index += 1
        heldPositionMs = 0
        resetItemMeasurement()
        // Everything written from here on is the successor's.
        sink?.let {
            measuring = true
            itemMarker = acceptedFrames(it)
        }
        recoveryAttempted = false
        changeListenTrack(outgoing, outgoingPositionMs)
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        queue.getOrNull(index + 1)?.let { current.setQueuedNext(it.pcmTrack()) }
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.NEXT, source = source) }
        return true
    }

    private fun applyLoop(range: LoopRange?) {
        loop = range
        val current = engine?.takeIf { loaded } ?: return
        val rate = sink?.sampleRate ?: return
        if (range == null) current.clearLoop() else applyEngineLoop(current, range, rate)
    }

    /** A loop counted at another rate waits: the web recounts it once it hears this track's rate. */
    private fun applyEngineLoop(current: NativePcmEngine, range: LoopRange, rate: Int) {
        if (range.sampleRate == rate) current.setLoop(range.startFrame, range.endFrame, range.short)
    }

    /** Stops the item's stream and discards its unplayed PCM, so nothing more of it is heard. */
    private fun unload(reason: String) {
        if (measuring) itemHeardBase = itemRenderedFrames()
        measuring = false
        boundaryFrame = null
        endDrainUntilMs = null
        startWaitSinceMs = null
        if (loaded) engine?.stop(reason)
        loaded = false
        pendingRateChange = false
    }

    // ---- Socket ----

    private fun ensureTransport() {
        if (transport != null) return
        val epoch = ++transportEpoch
        transportOpen = false
        lastCloseCode = null
        transport = transports.connect(object : PcmTransportListener {
            override fun onOpen() = post { if (epoch == transportEpoch) transportOpened() }
            // Controls reach a stopped engine too, so it can close a stream the server confirms late.
            override fun onText(text: String) = post { if (epoch == transportEpoch) engine?.onServerText(text) }
            override fun onBinary(bytes: ByteArray) =
                post { if (epoch == transportEpoch && loaded) engine?.onBinary(bytes) }
            override fun onClosed(code: Int) = post { if (epoch == transportEpoch) transportClosed(code) }
        })
    }

    private fun transportOpened() {
        transportOpen = true
        timing.socketOpen(clock(), reused = false)
        if (!wantPlay) return
        if (loaded) startWhenReady() else startEngineAt(index, heldPositionMs)
    }

    private fun transportClosed(code: Int) {
        transport = null
        transportOpen = false
        lastCloseCode = code
        if (loaded) {
            engine?.onTransportClosed(code)
        } else if (wantPlay && state != NativePlaybackState.PLAYING) {
            wantPlay = false
            retireClaim()
            setState(NativePlaybackState.ERROR)
            if (code in REFUSED_CLOSE_CODES) {
                emit { NativePlaybackEvent.Error(it, "authentication_required", "Sign in again to play.") }
            } else {
                emit { NativePlaybackEvent.Error(it, "connection_failed", "Playback could not connect.") }
            }
        }
    }

    private fun closeTransport() {
        transportEpoch += 1
        transport?.close()
        transport = null
        transportOpen = false
    }

    // ---- Ownership and listen writes ----

    /** Pause, stop, end and errors release ownership once the listen writes for them drain. */
    private fun retireClaim() {
        if (!claims.owned) {
            releasePending = false
            claims.release()
            return
        }
        releasePending = true
    }

    private fun maybeRelease() {
        if (!releasePending || effectsInFlight > 0) return
        releasePending = false
        claims.release()
    }

    private fun maybeFinishShutdown() {
        val deadline = shutdownDeadlineMs ?: return
        if (effectsInFlight > 0 && clock() < deadline) return
        shutdownDeadlineMs = null
        claims.close()
        closeTransport()
        releaseOutput()
        retired = true
        // Shutdowns that already waited finish first; one posted since runs at once after them.
        shutdownFinished()
        dropRetiredWork()
    }

    /** One listen write as the owner, once a pending claim settles; [done] runs on the playback thread. */
    private fun sendListen(effect: ListenEffect, body: JSONObject, done: (ListenWriteOutcome) -> Unit) {
        effectsInFlight += 1
        // A write that follows from this one is queued before the claim may go.
        fun finish(outcome: ListenWriteOutcome) = try {
            done(outcome)
        } finally {
            effectsInFlight -= 1
        }
        claims.awaitOwnership { outcome ->
            val token = claims.heldToken
            when {
                // Without a claim the server refuses the write, as it answers the web's with 403.
                outcome != ClaimOutcome.GRANTED || token == null -> finish(ListenWriteOutcome.Refused)
                // Built while the claim was requested; its answer says Last.fm cannot take it.
                effect != ListenEffect.COMPLETE && claims.scrobblingAvailable == false -> finish(ListenWriteOutcome.LastfmUnavailable)
                else -> listenIo.execute {
                    // A request that cannot even be built, such as one OkHttp refuses, is as unanswered as a lost one.
                    val result = try {
                        listenApi.post(effect, clientId, token, body)
                    } catch (_: RuntimeException) {
                        ListenEffectResult.Unreachable
                    }
                    post { finish(ListenWriteOutcome.of(result)) }
                }
            }
        }
    }

    /** The web's `setCurrentPlayerTrack`: another track ends the listen of the one left. */
    private fun changeListenTrack(outgoing: QueueItem?, outgoingPositionMs: Long) {
        val incoming = queue.getOrNull(index)
        // An unknown position or duration falls back to the incoming item's, as the web's snapshot does.
        val positionMs = outgoingPositionMs.takeIf { it > 0 } ?: heldPositionMs
        val durationMs = outgoing?.durationMs?.takeIf { it > 0 } ?: incoming?.durationMs ?: 0
        listens.select(incoming?.listenTrack(), positionMs / 1000.0, durationMs / 1000.0)
    }

    /** The web's gapless boundary: the outgoing listen ends complete and the incoming one starts. */
    private fun advanceListen(outgoing: QueueItem) {
        val incoming = queue[index].listenTrack()
        val durationSeconds = outgoing.durationMs / 1000.0
        listens.advance(if (durationSeconds > 0) durationSeconds else positionMs() / 1000.0, durationSeconds, incoming)
    }

    /** Hands the item's frames heard since the last call, and any new underrun, to the current listen. */
    private fun measureListening(frames: Long = itemRenderedFrames()) {
        val rate = sink?.sampleRate ?: return
        if (frames > listenedFrames && listens.heard(frames - listenedFrames, rate)) listenedFrames = frames
        if (itemUnderruns > listenedUnderruns) {
            listenedUnderruns = itemUnderruns
            listens.underrun()
        }
    }

    private fun warm() {
        lastWarmMs = clock()
        warmer.warm(socketConnection = transport == null)
    }

    private fun maybeKeepWarm() {
        val until = warmUntilMs ?: return
        val now = clock()
        when {
            // The owner's own requests keep its connections warm.
            claims.owned -> {
                warmUntilMs = now + KEEP_WARM_FOR_MS
                lastWarmMs = now
            }
            now >= until -> warmUntilMs = null
            now - lastWarmMs >= KEEP_WARM_MS -> warm()
        }
    }

    // ---- Measured listening ----

    private fun acceptedFrames(output: PcmSink): Long = output.heardFrames() + output.pendingFrames()

    private fun startMeasuring() {
        val output = sink ?: return
        measuring = true
        itemMarker = acceptedFrames(output)
        boundaryFrame = null
    }

    private fun resetItemMeasurement() {
        measuring = false
        itemHeardBase = 0
        itemUnderruns = 0
        listenedFrames = 0
        listenedUnderruns = 0
        boundaryFrame = null
    }

    /** Frames of the current item heard so far; a pending boundary caps them at the successor's start. */
    private fun itemRenderedFrames(): Long {
        val output = sink
        if (!measuring || output == null) return itemHeardBase
        val heard = minOf(output.heardFrames(), boundaryFrame ?: Long.MAX_VALUE)
        return itemHeardBase + (heard - itemMarker).coerceAtLeast(0)
    }

    // ---- Ownership, state and position ----

    private fun onClaimEvent(event: ClaimEvent) {
        val ownership = when (event) {
            ClaimEvent.Owned -> "owned"
            ClaimEvent.Released -> "released"
            ClaimEvent.Blocked -> "blocked"
            ClaimEvent.Lost -> "lost"
        }
        if (event == ClaimEvent.Lost) {
            // Another client owns playback now; this one must fall silent at once, and stay silent.
            startGate.dropHeldStart()
            releasePending = false
            measureListening()
            if (loaded) heldPositionMs = positionMs()
            wantPlay = false
            engine?.takeIf { loaded }?.pause(immediate = true)
            setState(NativePlaybackState.PAUSED)
        }
        if (event == ClaimEvent.Lost || event == ClaimEvent.Blocked) listens.ownershipLost(heldPositionMs / 1000.0)
        emit { NativePlaybackEvent.Ownership(it, ownership) }
    }

    private fun setState(next: NativePlaybackState) {
        // A start not heard yet ends as whatever stopped it: a pause, a stop, an error or the end.
        if (!next.wanted) timing.finish(next.wire, clock())
        if (state == next) {
            refreshSnapshot()
            return
        }
        state = next
        if (!next.wanted) startGate.stopped(next)
        emit { NativePlaybackEvent.State(it, source) }
    }

    private fun maybeEmitPosition() {
        if (!loaded || (state != NativePlaybackState.PLAYING && state != NativePlaybackState.BUFFERING)) return
        val now = clock()
        if (now - lastPositionEventMs < POSITION_INTERVAL_MS) return
        lastPositionEventMs = now
        emit { NativePlaybackEvent.Position(it) }
        listens.position()
    }

    private fun positionMs(): Long {
        val current = engine
        val output = sink
        // A seek reports its target until its PCM takes over, so the seekbar never jumps back.
        if (!loaded || current == null || output == null || current.seekPending) return heldPositionMs
        val frames = (current.timelineFrame - output.pendingFrames()).coerceAtLeast(0)
        return frames * 1000 / output.sampleRate
    }

    private fun refreshSnapshot(): NativePlaybackSnapshot = NativePlaybackSnapshot(
        clientId = clientId,
        state = state,
        queueRevision = revision,
        currentIndex = index.takeIf { it in queue.indices },
        positionMs = positionMs(),
        durationMs = queue.getOrNull(index)?.durationMs ?: 0,
        items = queue,
        sampleRate = currentSampleRate(),
    ).also { snapshot = it }

    /** The current item's rate: its output's once it was heard, or the rate the server named for it. */
    private fun currentSampleRate(): Int? {
        val item = queue.getOrNull(index) ?: return null
        return sink?.sampleRate?.takeIf { loaded && firstFrameHeard } ?: rates[item.playbackRef]
    }

    private fun emit(build: (NativePlaybackSnapshot) -> NativePlaybackEvent) {
        measureListening()
        events(build(refreshSnapshot()))
    }

    private fun remember(playbackRef: String, rate: Int) {
        rates[playbackRef] = rate
        if (rates.size > MAX_KNOWN_RATES) rates.remove(rates.keys.first())
    }

    private fun msToFrames(positionMs: Long, rate: Int): Long = positionMs * rate / 1000

    private class HeldFrame(val playbackRef: String, val sampleRate: Int, val frame: Long)

    companion object {
        /** Most albums are CD audio; a wrong guess costs one refused open, as on the web. */
        const val DEFAULT_RATE = 44_100

        /** `STREAMING_RECENT_STALL_MS`. */
        const val RECENT_STALL_MS = 60_000L

        /** `fallback_sample_rate`: a 320 kbps MP3 keeps the source rate up to 48 kHz. */
        const val LOW_BITRATE_MAX_RATE = 48_000
        const val RENDER_CHUNK_FRAMES = 4_096
        /** How long the thread waits for work while it feeds the output. */
        const val RENDER_WAIT_MS = 5L
        const val PAUSE_POLL_MS = 1L
        const val POSITION_INTERVAL_MS = 250L
        const val MAX_KNOWN_RATES = 512

        /** OkHttp keeps an idle pooled connection for five minutes. */
        const val KEEP_WARM_MS = 4L * 60 * 1000

        /** How long connections stay warm after the handshake or after this client last owned playback. */
        const val KEEP_WARM_FOR_MS = 30L * 60 * 1000
        const val END_DRAIN_MARGIN_MS = 500L
        /** How long an owned start may wait for its first PCM before it is reopened, then failed. */
        const val START_STALL_MS = 15_000L
        /** How long a shutdown keeps the claim for the listen writes still in flight. */
        const val SHUTDOWN_CHECKPOINT_MS = 3_000L
        private val REFUSED_CLOSE_CODES = setOf(
            PcmCloseCodes.UNAUTHENTICATED,
            PcmCloseCodes.FORBIDDEN,
            PcmCloseCodes.MEDIA_NOT_FOUND,
        )
    }
}
