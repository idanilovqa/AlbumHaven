package org.albumhaven.shell

import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.TextView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.core.view.isVisible

enum class RecoveryState { LOADING, ERROR, UPDATE_REQUIRED }

/** The exceptional native screen shown only while the web app cannot run. */
class RecoveryPanel(private val root: View, onRetry: () -> Unit) {
    private val loading: View = root.findViewById(R.id.recovery_loading)
    private val loadingDetail: TextView = root.findViewById(R.id.recovery_loading_detail)
    private val alert: View = root.findViewById(R.id.recovery_alert)
    private val alertIcon: ImageView = root.findViewById(R.id.recovery_alert_icon)
    private val alertTitle: TextView = root.findViewById(R.id.recovery_alert_title)
    private val alertMessage: TextView = root.findViewById(R.id.recovery_alert_message)
    private val retry: Button = root.findViewById(R.id.recovery_retry)

    init {
        retry.setOnClickListener { onRetry() }
    }

    fun show(state: RecoveryState, originHost: String) {
        root.isVisible = true
        loading.isVisible = state == RecoveryState.LOADING
        alert.isVisible = state != RecoveryState.LOADING
        when (state) {
            RecoveryState.LOADING ->
                loadingDetail.text = root.context.getString(R.string.recovery_loading_detail, originHost)
            RecoveryState.ERROR -> {
                showAlert(R.drawable.alert_error, R.drawable.ic_alert, R.string.recovery_error_title, R.string.recovery_error_message)
                retry.isVisible = true
            }
            RecoveryState.UPDATE_REQUIRED -> {
                showAlert(R.drawable.alert_warning, R.drawable.ic_alert, R.string.recovery_update_title, R.string.recovery_update_message)
                retry.isVisible = false
            }
        }
    }

    fun hide() {
        root.isVisible = false
    }

    private fun showAlert(
        @DrawableRes background: Int,
        @DrawableRes icon: Int,
        @StringRes title: Int,
        @StringRes message: Int,
    ) {
        alert.setBackgroundResource(background)
        alertIcon.setImageResource(icon)
        alertTitle.setText(title)
        alertMessage.setText(message)
    }
}
