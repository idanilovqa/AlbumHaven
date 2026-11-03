package org.albumhaven.shell.playback

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.UUID
import kotlin.math.max

/** The path-free identity and display metadata a listen write names its track by. */
data class ListenTrack(
    val playbackRef: String,
    val title: String,
    val artist: String,
    val album: String,
    val trackNumber: String,
)

/** Sends one listen write; [done] runs later with whether the server accepted it. */
fun interface ListenWriter {
    fun send(effect: ListenEffect, body: JSONObject, done: (accepted: Boolean) -> Unit)
}

/**
 * The listen sessions of the native owner: the now-playing, scrobble and completion writes the
 * web listen session sends in a browser (music_app/static/js/runtime/player-listen-session-helpers.js
 * as driven by player-loop-playback.js), built from the same playback transitions with the same
 * thresholds, `rendered-pcm-v1` measurement, segments, sequences and retries. Each public method
 * is one of the web player's handlers; tests/fixtures/listen-sessions-v1.json holds the writes
 * both implementations must produce. Not thread-safe: the playback thread owns it.
 */
class ListenSessions(
    private val deviceId: String,
    private val originId: String,
    private val writer: ListenWriter,
    /** Whether this client owns, or is acquiring, the playback claim. */
    private val canEmit: () -> Boolean,
    /** The duration of the item now playing, which the web reads from its playback snapshot. */
    private val playingDurationSeconds: () -> Double,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    private var current: Session? = null
    private var selection = 0L

    // The measured listening of the item being heard, bound to its session on the first frames.
    private var measuredTrack: ListenTrack? = null
    private var measuredSession: Session? = null

    val currentTrack: ListenTrack? get() = current?.track

    /** A new item is heard; frames before it belong to the previous one. */
    fun measureItem(track: ListenTrack?) {
        measuredTrack = track
        measuredSession = null
    }

    /** Records frames actually heard; false when no listen could take them yet, so they count later. */
    fun heard(frames: Long, sampleRate: Int): Boolean {
        val track = measuredTrack ?: return false
        if (frames <= 0 || sampleRate <= 0) return false
        val session = measuredSession ?: run {
            val active = current ?: newSession(track).also { current = it }
            if (active.track.playbackRef != track.playbackRef) return false
            active.also { measuredSession = it }
        }
        if (session.completion != Completion.NONE) return true
        val elapsed = frames.toDouble() / sampleRate
        session.measuredTotal += elapsed
        session.contiguous += elapsed
        session.longest = max(session.longest, session.contiguous)
        return true
    }

    /** An output underrun breaks contiguous listening. */
    fun underrun() {
        measuredSession?.contiguous = 0.0
    }

    /** `beginStreamingPlayerListenSession`: playback of [track] starts or resumes at [positionSeconds]. */
    fun begin(track: ListenTrack, positionSeconds: Double) {
        selection += 1
        val session = resume(track, positionSeconds)
        sendNowPlaying(track, session)
    }

    /** `handleStreamingPlaybackPosition`. */
    fun position() {
        val session = current ?: return
        session.durationSeconds = round3(playingDurationSeconds())
        scrobble(session)
    }

    /** `pausePlayerPlaybackForHandoff`: closes the listen, scrobbles it if due and checkpoints it. */
    fun pause(positionSeconds: Double) {
        val token = ++selection
        val session = current
        closeSegment(session, positionSeconds)
        if (session != null) markPaused(session)
        val isCurrentPause = { token == selection && session === current }
        scrobble(session).then {
            if (isCurrentPause() && session != null) persistPaused(session)
        }
    }

    /** `setPlayerPlaybackHead`. */
    fun seek(track: ListenTrack, fromSeconds: Double, toSeconds: Double, playing: Boolean) {
        closeSegment(current, fromSeconds)
        if (playing) resume(track, toSeconds)
    }

    /** `handleStreamingPlaybackBoundary`: the queued successor took over gaplessly. */
    fun advance(outgoingPositionSeconds: Double, outgoingDurationSeconds: Double, incoming: ListenTrack) {
        current?.let { outgoing ->
            current = null
            finalize(outgoing, "ended", outgoingPositionSeconds, outgoingDurationSeconds, finishedFully = true)
        }
        sendNowPlaying(incoming, resume(incoming, 0.0))
    }

    /** `handleStreamingPlaybackEnded`. */
    fun ended(positionSeconds: Double, durationSeconds: Double) {
        current?.let { finalize(it, "ended", positionSeconds, durationSeconds, finishedFully = true) }
    }

    /** `setCurrentPlayerTrack` with another track: the listen of the one left ends here. */
    fun trackChange(positionSeconds: Double, durationSeconds: Double) {
        current?.let { finalize(it, "track-change", positionSeconds, durationSeconds, finishedFully = false) }
    }

    /** `losePlaybackOwnership`. */
    fun ownershipLost(positionSeconds: Double) {
        val session = current
        closeSegment(session, positionSeconds)
        if (session != null && session.pausedAt.isEmpty()) markPaused(session)
    }

    // ---- The web listen session helpers ----

    private fun newSession(track: ListenTrack): Session {
        val now = wallClockMs()
        return Session(track, newId(), iso(now), Math.floorDiv(now, 1000L))
    }

    /** `resumeListenSessionPlayback`. */
    private fun resume(track: ListenTrack, positionSeconds: Double): Session {
        val session = current ?: newSession(track).also { current = it }
        session.pausedAt = ""
        if (!session.segmentActive) {
            session.segmentActive = true
            session.segmentStart = max(0.0, positionSeconds)
        }
        return session
    }

    private fun closeSegment(session: Session?, positionSeconds: Double) {
        if (session == null) return
        session.contiguous = 0.0
        if (!session.segmentActive) return
        val end = max(0.0, positionSeconds)
        val start = max(0.0, session.segmentStart)
        session.segmentActive = false
        session.segmentStart = 0.0
        if (end > start) session.segments += round3(start) to round3(end)
    }

    private fun markPaused(session: Session) {
        session.contiguous = 0.0
        session.pausedAt = iso(wallClockMs())
    }

    private fun duration(session: Session): Double =
        if (session.durationSeconds > 0) session.durationSeconds else playingDurationSeconds()

    private fun canScrobble(session: Session): Boolean {
        val duration = duration(session)
        if (duration <= 0) return false
        val threshold = if (duration < 600) duration * 0.5 else 300.0
        return session.measuredTotal >= threshold || session.longest >= threshold
    }

    private fun shouldPersist(session: Session): Boolean =
        maxOf(session.listenedSeconds(), session.longestSegmentSeconds(), session.measuredTotal) > MIN_RECORDED_LISTEN_SECONDS

    private fun sendNowPlaying(track: ListenTrack, session: Session): Pending {
        session.nowPlayingRequest?.let { return it }
        if (session.nowPlayingSent) return Pending.settled(true)
        if (!canEmit()) return Pending.settled(false)
        val body = nowPlayingBody(track, session)
        if (track.artist.isEmpty() || track.title.isEmpty()) return Pending.settled(false)
        val request = Pending()
        session.nowPlayingRequest = request
        writer.send(ListenEffect.NOW_PLAYING, body) { accepted ->
            if (accepted) session.nowPlayingSent = true
            if (session.nowPlayingRequest === request) session.nowPlayingRequest = null
            request.settle(accepted)
        }
        return request
    }

    /** `maybeScrobbleListenSession`; a refused scrobble is sent again, unchanged, on the next trigger. */
    private fun scrobble(session: Session?): Pending {
        if (session == null) return Pending.settled(false)
        session.scrobbleRequest?.let { return it }
        if (session.scrobbled || !canScrobble(session) || session.scrobblePending || !canEmit()) {
            return Pending.settled(false)
        }
        session.scrobblePending = true
        val body = session.scrobbleBody ?: nowPlayingBody(session.track, session).also { body ->
            measuredFields(session, advance = true).forEach(body::put)
            body.put("total_listened_seconds", round3(session.listenedSeconds()))
            body.put("max_contiguous_seconds", round3(session.longestSegmentSeconds()))
            session.scrobbleBody = body
        }
        val request = Pending()
        session.scrobbleRequest = request
        writer.send(ListenEffect.SCROBBLE, body) { accepted ->
            if (accepted) session.scrobbled = true
            session.scrobblePending = false
            if (session.scrobbleRequest === request) session.scrobbleRequest = null
            request.settle(accepted)
        }
        return request
    }

    /** `persistPausedListenSession`: a finalized checkpoint the same listen may continue after. */
    private fun persistPaused(session: Session) {
        Pending.all(session.nowPlayingRequest, session.scrobbleRequest).then {
            if (session !== current || !shouldPersist(session) || !canEmit()) return@then
            session.scrobbleBody = null
            val body = nowPlayingBody(session.track, session)
            measuredFields(session, advance = true, finalized = true).forEach(body::put)
            body.put("ended_at", session.pausedAt.ifEmpty { iso(wallClockMs()) })
                .put("total_listened_seconds", round3(session.listenedSeconds()))
                .put("max_contiguous_seconds", round3(session.longestSegmentSeconds()))
                .put("finished_fully", false)
                .put("skipped", false)
                .put("completion_reason", "paused")
                .put("scrobble_eligible", canScrobble(session))
                .put("scrobbled", session.scrobbled)
                .put("segments", session.segmentsJson())
            writer.send(ListenEffect.COMPLETE, body) {}
        }
    }

    /** `finalizeListenSession`: the listen ends; a failed completion is not retried. */
    private fun finalize(
        session: Session,
        reason: String,
        positionSeconds: Double,
        durationSeconds: Double,
        finishedFully: Boolean,
    ) {
        if (session.completion == Completion.PENDING || session.completion == Completion.DONE) return
        if (current === session) current = null
        session.completion = Completion.PENDING
        Pending.all(session.nowPlayingRequest).then {
            closeSegment(session, positionSeconds)
            session.durationSeconds = round3(durationSeconds)
            val endedAt = session.pausedAt.ifEmpty { iso(wallClockMs()) }
            if (!shouldPersist(session) || !canEmit()) {
                session.completion = Completion.DONE
                session.pausedAt = ""
                return@then
            }
            val eligible = canScrobble(session)
            val scrobbled = if (eligible && !session.scrobbled) scrobble(session) else Pending.settled(false)
            scrobbled.then {
                val body = session.completionBody ?: nowPlayingBody(session.track, session).also { body ->
                    measuredFields(session, advance = true, finalized = true).forEach(body::put)
                    body.put("ended_at", endedAt)
                        .put("duration_seconds", session.durationSeconds)
                        .put("total_listened_seconds", round3(session.listenedSeconds()))
                        .put("max_contiguous_seconds", round3(session.longestSegmentSeconds()))
                        .put("finished_fully", finishedFully)
                        .put("skipped", !finishedFully)
                        .put("completion_reason", reason)
                        .put("scrobble_eligible", eligible)
                        .put("scrobbled", session.scrobbled)
                        .put("segments", session.segmentsJson())
                    session.completionBody = body
                }
                writer.send(ListenEffect.COMPLETE, body) { accepted ->
                    session.completion = if (accepted) Completion.DONE else Completion.FAILED
                    session.pausedAt = ""
                }
            }
        }
    }

    /** `buildNowPlayingPayload` with the track named by its reference instead of its path. */
    private fun nowPlayingBody(track: ListenTrack, session: Session): JSONObject {
        val body = JSONObject()
        measuredFields(session).forEach(body::put)
        return body
            .put("playbackRef", track.playbackRef)
            .put("title", track.title)
            .put("artist", track.artist)
            .put("album", track.album)
            .put("album_artist", track.artist)
            .put("duration_seconds", round3(if (session.durationSeconds > 0) session.durationSeconds else playingDurationSeconds()))
            .put("started_at", session.startedAt)
            .put("started_at_unix", session.startedAtUnix)
            .put("track_number", track.trackNumber)
            .put(
                "request_origin",
                JSONObject().put("client_kind", "private_web").put("origin_type", "browser_tab").put("origin_id", originId),
            )
    }

    /** `buildMeasuredCompletionFields`. */
    private fun measuredFields(session: Session, advance: Boolean = false, finalized: Boolean = false): Map<String, Any> {
        if (advance) session.sequence += 1
        session.finalized = session.finalized || finalized
        return linkedMapOf(
            "measurement_version" to MEASUREMENT_VERSION,
            "device_id" to deviceId,
            "session_id" to session.sessionId,
            "sequence" to session.sequence,
            "finalized" to session.finalized,
            "measured_listened_seconds" to round3(session.measuredTotal),
            "max_measured_contiguous_seconds" to round3(session.longest),
        )
    }

    private enum class Completion { NONE, PENDING, DONE, FAILED }

    private class Session(
        val track: ListenTrack,
        val sessionId: String,
        val startedAt: String,
        val startedAtUnix: Long,
    ) {
        var measuredTotal = 0.0
        var contiguous = 0.0
        var longest = 0.0
        var sequence = 0L
        var finalized = false
        var durationSeconds = 0.0
        val segments = mutableListOf<Pair<Double, Double>>()
        var segmentActive = false
        var segmentStart = 0.0
        var pausedAt = ""
        var scrobbled = false
        var scrobblePending = false
        var scrobbleRequest: Pending? = null
        var scrobbleBody: JSONObject? = null
        var nowPlayingSent = false
        var nowPlayingRequest: Pending? = null
        var completion = Completion.NONE
        var completionBody: JSONObject? = null

        fun listenedSeconds() = segments.sumOf { (start, end) -> max(0.0, end - start) }

        fun longestSegmentSeconds() = segments.maxOfOrNull { (start, end) -> max(0.0, end - start) } ?: 0.0

        fun segmentsJson() = JSONArray().also { array ->
            segments.forEach { (start, end) -> array.put(JSONObject().put("start_seconds", start).put("end_seconds", end)) }
        }
    }

    /** A write's outcome that later steps wait for, as the web awaits the write's promise. */
    private class Pending {
        private var outcome: Boolean? = null
        private val waiters = mutableListOf<(Boolean) -> Unit>()

        fun then(action: (Boolean) -> Unit) {
            val settled = outcome
            if (settled == null) waiters += action else action(settled)
        }

        fun settle(value: Boolean) {
            outcome = value
            waiters.toList().also { waiters.clear() }.forEach { it(value) }
        }

        companion object {
            fun settled(value: Boolean) = Pending().also { it.outcome = value }

            fun all(vararg pending: Pending?): Pending {
                val waiting = pending.filterNotNull()
                val combined = Pending()
                var left = waiting.size
                if (left == 0) return settled(true)
                waiting.forEach { it.then { if (--left == 0) combined.settle(true) } }
                return combined
            }
        }
    }

    companion object {
        const val MEASUREMENT_VERSION = "rendered-pcm-v1"
        private const val MIN_RECORDED_LISTEN_SECONDS = 10.0
        private val ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)

        /** `Math.round(value * 1000) / 1000`. */
        fun round3(value: Double): Double = Math.round(value * 1000) / 1000.0

        /** `Date.prototype.toISOString`. */
        fun iso(epochMs: Long): String = ISO.format(Instant.ofEpochMilli(epochMs))
    }
}
