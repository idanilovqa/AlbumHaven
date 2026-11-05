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
            UpdateState.UpToDate(1) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Available(manifest) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Checking(null) to UpdateRequiredView(UpdateStep.CHECKING),
            UpdateState.Downloading(manifest, 1721) to UpdateRequiredView(UpdateStep.DOWNLOADING, 42, manifest.versionName),
            UpdateState.Verifying(manifest) to UpdateRequiredView(UpdateStep.DOWNLOADING, 100, manifest.versionName),
            UpdateState.Ready(manifest) to UpdateRequiredView(UpdateStep.READY),
            UpdateState.Installing(manifest) to UpdateRequiredView(UpdateStep.INSTALLING),
            UpdateState.Authorization(manifest) to UpdateRequiredView(UpdateStep.AUTHORIZATION),
            UpdateState.Failed(UpdateError.VERIFICATION_FAILED, "hash_mismatch", manifest, null) to UpdateRequiredView(UpdateStep.INVALID),
            UpdateState.Failed(UpdateError.CHECK_FAILED, null, null, null) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Failed(UpdateError.MANIFEST_REJECTED, "incompatible_bridge", null, null) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Failed(UpdateError.DOWNLOAD_FAILED, null, manifest, null) to UpdateRequiredView(UpdateStep.REQUIRED),
            UpdateState.Failed(UpdateError.INSTALL_FAILED, null, manifest, null) to UpdateRequiredView(UpdateStep.REQUIRED),
        )
        cases.forEach { (state, view) -> assertEquals(state.toString(), view, UpdateRequiredView.of(state)) }
    }

    @Test
    fun onlyStepsWaitingForTheUserOfferAnAction() {
        val actionable = UpdateStep.entries.filter { it.actionable }
        assertEquals(listOf(UpdateStep.REQUIRED, UpdateStep.READY, UpdateStep.AUTHORIZATION, UpdateStep.INVALID), actionable)
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
    fun aCheckThatFindsNothingEndsTheRequestAndALaterUpdateWaits() {
        val (flow, updates) = flow()
        flow.act()
        updates.state = UpdateState.UpToDate(1)
        updates.state = UpdateState.Available(manifest)
        assertEquals(listOf("check"), updates.calls)
    }

    @Test
    fun readyAndAuthorizationInstallAndAnInvalidDownloadRetries() {
        val (ready, readyUpdates) = flow(UpdateState.Ready(manifest))
        ready.act()
        val (authorization, authorizationUpdates) = flow(UpdateState.Authorization(manifest))
        authorization.act()
        val (invalid, invalidUpdates) = flow(UpdateState.Failed(UpdateError.VERIFICATION_FAILED, null, manifest, null))
        invalid.act()
        assertEquals(listOf("install"), readyUpdates.calls)
        assertEquals(listOf("install"), authorizationUpdates.calls)
        assertEquals(listOf("download"), invalidUpdates.calls)
    }

    @Test
    fun busyStepsIgnoreTheButton() {
        for (state in listOf(UpdateState.Checking(null), UpdateState.Downloading(manifest, 1), UpdateState.Verifying(manifest), UpdateState.Installing(manifest))) {
            val (flow, updates) = flow(state)
            flow.act()
            assertEquals(state.toString(), emptyList<String>(), updates.calls)
        }
    }
}
