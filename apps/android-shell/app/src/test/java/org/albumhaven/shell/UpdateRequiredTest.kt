package org.albumhaven.shell

import org.albumhaven.shell.updates.UpdateError
import org.albumhaven.shell.updates.UpdateState
import org.albumhaven.shell.updates.manifest
import org.junit.Assert.assertEquals
import org.junit.Test

class UpdateRequiredTest {
    private val manifest = manifest()

    /** The updater as the screen drives it: each call moves to the state the real updater would. */
    private class FakeUpdates(initial: UpdateState) : UpdatePort {
        val calls = mutableListOf<String>()
        var checkedWith: IntRange? = null
        var onChange: (UpdateState) -> Unit = {}
        var next: UpdateState? = null
        override var state: UpdateState = initial
            set(value) {
                field = value
                onChange(value)
            }

        override fun check(webProtocols: IntRange): Boolean {
            calls += "check"
            checkedWith = webProtocols
            state = UpdateState.Checking(null)
            return true
        }

        override fun download(): Boolean {
            calls += "download"
            next?.let { state = it }
            return true
        }

        override fun install(): Boolean {
            calls += "install"
            return true
        }
    }

    private fun flow(initial: UpdateState = UpdateState.Idle(null)): Pair<UpdateRequiredFlow, FakeUpdates> {
        val updates = FakeUpdates(initial)
        val flow = UpdateRequiredFlow(updates, 1..2)
        updates.onChange = flow::onState
        return flow to updates
    }

    @Test
    fun everyUpdaterStateMapsToAnApprovedStep() {
        val cases = mapOf(
            UpdateState.Idle(null) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.UpToDate(1) to UpdateRequiredView(UpdateStep.NO_UPDATE),
            UpdateState.Available(manifest) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Checking(null) to UpdateRequiredView(UpdateStep.CHECKING),
            UpdateState.Downloading(manifest, 1721) to UpdateRequiredView(UpdateStep.DOWNLOADING, 42, manifest.versionName),
            UpdateState.Verifying(manifest) to UpdateRequiredView(UpdateStep.VERIFYING, versionName = manifest.versionName),
            UpdateState.Ready(manifest) to UpdateRequiredView(UpdateStep.READY),
            UpdateState.Installing(manifest) to UpdateRequiredView(UpdateStep.INSTALLING),
            UpdateState.Authorization(manifest) to UpdateRequiredView(UpdateStep.AUTHORIZATION),
        ) + failures.associateWith { UpdateRequiredView(UpdateStep.FAILED) }
        cases.forEach { (state, view) -> assertEquals(state.toString(), view, UpdateRequiredView.of(state)) }
    }

    /** Every failed check, download and install, with or without the update it found. */
    private val failures = listOf(
        UpdateState.Failed(UpdateError.CHECK_FAILED, null, null, null),
        UpdateState.Failed(UpdateError.CHECK_FAILED, "signed_out", null, null),
        UpdateState.Failed(UpdateError.MANIFEST_REJECTED, "incompatible_bridge", null, null),
        UpdateState.Failed(UpdateError.DOWNLOAD_FAILED, null, manifest, null),
        UpdateState.Failed(UpdateError.VERIFICATION_FAILED, "hash_mismatch", manifest, null),
        UpdateState.Failed(UpdateError.INSTALL_FAILED, null, manifest, null),
    )

    @Test
    fun theOwnerApprovedCopyNamesNoUpdateVerifyingAndFailure() {
        assertEquals(R.string.recovery_update_none_title, UpdateStep.NO_UPDATE.title)
        assertEquals(R.string.recovery_update_check, UpdateStep.NO_UPDATE.action)
        assertEquals(R.string.recovery_update_verifying_title, UpdateStep.VERIFYING.title)
        assertEquals(R.string.recovery_update_verifying_action, UpdateStep.VERIFYING.action)
        // The failure is its title alone, with Retry; its details go to the log.
        assertEquals(R.string.recovery_update_failed_title, UpdateStep.FAILED.title)
        assertEquals(null, UpdateStep.FAILED.message)
        assertEquals(R.string.recovery_retry, UpdateStep.FAILED.action)
        assertEquals(AlertSeverity.ERROR, UpdateStep.FAILED.severity)
    }

    @Test
    fun onlyStepsWaitingForTheUserOfferAnAction() {
        val actionable = UpdateStep.entries.filter { it.actionable }
        assertEquals(
            listOf(UpdateStep.REQUIRED, UpdateStep.NO_UPDATE, UpdateStep.READY, UpdateStep.INSTALLING, UpdateStep.AUTHORIZATION, UpdateStep.FAILED),
            actionable,
        )
    }

    @Test
    fun checkForUpdateChecksForTheSiteRangeAndDownloadsWhatItFinds() {
        val (flow, updates) = flow()
        updates.next = UpdateState.Downloading(manifest, 0)
        flow.act()
        assertEquals(1..2, updates.checkedWith)
        assertEquals(UpdateStep.CHECKING, flow.view.step)
        updates.state = UpdateState.Available(manifest)
        assertEquals(listOf("check", "download"), updates.calls)
        assertEquals(UpdateStep.DOWNLOADING, flow.view.step)
    }

    @Test
    fun anUpdateFoundWithoutAskingIsNotDownloaded() {
        val (flow, updates) = flow()
        updates.state = UpdateState.Checking(null)
        updates.state = UpdateState.Available(manifest)
        assertEquals(emptyList<String>(), updates.calls)
        assertEquals(UpdateStep.REQUIRED, flow.view.step)
    }

    @Test
    fun aCheckThatFindsNothingSaysSoAndALaterUpdateWaits() {
        val (flow, updates) = flow()
        flow.act()
        updates.state = UpdateState.UpToDate(1)
        assertEquals(UpdateStep.NO_UPDATE, flow.view.step)
        updates.state = UpdateState.Available(manifest)
        assertEquals(listOf("check"), updates.calls)
        assertEquals(UpdateStep.REQUIRED, flow.view.step)
    }

    @Test
    fun noUpdatesAvailableChecksAgain() {
        val (flow, updates) = flow()
        flow.act()
        updates.state = UpdateState.UpToDate(1)
        flow.act()
        assertEquals(listOf("check", "check"), updates.calls)
        assertEquals(UpdateStep.CHECKING, flow.view.step)
    }

    @Test
    fun verifyingIsItsOwnStepAfterTheDownload() {
        val (flow, updates) = flow()
        flow.act()
        updates.next = UpdateState.Downloading(manifest, manifest.apkSize)
        updates.state = UpdateState.Available(manifest)
        assertEquals(UpdateRequiredView(UpdateStep.DOWNLOADING, 100, manifest.versionName), flow.view)
        updates.state = UpdateState.Verifying(manifest)
        assertEquals(UpdateRequiredView(UpdateStep.VERIFYING, versionName = manifest.versionName), flow.view)
    }

    @Test
    fun aFailedCheckRetriesTheCheckAndAFailedDownloadOrInstallDownloadsAgain() {
        for (failure in failures) {
            val (flow, updates) = flow()
            flow.act()
            updates.state = failure
            assertEquals(failure.toString(), UpdateStep.FAILED, flow.view.step)
            flow.act()
            val retry = if (failure.manifest == null) "check" else "download"
            assertEquals(failure.toString(), listOf("check", retry), updates.calls)
        }
    }

    @Test
    fun aResultLeftByAnEarlierRequestFromSettingsIsNotThisScreensAnswer() {
        for (earlier in failures + UpdateState.UpToDate(1)) {
            val (flow, updates) = flow(earlier)
            assertEquals(earlier.toString(), UpdateStep.REQUIRED, flow.view.step)
            flow.act()
            assertEquals(earlier.toString(), listOf("check"), updates.calls)
        }
    }

    @Test
    fun readyInstallingAndAuthorizationInstall() {
        val (ready, readyUpdates) = flow(UpdateState.Ready(manifest))
        ready.act()
        // Update while installing shows a confirmation left unanswered again.
        val (installing, installingUpdates) = flow(UpdateState.Installing(manifest))
        installing.act()
        val (authorization, authorizationUpdates) = flow(UpdateState.Authorization(manifest))
        authorization.act()
        assertEquals(listOf("install"), readyUpdates.calls)
        assertEquals(listOf("install"), installingUpdates.calls)
        assertEquals(listOf("install"), authorizationUpdates.calls)
    }

    @Test
    fun busyStepsIgnoreTheButton() {
        for (state in listOf(UpdateState.Checking(null), UpdateState.Downloading(manifest, 1), UpdateState.Verifying(manifest))) {
            val (flow, updates) = flow(state)
            flow.act()
            assertEquals(state.toString(), emptyList<String>(), updates.calls)
        }
    }
}
