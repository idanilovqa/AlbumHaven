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
        val failing = mutableListOf<String>()
        var now = fixture.getLong("startEpochMs")
        var owner = true
        var duration = 0.0
        var playing: ListenTrack? = null
        var paused = true
        var ids = 0
        val sessions = ListenSessions(
            deviceId = fixture.getString("deviceId"),
            originId = fixture.getString("originId"),
            writer = { effect, body, done ->
                val refused = failing.remove(effect.wire)
                writes += JSONObject().put("effect", effect.wire).put("body", JSONObject(body.toString()))
                answers += { done(!refused) }
            },
            canEmit = { owner },
            playingDurationSeconds = { duration },
            wallClockMs = { now },
            newId = { "00000000-0000-4000-8000-%012d".format(++ids) },
        )
        fun select(key: String) {
            val (item, seconds) = track(key)
            playing = item
            duration = seconds
            sessions.measureItem(item)
        }
        val steps = scenario.getJSONArray("steps")
        for (index in 0 until steps.length()) {
            val step = steps.getJSONObject(index)
            now = fixture.getLong("startEpochMs") + step.getLong("at")
            when (step.getString("do")) {
                "select" -> {
                    val next = track(step.getString("track")).first
                    val previous = sessions.currentTrack
                    if (previous != null && previous.playbackRef != next.playbackRef) {
                        sessions.trackChange(step.getDouble("position"), step.getDouble("duration"))
                    }
                    select(step.getString("track"))
                }
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
                    // As in the controller, the playing item is already the incoming one.
                    select(step.getString("track"))
                    sessions.advance(outgoing, outgoing, playing!!)
                }
                "ended" -> {
                    paused = true
                    sessions.ended(duration, duration)
                }
                "lost" -> sessions.ownershipLost(step.getDouble("position"))
                "owner" -> owner = step.getBoolean("value")
                "fail" -> failing += step.getString("effect")
                else -> error("unknown step ${step.getString("do")}")
            }
            while (answers.isNotEmpty()) answers.removeFirst()()
        }
        return JSONArray(writes)
    }

    /** Writes in order within each listen session, as JSON values with every number a double. */
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
