package org.albumhaven.shell

import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.webkit.CookieManager
import okhttp3.OkHttpClient
import org.albumhaven.shell.net.ShellSession
import org.albumhaven.shell.playback.PlaybackHost

/** Gives the playback service, which System UI may start without the Activity, the shell's origin, session and app. */
class ShellApplication : Application(), PlaybackHost {
    /** One connection pool for playback and updates. */
    override val client: OkHttpClient by lazy { ShellSession.client() }

    override fun initialOrigin(): String = ShellPreferences(this).selectedOrigin

    override fun cookies(url: String): String? = CookieManager.getInstance().getCookie(url)

    override fun sessionActivity(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, ShellActivity::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}
