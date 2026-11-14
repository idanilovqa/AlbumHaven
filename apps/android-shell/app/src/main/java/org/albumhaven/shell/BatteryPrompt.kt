package org.albumhaven.shell

import androidx.annotation.StringRes

/** Whether the battery offer was answered; survives app updates and process death. */
interface BatteryPromptStore {
    val batteryPromptAnswered: Boolean
    fun answerBatteryPrompt()
}

/** What Android lets this app do in the background. */
data class BatteryState(val ignoringOptimizations: Boolean, val backgroundRestricted: Boolean) {
    /** What Settings → Apps → Battery calls Unrestricted. */
    val unrestricted: Boolean get() = ignoringOptimizations && !backgroundRestricted
}

/** Where the offer sends the user: Android's own one-tap question, or App info's Battery choice. */
enum class BatterySettings { REQUEST, APP_INFO }

/**
 * The library's one offer to set Battery to Unrestricted, so battery saving stops closing the app in
 * the background (owner, 2026-11-14: every phone; any answer is final; an offer left unanswered,
 * as when the app is closed under it, comes back on the next library view).
 */
internal class BatteryPrompt(private val store: BatteryPromptStore) {

    fun shouldOffer(state: BatteryState): Boolean = !store.batteryPromptAnswered && !state.unrestricted

    fun declined() = store.answerBatteryPrompt()

    /**
     * Back from [opened], whatever was chosen there. Allowed but still Restricted, which Android's
     * question may leave on, sends the user on to App info, where Unrestricted clears both.
     */
    fun returned(opened: BatterySettings, state: BatteryState): BatterySettings? {
        store.answerBatteryPrompt()
        return BatterySettings.APP_INFO.takeIf { opened == BatterySettings.REQUEST && state.ignoringOptimizations && state.backgroundRestricted }
    }

    companion object {
        @StringRes
        fun reason(manufacturer: String): Int =
            if (manufacturer.equals("samsung", ignoreCase = true)) R.string.battery_prompt_reason_samsung else R.string.battery_prompt_reason
    }
}
