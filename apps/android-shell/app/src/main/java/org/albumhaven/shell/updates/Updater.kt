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
    data class Downloading(val manifest: UpdateManifest, val bytes: Long) : UpdateState {
        val percent: Int get() = (bytes.coerceIn(0, manifest.apkSize) * 100 / manifest.apkSize).toInt()
    }
    data class Verifying(val manifest: UpdateManifest) : UpdateState
    data class Ready(val manifest: UpdateManifest) : UpdateState

    /** Android blocks this install source until the user allows it in system Settings. */
    data class Authorization(val manifest: UpdateManifest) : UpdateState

    /** Playback is stopping, Android is asking the user to confirm the installation, or it is installing. */
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
                if (this is Downloading) percent else JSONObject.NULL,
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

    /** An installation with no status for its session this long returns to ready, so it can be retried. */
    const val INSTALL_TIMEOUT_MS = 2L * 60 * 1000

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

    /** Whether Android still holds the install session: awaiting its confirmation, or installing. */
    fun sessionExists(sessionId: Int): Boolean

    /** Runs [task] on the main thread after [delayMs]; the returned function cancels it. */
    fun after(delayMs: Long, task: () -> Unit): () -> Unit
}

/**
 * The APK update state machine (bridge capability `updates.manual.v1`). Main-thread confined.
 * Checks are passive (cold launch, six-hourly) or manual; downloads and installs happen only on
 * the user's request, and Android confirms every installation. No downgrade is possible: only a
 * manifest whose version code exceeds the installed one is ever downloaded.
 */
class Updater(
    /** The compiled policy, trusting only the origin the app is signed in to now. */
    private val currentPolicy: () -> UpdatePolicy,
    private val ports: UpdatePorts,
    private val store: UpdateStore,
) {
    private val policy: UpdatePolicy get() = currentPolicy()

    private val listeners = mutableSetOf<(UpdateState) -> Unit>()
    private var passiveChecked = false
    private var sessionId: Int? = null

    /** Shows the committed session's confirmation again until Android reports anything else for it. */
    private var confirm: (() -> Unit)? = null

    /** Counts install requests, so a superseded one's stage changes nothing. */
    private var installAttempt = 0

    /** Whether the current attempt's session was committed, so Android may already be installing it. */
    private var committed = false
    private var cancelInstallTimeout: (() -> Unit)? = null

    var state: UpdateState = restore()
        private set(value) {
            if (value !is UpdateState.Installing) clearInstallTimeout()
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
     * While installing, a confirmation the user left unanswered, for example with Home, is shown
     * again; an approved installation keeps installing.
     */
    fun install(prepare: (done: () -> Unit) -> Unit): Boolean {
        val manifest = when (val current = state) {
            is UpdateState.Installing -> return confirm?.also { it() } != null
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
        // The previous session, whose confirmation Android dropped, gives way to a fresh one.
        sessionId?.let(ports::abandon)
        sessionId = null
        confirm = null
        committed = false
        val attempt = ++installAttempt
        state = UpdateState.Installing(manifest)
        cancelInstallTimeout = ports.after(UpdateSchedule.INSTALL_TIMEOUT_MS) { installTimedOut() }
        ports.stage(manifest) { result -> staged(attempt, manifest, result, prepare) }
        return true
    }

    /**
     * No result came for the session in time; Android's request for the user's confirmation is not
     * one, so the timer runs on through it and its re-showing. A session not yet committed cannot
     * be installing and is abandoned; a committed one may be, so it is left for its later status,
     * which the session ID still matches until a retry replaces it.
     */
    private fun installTimedOut() {
        val manifest = (state as UpdateState.Installing).manifest
        val id = sessionId
        if (id != null && !committed) {
            if (ports.sessionExists(id)) ports.abandon(id)
            sessionId = null
        }
        state = UpdateState.Ready(manifest)
    }

    private fun clearInstallTimeout() {
        cancelInstallTimeout?.invoke()
        cancelInstallTimeout = null
    }

    private fun staged(attempt: Int, manifest: UpdateManifest, result: StageResult, prepare: (done: () -> Unit) -> Unit) {
        if (attempt != installAttempt || state !is UpdateState.Installing) {
            (result as? StageResult.Staged)?.let { ports.abandon(it.sessionId) }
            return
        }
        when (result) {
            is StageResult.Staged -> {
                sessionId = result.sessionId
                prepare {
                    if (sessionId == result.sessionId) {
                        committed = ports.commit(result.sessionId)
                        if (!committed) {
                            sessionId = null
                            fail(UpdateError.INSTALL_FAILED, null, manifest)
                        }
                    }
                }
            }
            is StageResult.Refused -> fail(UpdateError.VERIFICATION_FAILED, result.reason.wireName, manifest)
            StageResult.Failed -> fail(UpdateError.INSTALL_FAILED, null, manifest)
        }
    }

    /**
     * Reported by `PackageInstaller` for the committed session, also after its confirmation was left
     * unanswered. A status for any other session, such as one abandoned for a retry, is ignored.
     */
    fun onInstallStatus(statusSessionId: Int, status: InstallStatus) {
        if (statusSessionId != sessionId) return
        val manifest = when (val current = state) {
            is UpdateState.Installing -> current.manifest
            is UpdateState.Ready -> current.manifest
            else -> return
        }
        confirm = null
        when (status) {
            is InstallStatus.PendingUserAction -> if (state is UpdateState.Installing) {
                confirm = status.confirm
                status.confirm()
            }
            // Android replaces the package and ends this process; nothing is left to show.
            InstallStatus.Succeeded -> {
                clearInstallTimeout()
                sessionId = null
                store.stagedManifest = null
            }
            // The verified file stays, so Update can ask Android again.
            InstallStatus.Cancelled -> {
                sessionId = null
                state = UpdateState.Ready(manifest)
            }
            InstallStatus.Failed -> {
                sessionId = null
                fail(UpdateError.INSTALL_FAILED, null, manifest)
            }
        }
    }

    /**
     * The user came back to the app: from system Settings, a granted install source makes the
     * update ready again. From Android's confirmation, an approved installation is still running,
     * so the update stays installing while Android holds the session; once the session is gone
     * without a status, as when its confirmation was left and dropped, Update asks again.
     */
    fun onForeground() {
        when (val current = state) {
            is UpdateState.Authorization -> if (ports.canRequestInstalls()) state = UpdateState.Ready(current.manifest)
            is UpdateState.Installing -> {
                val id = sessionId
                if (id != null && !ports.sessionExists(id)) state = UpdateState.Ready(current.manifest)
            }
            else -> Unit
        }
    }

    /** [reason] is a [Rejection] or [AccessFailure] wire name. */
    private fun fail(error: UpdateError, reason: String?, manifest: UpdateManifest) {
        ports.cancelDownload()
        ports.discardFiles()
        store.stagedManifest = null
        state = UpdateState.Failed(error, reason, manifest, store.lastCheckedAtMs)
    }
}
