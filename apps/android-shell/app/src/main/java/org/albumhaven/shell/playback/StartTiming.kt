package org.albumhaven.shell.playback

/** What the user did to start playback: picked a track (a queue load that autoplays), pressed play, or skipped. */
enum class StartKind(val wire: String) {
    SELECT("select"),
    PLAY("play"),
    NEXT("next"),
    PREVIOUS("previous"),
}

/**
 * A user-initiated start as its command arrived, on the controller's clock and before the playback
 * thread ran it. [refsAnsweredAtMs] is when fresh references for it arrived, for a start that had
 * to request them first.
 */
class StartCommand(
    val kind: StartKind,
    val source: CommandSource,
    val atMs: Long,
    val refsAnsweredAtMs: Long? = null,
)

/**
 * Time to first sound of one user-initiated start, reported as one line of fixed keys once the start
 * is heard or given up. Every stage holds the first moment it was reached, in milliseconds after the
 * command arrived, or `-` when it was not reached; a stage reached before the start (an open socket,
 * a held claim) counts from the start's own beginning. The line names the start only by a
 * per-process number and its queue index: no title, path, reference or token.
 *
 * Playback-thread only. Marking a stage is one clock read the caller already made and one array
 * write, so the render loop stays as cheap as before; the line is built only when the start finishes.
 */
class StartTiming(private val report: (String) -> Unit) {
    /** In the order a start normally passes them; claim and socket run side by side. */
    enum class Stage(val key: String) {
        REF("ref"),
        GATE("gate"),
        CLAIM("claim"),
        SOCKET("socket"),
        OPEN("open"),
        METADATA("metadata"),
        FIRST_PCM("first_pcm"),
        FIRST_WRITE("first_write"),
        AUDIBLE("audible"),
    }

    private var sequence = 0L
    private var command: StartCommand? = null
    private var queueIndex = -1
    private val reachedAtMs = LongArray(Stage.entries.size)
    private var socketReused = false
    private var reopens = 0

    /** The output's heard frames before any of this start was written; more means it is being heard. */
    private var heardBase = 0L

    /** Whether a start is being timed. */
    val active: Boolean get() = command != null

    /** Set once this start's PCM sits in the output, so the playback head is watched for it. */
    var awaitingAudible = false
        private set

    /** Starts timing [started] for the item at [index]; a start still being timed ends as superseded. */
    fun begin(started: StartCommand, index: Int, nowMs: Long) {
        finish("superseded", nowMs)
        sequence += 1
        command = started
        queueIndex = index
        reachedAtMs.fill(UNREACHED)
        socketReused = false
        reopens = 0
        awaitingAudible = false
        started.refsAnsweredAtMs?.let { reachedAtMs[Stage.REF.ordinal] = it }
    }

    fun mark(stage: Stage, nowMs: Long) {
        if (command != null && reachedAtMs[stage.ordinal] == UNREACHED) reachedAtMs[stage.ordinal] = nowMs
    }

    /** The PCM socket is open; [reused] says it already was when the start began. */
    fun socketOpen(nowMs: Long, reused: Boolean) {
        if (command == null || reachedAtMs[Stage.SOCKET.ordinal] != UNREACHED) return
        mark(Stage.SOCKET, nowMs)
        socketReused = reused
    }

    /** A stream for the start was opened; a second one (another rate, a stalled or lost stream) counts as a reopen. */
    fun streamOpened(nowMs: Long) {
        if (command == null) return
        if (reachedAtMs[Stage.OPEN.ordinal] == UNREACHED) mark(Stage.OPEN, nowMs) else reopens += 1
    }

    /**
     * The output holds nothing of this start yet and has heard [heardFrames]; [queued] says its PCM
     * is already queued there, as for a paused track that resumes, so no new write is awaited.
     */
    fun outputReady(heardFrames: Long, queued: Boolean) {
        if (command == null) return
        heardBase = heardFrames
        awaitingAudible = queued
    }

    /** The first PCM of the start was written to the output. */
    fun written(nowMs: Long) {
        if (command == null) return
        mark(Stage.FIRST_WRITE, nowMs)
        awaitingAudible = true
    }

    /** The output has heard [heardFrames]; once its playback head passes the start's first frame, the start is heard. */
    fun heard(nowMs: Long, heardFrames: Long) {
        if (!awaitingAudible || heardFrames <= heardBase) return
        mark(Stage.AUDIBLE, nowMs)
        finish("audible", nowMs)
    }

    /** Reports the start being timed, if any, as [outcome]; it is reported once. */
    fun finish(outcome: String, nowMs: Long) {
        val started = command ?: return
        command = null
        awaitingAudible = false
        val line = StringBuilder(LINE_CAPACITY)
            .append("start=").append(sequence)
            .append(" kind=").append(started.kind.wire)
            .append(" source=").append(started.source.name.lowercase())
            .append(" index=").append(queueIndex)
            .append(" outcome=").append(outcome)
        for (stage in Stage.entries) {
            val at = reachedAtMs[stage.ordinal]
            line.append(' ').append(stage.key).append('=')
            if (at == UNREACHED) line.append('-') else line.append(at - started.atMs)
        }
        line.append(" socket_reused=").append(socketReused)
            .append(" reopens=").append(reopens)
            .append(" total=").append(nowMs - started.atMs)
        report(line.toString())
    }

    companion object {
        /** `adb logcat -s AlbumHavenStartTiming`; 21 characters, inside Android's tag limit. */
        const val LOG_TAG = "AlbumHavenStartTiming"
        private const val UNREACHED = Long.MIN_VALUE
        private const val LINE_CAPACITY = 256
    }
}
