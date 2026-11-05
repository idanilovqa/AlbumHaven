package org.albumhaven.shell.updates

import android.app.DownloadManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.content.pm.SigningInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.CookieManager
import androidx.core.content.IntentCompat
import androidx.core.content.edit
import androidx.core.net.toUri
import okhttp3.OkHttpClient
import org.albumhaven.shell.BuildConfig
import org.albumhaven.shell.OriginPolicy
import org.albumhaven.shell.R
import org.albumhaven.shell.ShellChannel
import org.albumhaven.shell.ShellPreferences
import org.albumhaven.shell.playback.ShellSession
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/** The process's one [Updater], or null when this build has no compiled update certificate. */
object Updates {
    private var instance: Updater? = null

    fun policy(context: Context) = UpdatePolicy(
        channel = ShellChannel.fromWireName(BuildConfig.CHANNEL),
        applicationId = context.packageName,
        artifactOrigin = signedInOrigin(context),
        expectedCertificateSha256 = BuildConfig.UPDATE_CERTIFICATE_SHA256,
        installedVersionCode = BuildConfig.VERSION_CODE.toLong(),
        deviceApi = Build.VERSION.SDK_INT,
    )

    /** Artifacts come from the origin the app is signed in to: albumhaven.org, or the selected sandbox. */
    fun signedInOrigin(context: Context): String =
        OriginPolicy(ShellChannel.fromWireName(BuildConfig.CHANNEL), BuildConfig.DEV_ORIGIN)
            .initialOrigin(ShellPreferences(context).selectedSandboxSlot)

    /** Main thread only. */
    fun get(context: Context): Updater? {
        instance?.let { return it }
        val app = context.applicationContext
        val policy = policy(app)
        if (!policy.enabled) return null
        return Updater(policy, AndroidUpdatePorts(app, policy), PreferencesUpdateStore(app)).also { instance = it }
    }

    /** For the install receiver, which must never create an updater of its own. */
    fun current(): Updater? = instance
}

private class PreferencesUpdateStore(context: Context) : UpdateStore {
    private val preferences = context.getSharedPreferences("updates", Context.MODE_PRIVATE)

    // Written synchronously: the package replacement that follows ends this process.
    override var lastCheckedAtMs: Long?
        get() = preferences.getLong(KEY_CHECKED, 0).takeIf { it > 0 }
        set(value) = preferences.edit(commit = true) { if (value == null) remove(KEY_CHECKED) else putLong(KEY_CHECKED, value) }

    override var stagedManifest: String?
        get() = preferences.getString(KEY_STAGED, null)
        set(value) = preferences.edit(commit = true) { if (value == null) remove(KEY_STAGED) else putString(KEY_STAGED, value) }

    private companion object {
        const val KEY_CHECKED = "last_checked_at_ms"
        const val KEY_STAGED = "staged_manifest"
    }
}

/**
 * Android side of the updater. `DownloadManager` writes into this app's own external files
 * directory; the file is then moved into no-backup internal storage while it is hashed, and only
 * that private copy is inspected and installed.
 */
private class AndroidUpdatePorts(private val context: Context, private val policy: UpdatePolicy) : UpdatePorts {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    // The WebView session is read per request and never stored here.
    private val http = ArtifactHttp(
        OkHttpClient(),
        ShellSession(::artifactOrigin) { url -> CookieManager.getInstance().getCookie(url) },
        policy.channel,
        KeystoreDeviceKeys(context),
        PreferencesDeviceKeyIds(context),
    )
    private val downloads = context.getSystemService(DownloadManager::class.java)
    private val installer = context.packageManager.packageInstaller
    private var downloadId: Long? = null

    // The finished download's row, removed once its file has been moved into private storage.
    @Volatile private var completedId: Long? = null
    private var poll: Runnable? = null

    private val downloadDir get() = File(context.getExternalFilesDir(null), UPDATES_DIR)
    private val verifiedApk get() = File(File(context.noBackupFilesDir, UPDATES_DIR), APK_NAME)

    override fun nowMs() = System.currentTimeMillis()

    override fun artifactOrigin() = Updates.signedInOrigin(context)

    override fun fetchManifest(url: String, done: (FetchResult) -> Unit) {
        io.execute {
            val result = http.fetchManifest(url)
            main.post { done(result) }
        }
    }

    override fun download(manifest: UpdateManifest, onProgress: (Long) -> Unit, done: (DownloadResult) -> Unit) {
        io.execute {
            val resolution = http.resolveApk(manifest, policy.maxApkBytes)
            main.post {
                when (resolution) {
                    is ArtifactHttp.Resolution.Url -> enqueue(resolution.url, manifest, onProgress, done)
                    is ArtifactHttp.Resolution.Refused -> done(DownloadResult.Refused(resolution.reason))
                    is ArtifactHttp.Resolution.Denied -> done(DownloadResult.Denied(resolution.reason))
                    ArtifactHttp.Resolution.Failed -> done(DownloadResult.Failed)
                }
            }
        }
    }

    private fun enqueue(url: String, manifest: UpdateManifest, onProgress: (Long) -> Unit, done: (DownloadResult) -> Unit) {
        downloadDir.mkdirs()
        val request = DownloadManager.Request(url.toUri())
            .setTitle(context.getString(R.string.app_name))
            .setMimeType(APK_MIME)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(context, null, "$UPDATES_DIR/$APK_NAME")
        val id = try {
            downloads.enqueue(request)
        } catch (_: IllegalStateException) {
            done(DownloadResult.Failed)
            return
        } catch (_: SecurityException) {
            done(DownloadResult.Failed)
            return
        }
        downloadId = id
        val tick = object : Runnable {
            override fun run() {
                if (downloadId != id) return
                when (val progress = query(id)) {
                    null -> finish(id, DownloadResult.Failed, done)
                    else -> {
                        val (status, bytes) = progress
                        when {
                            bytes > manifest.apkSize -> finish(id, DownloadResult.Refused(Rejection.SIZE_MISMATCH), done)
                            status == DownloadManager.STATUS_SUCCESSFUL -> {
                                onProgress(bytes)
                                downloadId = null
                                completedId = id
                                done(DownloadResult.Completed)
                            }
                            status == DownloadManager.STATUS_FAILED -> finish(id, DownloadResult.Failed, done)
                            else -> {
                                onProgress(bytes)
                                main.postDelayed(this, POLL_MS)
                            }
                        }
                    }
                }
            }
        }
        poll = tick
        main.post(tick)
    }

    private fun finish(id: Long, result: DownloadResult, done: (DownloadResult) -> Unit) {
        downloadId = null
        downloads.remove(id)
        done(result)
    }

    private fun query(id: Long): Pair<Int, Long>? =
        downloads.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val bytes = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            status to bytes
        }

    override fun cancelDownload() {
        val id = downloadId ?: return
        downloadId = null
        poll?.let(main::removeCallbacks)
        downloads.remove(id)
    }

    override fun inspect(done: (DownloadInspection) -> Unit) {
        io.execute {
            val downloaded = File(downloadDir, APK_NAME)
            val target = verifiedApk
            val (size, sha256) = try {
                target.parentFile?.mkdirs()
                downloaded.inputStream().use { input ->
                    target.outputStream().use { output -> copyHashing(input, output, policy.maxApkBytes + 1) }
                }
            } catch (_: IOException) {
                -1L to ""
            } finally {
                downloaded.delete()
                completedId?.let { downloads.remove(it) }
                completedId = null
            }
            val inspection = DownloadInspection(
                size = size,
                sha256 = sha256,
                archive = if (size > 0) archiveFacts(target) else null,
                installedSignerSha256 = installedSigners(),
            )
            main.post { done(inspection) }
        }
    }

    @Suppress("DEPRECATION")
    private fun archiveFacts(apk: File): ArchiveFacts? {
        val info = context.packageManager.getPackageArchiveInfo(apk.path, PackageManager.GET_SIGNING_CERTIFICATES)
            ?: return null
        val signing = info.signingInfo ?: return null
        return ArchiveFacts(
            packageName = info.packageName,
            versionCode = info.longVersionCode,
            versionName = info.versionName,
            signerSha256 = signers(signing),
            multipleSigners = signing.hasMultipleSigners(),
        )
    }

    private fun installedSigners(): List<String> = try {
        context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            .signingInfo?.let(::signers).orEmpty()
    } catch (_: PackageManager.NameNotFoundException) {
        emptyList()
    }

    private fun signers(signing: SigningInfo): List<String> {
        val certificates: Array<Signature> = if (signing.hasMultipleSigners()) {
            signing.apkContentsSigners
        } else {
            signing.signingCertificateHistory
        } ?: emptyArray()
        return certificates.map { sha256Hex(it.toByteArray()) }
    }

    override fun hasVerifiedApk() = verifiedApk.isFile

    override fun discardFiles() {
        io.execute {
            downloadDir.deleteRecursively()
            verifiedApk.parentFile?.deleteRecursively()
        }
    }

    override fun canRequestInstalls() = context.packageManager.canRequestPackageInstalls()

    override fun openInstallSettings() {
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:${context.packageName}".toUri())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    override fun stage(manifest: UpdateManifest, done: (StageResult) -> Unit) {
        io.execute {
            val result = stageNow(manifest)
            main.post { done(result) }
        }
    }

    private fun stageNow(manifest: UpdateManifest): StageResult {
        val apk = verifiedApk
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(manifest.apkSize)
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            // Installation stays user-confirmed even once this app is the installer of record.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }
        val id = try {
            installer.createSession(params)
        } catch (_: IOException) {
            return StageResult.Failed
        }
        return try {
            // The private copy is hashed again as it is written, so the session holds exactly the verified bytes.
            val (size, sha256) = installer.openSession(id).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite(APK_NAME, 0, manifest.apkSize).use { output ->
                        copyHashing(input, output, manifest.apkSize + 1).also { session.fsync(output) }
                    }
                }
            }
            when {
                size != manifest.apkSize -> abandoned(id, StageResult.Refused(Rejection.SIZE_MISMATCH))
                sha256 != manifest.sha256 -> abandoned(id, StageResult.Refused(Rejection.HASH_MISMATCH))
                else -> StageResult.Staged(id)
            }
        } catch (_: IOException) {
            abandoned(id, StageResult.Failed)
        } catch (_: SecurityException) {
            abandoned(id, StageResult.Failed)
        }
    }

    private fun abandoned(id: Int, result: StageResult): StageResult {
        abandon(id)
        return result
    }

    override fun commit(sessionId: Int): Boolean = try {
        // Mutable: PackageInstaller adds the status and confirmation intent to it.
        val status = PendingIntent.getBroadcast(
            context,
            sessionId,
            Intent(context, UpdateInstallReceiver::class.java).setPackage(context.packageName),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        installer.openSession(sessionId).use { it.commit(status.intentSender) }
        true
    } catch (_: IOException) {
        false
    } catch (_: SecurityException) {
        false
    }

    override fun abandon(sessionId: Int) {
        try {
            installer.abandonSession(sessionId)
        } catch (_: SecurityException) {
            // Already gone.
        }
    }

    private companion object {
        const val UPDATES_DIR = "updates"
        const val APK_NAME = "update.apk"
        const val APK_MIME = "application/vnd.android.package-archive"
        const val POLL_MS = 500L
    }
}

/** `PackageInstaller` reports the committed session here. */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val updater = Updates.current() ?: return
        val status = when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                    ?: return updater.onInstallStatus(InstallStatus.Failed)
                InstallStatus.PendingUserAction {
                    context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
            }
            PackageInstaller.STATUS_SUCCESS -> InstallStatus.Succeeded
            PackageInstaller.STATUS_FAILURE_ABORTED -> InstallStatus.Cancelled
            else -> InstallStatus.Failed
        }
        updater.onInstallStatus(status)
    }
}
