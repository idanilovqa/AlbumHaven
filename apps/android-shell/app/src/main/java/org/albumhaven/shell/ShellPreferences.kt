package org.albumhaven.shell

import android.content.Context
import androidx.core.content.edit

/** Non-secret shell selection; survives app updates and process death. */
class ShellPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("shell", Context.MODE_PRIVATE)

    var selectedSandboxSlot: Int
        get() = preferences.getInt(KEY_SLOT, OriginPolicy.DEFAULT_SANDBOX_SLOT)
            .takeIf { it in OriginPolicy.SANDBOX_SLOTS } ?: OriginPolicy.DEFAULT_SANDBOX_SLOT
        set(slot) = preferences.edit { putInt(KEY_SLOT, slot).putInt(KEY_CONNECTED, slot) }

    /** One-shot: reports the switch to the first page that handshakes after it. */
    fun takeConnectedSandboxSlot(): Int? {
        val slot = preferences.getInt(KEY_CONNECTED, 0).takeIf { it != 0 }
        if (slot != null) preferences.edit { remove(KEY_CONNECTED) }
        return slot
    }

    private companion object {
        const val KEY_SLOT = "selected_sandbox_slot"
        const val KEY_CONNECTED = "connected_sandbox_slot"
    }
}
