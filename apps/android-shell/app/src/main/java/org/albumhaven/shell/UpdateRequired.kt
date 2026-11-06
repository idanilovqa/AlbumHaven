package org.albumhaven.shell

import org.albumhaven.shell.updates.UpdateState

/** What the native Update required screen shows; [progress] belongs to the download, [versionName] to it and its verification. */
data class UpdateRequiredView(val step: UpdateStep, val progress: Int? = null, val versionName: String? = null) {
    companion object {
        fun of(state: UpdateState): UpdateRequiredView = when (state) {
            // An update found without asking waits for Check for update, which downloads it.
            is UpdateState.Idle, is UpdateState.Available -> UpdateRequiredView(UpdateStep.REQUIRED)
            is UpdateState.UpToDate -> UpdateRequiredView(UpdateStep.NO_UPDATE)
            is UpdateState.Checking -> UpdateRequiredView(UpdateStep.CHECKING)
            is UpdateState.Downloading ->
                UpdateRequiredView(UpdateStep.DOWNLOADING, state.percent, state.manifest.versionName)
            is UpdateState.Verifying -> UpdateRequiredView(UpdateStep.VERIFYING, versionName = state.manifest.versionName)
            is UpdateState.Ready -> UpdateRequiredView(UpdateStep.READY)
            is UpdateState.Installing -> UpdateRequiredView(UpdateStep.INSTALLING)
            is UpdateState.Authorization -> UpdateRequiredView(UpdateStep.AUTHORIZATION)
            // Every failure reads the same; the shell logs its error and reason.
            is UpdateState.Failed -> UpdateRequiredView(UpdateStep.FAILED)
        }
    }
}

/**
 * Runs the updater from the native Update required screen for a site speaking [webProtocols], so
 * only an update that can open it is accepted. Check for update on this screen is the user's
 * explicit request for the app the site needs: a newer update it finds downloads at once.
 * Installation still waits for Update and Android's confirmation. Main-thread confined.
 */
class UpdateRequiredFlow(private val updates: UpdatePort, private val webProtocols: IntRange) {
    private var checkRequested = false

    /** Until the user acts here, a result left by an earlier request from Settings is not this screen's answer. */
    private var acted = false

    val view: UpdateRequiredView
        get() = updates.state.let { state ->
            if (!acted && (state is UpdateState.UpToDate || state is UpdateState.Failed)) {
                UpdateRequiredView(UpdateStep.REQUIRED)
            } else {
                UpdateRequiredView.of(state)
            }
        }

    fun act() {
        val step = view.step
        if (!step.actionable) return
        acted = true
        when (step) {
            UpdateStep.REQUIRED, UpdateStep.NO_UPDATE -> check()
            // A failure that kept its update downloads it again; any other checks again.
            UpdateStep.FAILED -> if ((updates.state as UpdateState.Failed).manifest != null) updates.download() else check()
            // While installing, Update shows a confirmation the user left unanswered again.
            UpdateStep.READY, UpdateStep.INSTALLING, UpdateStep.AUTHORIZATION -> updates.install()
            else -> Unit
        }
    }

    private fun check() {
        checkRequested = true
        if (!updates.check(webProtocols)) checkRequested = false
    }

    /** Call with every updater state. */
    fun onState(state: UpdateState) {
        if (state is UpdateState.Checking) return
        val download = checkRequested && state is UpdateState.Available
        checkRequested = false
        if (download) updates.download()
    }
}
