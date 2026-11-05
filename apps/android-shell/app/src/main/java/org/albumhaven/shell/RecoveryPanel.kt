package org.albumhaven.shell

import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.view.isVisible

/** The exceptional native screen shown only while the web app is loading, unavailable or incompatible. */
class RecoveryPanel(private val root: View) {
    private val loading: View = root.findViewById(R.id.recovery_loading)
    private val loadingDetail: TextView = root.findViewById(R.id.recovery_loading_detail)
    private val alert: View = root.findViewById(R.id.recovery_alert)
    private val alertIcon: ImageView = root.findViewById(R.id.recovery_alert_icon)
    private val alertTitle: TextView = root.findViewById(R.id.recovery_alert_title)
    private val alertMessage: TextView = root.findViewById(R.id.recovery_alert_message)
    private val action: Button = root.findViewById(R.id.recovery_action)
    private val progressLabel: TextView = root.findViewById(R.id.recovery_progress_label)
    private val progress: ProgressBar = root.findViewById(R.id.recovery_progress)

    fun showLoading(originHost: String) {
        root.isVisible = true
        loading.isVisible = true
        alert.isVisible = false
        loadingDetail.text = root.context.getString(R.string.recovery_loading_detail, originHost)
    }

    fun showError(onRetry: () -> Unit) {
        showAlert(AlertSeverity.ERROR, root.context.getString(R.string.recovery_error_title), root.context.getString(R.string.recovery_error_message))
        showAction(R.string.recovery_retry, onRetry)
        showProgress(null)
    }

    /** [onAction] is null when updating this app cannot help, so the screen offers no action. */
    fun showUpdate(view: UpdateRequiredView, onAction: (() -> Unit)?) {
        val context = root.context
        val step = view.step
        // Only the download names its progress and version.
        val downloading = step == UpdateStep.DOWNLOADING
        val title = if (downloading) context.getString(step.title, view.progress ?: 0) else context.getString(step.title)
        val message = if (downloading) context.getString(step.message, view.versionName.orEmpty()) else context.getString(step.message)
        showAlert(step.severity, title, message)
        if (onAction == null) {
            action.isVisible = false
        } else {
            showAction(step.action, onAction.takeIf { step.actionable })
        }
        showProgress(view.progress.takeIf { downloading })
    }

    fun hide() {
        root.isVisible = false
    }

    private fun showAlert(severity: AlertSeverity, title: String, message: String) {
        root.isVisible = true
        loading.isVisible = false
        alert.isVisible = true
        alert.setBackgroundResource(severity.background)
        alertIcon.setImageResource(severity.icon)
        alertTitle.text = title
        alertMessage.text = message
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

/** Approved Android native recovery v002, plus the approved Settings authorization and installing copy. */
enum class UpdateStep(
    val severity: AlertSeverity,
    @StringRes val title: Int,
    @StringRes val message: Int,
    @StringRes val action: Int,
    val actionable: Boolean,
) {
    REQUIRED(AlertSeverity.WARNING, R.string.recovery_update_title, R.string.recovery_update_message, R.string.recovery_update_check, true),
    CHECKING(AlertSeverity.INFO, R.string.recovery_update_checking_title, R.string.recovery_update_checking_message, R.string.recovery_update_checking_action, false),
    DOWNLOADING(AlertSeverity.INFO, R.string.recovery_update_downloading_title, R.string.recovery_update_downloading_message, R.string.recovery_update_downloading_action, false),
    READY(AlertSeverity.SUCCESS, R.string.recovery_update_ready_title, R.string.recovery_update_ready_message, R.string.recovery_update_install, true),
    INSTALLING(AlertSeverity.SUCCESS, R.string.recovery_update_ready_title, R.string.recovery_update_ready_message, R.string.recovery_update_installing_action, true),
    AUTHORIZATION(AlertSeverity.WARNING, R.string.recovery_update_authorization_title, R.string.recovery_update_authorization_message, R.string.recovery_update_authorization_action, true),
    INVALID(AlertSeverity.ERROR, R.string.recovery_update_invalid_title, R.string.recovery_update_invalid_message, R.string.recovery_update_retry_download, true),
}
