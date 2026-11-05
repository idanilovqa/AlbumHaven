package org.albumhaven.shell.playback

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import kotlin.math.roundToLong

/**
 * Android's listen sessions must produce exactly the writes in tests/fixtures/listen-sessions-v1.json,
 * the same file tests/js/runtime/listen-session-parity.test.js holds the browser listen session to.
 */
class ListenSessionsParityTest {
    private val fixture = JSONObject(File("../../../tests/fixtures/listen-sessions-v1.json").readText())
    private val rate = fixture.getInt("sampleRate")

    @Test
    fun everyScenarioWritesWhatTheBrowserWrites() {
        val scenarios = fixture.getJSONArray("scenarios")
        for (index in 0 until scenarios.length()) {
            val scenario = scenarios.getJSONObject(index)
            val name = scenario.getString("name")
            assertEquals(name, canonical(scenario.getJSONArray("writes")), canonical(run(scenario)))
        }
    }

    private fun track(key: String): Pair<ListenTrack, Double> {
        val item = fixture.getJSONObject("tracks").getJSONObject(key)
        val track = ListenTrack(
            item.getString("listenKey"),
            item.getString("playbackRef"),
            item.getString("title"),
            item.getString("artist"),
            item.getString("album"),
            item.getString("trackNumber"),
        )
        return track to item.getDouble("durationSeconds")
    }

    private fun run(scenario: JSONObject): JSONArray {
        val writes = mutableListOf<JSONObject>()
        val answers = ArrayDeque<() -> Unit>()
        val failing = mutableListOf<JSONObject>()
        var now = fixture.getLong("startEpochMs")
        var owner = true
        var scrobbling: Boolean? = null
        var duration = 0.0
        var playing: ListenTrack? = null
        var paused = true
        var ids = 0
        val sessions = ListenSessions(
            deviceId = fixture.getString("deviceId"),
            originId = fixture.getString("originId"),
            writer = { effect, body, done ->
                val failure = failing.firstOrNull { it.getString("effect") == effect.wire }?.also(failing::remove)
                writes += JSONObject().put("effect", effect.wire).put("body", JSONObject(body.toString()))
                val answer = if (failure == null) {
                    ListenEffectResult.Answered(200, JSONObject().put("ok", true))
                } else {
                    ListenEffectResult.Answered(
                        failure.getInt("status"),
                        JSONObject().put("ok", false).put("error", failure.optString("error", "refused")),
                        ListenWriteOutcome.retryAfterMs(failure.optString("retryAfter").ifEmpty { null }, now),
                    )
                }
                answers += { done(ListenWriteOutcome.of(answer)) }
            },
            canEmit = { owner },
            playingDurationSeconds = { duration },
            wallClockMs = { now },
            newId = { "00000000-0000-4000-8000-%012d".format(++ids) },
            elapsedMs = { now },
            jitter = { fixture.getDouble("retryJitter") },
            scrobblingUnavailable = { scrobbling == false },
        )
        // As the controller does: the item it names becomes the playing one, then listen glue follows.
        fun play(key: String): ListenTrack {
            val (item, seconds) = track(key)
            playing = item
            duration = seconds
            return item
        }
        val steps = scenario.getJSONArray("steps")
        for (index in 0 until steps.length()) {
            val step = steps.getJSONObject(index)
            now = fixture.getLong("startEpochMs") + step.getLong("at")
            when (step.getString("do")) {
                "select" -> sessions.select(
                    play(step.getString("track")),
                    step.optDouble("position", 0.0),
                    step.optDouble("duration", 0.0),
                )
                "begin" -> {
                    paused = false
                    sessions.begin(playing!!, step.getDouble("position"))
                }
                "heard" -> sessions.heard((step.getDouble("seconds") * rate).roundToLong(), rate)
                "underrun" -> sessions.underrun()
                "position" -> sessions.position()
                "pause" -> {
                    paused = true
                    sessions.pause(step.getDouble("position"))
                }
                "seek" -> sessions.seek(playing!!, step.getDouble("from"), step.getDouble("to"), !paused)
                "advance" -> {
                    val outgoing = duration
                    sessions.advance(outgoing, outgoing, play(step.getString("track")))
                }
                "ended" -> {
                    paused = true
                    sessions.ended(duration, duration)
                }
                "lost" -> sessions.ownershipLost(step.getDouble("position"))
                "refresh" -> {
                    // As the controller applies a reloaded queue: same listen key, fresh reference, then a start.
                    val refreshed = play(step.getString("track")).copy(playbackRef = step.getString("playbackRef"))
                    playing = refreshed
                    sessions.select(refreshed, step.getDouble("position"), duration)
                    sessions.begin(refreshed, step.getDouble("position"))
                }
                "unload" -> sessions.unload(step.getDouble("position"), duration)
                "owner" -> owner = step.getBoolean("value")
                "claim" -> scrobbling = step.getBoolean("scrobbling")
                "fail" -> failing += step
                else -> error("unknown step ${step.getString("do")}")
            }
            while (answers.isNotEmpty()) answers.removeFirst()()
        }
        return JSONArray(writes)
    }

    /**
     * Writes in order within each listen session, as JSON values with every number a double: the
     * shared fixture holds the browser's writes grouped the same way (`bySession`).
     */
    private fun canonical(writes: JSONArray): List<Any?> {
        val all = (0 until writes.length()).map { writes.getJSONObject(it) }
        val sessions = all.map { it.getJSONObject("body").getString("session_id") }.distinct()
        return sessions.flatMap { id -> all.filter { it.getJSONObject("body").getString("session_id") == id } }
            .map(::plain)
    }

    private fun plain(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { plain(value.get(it)) }
        is Number -> value.toDouble()
        else -> value
    }
}
