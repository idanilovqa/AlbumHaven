package org.albumhaven.shell

import android.view.KeyEvent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged

/**
 * The exceptional native screen shown only while the web app is loading, unavailable or
 * incompatible, or while a sandbox build waits for its sandbox to be chosen. A null
 * `onSwitchSandbox` leaves Switch sandbox out, as on a stable build.
 */
class RecoveryPanel(private val root: View) {
    private val loading: View = root.findViewById(R.id.recovery_loading)
    private val loadingDetail: TextView = root.findViewById(R.id.recovery_loading_detail)
    private val loadingSwitch: Button = root.findViewById(R.id.recovery_loading_switch)
    private val choice: View = root.findViewById(R.id.sandbox_choice)
    private val choiceSlots: ViewGroup = root.findViewById(R.id.sandbox_choice_slots)
    private val otherSlot: EditText = root.findViewById(R.id.sandbox_choice_other)
    private val connect: Button = root.findViewById(R.id.sandbox_choice_connect)
    private val choiceMessage: TextView = root.findViewById(R.id.sandbox_choice_message)
    private val alert: View = root.findViewById(R.id.recovery_alert)
    private val alertIcon: ImageView = root.findViewById(R.id.recovery_alert_icon)
    private val alertTitle: TextView = root.findViewById(R.id.recovery_alert_title)
    private val alertMessage: TextView = root.findViewById(R.id.recovery_alert_message)
    private val action: Button = root.findViewById(R.id.recovery_action)
    private val alertSwitch: Button = root.findViewById(R.id.recovery_switch)
    private val progressLabel: TextView = root.findViewById(R.id.recovery_progress_label)
    private val progress: ProgressBar = root.findViewById(R.id.recovery_progress)
    private var onChooseSandbox: ((Int) -> Unit)? = null

    init {
        val context = root.context
        SandboxChoice.LISTED_SLOTS.forEach { slot ->
            val button = LayoutInflater.from(context).inflate(R.layout.sandbox_choice_slot, choiceSlots, false) as Button
            button.text = context.getString(R.string.sandbox_choice_slot, slot)
            button.setOnClickListener { onChooseSandbox?.invoke(slot) }
            choiceSlots.addView(button)
        }
        otherSlot.doAfterTextChanged {
            val slot = typedSlot()
            connect.isEnabled = slot != null
            // Names the sandbox Connect opens; the last valid number stays shown while typing.
            if (slot != null) choiceMessage.text = root.context.getString(R.string.sandbox_choice_message, slot)
        }
        connect.setOnClickListener { typedSlot()?.let { onChooseSandbox?.invoke(it) } }
        otherSlot.setOnEditorActionListener { _, actionId, event ->
            val go = actionId == EditorInfo.IME_ACTION_GO || event?.keyCode == KeyEvent.KEYCODE_ENTER
            if (go) typedSlot()?.let { onChooseSandbox?.invoke(it) }
            go
        }
    }

    private fun typedSlot(): Int? = SandboxChoice.parseSlot(otherSlot.text.toString())

    /** Whether the sandbox chooser is up, which a loading page must not replace. */
    val choosingSandbox: Boolean get() = root.isVisible && choice.isVisible

    /** Whether any native screen covers the page. */
    val showing: Boolean get() = root.isVisible

    fun showLoading(originHost: String, onSwitchSandbox: (() -> Unit)?) {
        show(loading)
        loadingDetail.text = root.context.getString(R.string.recovery_loading_detail, originHost)
        showSwitch(loadingSwitch, onSwitchSandbox)
    }

    fun showError(onRetry: () -> Unit, onSwitchSandbox: (() -> Unit)?) {
        showAlert(AlertSeverity.ERROR, root.context.getString(R.string.recovery_error_title), root.context.getString(R.string.recovery_error_message))
        showAction(R.string.recovery_retry, onRetry)
        showSwitch(alertSwitch, onSwitchSandbox)
        showProgress(null)
    }

    /** Buttons for [SandboxChoice.LISTED_SLOTS], and any other slot in 1..99 typed in, prefilled with [initialSlot]. */
    fun showSandboxChoice(initialSlot: Int, onChoose: (slot: Int) -> Unit) {
        show(choice)
        onChooseSandbox = onChoose
        choiceMessage.text = root.context.getString(R.string.sandbox_choice_message, initialSlot)
        otherSlot.setText(initialSlot.toString())
    }

    /** [onAction] is null when updating this app cannot help, so the screen offers no action. */
    fun showUpdate(view: UpdateRequiredView, onAction: (() -> Unit)?) {
        val context = root.context
        val step = view.step
        // Only the download names its progress; it and its verification name the version.
        val downloading = step == UpdateStep.DOWNLOADING
        val title = if (downloading) context.getString(step.title, view.progress ?: 0) else context.getString(step.title)
        val message = step.message?.let { context.getString(it, view.versionName.orEmpty()) }
        showAlert(step.severity, title, message)
        if (onAction == null) {
            action.isVisible = false
        } else {
            showAction(step.action, onAction.takeIf { step.actionable })
        }
        alertSwitch.isVisible = false
        showProgress(view.progress.takeIf { downloading })
    }

    fun hide() {
        root.isVisible = false
    }

    /** A null [message] leaves the title alone in the alert. */
    private fun showAlert(severity: AlertSeverity, title: String, message: String?) {
        show(alert)
        alert.setBackgroundResource(severity.background)
        alertIcon.setImageResource(severity.icon)
        alertTitle.text = title
        alertMessage.isVisible = message != null
        alertMessage.text = message
    }

    /** Shows one of the screen's three sections: loading, an alert, or the sandbox chooser. */
    private fun show(section: View) {
        root.isVisible = true
        loading.isVisible = section === loading
        alert.isVisible = section === alert
        choice.isVisible = section === choice
    }

    private fun showSwitch(button: Button, onClick: (() -> Unit)?) {
        button.isVisible = onClick != null
        button.setOnClickListener(onClick?.let { click -> View.OnClickListener { click() } })
    }

    /** A null [onClick] shows the step's busy label on a disabled button. */
    private fun showAction(@StringRes label: Int, onClick: (() -> Unit)?) {
        action.isVisible = true
        action.setText(label)
        action.isEnabled = onClick != null
        action.setOnClickListener(onClick?.let { click -> View.OnClickListener { click() } })
    }

    private fun showProgress(percent: Int?) {
        progressLabel.isVisible = percent != null
        progress.isVisible = percent != null
        if (percent == null) return
        progressLabel.text = root.context.getString(R.string.recovery_update_progress, percent)
        progress.progress = percent
    }
}

enum class AlertSeverity(@DrawableRes val background: Int, @DrawableRes val icon: Int) {
    INFO(R.drawable.alert_info, R.drawable.ic_alert_info),
    SUCCESS(R.drawable.alert_success, R.drawable.ic_alert_success),
    WARNING(R.drawable.alert_warning, R.drawable.ic_alert),
    ERROR(R.drawable.alert_error, R.drawable.ic_alert),
}

/**
 * Approved Android native recovery v002, plus the approved Settings authorization and installing
 * copy, the owner's November 5, 2026 no-update, verifying and failure decisions, and the
 * available step that waits for Download update. A null [message] shows the title alone.
 */
enum class UpdateStep(
    val severity: AlertSeverity,
    @StringRes val title: Int,
    @StringRes val message: Int?,
    @StringRes val action: Int,
    val actionable: Boolean,
) {
    REQUIRED(AlertSeverity.WARNING, R.string.recovery_update_title, R.string.recovery_update_message, R.string.recovery_update_check, true),
    NO_UPDATE(AlertSeverity.INFO, R.string.recovery_update_none_title, R.string.recovery_update_message, R.string.recovery_update_check, true),
    AVAILABLE(AlertSeverity.WARNING, R.string.recovery_update_available_title, R.string.recovery_update_downloading_message, R.string.recovery_update_download, true),
    CHECKING(AlertSeverity.INFO, R.string.recovery_update_checking_title, R.string.recovery_update_checking_message, R.string.recovery_update_checking_action, false),
    DOWNLOADING(AlertSeverity.INFO, R.string.recovery_update_downloading_title, R.string.recovery_update_downloading_message, R.string.recovery_update_downloading_action, false),
    VERIFYING(AlertSeverity.INFO, R.string.recovery_update_verifying_title, R.string.recovery_update_downloading_message, R.string.recovery_update_verifying_action, false),
    READY(AlertSeverity.SUCCESS, R.string.recovery_update_ready_title, R.string.recovery_update_ready_message, R.string.recovery_update_install, true),
    INSTALLING(AlertSeverity.SUCCESS, R.string.recovery_update_ready_title, R.string.recovery_update_ready_message, R.string.recovery_update_installing_action, true),
    AUTHORIZATION(AlertSeverity.WARNING, R.string.recovery_update_authorization_title, R.string.recovery_update_authorization_message, R.string.recovery_update_authorization_action, true),
    FAILED(AlertSeverity.ERROR, R.string.recovery_update_failed_title, null, R.string.recovery_retry, true),
}
