package org.albumhaven.shell

import org.albumhaven.shell.updates.UpdateError
import org.albumhaven.shell.updates.UpdateState

/** What the native Update required screen shows; [progress] and [versionName] belong to the download. */
data class UpdateRequiredView(val step: UpdateStep, val progress: Int? = null, val versionName: String? = null) {
    companion object {
        /**
         * The approved screen has no copy for "no newer app yet" or for a failed check, download or
         * install, so those return to Update required, whose Check for update starts again.
         */
        fun of(state: UpdateState): UpdateRequiredView = when (state) {
            is UpdateState.Idle, is UpdateState.UpToDate, is UpdateState.Available -> UpdateRequiredView(UpdateStep.REQUIRED)
            is UpdateState.Checking -> UpdateRequiredView(UpdateStep.CHECKING)
            is UpdateState.Downloading ->
                UpdateRequiredView(UpdateStep.DOWNLOADING, state.percent, state.manifest.versionName)
            is UpdateState.Verifying -> UpdateRequiredView(UpdateStep.DOWNLOADING, 100, state.manifest.versionName)
            is UpdateState.Ready -> UpdateRequiredView(UpdateStep.READY)
            is UpdateState.Installing -> UpdateRequiredView(UpdateStep.INSTALLING)
            is UpdateState.Authorization -> UpdateRequiredView(UpdateStep.AUTHORIZATION)
            is UpdateState.Failed ->
                if (state.error == UpdateError.VERIFICATION_FAILED && state.manifest != null) {
                    UpdateRequiredView(UpdateStep.INVALID)
                } else {
                    UpdateRequiredView(UpdateStep.REQUIRED)
                }
        }
    }
}

/**
 * Runs the updater from the native Update required screen for a site speaking [webProtocols], so
 * only an update that can open it is accepted. Check for update on this screen is the user's
 * explicit request for the app the site needs: a newer update it finds downloads at once.
 * Installation still waits for Install update and Android's confirmation. Main-thread confined.
 */
class UpdateRequiredFlow(private val updates: UpdatePort, private val webProtocols: IntRange) {
    private var checkRequested = false

    val view: UpdateRequiredView get() = UpdateRequiredView.of(updates.state)

    fun act() {
        when (view.step) {
            UpdateStep.REQUIRED -> {
                checkRequested = true
                if (!updates.check(webProtocols)) checkRequested = false
            }
            UpdateStep.INVALID -> updates.download()
            UpdateStep.READY, UpdateStep.AUTHORIZATION -> updates.install()
            else -> Unit
        }
    }

    /** Call with every updater state. */
    fun onState(state: UpdateState) {
        if (state is UpdateState.Checking) return
        val download = checkRequested && state is UpdateState.Available
        checkRequested = false
        if (download) updates.download()
    }
}
