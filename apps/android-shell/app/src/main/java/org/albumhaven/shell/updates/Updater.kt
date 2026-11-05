package org.albumhaven.shell.updates

import org.json.JSONObject

/** Why an update stopped; the web shows the matching approved copy and retry. */
enum class UpdateError(val wireName: String) {
    CHECK_FAILED("check_failed"),
    MANIFEST_REJECTED("manifest_rejected"),
    DOWNLOAD_FAILED("download_failed"),
    VERIFICATION_FAILED("verification_failed"),
    INSTALL_FAILED("install_failed"),
}

/** What Settings > Android app shows. Every state is path-free. */
sealed interface UpdateState {
    data class Idle(val checkedAtMs: Long?) : UpdateState
    data class Checking(val checkedAtMs: Long?) : UpdateState
    data class UpToDate(val checkedAtMs: Long) : UpdateState
    data class Available(val manifest: UpdateManifest) : UpdateState
    data class Downloading(val manifest: UpdateManifest, val bytes: Long) : UpdateState
    data class Verifying(val manifest: UpdateManifest) : UpdateState
    data class Ready(val manifest: UpdateManifest) : UpdateState

    /** Android blocks this install source until the user allows it in system Settings. */
    data class Authorization(val manifest: UpdateManifest) : UpdateState

    /** Playback is stopping, or Android is asking the user to confirm the installation. */
    data class Installing(val manifest: UpdateManifest) : UpdateState

    /** [manifest] is kept when retrying means downloading it again. */
    data class Failed(
        val error: UpdateError,
        val reason: String?,
        val manifest: UpdateManifest?,
        val checkedAtMs: Long?,
    ) : UpdateState

    fun toJson(): JSONObject {
        val manifest = when (this) {
            is Available -> manifest
            is Downloading -> manifest
            is Verifying -> manifest
            is Ready -> manifest
            is Authorization -> manifest
            is Installing -> manifest
            is Failed -> manifest
            else -> null
        }
        val checkedAt = when (this) {
            is Idle -> checkedAtMs
            is Checking -> checkedAtMs
            is UpToDate -> checkedAtMs
            is Failed -> checkedAtMs
            else -> null
        }
        return JSONObject()
            .put("state", wireName)
            .put("versionName", manifest?.versionName ?: JSONObject.NULL)
            .put("versionCode", manifest?.versionCode ?: JSONObject.NULL)
            .put(
                "progress",
                if (this is Downloading) (bytes.coerceIn(0, manifest!!.apkSize) * 100 / manifest.apkSize).toInt() else JSONObject.NULL,
            )
            .put("checkedAt", checkedAt ?: JSONObject.NULL)
            .put("error", (this as? Failed)?.error?.wireName ?: JSONObject.NULL)
            .put("reason", (this as? Failed)?.reason ?: JSONObject.NULL)
    }

    val wireName: String
        get() = when (this) {
            is Idle -> "idle"
            is Checking -> "checking"
            is UpToDate -> "upToDate"
            is Available -> "available"
            is Downloading -> "downloading"
            is Verifying -> "verifying"
            is Ready -> "ready"
            is Authorization -> "authorization"
            is Installing -> "installing"
            is Failed -> "failed"
        }
}

/** Passive checks run on a cold launch only when the last successful check is six hours old. */
object UpdateSchedule {
    const val PASSIVE_INTERVAL_MS = 6L * 60 * 60 * 1000

    /** A clock that moved backwards makes the check due rather than suppressing it indefinitely. */
    fun passiveCheckDue(nowMs: Long, lastCheckedAtMs: Long?): Boolean =
        lastCheckedAtMs == null || nowMs < lastCheckedAtMs || nowMs - lastCheckedAtMs >= PASSIVE_INTERVAL_MS
}

sealed interface FetchResult {
    data class Body(val text: String) : FetchResult
    data class Refused(val reason: Rejection) : FetchResult
    data class Denied(val reason: AccessFailure) : FetchResult
    data object Failed : FetchResult
}

sealed interface DownloadResult {
    data object Completed : DownloadResult
    data class Refused(val reason: Rejection) : DownloadResult
    data class Denied(val reason: AccessFailure) : DownloadResult
    data object Failed : DownloadResult
}

sealed interface StageResult {
    data class Staged(val sessionId: Int) : StageResult
    data class Refused(val reason: Rejection) : StageResult
    data object Failed : StageResult
}

sealed interface InstallStatus {
    /** Android needs the user's confirmation; [confirm] shows its prompt. */
    data class PendingUserAction(val confirm: () -> Unit) : InstallStatus
    data object Succeeded : InstallStatus
    data object Cancelled : InstallStatus
    data object Failed : InstallStatus
}

/** Persisted across process death: the last successful check, and the verified update awaiting install. */
interface UpdateStore {
    var lastCheckedAtMs: Long?
    var stagedManifest: String?
}

/** Android work the [Updater] asks for. Every callback arrives on the main thread. */
interface UpdatePorts {
    fun nowMs(): Long

    /** The origin this app is signed in to, which alone serves its artifacts. */
    fun artifactOrigin(): String
    fun fetchManifest(url: String, done: (FetchResult) -> Unit)

    /** Downloads [manifest]'s APK into app-private storage, reporting bytes received so far. */
    fun download(manifest: UpdateManifest, onProgress: (Long) -> Unit, done: (DownloadResult) -> Unit)
    fun cancelDownload()
    fun inspect(done: (DownloadInspection) -> Unit)
    fun hasVerifiedApk(): Boolean
    fun discardFiles()
    fun canRequestInstalls(): Boolean
    fun openInstallSettings()

    /** Writes the verified APK into an install session, hashing it again as it goes. */
    fun stage(manifest: UpdateManifest, done: (StageResult) -> Unit)
    fun commit(sessionId: Int): Boolean
    fun abandon(sessionId: Int)
}

/**
 * The APK update state machine (bridge capability `updates.manual.v1`). Main-thread confined.
 * Checks are passive (cold launch, six-hourly) or manual; downloads and installs happen only on
 * the user's request, and Android confirms every installation. No downgrade is possible: only a
 * manifest whose version code exceeds the installed one is ever downloaded.
 */
class Updater(
    private val basePolicy: UpdatePolicy,
    private val ports: UpdatePorts,
    private val store: UpdateStore,
) {
    /** The compiled policy, trusting only the origin currently selected. */
    private val policy: UpdatePolicy get() = basePolicy.copy(artifactOrigin = ports.artifactOrigin())

    private val listeners = mutableSetOf<(UpdateState) -> Unit>()
    private var passiveChecked = false
    private var sessionId: Int? = null

    var state: UpdateState = restore()
        private set(value) {
            field = value
            listeners.toList().forEach { it(value) }
        }

    fun addListener(listener: (UpdateState) -> Unit) {
        listeners += listener
    }

    fun removeListener(listener: (UpdateState) -> Unit) {
        listeners -= listener
    }

    /** A verified update survives process death, so returning from system Settings keeps it ready. */
    private fun restore(): UpdateState {
        val staged = store.stagedManifest
        val check = staged?.let { ManifestValidator.check(it, policy, null) }
        if (check is ManifestCheck.Newer && ports.hasVerifiedApk()) return UpdateState.Ready(check.manifest)
        store.stagedManifest = null
        ports.discardFiles()
        return UpdateState.Idle(store.lastCheckedAtMs)
    }

    /** Once per process, on a cold launch. A failed passive check stays silent and is retried next launch. */
    fun passiveCheckIfDue() {
        if (passiveChecked) return
        passiveChecked = true
        if (state !is UpdateState.Idle) return
        if (!UpdateSchedule.passiveCheckDue(ports.nowMs(), store.lastCheckedAtMs)) return
        runCheck(passive = true, webProtocols = null)
    }

    /** The user asked from Settings. Returns false while another step is running. */
    fun check(webProtocols: IntRange?): Boolean {
        when (state) {
            is UpdateState.Idle, is UpdateState.UpToDate, is UpdateState.Available, is UpdateState.Failed -> Unit
            else -> return false
        }
        runCheck(passive = false, webProtocols = webProtocols)
        return true
    }

    private fun runCheck(passive: Boolean, webProtocols: IntRange?) {
        val previous = store.lastCheckedAtMs
        val checkPolicy = policy
        state = UpdateState.Checking(previous)
        ports.fetchManifest(checkPolicy.manifestUrl) { result ->
            if (state !is UpdateState.Checking) return@fetchManifest
            val check = when (result) {
                is FetchResult.Body -> ManifestValidator.check(result.text, checkPolicy, webProtocols)
                is FetchResult.Refused -> ManifestCheck.Rejected(result.reason)
                is FetchResult.Denied, FetchResult.Failed -> null
            }
            if (check is ManifestCheck.Newer || check is ManifestCheck.Current) {
                val now = ports.nowMs()
                store.lastCheckedAtMs = now
                state = when {
                    check is ManifestCheck.Newer -> UpdateState.Available(check.manifest)
                    passive -> UpdateState.Idle(now)
                    else -> UpdateState.UpToDate(now)
                }
                return@fetchManifest
            }
            state = when {
                passive -> UpdateState.Idle(previous)
                check is ManifestCheck.Rejected ->
                    UpdateState.Failed(UpdateError.MANIFEST_REJECTED, check.reason.wireName, null, previous)
                else -> UpdateState.Failed(UpdateError.CHECK_FAILED, (result as? FetchResult.Denied)?.reason?.wireName, null, previous)
            }
        }
    }

    /** Starts the explicit download of an available update, or retries a failed one. */
    fun download(): Boolean {
        val manifest = when (val current = state) {
            is UpdateState.Available -> current.manifest
            is UpdateState.Failed -> current.manifest ?: return false
            else -> return false
        }
        ports.discardFiles()
        store.stagedManifest = null
        state = UpdateState.Downloading(manifest, 0)
        ports.download(
            manifest,
            onProgress = { bytes ->
                val current = state
                if (current is UpdateState.Downloading && current.manifest == manifest && bytes != current.bytes) {
                    state = current.copy(bytes = bytes)
                }
            },
            done = { result -> downloaded(manifest, result) },
        )
        return true
    }

    private fun downloaded(manifest: UpdateManifest, result: DownloadResult) {
        if ((state as? UpdateState.Downloading)?.manifest != manifest) return
        when (result) {
            DownloadResult.Completed -> verify(manifest)
            is DownloadResult.Refused -> fail(UpdateError.VERIFICATION_FAILED, result.reason.wireName, manifest)
            is DownloadResult.Denied -> fail(UpdateError.DOWNLOAD_FAILED, result.reason.wireName, manifest)
            DownloadResult.Failed -> fail(UpdateError.DOWNLOAD_FAILED, null, manifest)
        }
    }

    private fun verify(manifest: UpdateManifest) {
        state = UpdateState.Verifying(manifest)
        ports.inspect { inspection ->
            if ((state as? UpdateState.Verifying)?.manifest != manifest) return@inspect
            val rejection = DownloadVerifier.verify(manifest, policy, inspection)
            if (rejection != null) {
                fail(UpdateError.VERIFICATION_FAILED, rejection.wireName, manifest)
                return@inspect
            }
            store.stagedManifest = manifest.raw
            state = UpdateState.Ready(manifest)
        }
    }

    /**
     * Installs the verified update. Without install-source permission the first request explains
     * it and the next opens Android's setting. [prepare] stops playback, writes the final listen
     * checkpoint and releases the claim, then runs its callback; only then is the session committed.
     */
    fun install(prepare: (done: () -> Unit) -> Unit): Boolean {
        val manifest = when (val current = state) {
            is UpdateState.Ready -> current.manifest
            is UpdateState.Authorization -> {
                if (!ports.canRequestInstalls()) {
                    ports.openInstallSettings()
                    return true
                }
                current.manifest
            }
            else -> return false
        }
        if (!ports.canRequestInstalls()) {
            state = UpdateState.Authorization(manifest)
            return true
        }
        state = UpdateState.Installing(manifest)
        ports.stage(manifest) { result -> staged(manifest, result, prepare) }
        return true
    }

    private fun staged(manifest: UpdateManifest, result: StageResult, prepare: (done: () -> Unit) -> Unit) {
        if ((state as? UpdateState.Installing)?.manifest != manifest) {
            (result as? StageResult.Staged)?.let { ports.abandon(it.sessionId) }
            return
        }
        when (result) {
            is StageResult.Staged -> {
                sessionId = result.sessionId
                prepare {
                    if (sessionId == result.sessionId && !ports.commit(result.sessionId)) {
                        sessionId = null
                        fail(UpdateError.INSTALL_FAILED, null, manifest)
                    }
                }
            }
            is StageResult.Refused -> fail(UpdateError.VERIFICATION_FAILED, result.reason.wireName, manifest)
            StageResult.Failed -> fail(UpdateError.INSTALL_FAILED, null, manifest)
        }
    }

    /** Reported by `PackageInstaller` for the committed session. */
    fun onInstallStatus(status: InstallStatus) {
        val installing = state as? UpdateState.Installing ?: return
        when (status) {
            is InstallStatus.PendingUserAction -> status.confirm()
            // Android replaces the package and ends this process; nothing is left to show.
            InstallStatus.Succeeded -> {
                sessionId = null
                store.stagedManifest = null
            }
            // The verified file stays, so Install update can ask Android again.
            InstallStatus.Cancelled -> {
                sessionId = null
                state = UpdateState.Ready(installing.manifest)
            }
            InstallStatus.Failed -> {
                sessionId = null
                fail(UpdateError.INSTALL_FAILED, null, installing.manifest)
            }
        }
    }

    /** The user came back from system Settings: a granted install source makes the update ready again. */
    fun onForeground() {
        val current = state as? UpdateState.Authorization ?: return
        if (ports.canRequestInstalls()) state = UpdateState.Ready(current.manifest)
    }

    /** [reason] is a [Rejection] or [AccessFailure] wire name. */
    private fun fail(error: UpdateError, reason: String?, manifest: UpdateManifest) {
        ports.cancelDownload()
        ports.discardFiles()
        store.stagedManifest = null
        state = UpdateState.Failed(error, reason, manifest, store.lastCheckedAtMs)
    }
}
