package org.albumhaven.shell.playback

import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.roundToLong

/** One `playback.loadQueue` entry; [playbackRef] is opaque and path-free. */
data class QueueItem(
    val playbackRef: String,
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val durationMs: Long,
) {
    fun pcmTrack() = PcmTrack(playbackRef, durationMs / 1000.0)

    fun claimTrack() = ClaimTrack(playbackRef, title, artist, album, artworkUrl)
}

/** A loop range on the bridge's fixed 48 kHz media timeline. */
data class LoopRange48k(val startFrame: Long, val endFrame: Long) {
    fun toTrackFrames(sampleRate: Int): Pair<Long, Long> =
        convert(startFrame, sampleRate) to convert(endFrame, sampleRate)

    private fun convert(frame: Long, sampleRate: Int): Long =
        if (sampleRate == BRIDGE_RATE) frame else (frame.toDouble() * sampleRate / BRIDGE_RATE).roundToLong()

    companion object {
        const val BRIDGE_RATE = 48_000
    }
}

data class QueueLoad(
    val queueRevision: Long,
    val items: List<QueueItem>,
    val currentIndex: Int,
    val positionMs: Long,
    val loop: LoopRange48k?,
    val autoplay: Boolean,
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
)

enum class CurrentItemReason(val wire: String) {
    LOAD("load"),
    ADVANCE("advance"),
    NEXT("next"),
    PREVIOUS("previous"),
}

sealed interface NativePlaybackEvent {
    val snapshot: NativePlaybackSnapshot

    data class State(override val snapshot: NativePlaybackSnapshot) : NativePlaybackEvent
    data class Position(override val snapshot: NativePlaybackSnapshot) : NativePlaybackEvent
    data class CurrentItem(override val snapshot: NativePlaybackSnapshot, val reason: CurrentItemReason) :
        NativePlaybackEvent
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
 * of the WebView, so a Media3 player can adapt it unchanged.
 */
class NativePlaybackController(
    private val transports: PcmTransportFactory,
    claimApi: PlaybackClaimApi,
    private val sinks: (sampleRate: Int) -> PcmSink,
    io: Executor,
    private val clock: () -> Long,
    private val events: (NativePlaybackEvent) -> Unit,
    val clientId: String = UUID.randomUUID().toString(),
) {
    private val tasks = LinkedBlockingQueue<Runnable>()

    @Volatile private var running = false
    private var thread: Thread? = null

    private val revisionLock = Any()
    private var acceptedRevision = 0L

    @Volatile var snapshot = NativePlaybackSnapshot(clientId, NativePlaybackState.IDLE, 0, null, 0, 0)
        private set

    private val claims = PlaybackClaimOwner(claimApi, clientId, io, ::post, clock, ::onClaimEvent)

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

    // ---- Commands (any thread) ----

    fun loadQueue(load: QueueLoad): CommandResult {
        synchronized(revisionLock) {
            if (load.queueRevision <= acceptedRevision) return CommandResult.STALE_REVISION
            acceptedRevision = load.queueRevision
        }
        post { applyLoad(load) }
        return CommandResult.ACCEPTED
    }

    fun play(queueRevision: Long) = revisioned(queueRevision) { requestPlay() }

    fun seek(queueRevision: Long, positionMs: Long) = revisioned(queueRevision) { seekTo(positionMs) }

    fun next(queueRevision: Long) = revisioned(queueRevision) { step(+1) }

    fun previous(queueRevision: Long) = revisioned(queueRevision) { step(-1) }

    fun setLoop(queueRevision: Long, range: LoopRange48k?) = revisioned(queueRevision) { applyLoop(range) }

    fun pause() = post { pauseNow() }

    fun stop() = post { stopNow(NativePlaybackState.IDLE) }

    fun start() {
        if (running) return
        running = true
        thread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO)
            while (running) runOnce(IDLE_WAIT_MS)
        }, "AlbumHavenPlayback").also { it.start() }
    }

    /** Stops playback, releases the claim and the socket, then ends the playback thread. */
    fun shutdown() {
        post {
            stopNow(NativePlaybackState.IDLE)
            closeTransport()
            running = false
        }
        thread?.join(SHUTDOWN_JOIN_MS)
        thread = null
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
        val written = if (loaded) engine?.render(RENDER_CHUNK_FRAMES) ?: 0 else 0
        maybeEmitPosition()
        if (written == 0 && waitMs > 0) {
            tasks.poll(waitMs, TimeUnit.MILLISECONDS)?.run()
        }
    }

    private fun post(task: Runnable) {
        tasks.offer(task)
    }

    private fun post(task: () -> Unit) = post(Runnable(task))

    private fun revisioned(queueRevision: Long, task: () -> Unit): CommandResult {
        synchronized(revisionLock) {
            if (acceptedRevision == 0L) return CommandResult.NO_QUEUE
            if (queueRevision != acceptedRevision) return CommandResult.STALE_REVISION
        }
        post { if (queueRevision == revision) task() }
        return CommandResult.ACCEPTED
    }

    private fun applyLoad(load: QueueLoad) {
        unload("replacement")
        wantPlay = false
        queue = load.items
        revision = load.queueRevision
        index = load.currentIndex
        loop = load.loop
        heldPositionMs = load.positionMs
        recoveryAttempted = false
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.LOAD) }
        if (load.autoplay) {
            requestPlay()
        } else {
            claims.release()
            setState(NativePlaybackState.PAUSED)
        }
    }

    private fun requestPlay() {
        val item = queue.getOrNull(index) ?: return
        if (wantPlay && state != NativePlaybackState.PAUSED) return
        wantPlay = true
        // A replaced or resumed item reports loading, so its first frame is a fresh `playing`.
        setState(NativePlaybackState.LOADING)
        ensureTransport()
        val requestRevision = revision
        val requestIndex = index
        claims.acquire(item.claimTrack()) { outcome ->
            if (!wantPlay || revision != requestRevision || index != requestIndex) return@acquire
            when (outcome) {
                ClaimOutcome.GRANTED -> startWhenReady()
                ClaimOutcome.BLOCKED -> {
                    wantPlay = false
                    setState(NativePlaybackState.PAUSED)
                }
                ClaimOutcome.UNAVAILABLE -> {
                    wantPlay = false
                    setState(NativePlaybackState.ERROR)
                    emit { NativePlaybackEvent.Error(it, "ownership_unavailable", "Playback ownership is unavailable.") }
                }
            }
        }
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
        val current = engineFor(rate)
        heldPositionMs = positionMs
        pendingRateChange = false
        loaded = true
        current.start(item.pcmTrack(), msToFrames(positionMs, rate), playWhenReady)
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
                PcmBoundaryKind.QUEUED_NEXT -> post { advanced() }
                PcmBoundaryKind.SEEK -> emit { NativePlaybackEvent.Position(it) }
                PcmBoundaryKind.LOOP -> emit { NativePlaybackEvent.LoopWrapped(it) }
            }
            is PcmEngineEvent.Ended -> post { ended() }
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
            is PcmEngineEvent.Underrun -> Unit
        }
    }

    private fun advanced() {
        if (index + 1 >= queue.size) return
        index += 1
        heldPositionMs = 0
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        queue.getOrNull(index + 1)?.let { engine?.setQueuedNext(it.pcmTrack()) }
        emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.ADVANCE) }
    }

    private fun ended() {
        val hasNext = index + 1 < queue.size
        if (hasNext && (pendingRateChange || wantPlay)) {
            // A successor at another native rate starts on a new engine after this one drains.
            index += 1
            queue[index].let { claims.updateTrack(it.claimTrack()) }
            emit { NativePlaybackEvent.CurrentItem(it, CurrentItemReason.ADVANCE) }
            startEngineAt(index, 0)
            return
        }
        // The server already completed the drained stream, so nothing is closed.
        loaded = false
        wantPlay = false
        heldPositionMs = queue.getOrNull(index)?.durationMs ?: 0
        sink?.pause()
        claims.release()
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
        claims.release()
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
        if (loaded) heldPositionMs = positionMs()
        wantPlay = false
        engine?.takeIf { loaded }?.pause()
        claims.release()
        setState(NativePlaybackState.PAUSED)
    }

    private fun stopNow(finalState: NativePlaybackState) {
        unload("stopped")
        wantPlay = false
        heldPositionMs = 0
        claims.release()
        setState(finalState)
    }

    private fun seekTo(positionMs: Long) {
        val item = queue.getOrNull(index) ?: return
        val target = positionMs.coerceIn(0, maxOf(0, item.durationMs))
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

    private fun step(direction: Int) {
        if (queue.isEmpty()) return
        val target = index + direction
        val reason = if (direction > 0) CurrentItemReason.NEXT else CurrentItemReason.PREVIOUS
        if (target >= queue.size) return
        val playing = wantPlay
        unload("replacement")
        index = target.coerceAtLeast(0)
        heldPositionMs = 0
        recoveryAttempted = false
        queue[index].let { claims.updateTrack(it.claimTrack()) }
        emit { NativePlaybackEvent.CurrentItem(it, reason) }
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
        if (end > start) current.setLoop(start, end)
    }

    private fun unload(reason: String) {
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
            override fun onText(text: String) = post { if (epoch == transportEpoch && loaded) engine?.onServerText(text) }
            override fun onBinary(bytes: ByteArray) =
                post { if (epoch == transportEpoch && loaded) engine?.onBinary(bytes) }
            override fun onClosed(code: Int) = post { if (epoch == transportEpoch) transportClosed(code) }
        })
    }

    private fun transportOpened() {
        transportOpen = true
        if (!wantPlay) return
        if (loaded) startWhenReady() else if (claims.owned) startEngineAt(index, heldPositionMs)
    }

    private fun transportClosed(code: Int) {
        transport = null
        transportOpen = false
        lastCloseCode = code
        if (loaded) {
            engine?.onTransportClosed(code)
        } else if (wantPlay && state != NativePlaybackState.PLAYING) {
            wantPlay = false
            claims.release()
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
            if (loaded) heldPositionMs = positionMs()
            wantPlay = false
            engine?.takeIf { loaded }?.pause()
            setState(NativePlaybackState.PAUSED)
        }
        emit { NativePlaybackEvent.Ownership(it, ownership) }
    }

    private fun setState(next: NativePlaybackState) {
        if (state == next) {
            refreshSnapshot()
            return
        }
        state = next
        emit { NativePlaybackEvent.State(it) }
    }

    private fun maybeEmitPosition() {
        if (!loaded || (state != NativePlaybackState.PLAYING && state != NativePlaybackState.BUFFERING)) return
        val now = clock()
        if (now - lastPositionEventMs < POSITION_INTERVAL_MS) return
        lastPositionEventMs = now
        emit { NativePlaybackEvent.Position(it) }
    }

    private fun positionMs(): Long {
        val current = engine
        val output = sink
        if (!loaded || current == null || output == null) return heldPositionMs
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
    ).also { snapshot = it }

    private fun emit(build: (NativePlaybackSnapshot) -> NativePlaybackEvent) {
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
        private const val SHUTDOWN_JOIN_MS = 2_000L
        private val REFUSED_CLOSE_CODES = setOf(
            PcmCloseCodes.UNAUTHENTICATED,
            PcmCloseCodes.FORBIDDEN,
            PcmCloseCodes.MEDIA_NOT_FOUND,
        )
    }
}
