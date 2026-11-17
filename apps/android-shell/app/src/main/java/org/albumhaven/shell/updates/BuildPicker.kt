package org.albumhaven.shell.updates

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** Android work the [BuildPicker] asks for. Every callback arrives on the main thread. */
interface BuildPickerPorts {
    fun nowMs(): Long
    fun fetchIndex(url: String, done: (FetchResult) -> Unit)
    fun requestRebuild(origin: String, sandbox: Int, done: (RebuildResult) -> Unit)
}

/** Rebuilds the owner started, kept across process death while they run. */
interface RebuildStore {
    var pendingRebuilds: String?
}

/**
 * Which sandbox builds a sandbox app can install (bridge capability `updates.choose.v1`): reads the
 * sandbox build index from the sandbox it is signed in to, and starts the owner's rebuilds there.
 * Installing never happens here; the [Updater] installs a chosen build from its own sandbox's
 * manifest. Main-thread confined.
 */
class BuildPicker(
    private val currentPolicy: () -> UpdatePolicy,
    private val currentSandbox: () -> Int?,
    private val ports: BuildPickerPorts,
    private val store: RebuildStore,
) {
    /** The last index read; null until one is. */
    var builds: List<SandboxBuild>? = null
        private set
    private val listeners = mutableSetOf<() -> Unit>()
    private val waiting = mutableListOf<(Boolean) -> Unit>()
    private var reading = false

    fun addListener(listener: () -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: () -> Unit) {
        listeners -= listener
    }

    private fun changed() = listeners.toList().forEach { it() }

    /** Every sandbox's build this app does not have, newest first; null before an index was read. */
    val choices: List<BuildChoice>?
        get() {
            val policy = currentPolicy()
            return builds?.let { BuildChoices.of(it, policy.installedVersionCode, currentSandbox(), policy.deviceApi) }
        }

    val summary: JSONObject get() = BuildChoices.summary(choices, currentPolicy().installedVersionCode)

    /** Reads the index again; reads already running are joined. [done] says whether it was read. */
    fun refresh(done: ((Boolean) -> Unit)? = null) {
        done?.let(waiting::add)
        if (reading) return
        reading = true
        val policy = currentPolicy()
        ports.fetchIndex(SandboxIndex.url(policy.artifactOrigin)) { result ->
            reading = false
            val read = (result as? FetchResult.Body)?.let { SandboxIndex.parse(it.text, policy.applicationId) }
            if (read != null) {
                builds = read
                // A rebuild that produced its build, or ran out of time, is no longer shown.
                savePending(Rebuilds.running(pending(), read, ports.nowMs()))
                changed()
            }
            val callbacks = waiting.toList()
            waiting.clear()
            callbacks.forEach { it(read != null) }
        }
    }

    /** The owner's rebuild of [build] under a newer version code, which this sandbox's server dispatches. */
    fun rebuild(build: SandboxBuild, done: (RebuildResult) -> Unit) {
        ports.requestRebuild(currentPolicy().artifactOrigin, build.sandbox) { result ->
            if (result == RebuildResult.STARTED) {
                savePending(pending().filter { it.sandbox != build.sandbox } +
                    PendingRebuild(build.sandbox, build.versionCode, ports.nowMs()))
                changed()
            }
            done(result)
        }
    }

    /** The running rebuild of [sandbox]'s build, if the owner started one. */
    fun rebuilding(sandbox: Int): PendingRebuild? {
        val running = Rebuilds.running(pending(), builds.orEmpty(), ports.nowMs())
        return running.firstOrNull { it.sandbox == sandbox }
    }

    /** Whether any started rebuild still waits for its build, so the index is worth reading again soon. */
    val watchingRebuilds: Boolean get() = Rebuilds.running(pending(), builds.orEmpty(), ports.nowMs()).isNotEmpty()

    private fun pending(): List<PendingRebuild> = try {
        val array = JSONArray(store.pendingRebuilds ?: return emptyList())
        (0 until array.length()).map { index ->
            val item = array.getJSONObject(index)
            PendingRebuild(item.getInt("sandbox"), item.getLong("fromVersionCode"), item.getLong("requestedAtMs"))
        }
    } catch (_: JSONException) {
        emptyList()
    }

    private fun savePending(pending: List<PendingRebuild>) {
        store.pendingRebuilds = if (pending.isEmpty()) {
            null
        } else {
            JSONArray(pending.map {
                JSONObject().put("sandbox", it.sandbox).put("fromVersionCode", it.fromVersionCode).put("requestedAtMs", it.requestedAtMs)
            }).toString()
        }
    }
}
