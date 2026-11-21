package org.albumhaven.shell.updates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildPickerTest {
    private class FakePorts : BuildPickerPorts {
        var now = 10_000L
        val fetched = mutableListOf<String>()
        val fetches = mutableListOf<(FetchResult) -> Unit>()
        val rebuilds = mutableListOf<Pair<String, Int>>()
        var rebuildResult = RebuildResult.STARTED

        override fun nowMs() = now
        override fun fetchIndex(url: String, done: (FetchResult) -> Unit) {
            fetched += url
            fetches += done
        }

        override fun requestRebuild(origin: String, sandbox: Int, done: (RebuildResult) -> Unit) {
            rebuilds += origin to sandbox
            done(rebuildResult)
        }

        fun answer(result: FetchResult) = fetches.removeAt(0)(result)
    }

    private class MemoryStore : RebuildStore {
        override var pendingRebuilds: String? = null
    }

    private val ports = FakePorts()
    private val store = MemoryStore()
    private var sandbox: Int? = 5
    private val picker = BuildPicker({ policy(installedVersionCode = 24, artifactOrigin = "https://sandbox5.albumhaven.org", deviceApi = 34) }, { sandbox }, ports, store)

    @Test
    fun `the index is read from the signed-in sandbox and joined while it is read`() {
        var changes = 0
        picker.addListener { changes++ }
        val results = mutableListOf<Boolean>()
        picker.refresh { results += it }
        picker.refresh { results += it }
        assertEquals(listOf("https://sandbox5.albumhaven.org/artifacts/android/sandbox/index.json"), ports.fetched)
        assertNull(picker.choices)

        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 25), indexEntry(5, 24))))

        assertEquals(listOf(true, true), results)
        assertEquals(1, changes)
        assertEquals(listOf(2), picker.choices!!.map { it.build.sandbox })
        assertEquals(1, picker.summary.getInt("count"))
    }

    @Test
    fun `an unreadable index keeps the last one`() {
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 25))))
        val results = mutableListOf<Boolean>()
        picker.refresh { results += it }
        ports.answer(FetchResult.Failed)
        picker.refresh { results += it }
        ports.answer(FetchResult.Body("{broken"))
        assertEquals(listOf(false, false), results)
        assertEquals(listOf(25L), picker.builds!!.map(SandboxBuild::versionCode))
    }

    @Test
    fun `a started rebuild is shown until its sandbox has a newer build`() {
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 21), indexEntry(3, 22))))
        val build = picker.builds!!.first { it.sandbox == 2 }
        var changes = 0
        picker.addListener { changes++ }
        val results = mutableListOf<RebuildResult>()

        picker.rebuild(build) { results += it }

        assertEquals(listOf(RebuildResult.STARTED), results)
        assertEquals(listOf("https://sandbox5.albumhaven.org" to 2), ports.rebuilds)
        assertEquals(1, changes)
        assertEquals(PendingRebuild(2, 21, 10_000), picker.rebuilding(2))
        assertNull(picker.rebuilding(3))
        assertTrue(picker.watchingRebuilds)
        // The rebuilt build arrives under a newer version code.
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 27), indexEntry(3, 22))))
        assertNull(picker.rebuilding(2))
        assertFalse(picker.watchingRebuilds)
        assertNull(store.pendingRebuilds)
    }

    @Test
    fun `a refused rebuild records nothing`() {
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 21))))
        ports.rebuildResult = RebuildResult.UNAVAILABLE
        val results = mutableListOf<RebuildResult>()
        picker.rebuild(picker.builds!!.single()) { results += it }
        assertEquals(listOf(RebuildResult.UNAVAILABLE), results)
        assertNull(picker.rebuilding(2))
        assertNull(store.pendingRebuilds)
    }

    @Test
    fun `a rebuild stops being shown after half an hour`() {
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 21))))
        picker.rebuild(picker.builds!!.single()) {}
        ports.now += Rebuilds.WATCH_MS
        assertNull(picker.rebuilding(2))
        assertFalse(picker.watchingRebuilds)
    }

    @Test
    fun `choices follow the sandbox the app is on`() {
        picker.refresh()
        ports.answer(FetchResult.Body(indexJson(indexEntry(2, 25))))
        assertFalse(picker.choices!!.single().thisSandbox)
        sandbox = 2
        assertTrue(picker.choices!!.single().thisSandbox)
    }
}
