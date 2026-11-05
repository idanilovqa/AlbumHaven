package org.albumhaven.shell.updates

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterTest {

    private class MemoryStore : UpdateStore {
        override var lastCheckedAtMs: Long? = null
        override var stagedManifest: String? = null
    }

    /** Holds each asynchronous request until the test answers it. */
    private class FakePorts : UpdatePorts {
        var now = 1_000_000L
        val fetched = mutableListOf<String>()
        var fetch: ((FetchResult) -> Unit)? = null
        var downloadDone: ((DownloadResult) -> Unit)? = null
        var progress: ((Long) -> Unit)? = null
        var inspectDone: ((DownloadInspection) -> Unit)? = null
        var stageDone: ((StageResult) -> Unit)? = null
        var verifiedApk = false
        var installsAllowed = true
        var settingsOpened = 0
        var discarded = 0
        var cancelled = 0
        val committed = mutableListOf<Int>()
        val abandoned = mutableListOf<Int>()
        var commitSucceeds = true
        var origin = ARTIFACT_ORIGIN

        override fun nowMs() = now
        override fun artifactOrigin() = origin
        override fun fetchManifest(url: String, done: (FetchResult) -> Unit) {
            fetched += url
            fetch = done
        }
        override fun download(manifest: UpdateManifest, onProgress: (Long) -> Unit, done: (DownloadResult) -> Unit) {
            progress = onProgress
            downloadDone = done
        }
        override fun cancelDownload() {
            cancelled++
        }
        override fun inspect(done: (DownloadInspection) -> Unit) {
            inspectDone = done
        }
        override fun hasVerifiedApk() = verifiedApk
        override fun discardFiles() {
            discarded++
            verifiedApk = false
        }
        override fun canRequestInstalls() = installsAllowed
        override fun openInstallSettings() {
            settingsOpened++
        }
        override fun stage(manifest: UpdateManifest, done: (StageResult) -> Unit) {
            stageDone = done
        }
        override fun commit(sessionId: Int): Boolean {
            committed += sessionId
            return commitSucceeds
        }
        override fun abandon(sessionId: Int) {
            abandoned += sessionId
        }
    }

    private val ports = FakePorts()
    private val store = MemoryStore()
    private val states = mutableListOf<UpdateState>()

    private fun updater(policy: UpdatePolicy = policy()) = Updater(policy, ports, store).also { it.addListener { state -> states += state } }

    private fun available(): Updater = updater().also {
        assertTrue(it.check(1..1))
        ports.fetch!!(FetchResult.Body(manifestJson()))
    }

    private fun ready(): Updater = available().also {
        assertTrue(it.download())
        ports.downloadDone!!(DownloadResult.Completed)
        ports.verifiedApk = true
        ports.inspectDone!!(inspection())
    }

    @Test
    fun `a manual check finds a newer update and records the check`() {
        val updater = updater()
        assertTrue(updater.check(1..1))
        assertEquals(UpdateState.Checking(null), updater.state)
        assertEquals(listOf("https://albumhaven.org/artifacts/android/sandbox/manifest.json"), ports.fetched)
        ports.fetch!!(FetchResult.Body(manifestJson()))
        assertEquals(UpdateState.Available(manifest()), updater.state)
        assertEquals(1_000_000L, store.lastCheckedAtMs)
    }

    @Test
    fun `the same version is up to date`() {
        val updater = updater()
        updater.check(1..1)
        ports.fetch!!(FetchResult.Body(manifestJson("versionCode" to 1)))
        assertEquals(UpdateState.UpToDate(1_000_000L), updater.state)
    }

    @Test
    fun `a rejected manifest and a failed fetch are readable failures that keep the last check`() {
        store.lastCheckedAtMs = 5L
        val updater = updater()
        updater.check(1..1)
        ports.fetch!!(FetchResult.Body(manifestJson("signingCertificateSha256" to OTHER_CERT)))
        assertEquals(UpdateState.Failed(UpdateError.MANIFEST_REJECTED, "wrong_certificate", null, 5L), updater.state)
        assertEquals(5L, store.lastCheckedAtMs)

        updater.check(1..1)
        ports.fetch!!(FetchResult.Refused(Rejection.REDIRECT))
        assertEquals(UpdateState.Failed(UpdateError.MANIFEST_REJECTED, "cross_host_redirect", null, 5L), updater.state)

        updater.check(1..1)
        ports.fetch!!(FetchResult.Failed)
        assertEquals(UpdateState.Failed(UpdateError.CHECK_FAILED, null, null, 5L), updater.state)
    }

    @Test
    fun `signed out, refused and unsupported devices are readable check failures`() {
        val updater = updater()
        for (reason in AccessFailure.entries) {
            updater.check(1..1)
            ports.fetch!!(FetchResult.Denied(reason))
            assertEquals(UpdateState.Failed(UpdateError.CHECK_FAILED, reason.wireName, null, null), updater.state)
        }
    }

    @Test
    fun `a passive check that is denied stays silent`() {
        val updater = updater()
        updater.passiveCheckIfDue()
        ports.fetch!!(FetchResult.Denied(AccessFailure.SIGNED_OUT))
        assertEquals(UpdateState.Idle(null), updater.state)
    }

    @Test
    fun `a download that is denied can be retried`() {
        val updater = available()
        updater.download()
        ports.downloadDone!!(DownloadResult.Denied(AccessFailure.SIGNED_OUT))
        assertEquals(UpdateState.Failed(UpdateError.DOWNLOAD_FAILED, "signed_out", manifest(), 1_000_000L), updater.state)
        assertTrue(updater.download())
    }

    @Test
    fun `artifacts come from the origin currently signed in to`() {
        ports.origin = "https://sandbox5.albumhaven.org"
        val updater = updater()
        updater.check(1..1)
        assertEquals(listOf("https://sandbox5.albumhaven.org/artifacts/android/sandbox/manifest.json"), ports.fetched)
        // An APK URL on another origin than the signed-in one is refused.
        ports.fetch!!(FetchResult.Body(manifestJson()))
        assertEquals(UpdateState.Failed(UpdateError.MANIFEST_REJECTED, "untrusted_host", null, null), updater.state)
    }

    @Test
    fun `the current site's bridge range decides compatibility`() {
        val updater = updater()
        updater.check(2..2)
        ports.fetch!!(FetchResult.Body(manifestJson()))
        assertEquals("incompatible_bridge", (updater.state as UpdateState.Failed).reason)
    }

    @Test
    fun `a check is refused while another step runs`() {
        val updater = updater()
        updater.check(1..1)
        assertFalse(updater.check(1..1))
        assertEquals(1, ports.fetched.size)
    }

    @Test
    fun `the passive check runs on a cold launch only when six hours passed`() {
        store.lastCheckedAtMs = ports.now - UpdateSchedule.PASSIVE_INTERVAL_MS + 1
        updater().passiveCheckIfDue()
        assertTrue(ports.fetched.isEmpty())

        store.lastCheckedAtMs = ports.now - UpdateSchedule.PASSIVE_INTERVAL_MS
        val due = updater()
        due.passiveCheckIfDue()
        due.passiveCheckIfDue()
        assertEquals(1, ports.fetched.size)
    }

    @Test
    fun `a passive check that finds nothing or fails stays quiet`() {
        val updater = updater()
        updater.passiveCheckIfDue()
        ports.fetch!!(FetchResult.Body(manifestJson("versionCode" to 1)))
        assertEquals(UpdateState.Idle(1_000_000L), updater.state)

        val failing = updater()
        store.lastCheckedAtMs = null
        failing.passiveCheckIfDue()
        ports.fetch!!(FetchResult.Failed)
        assertEquals(UpdateState.Idle(null), failing.state)
        assertNull(store.lastCheckedAtMs)
    }

    @Test
    fun `a passive check that finds an update shows it without downloading`() {
        val updater = updater()
        updater.passiveCheckIfDue()
        ports.fetch!!(FetchResult.Body(manifestJson()))
        assertEquals(UpdateState.Available(manifest()), updater.state)
        assertNull(ports.downloadDone)
    }

    @Test
    fun `the schedule is due without a check, after six hours, and when the clock moved back`() {
        assertTrue(UpdateSchedule.passiveCheckDue(10, null))
        assertFalse(UpdateSchedule.passiveCheckDue(10 + UpdateSchedule.PASSIVE_INTERVAL_MS - 1, 10))
        assertTrue(UpdateSchedule.passiveCheckDue(10 + UpdateSchedule.PASSIVE_INTERVAL_MS, 10))
        assertTrue(UpdateSchedule.passiveCheckDue(5, 10))
    }

    @Test
    fun `downloading happens only on request and reports progress`() {
        assertFalse(updater().download())

        val shown = available()
        assertTrue(shown.download())
        assertEquals(UpdateState.Downloading(manifest(), 0), shown.state)
        ports.progress!!(1024)
        assertEquals(25, shown.state.toJson().getInt("progress"))
        ports.downloadDone!!(DownloadResult.Completed)
        assertEquals(UpdateState.Verifying(manifest()), shown.state)
        ports.verifiedApk = true
        ports.inspectDone!!(inspection())
        assertEquals(UpdateState.Ready(manifest()), shown.state)
        assertEquals(manifestJson(), store.stagedManifest)
    }

    @Test
    fun `a failed verification discards the file and offers the download again`() {
        val updater = available()
        updater.download()
        ports.downloadDone!!(DownloadResult.Completed)
        ports.inspectDone!!(inspection(sha256 = APK_SHA.replace('4', '5')))
        assertEquals(UpdateState.Failed(UpdateError.VERIFICATION_FAILED, "hash_mismatch", manifest(), 1_000_000L), updater.state)
        assertNull(store.stagedManifest)
        assertTrue(ports.discarded > 0)
        assertTrue(updater.download())
        assertTrue(updater.state is UpdateState.Downloading)
    }

    @Test
    fun `a wrong certificate, refused redirect, and failed download are readable`() {
        val updater = available()
        updater.download()
        ports.downloadDone!!(DownloadResult.Completed)
        ports.inspectDone!!(inspection(archive = inspection().archive!!.copy(signerSha256 = listOf(OTHER_CERT))))
        assertEquals("wrong_certificate", (updater.state as UpdateState.Failed).reason)

        updater.download()
        ports.downloadDone!!(DownloadResult.Refused(Rejection.REDIRECT))
        assertEquals(UpdateState.Failed(UpdateError.VERIFICATION_FAILED, "cross_host_redirect", manifest(), 1_000_000L), updater.state)

        updater.download()
        ports.downloadDone!!(DownloadResult.Failed)
        assertEquals(UpdateError.DOWNLOAD_FAILED, (updater.state as UpdateState.Failed).error)
    }

    @Test
    fun `a check failure keeps no update to download`() {
        val updater = updater()
        updater.check(1..1)
        ports.fetch!!(FetchResult.Failed)
        assertFalse(updater.download())
    }

    @Test
    fun `install-source authorization is explained, then opened, then recognised on return`() {
        val updater = ready()
        ports.installsAllowed = false
        assertTrue(updater.install { error("not reached") })
        assertEquals(UpdateState.Authorization(manifest()), updater.state)
        assertEquals(0, ports.settingsOpened)

        assertTrue(updater.install { error("not reached") })
        assertEquals(1, ports.settingsOpened)

        updater.onForeground()
        assertEquals(UpdateState.Authorization(manifest()), updater.state)
        ports.installsAllowed = true
        updater.onForeground()
        assertEquals(UpdateState.Ready(manifest()), updater.state)
        assertNull(ports.stageDone)
    }

    @Test
    fun `playback is shut down before the session is committed`() {
        val updater = ready()
        val order = mutableListOf<String>()
        var prepared: (() -> Unit)? = null
        assertTrue(updater.install { done -> order += "prepare"; prepared = done })
        assertEquals(UpdateState.Installing(manifest()), updater.state)
        assertTrue(order.isEmpty())
        ports.stageDone!!(StageResult.Staged(7))
        assertEquals(listOf("prepare"), order)
        assertTrue(ports.committed.isEmpty())
        prepared!!()
        assertEquals(listOf(7), ports.committed)
    }

    @Test
    fun `Android's confirmation is shown and a cancel keeps the update ready`() {
        val updater = ready()
        updater.install { it() }
        ports.stageDone!!(StageResult.Staged(3))
        var confirmed = 0
        updater.onInstallStatus(InstallStatus.PendingUserAction { confirmed++ })
        assertEquals(1, confirmed)
        assertEquals(UpdateState.Installing(manifest()), updater.state)
        updater.onInstallStatus(InstallStatus.Cancelled)
        assertEquals(UpdateState.Ready(manifest()), updater.state)
        assertEquals(manifestJson(), store.stagedManifest)
    }

    @Test
    fun `leaving Android's confirmation unanswered makes the update ready again on return`() {
        val updater = ready()
        updater.install { it() }
        // Returning while staging, stopping playback or committing changes nothing.
        updater.onForeground()
        ports.stageDone!!(StageResult.Staged(3))
        updater.onForeground()
        assertEquals(UpdateState.Installing(manifest()), updater.state)

        // The user went Home from the confirmation; Android reports nothing for it.
        updater.onInstallStatus(InstallStatus.PendingUserAction {})
        updater.onForeground()
        assertEquals(UpdateState.Ready(manifest()), updater.state)

        // Install update asks Android again with a fresh session in place of the unanswered one.
        assertTrue(updater.install { it() })
        assertEquals(listOf(3), ports.abandoned)
        assertEquals(UpdateState.Installing(manifest()), updater.state)
        ports.stageDone!!(StageResult.Staged(4))
        assertEquals(listOf(3, 4), ports.committed)
    }

    @Test
    fun `a late answer to an unanswered confirmation still applies`() {
        val updater = ready()
        updater.install { it() }
        ports.stageDone!!(StageResult.Staged(3))
        updater.onInstallStatus(InstallStatus.PendingUserAction {})
        updater.onForeground()
        updater.onInstallStatus(InstallStatus.Cancelled)
        assertEquals(UpdateState.Ready(manifest()), updater.state)

        // The cancelled session is gone, so the next install has nothing to abandon.
        updater.install { it() }
        assertTrue(ports.abandoned.isEmpty())
        ports.stageDone!!(StageResult.Staged(5))
        updater.onInstallStatus(InstallStatus.PendingUserAction {})
        updater.onForeground()
        updater.onInstallStatus(InstallStatus.Failed)
        assertEquals(UpdateState.Failed(UpdateError.INSTALL_FAILED, null, manifest(), 1_000_000L), updater.state)
    }

    @Test
    fun `an install failure is readable and offers the download again`() {
        val updater = ready()
        updater.install { it() }
        ports.stageDone!!(StageResult.Staged(3))
        updater.onInstallStatus(InstallStatus.Failed)
        assertEquals(UpdateState.Failed(UpdateError.INSTALL_FAILED, null, manifest(), 1_000_000L), updater.state)
        assertNull(store.stagedManifest)
        assertTrue(updater.download())
    }

    @Test
    fun `a session whose bytes changed or that cannot commit fails`() {
        val updater = ready()
        updater.install { it() }
        ports.stageDone!!(StageResult.Refused(Rejection.HASH_MISMATCH))
        assertEquals(UpdateState.Failed(UpdateError.VERIFICATION_FAILED, "hash_mismatch", manifest(), 1_000_000L), updater.state)

        val again = ready()
        ports.commitSucceeds = false
        again.install { it() }
        ports.stageDone!!(StageResult.Staged(4))
        assertEquals(UpdateError.INSTALL_FAILED, (again.state as UpdateState.Failed).error)
    }

    @Test
    fun `status for no running install is ignored`() {
        val updater = ready()
        updater.onInstallStatus(InstallStatus.Failed)
        assertEquals(UpdateState.Ready(manifest()), updater.state)
        assertTrue(ports.committed.isEmpty())
    }

    @Test
    fun `a verified update survives process death and anything else is discarded`() {
        store.stagedManifest = manifestJson()
        ports.verifiedApk = true
        assertEquals(UpdateState.Ready(manifest()), updater().state)

        // After the update installed, the staged manifest is no longer newer.
        val discardedBefore = ports.discarded
        val updated = Updater(policy(installedVersionCode = 2), ports, store)
        assertEquals(UpdateState.Idle(null), updated.state)
        assertNull(store.stagedManifest)
        assertTrue(ports.discarded > discardedBefore)

        store.stagedManifest = manifestJson()
        ports.verifiedApk = false
        assertEquals(UpdateState.Idle(null), updater().state)
    }

    @Test
    fun `state payloads are path-free and complete`() {
        val updater = ready()
        val json = updater.state.toJson()
        assertEquals(setOf("state", "versionName", "versionCode", "progress", "checkedAt", "error", "reason"), json.keys().asSequence().toSet())
        assertEquals("ready", json.getString("state"))
        assertEquals("0.10.0-sandbox.763af93", json.getString("versionName"))
        assertTrue(json.isNull("progress"))
        assertFalse(json.toString().contains("artifacts"))
        assertEquals("idle", UpdateState.Idle(null).toJson().getString("state"))
        assertTrue(states.any { it is UpdateState.Checking })
    }
}
