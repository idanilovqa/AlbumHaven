package org.albumhaven.shell.playback

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
 * web's own skips do, while a natural end continues into the next group.
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
) {
    fun pcmTrack() = PcmTrack(playbackRef, durationMs / 1000.0)

    fun claimTrack() = ClaimTrack(playbackRef, title, artist, album, artworkUrl)

    fun listenTrack() = ListenTrack(listenKey, playbackRef, title, artist, album, trackNumber)

    companion object {
        private const val MAX_TEXT_CHARS = 512
        private const val MAX_URL_CHARS = 2_048

        /** Same bounds `PUT /playback/state` applies to mirrored track text. */
        fun isDisplayText(value: String): Boolean = value.length <= MAX_TEXT_CHARS && value.none { it.code < 32 }

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

/** A loop range on the bridge's fixed 48 kHz media timeline; [kind] is the web's when it names one. */
data class LoopRange48k(val startFrame: Long, val endFrame: Long, val kind: LoopKind? = null) {
    fun toTrackFrames(sampleRate: Int): Pair<Long, Long> =
        convert(startFrame, sampleRate) to convert(endFrame, sampleRate)

    /** Replayed from retained PCM: the web's kind, or the worklet's own rule of at most five seconds. */
    val short: Boolean
        get() = kind?.let { it == LoopKind.SHORT }
            ?: (endFrame - startFrame <= PcmEngineConfig.SHORT_LOOP_MAX_SECONDS.toLong() * BRIDGE_RATE)

    private fun convert(frame: Long, sampleRate: Int): Long =
        if (sampleRate == BRIDGE_RATE) frame else (frame.toDouble() * sampleRate / BRIDGE_RATE).roundToLong()

    companion object {
        const val BRIDGE_RATE = 48_000
    }
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
    val loop: LoopRange48k?,
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
) {
    private val tasks = LinkedBlockingQueue<Runnable>()

    @Volatile private var running = false

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
    private var loop: LoopRange48k? = null
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

    private var warmEnabled = false
    private var lastWarmMs = 0L

    // Measured listening of the current item, in the sink's accepted-frame coordinates.
    private var measuring = false
    private var itemMarker = 0L
    private var itemHeardBase = 0L
    private var itemUnderruns = 0

    /** Accepted frame where a queued successor took over; [advanced] has not applied it yet. */
    private var boundaryFrame: Long? = null

    /** While a replacement waits for the outgoing cushion: when the web would start afresh instead. */
    private var replacementDeadlineMs: Long? = null

    // ---- Commands (any thread) ----

    fun loadQueue(load: QueueLoad): CommandResult {
        synchronized(revisionLock) {
            if (load.queueRevision <= acceptedRevision && !documentRestarted) return CommandResult.STALE_REVISION
            acceptedRevision = load.queueRevision
            documentRestarted = false
        }
        post { applyLoad(load) }
        return CommandResult.ACCEPTED
    }

    fun play(queueRevision: Long, from: CommandSource = CommandSource.WEB) =
        revisioned(queueRevision, from) { requestPlay() }

    fun seek(queueRevision: Long, positionMs: Long, from: CommandSource = CommandSource.WEB) =
        revisioned(queueRevision, from) { seekTo(positionMs) }

    fun next(queueRevision: Long, from: CommandSource = CommandSource.WEB) = revisioned(queueRevision, from) { step(+1) }

    fun previous(queueRevision: Long, from: CommandSource = CommandSource.WEB) =
        revisioned(queueRevision, from) { step(-1) }

    fun setLoop(queueRevision: Long, range: LoopRange48k?) = revisioned(queueRevision) { applyLoop(range) }

    fun pause(from: CommandSource = CommandSource.WEB) = post(from) { pauseNow() }

    fun stop(from: CommandSource = CommandSource.WEB) = post(from) { stopNow(NativePlaybackState.IDLE) }

    /**
     * A new document of the same origin re-attaches to the running queue: playback, the claim and
     * the applied revision continue, so the document can adopt them from its handshake snapshot.
     * A document counts revisions from one, so its first queue replaces this one whatever its revision.
     */
    fun documentStarted() {
        synchronized(revisionLock) { documentRestarted = true }
    }

    /** Runs [callback] on the playback thread once every command sent before it has been applied. */
    fun afterPendingCommands(callback: Runnable) = post(callback)

    /** Warms the connections a first start needs, then keeps them warm while nothing plays. */
    fun warmConnections() = post {
        warmEnabled = true
        warm()
    }

    fun start() {
        if (running) return
        running = true
        Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
            while (running) runOnce(IDLE_WAIT_MS)
        }, "AlbumHavenPlayback").start()
    }

    /**
     * Stops playback without waiting: a listen heard mid-play ends with the web's unload checkpoint,
     * and the claim, the socket and the playback thread go once the listen writes drain, or after
     * [SHUTDOWN_CHECKPOINT_MS], so none is refused for a released claim. [finished] then runs on the
     * playback thread, after the claim release has been handed to its executor.
     */
    fun shutdown(finished: () -> Unit = {}) = post {
        measureListening()
        if (wantPlay && claims.owned) {
            listens.unload(positionMs() / 1000.0, (queue.getOrNull(index)?.durationMs ?: 0) / 1000.0)
        }
        stopNow(NativePlaybackState.IDLE)
        releasePending = false
        warmEnabled = false
        shutdownFinished = finished
        shutdownDeadlineMs = clock() + SHUTDOWN_CHECKPOINT_MS
    }

    // ---- Playback thread ----

    /** Runs queued work and one render pass; waits up to [waitMs] for work when nothing rendered. */
    fun runOnce(waitMs: Long) {
        var task: Runnable? = tasks.poll()
        while (task != null) {
            task.run()
            task = tasks.poll()
        }
        claims.tick()
        maybeAbandonReplacement()
        // A stream may buffer while the claim is requested; only an owner is heard.
        val written = if (loaded && claims.owned) engine?.render(RENDER_CHUNK_FRAMES) ?: 0 else 0
        maybeFinishDrainedQueue()
        maybeEmitPosition()
        maybeRelease()
        maybeKeepWarm()
        maybeFinishShutdown()
        if (written == 0 && waitMs > 0) {
            tasks.poll(waitMs, TimeUnit.MILLISECONDS)?.run()
        }
    }

    private fun post(task: Runnable) {
        tasks.offer(task)
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

    private fun applyLoad(load: QueueLoad) {
        if (load.keepCurrent && keepCurrent(load)) return
        measureListening()
        val outgoing = queue.getOrNull(index)
        val outgoingPositionMs = positionMs()
        val replacing = load.autoplay && load.loop == null && canReplace()
        if (replacing) detachMeasurement() else unload("replacement")
        resetItemMeasurement()
        // A replacement keeps the outgoing track playing until the new start has its cushion.
        wantPlay = replacing
        queue = load.items
        revision = load.queueRevision
        index = load.currentIndex
        loop = load.loop
        heldPositionMs = load.positionMs
        recoveryAttempted = false
        changeListenTrack(outgoing, outgoingPositionMs)
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.LOAD) }
        if (replacing && replaceWhilePlaying()) return
        if (replacing) {
            unload("replacement")
            wantPlay = false
        }
        if (load.autoplay) {
            requestPlay()
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
        if (incoming.listenKey != playingItem.listenKey || current.replacing) return false
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

    /** `startStreamingTrack`'s `canPrepareReplacement`: playing, heard, and no seek or replacement pending. */
    private fun canReplace(): Boolean =
        wantPlay && loaded && claims.owned && state == NativePlaybackState.PLAYING && loop == null &&
            engine?.replacing == false

    /**
     * Prepares the current item as the web's track replacement: the outgoing audio plays on until
     * the new start has its cushion. False when it must start afresh: another native rate, or the
     * engine refused.
     */
    private fun replaceWhilePlaying(): Boolean {
        val current = engine ?: return false
        val output = sink ?: return false
        val item = queue.getOrNull(index) ?: return false
        if ((rates[item.playbackRef] ?: output.sampleRate) != output.sampleRate) return false
        val successor = queue.getOrNull(index + 1)?.pcmTrack()
        if (!current.replace(item.pcmTrack(), msToFrames(heldPositionMs, output.sampleRate), successor)) return false
        replacementDeadlineMs = if (current.outgoingCushionReady) null else clock() + REPLACEMENT_CUSHION_WAIT_MS
        claims.updateTrack(item.claimTrack())
        // The new start is not heard yet, so it reports loading until its first frame.
        setState(NativePlaybackState.LOADING)
        listens.begin(item.listenTrack(), heldPositionMs / 1000.0)
        return true
    }

    /** `waitForStreamingReplacementCushion`: without the outgoing cushion within a second, start afresh. */
    private fun maybeAbandonReplacement() {
        val deadline = replacementDeadlineMs ?: return
        val current = engine
        if (current == null || !loaded || !current.replacing || current.outgoingCushionReady) {
            replacementDeadlineMs = null
            return
        }
        if (clock() < deadline) return
        replacementDeadlineMs = null
        unload("replacement")
        startEngineAt(index, heldPositionMs)
    }

    private fun requestPlay() {
        val item = queue.getOrNull(index) ?: return
        if (wantPlay && state != NativePlaybackState.PAUSED) return
        wantPlay = true
        releasePending = false
        // A replaced or resumed item reports loading, so its first frame is a fresh `playing`.
        setState(NativePlaybackState.LOADING)
        ensureTransport()
        // The stream fills its cushion while the claim is requested; nothing plays before it is granted.
        if (transportOpen && !loaded) startEngineAt(index, heldPositionMs)
        val requestRevision = revision
        val requestIndex = index
        claims.acquire(item.claimTrack()) { outcome ->
            if (!wantPlay || revision != requestRevision || index != requestIndex) return@acquire
            when (outcome) {
                ClaimOutcome.GRANTED -> startWhenReady()
                ClaimOutcome.BLOCKED -> {
                    wantPlay = false
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
        listens.begin(item.listenTrack(), heldPositionMs / 1000.0)
    }

    /** Starts or resumes once both the claim and the socket are ready. */
    private fun startWhenReady() {
        if (!wantPlay || !claims.owned || !transportOpen) return
        val current = engine
        if (loaded && current != null) {
            current.play()
            if (state == NativePlaybackState.LOADING || state == NativePlaybackState.PAUSED) {
                setState(NativePlaybackState.PLAYING)
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
        pendingRateChange = false
        loaded = true
        endDrainUntilMs = null
        current.start(item.pcmTrack(), msToFrames(positionMs, rate), playWhenReady)
        startMeasuring()
        queue.getOrNull(itemIndex + 1)?.let { current.setQueuedNext(it.pcmTrack()) }
        loop?.let { applyEngineLoop(current, it, rate) }
        if (state != NativePlaybackState.PLAYING && playWhenReady) setState(NativePlaybackState.BUFFERING)
    }

    private fun engineFor(rate: Int): NativePcmEngine {
        val current = engine
        if (current != null && sink?.sampleRate == rate) return current
        current?.let {
            lastGeneration = maxOf(lastGeneration, it.generation)
            it.release()
        }
        val newSink = sinks(rate)
        sink = newSink
        preferredRate = rate
        val sender = PcmControlSender { control ->
            val open = transport
            transportOpen && open != null && open.send(AhpcControlCodec.encode(control))
        }
        return NativePcmEngine(PcmEngineConfig(rate), newSink, sender, lastGeneration, ::onEngineEvent).also {
            engine = it
        }
    }

    private fun onEngineEvent(event: PcmEngineEvent) {
        when (event) {
            is PcmEngineEvent.FirstFrame -> {
                recoveryAttempted = false
                setState(NativePlaybackState.PLAYING)
            }
            is PcmEngineEvent.Buffering ->
                if (wantPlay) setState(if (event.active) NativePlaybackState.BUFFERING else NativePlaybackState.PLAYING)
            is PcmEngineEvent.Boundary -> when (event.kind) {
                PcmBoundaryKind.QUEUED_NEXT -> {
                    // Nothing of the successor is written yet, so this frame splits the two listens.
                    boundaryFrame = sink?.let(::acceptedFrames)
                    post { advanced() }
                }
                PcmBoundaryKind.SEEK -> emit { NativePlaybackEvent.Position(it) }
                PcmBoundaryKind.LOOP -> emit { NativePlaybackEvent.LoopWrapped(it) }
                PcmBoundaryKind.REPLACEMENT -> {
                    // Nothing of the new start is written yet: its listen counts from this frame.
                    replacementDeadlineMs = null
                    startMeasuring()
                }
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
            is PcmEngineEvent.Underrun -> if (measuring) itemUnderruns += 1
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
        // A paused player keeps its place; the next play reconnects.
        if (socketClosed && !wantPlay) return
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

    private fun pauseNow() {
        if (state == NativePlaybackState.IDLE || state == NativePlaybackState.ENDED) return
        measureListening()
        if (loaded) heldPositionMs = positionMs()
        // A replacement never cuts over after Pause: the outgoing audio stops and the new start waits.
        if (engine?.replacing == true) unload("replacement-paused")
        if (wantPlay) listens.pause(heldPositionMs / 1000.0)
        wantPlay = false
        engine?.takeIf { loaded }?.pause()
        // A drained queue still plays its tail; the next play resumes it and ends the queue.
        if (endDrainUntilMs != null) {
            endDrainUntilMs = null
            sink?.pause()
        }
        retireClaim()
        setState(NativePlaybackState.PAUSED)
    }

    private fun stopNow(finalState: NativePlaybackState) {
        unload("stopped")
        wantPlay = false
        heldPositionMs = 0
        retireClaim()
        setState(finalState)
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
     * queue group, with no restart of the current item and no step past the group's ends.
     */
    private fun step(direction: Int) {
        val target = index + direction
        val reason = if (direction > 0) CurrentItemReason.NEXT else CurrentItemReason.PREVIOUS
        if (target !in queue.indices || index !in queue.indices || queue[target].queueGroup != queue[index].queueGroup) return
        val playing = wantPlay
        val replacing = canReplace()
        measureListening()
        val outgoing = queue.getOrNull(index)
        val outgoingPositionMs = positionMs()
        if (replacing) detachMeasurement() else unload("replacement")
        index = target
        heldPositionMs = 0
        resetItemMeasurement()
        recoveryAttempted = false
        changeListenTrack(outgoing, outgoingPositionMs)
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        emit { NativePlaybackEvent.CurrentItem(it, reason, source = source) }
        if (replacing && replaceWhilePlaying()) return
        if (replacing) unload("replacement")
        if (playing) {
            wantPlay = false
            requestPlay()
        } else {
            setState(NativePlaybackState.PAUSED)
        }
    }

    private fun applyLoop(range: LoopRange48k?) {
        loop = range
        val current = engine?.takeIf { loaded } ?: return
        val rate = sink?.sampleRate ?: return
        if (range == null) current.clearLoop() else applyEngineLoop(current, range, rate)
    }

    private fun applyEngineLoop(current: NativePcmEngine, range: LoopRange48k, rate: Int) {
        val (start, end) = range.toTrackFrames(rate)
        if (end > start) current.setLoop(start, end, range.short)
    }

    private fun unload(reason: String) {
        detachMeasurement()
        replacementDeadlineMs = null
        if (loaded) engine?.stop(reason)
        loaded = false
        pendingRateChange = false
    }

    /** Stops measuring the outgoing item; the engine keeps playing it while a replacement prepares. */
    private fun detachMeasurement() {
        if (measuring) itemHeardBase = itemRenderedFrames()
        measuring = false
        boundaryFrame = null
        endDrainUntilMs = null
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
        claims.release()
        closeTransport()
        running = false
        shutdownFinished()
    }

    /** One listen write as the owner, once a pending claim settles; [done] runs on the playback thread. */
    private fun sendListen(effect: ListenEffect, body: JSONObject, done: (ListenWriteOutcome) -> Unit) {
        effectsInFlight += 1
        claims.awaitOwnership { outcome ->
            val token = claims.heldToken
            if (outcome != ClaimOutcome.GRANTED || token == null) {
                // Without a claim the server refuses the write, as it answers the web's with 403.
                done(ListenWriteOutcome.Refused)
                effectsInFlight -= 1
                return@awaitOwnership
            }
            if (effect != ListenEffect.COMPLETE && claims.scrobblingAvailable == false) {
                // Built while the claim was requested; its answer says Last.fm cannot take it.
                done(ListenWriteOutcome.LastfmUnavailable)
                effectsInFlight -= 1
                return@awaitOwnership
            }
            listenIo.execute {
                val result = listenApi.post(effect, clientId, token, body)
                post {
                    // A write that follows from this one is queued before the claim may go.
                    done(ListenWriteOutcome.of(result))
                    effectsInFlight -= 1
                }
            }
        }
    }

    /** The web's `setCurrentPlayerTrack`: another track ends the listen of the one left. */
    private fun changeListenTrack(outgoing: QueueItem?, outgoingPositionMs: Long) {
        val incoming = queue.getOrNull(index)
        if (incoming != null && listens.currentTrack?.listenKey != incoming.listenKey) {
            // An unknown position or duration falls back to the incoming item's, as the web's snapshot does.
            val positionMs = outgoingPositionMs.takeIf { it > 0 } ?: heldPositionMs
            val durationMs = outgoing?.durationMs?.takeIf { it > 0 } ?: incoming.durationMs
            listens.trackChange(positionMs / 1000.0, durationMs / 1000.0)
        }
        listens.measureItem(incoming?.listenTrack())
    }

    /** The web's gapless boundary: the outgoing listen ends complete and the incoming one starts. */
    private fun advanceListen(outgoing: QueueItem) {
        val incoming = queue[index].listenTrack()
        val durationSeconds = outgoing.durationMs / 1000.0
        listens.advance(if (durationSeconds > 0) durationSeconds else positionMs() / 1000.0, durationSeconds, incoming)
        listens.measureItem(incoming)
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
        if (warmEnabled && !claims.owned && clock() - lastWarmMs >= KEEP_WARM_MS) warm()
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
            // Another client owns playback now; this one must fall silent at once.
            releasePending = false
            measureListening()
            if (loaded) heldPositionMs = positionMs()
            wantPlay = false
            engine?.takeIf { loaded }?.pause()
            setState(NativePlaybackState.PAUSED)
        }
        if (event == ClaimEvent.Lost || event == ClaimEvent.Blocked) listens.ownershipLost(heldPositionMs / 1000.0)
        emit { NativePlaybackEvent.Ownership(it, ownership) }
    }

    private fun setState(next: NativePlaybackState) {
        if (state == next) {
            refreshSnapshot()
            return
        }
        state = next
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
        if (!loaded || current == null || output == null || current.replacing) return heldPositionMs
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
    ).also { snapshot = it }

    private fun emit(build: (NativePlaybackSnapshot) -> NativePlaybackEvent) {
        measureListening()
        events(build(refreshSnapshot()))
    }

    private fun remember(playbackRef: String, rate: Int) {
        rates[playbackRef] = rate
        if (rates.size > MAX_KNOWN_RATES) rates.remove(rates.keys.first())
    }

    private fun msToFrames(positionMs: Long, rate: Int): Long = positionMs * rate / 1000

    companion object {
        /** Most albums are CD audio; a wrong guess costs one refused open, as on the web. */
        const val DEFAULT_RATE = 44_100
        const val RENDER_CHUNK_FRAMES = 4_096
        const val IDLE_WAIT_MS = 5L
        const val POSITION_INTERVAL_MS = 250L
        const val MAX_KNOWN_RATES = 512

        /** OkHttp keeps an idle pooled connection for five minutes. */
        const val KEEP_WARM_MS = 4L * 60 * 1000
        const val END_DRAIN_MARGIN_MS = 500L
        /** `STREAMING_REPLACEMENT_CUSHION_WAIT_MS`. */
        const val REPLACEMENT_CUSHION_WAIT_MS = 1_000L
        /** How long a shutdown keeps the claim for the listen writes still in flight. */
        const val SHUTDOWN_CHECKPOINT_MS = 3_000L
        private val REFUSED_CLOSE_CODES = setOf(
            PcmCloseCodes.UNAUTHENTICATED,
            PcmCloseCodes.FORBIDDEN,
            PcmCloseCodes.MEDIA_NOT_FOUND,
        )
    }
}
