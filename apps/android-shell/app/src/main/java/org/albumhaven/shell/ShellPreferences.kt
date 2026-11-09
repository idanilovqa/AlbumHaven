package org.albumhaven.shell

import android.content.Context
import androidx.core.content.edit

/** Non-secret shell selection; survives app updates and process death. */
class ShellPreferences(context: Context) : SandboxSlots {
    private val preferences = context.getSharedPreferences("shell", Context.MODE_PRIVATE)

    override val selectedSandboxSlot: Int?
        get() = preferences.getInt(KEY_SLOT, 0).takeIf { it in OriginPolicy.SANDBOX_SLOTS }

    override fun chooseSandbox(slot: Int) = preferences.edit { putInt(KEY_SLOT, slot) }

    /** Settings' switch, once its probe connected; the next handshake reports it once. */
    fun switchSandbox(slot: Int) = preferences.edit { putInt(KEY_SLOT, slot).putInt(KEY_CONNECTED, slot) }

    /** The origin this build opens: its development origin, albumhaven.org, or the chosen sandbox; null before that choice. */
    val selectedOrigin: String? get() = OriginPolicy.forBuild.initialOrigin(selectedSandboxSlot)

    /** One-shot: reports the switch to the first page that handshakes after it. */
    fun takeConnectedSandboxSlot(): Int? {
        val slot = preferences.getInt(KEY_CONNECTED, 0).takeIf { it != 0 }
        if (slot != null) preferences.edit { remove(KEY_CONNECTED) }
        return slot
    }

    /** The page Update was pressed on, kept across the package replacement. */
    fun keepUpdatePage(url: String) = preferences.edit(commit = true) { putString(KEY_UPDATE_PAGE, url) }

    val hasUpdatePage: Boolean get() = preferences.contains(KEY_UPDATE_PAGE)

    /** One-shot: the updated app's first launch opens it. */
    fun takeUpdatePage(): String? {
        val url = preferences.getString(KEY_UPDATE_PAGE, null) ?: return null
        preferences.edit { remove(KEY_UPDATE_PAGE) }
        return url
    }

    private companion object {
        const val KEY_UPDATE_PAGE = "update_page"
        const val KEY_SLOT = "selected_sandbox_slot"
        const val KEY_CONNECTED = "connected_sandbox_slot"
    }
}
