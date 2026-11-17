package org.albumhaven.shell.updates

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

private const val APP = "org.albumhaven.app.sandbox"

/** One index entry for [sandbox], with [changes] applied; a null value keeps the key as JSON null. */
fun indexEntry(sandbox: Int, versionCode: Long, vararg changes: Pair<String, Any?>): JSONObject {
    val json = JSONObject()
        .put("sandbox", sandbox)
        .put("origin", "https://sandbox$sandbox.albumhaven.org")
        .put("versionCode", versionCode)
        .put("versionName", "0.11.8-sandbox.763af93")
        .put("sourceCommit", COMMIT)
        .put("sourceBranch", "2026-11-14-gapless-boundary-repair")
        .put("label", "8 - Gapless Fix")
        .put("apkSize", 13_751_220)
        .put("minAndroidApi", 29)
        .put("bridgeProtocolMin", 1)
        .put("bridgeProtocolMax", 1)
        .put("publishedAt", "2026-11-15T10:00:00Z")
    changes.forEach { (key, value) -> json.put(key, value ?: JSONObject.NULL) }
    return json
}

fun indexJson(vararg entries: JSONObject, applicationId: String = APP): String =
    JSONObject()
        .put("schemaVersion", 1)
        .put("channel", "sandbox")
        .put("applicationId", applicationId)
        .put("sandboxes", JSONArray(entries.toList()))
        .toString()

fun build(sandbox: Int, versionCode: Long, minAndroidApi: Int = 29) = SandboxBuild(
    sandbox = sandbox,
    versionCode = versionCode,
    versionName = "0.11.8-sandbox.763af93",
    sourceCommit = COMMIT,
    sourceBranch = "branch-$sandbox",
    label = null,
    apkSize = 100,
    minAndroidApi = minAndroidApi,
    publishedAt = Instant.parse("2026-11-15T10:00:00Z"),
)

class SandboxBuildsTest {
    @Test
    fun `the index lists one build per sandbox with its branch and label`() {
        val builds = SandboxIndex.parse(indexJson(indexEntry(2, 25), indexEntry(5, 24, "sourceBranch" to null, "label" to null)), APP)!!
        assertEquals(listOf(2, 5), builds.map(SandboxBuild::sandbox))
        assertEquals("8 - Gapless Fix", builds[0].title)
        assertEquals(Instant.parse("2026-11-15T10:00:00Z"), builds[0].publishedAt)
        assertEquals(COMMIT.take(7), builds[1].title)
        assertNull(builds[1].sourceBranch)
        assertEquals("2026-11-14-gapless-boundary-repair", builds[0].copy(label = null).title)
    }

    @Test
    fun `a malformed index or entry is refused as a whole`() {
        val bad = listOf(
            indexJson(indexEntry(2, 25), applicationId = "org.albumhaven.app"),
            JSONObject(indexJson(indexEntry(2, 25))).put("schemaVersion", 2).toString(),
            JSONObject(indexJson(indexEntry(2, 25))).put("channel", "stable").toString(),
            indexJson(indexEntry(2, 25), indexEntry(2, 26)),
            indexJson(indexEntry(2, 25, "origin" to "https://sandbox3.albumhaven.org")),
            indexJson(indexEntry(2, 25, "origin" to "https://evil.example")),
            indexJson(indexEntry(0, 25, "origin" to "https://sandbox0.albumhaven.org")),
            indexJson(indexEntry(2, 25, "sourceCommit" to "not-a-commit")),
            indexJson(indexEntry(2, 25, "sourceBranch" to "a..b")),
            indexJson(indexEntry(2, 25, "label" to "")),
            indexJson(indexEntry(2, 25, "label" to "x".repeat(61))),
            indexJson(indexEntry(2, 25, "label" to "line\nbreak")),
            indexJson(indexEntry(2, 25, "label" to 7)),
            indexJson(indexEntry(2, 25, "versionCode" to "25")),
            indexJson(indexEntry(2, 25, "apkSize" to 0)),
            indexJson(indexEntry(2, 25, "minAndroidApi" to 21)),
            indexJson(indexEntry(2, 25, "publishedAt" to "yesterday")),
            indexJson(indexEntry(2, 25).put("sha256", "f".repeat(64))),
            "{not json",
        )
        bad.forEach { raw -> assertNull(raw, SandboxIndex.parse(raw, APP)) }
    }

    @Test
    fun `every sandbox build but the installed one is a choice, newest first`() {
        val choices = BuildChoices.of(listOf(build(5, 24), build(3, 21), build(2, 25), build(4, 22, minAndroidApi = 31)), 24, 5, 29)
        assertEquals(listOf(25L, 22L, 21L), choices.map { it.build.versionCode })
        assertEquals(listOf(true, false, false), choices.map(BuildChoice::newer))
        assertEquals(listOf(true, false, true), choices.map(BuildChoice::supported))
        assertFalse(choices.any(BuildChoice::thisSandbox))
        assertTrue(BuildChoices.of(listOf(build(5, 26)), 24, 5, 29).single().thisSandbox)
    }

    @Test
    fun `Update installs the only newer build and lets the owner choose otherwise`() {
        val newerHere = BuildChoices.of(listOf(build(5, 26)), 24, 5, 29)
        assertEquals(BuildAction.Install(newerHere.single()), BuildChoices.action(newerHere))
        val newerElsewhere = BuildChoices.of(listOf(build(2, 26), build(5, 24)), 24, 5, 29)
        assertEquals(BuildAction.Install(newerElsewhere.single()), BuildChoices.action(newerElsewhere))
        assertEquals(BuildAction.Choose, BuildChoices.action(BuildChoices.of(listOf(build(2, 26), build(3, 25)), 24, 5, 29)))
        assertEquals("only an older one", BuildAction.Choose, BuildChoices.action(BuildChoices.of(listOf(build(2, 21)), 24, 5, 29)))
        assertEquals("unsupported", BuildAction.Choose, BuildChoices.action(BuildChoices.of(listOf(build(2, 26, 31)), 24, 5, 29)))
        assertEquals(BuildAction.None, BuildChoices.action(BuildChoices.of(listOf(build(5, 24)), 24, 5, 29)))
        assertEquals(BuildAction.None, BuildChoices.action(emptyList()))
    }

    @Test
    fun `the Update row summary names the count and the single build`() {
        val single = BuildChoices.summary(BuildChoices.of(listOf(build(2, 26), build(5, 24)), 24, 5, 29), 24)
        assertEquals(24L, single.getLong("installedVersionCode"))
        assertEquals(1, single.getInt("count"))
        val only = single.getJSONObject("single")
        assertEquals(2, only.getInt("sandbox"))
        assertEquals(26L, only.getLong("versionCode"))
        assertEquals("branch-2", only.getString("title"))
        assertFalse(only.getBoolean("thisSandbox"))
        val several = BuildChoices.summary(BuildChoices.of(listOf(build(2, 26), build(3, 21)), 24, 5, 29), 24)
        assertEquals(2, several.getInt("count"))
        assertTrue(several.isNull("single"))
        val unread = BuildChoices.summary(null, 24)
        assertTrue(unread.isNull("count") && unread.isNull("single"))
    }

    @Test
    fun `a rebuild runs until its sandbox has another build or half an hour passes`() {
        val pending = listOf(PendingRebuild(2, 21, requestedAtMs = 1_000), PendingRebuild(3, 22, requestedAtMs = 1_000))
        val builds = listOf(build(2, 21), build(3, 27))
        assertEquals(listOf(pending[0]), Rebuilds.running(pending, builds, nowMs = 2_000))
        assertEquals(emptyList<PendingRebuild>(), Rebuilds.running(pending, builds, nowMs = 1_000 + Rebuilds.WATCH_MS))
        assertEquals("a clock that moved back", emptyList<PendingRebuild>(), Rebuilds.running(pending, builds, nowMs = 500))
    }

    @Test
    fun `the copyable rebuild command dispatches the same promotion`() {
        assertEquals(
            "gh workflow run android-promote.yml -f channel=sandbox -f commit=$COMMIT -f sandbox=2 -f branch=branch-2 -f label=\"8 - \\\"Fix\\\"\"",
            Rebuilds.command(build(2, 21).copy(label = "8 - \"Fix\"")),
        )
        assertEquals(
            "gh workflow run android-promote.yml -f channel=sandbox -f commit=$COMMIT -f sandbox=5",
            Rebuilds.command(build(5, 24).copy(sourceBranch = null)),
        )
    }
}
