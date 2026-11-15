package org.albumhaven.shell.updates

import org.albumhaven.shell.OriginPolicy
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeParseException

/**
 * One sandbox's published build, as the sandbox build index lists it. Metadata only: the APK
 * itself always comes from that sandbox's own Update Manifest, verified as every update is.
 */
data class SandboxBuild(
    val sandbox: Int,
    val versionCode: Long,
    val versionName: String,
    val sourceCommit: String,
    val sourceBranch: String?,
    val label: String?,
    val apkSize: Long,
    val minAndroidApi: Int,
    val publishedAt: Instant,
) {
    /** The chat label, else the branch, else the short commit. */
    val title: String get() = label ?: sourceBranch ?: sourceCommit.take(7)
}

/** The index every sandbox serves at `/artifacts/android/sandbox/index.json`. */
object SandboxIndex {
    const val MAX_INDEX_BYTES = 256 * 1024
    private val ENTRY_KEYS = setOf(
        "sandbox", "origin", "versionCode", "versionName", "sourceCommit", "sourceBranch", "label", "apkSize",
        "minAndroidApi", "bridgeProtocolMin", "bridgeProtocolMax", "publishedAt",
    )
    private val COMMIT = Regex("^[0-9a-f]{40}$")
    private val BRANCH = Regex("^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
    private val CONTROL = Regex("[\\p{Cc}\\p{Cf}]")

    fun url(origin: String) = "$origin/artifacts/android/sandbox/index.json"

    /** The listed builds, one per sandbox; null when the index is malformed or for another app. */
    fun parse(raw: String, applicationId: String): List<SandboxBuild>? = try {
        val json = JSONObject(raw)
        if (json.opt("schemaVersion") != 1 || json.opt("channel") != "sandbox" || json.opt("applicationId") != applicationId) {
            null
        } else {
            val entries = json.get("sandboxes") as? JSONArray ?: throw JSONException("sandboxes")
            (0 until entries.length()).map { entry(entries.get(it) as? JSONObject ?: throw JSONException("entry")) }
                .takeIf { builds -> builds.map(SandboxBuild::sandbox).toSet().size == builds.size }
        }
    } catch (_: JSONException) {
        null
    }

    private fun entry(json: JSONObject): SandboxBuild {
        if (json.keys().asSequence().toSet() != ENTRY_KEYS) throw JSONException("keys")
        val sandbox = whole(json, "sandbox").takeIf { it in OriginPolicy.SANDBOX_SLOTS.first..OriginPolicy.SANDBOX_SLOTS.last }
            ?: throw JSONException("sandbox")
        if (json.get("origin") != OriginPolicy.sandboxOrigin(sandbox.toInt())) throw JSONException("origin")
        val commit = (json.get("sourceCommit") as? String)?.takeIf(COMMIT::matches) ?: throw JSONException("commit")
        val label = optionalText(json, "label")?.takeIf { it.length <= 60 && it.isNotBlank() && !CONTROL.containsMatchIn(it) }
        if (label == null && !json.isNull("label")) throw JSONException("label")
        val branch = optionalText(json, "sourceBranch")?.takeIf { BRANCH.matches(it) && ".." !in it }
        if (branch == null && !json.isNull("sourceBranch")) throw JSONException("branch")
        return SandboxBuild(
            sandbox = sandbox.toInt(),
            versionCode = whole(json, "versionCode").takeIf { it in 1..Int.MAX_VALUE } ?: throw JSONException("versionCode"),
            versionName = json.get("versionName") as? String ?: throw JSONException("versionName"),
            sourceCommit = commit,
            sourceBranch = branch,
            label = label,
            apkSize = whole(json, "apkSize").takeIf { it > 0 } ?: throw JSONException("apkSize"),
            minAndroidApi = whole(json, "minAndroidApi").takeIf { it in ManifestValidator.MIN_ANDROID_API..1000 }?.toInt()
                ?: throw JSONException("minAndroidApi"),
            publishedAt = try {
                Instant.parse(json.get("publishedAt") as? String ?: throw JSONException("publishedAt"))
            } catch (_: DateTimeParseException) {
                throw JSONException("publishedAt")
            },
        )
    }

    private fun optionalText(json: JSONObject, key: String): String? = if (json.isNull(key)) null else json.get(key) as? String

    private fun whole(json: JSONObject, key: String): Long = when (val value = json.get(key)) {
        is Int -> value.toLong()
        is Long -> value
        else -> throw JSONException(key)
    }
}

/** A build Update can offer: one the app does not have, on this sandbox or another. */
data class BuildChoice(
    val build: SandboxBuild,
    /** Published by the sandbox the app is on, so installing it needs no switch. */
    val thisSandbox: Boolean,
    /** Android installs only a higher version code in place; a lower one must be rebuilt first. */
    val newer: Boolean,
    /** False when this device's Android is too old for the build. */
    val supported: Boolean,
)

/** What pressing Update does. */
sealed interface BuildAction {
    /** No sandbox has a build this app does not have. */
    data object None : BuildAction

    /** Exactly one newer build waits: install it, switching sandbox when it is another's. */
    data class Install(val choice: BuildChoice) : BuildAction

    /** Two or more choices, or only an older one: the sheet lets the owner pick. */
    data object Choose : BuildAction
}

object BuildChoices {
    /** Every sandbox's build except the installed one, newest first. */
    fun of(builds: List<SandboxBuild>, installedVersionCode: Long, currentSandbox: Int?, deviceApi: Int): List<BuildChoice> =
        builds.filter { it.versionCode != installedVersionCode }
            .sortedByDescending(SandboxBuild::versionCode)
            .map { build ->
                BuildChoice(
                    build = build,
                    thisSandbox = build.sandbox == currentSandbox,
                    newer = build.versionCode > installedVersionCode,
                    supported = build.minAndroidApi <= deviceApi,
                )
            }

    fun action(choices: List<BuildChoice>): BuildAction {
        val only = choices.singleOrNull()
        return when {
            choices.isEmpty() -> BuildAction.None
            only != null && only.newer && only.supported -> BuildAction.Install(only)
            else -> BuildAction.Choose
        }
    }

    /** What the cogwheel menu's Update row shows (`updates.builds`). */
    fun summary(choices: List<BuildChoice>?, installedVersionCode: Long): JSONObject {
        val json = JSONObject().put("installedVersionCode", installedVersionCode)
        if (choices == null) return json.put("count", JSONObject.NULL).put("single", JSONObject.NULL)
        val single = (BuildChoices.action(choices) as? BuildAction.Install)?.choice
        return json.put("count", choices.size).put(
            "single",
            single?.let {
                JSONObject()
                    .put("sandbox", it.build.sandbox)
                    .put("versionCode", it.build.versionCode)
                    .put("title", it.build.title)
                    .put("thisSandbox", it.thisSandbox)
            } ?: JSONObject.NULL,
        )
    }
}

/** Why a rebuild did or did not start; wire names match the server's codes. */
enum class RebuildResult {
    STARTED,

    /** This sandbox has no rebuild token: the sheet offers the copyable command instead. */
    UNAVAILABLE,
    ALREADY_RUNNING,
    TOO_MANY,
    FAILED,
}

/** A rebuild the owner started, shown as running until a newer build appears or 30 minutes pass. */
data class PendingRebuild(val sandbox: Int, val fromVersionCode: Long, val requestedAtMs: Long)

object Rebuilds {
    const val WATCH_MS = 30L * 60 * 1000

    /** Rebuilds still waiting for their new build, given the latest index. */
    fun running(pending: List<PendingRebuild>, builds: List<SandboxBuild>, nowMs: Long): List<PendingRebuild> =
        pending.filter { rebuild ->
            nowMs - rebuild.requestedAtMs in 0 until WATCH_MS &&
                builds.firstOrNull { it.sandbox == rebuild.sandbox }?.versionCode.let { it == null || it == rebuild.fromVersionCode }
        }

    /** The command that does what the rebuild button does, for a sandbox without a rebuild token. */
    fun command(build: SandboxBuild): String = buildList {
        add("gh workflow run android-promote.yml -f channel=sandbox -f commit=${build.sourceCommit} -f sandbox=${build.sandbox}")
        build.sourceBranch?.let { add("-f branch=$it") }
        build.label?.let { add("-f label=\"${it.replace("\"", "\\\"")}\"") }
    }.joinToString(" ")
}
