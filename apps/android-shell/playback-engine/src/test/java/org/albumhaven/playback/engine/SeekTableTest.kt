package org.albumhaven.playback.engine

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** The device's lookup answers the shared vectors exactly as `playback_seek_table.lookup` does. */
class SeekTableTest {
    private val fixture = File(System.getProperty("user.dir"), "../../../tests/fixtures/playback-seek-table-v1.json")

    @Test
    fun lookupMatchesTheServersReferenceVectors() {
        val root = JSONObject(fixture.readText())
        var checked = 0
        for (section in listOf(root, root.getJSONObject("flac"))) {
            val raw = section.getJSONObject("table")
            val table = SeekTable(
                raw.getInt("prefixBytes"), raw.getLong("prerollFrames"),
                raw.getJSONArray("offsets").let { a -> IntArray(a.length(), a::getInt) },
                raw.getJSONArray("samples").let { a -> LongArray(a.length(), a::getLong) },
            )
            val cases: JSONArray = section.getJSONArray("cases")
            for (index in 0 until cases.length()) {
                val case = cases.getJSONObject(index)
                val window = table.lookup(
                    section.getLong("initialSkip"), section.getLong("initialTotal"), section.getLong("streamStart"),
                    case.getLong("target"), case.getInt("receivedBytes"), case.getBoolean("ended"),
                )
                val expected = case.optJSONObject("window")?.let {
                    LocalSeekWindow(it.getInt("prefixBytes"), it.getInt("byteOffset"), it.getLong("skipFrames"), it.getLong("totalFrames"))
                }
                assertEquals(case.toString(), expected, window)
                checked += 1
            }
        }
        assert(checked > 10)
    }
}
