package org.albumhaven.shell.updates

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import org.albumhaven.shell.R
import org.albumhaven.shell.ShellActivity
import org.albumhaven.shell.ShellPreferences

/**
 * Android ends the app to replace it and may not start it again by itself. After an in-app update
 * (one that kept the page Update was pressed on), a notification opens the new version on that page.
 */
class UpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED || !ShellPreferences(context).hasUpdatePage) return
        val notifications = context.getSystemService(NotificationManager::class.java)
        if (!notifications.areNotificationsEnabled()) return
        notifications.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.update_channel_name), NotificationManager.IMPORTANCE_HIGH),
        )
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, ShellActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(androidx.media3.session.R.drawable.media3_notification_small_icon)
            .setContentTitle(context.getString(R.string.update_done_title))
            .setContentText(context.getString(R.string.update_done_message))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setTimeoutAfter(TIMEOUT_MS)
            .build()
        notifications.notify(NOTIFICATION_ID, notification)
    }

    private companion object {
        const val CHANNEL_ID = "app_updates"
        const val NOTIFICATION_ID = 7301
        const val TIMEOUT_MS = 10L * 60 * 1000
    }
}
