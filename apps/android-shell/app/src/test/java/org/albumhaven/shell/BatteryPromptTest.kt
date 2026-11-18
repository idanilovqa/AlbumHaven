package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BatteryPromptTest {
    private class FakeStore : BatteryPromptStore {
        override var batteryPromptAnswered = false
        override fun answerBatteryPrompt() {
            batteryPromptAnswered = true
        }
    }

    private val optimized = BatteryState(ignoringOptimizations = false, backgroundRestricted = false)
    private val unrestricted = BatteryState(ignoringOptimizations = true, backgroundRestricted = false)
    private val restricted = BatteryState(ignoringOptimizations = false, backgroundRestricted = true)
    private val allowedButRestricted = BatteryState(ignoringOptimizations = true, backgroundRestricted = true)

    @Test
    fun anUnansweredPhoneThatBatterySavingCanCloseIsOffered() {
        val prompt = BatteryPrompt(FakeStore())
        assertTrue(prompt.shouldOffer(optimized))
        assertTrue(prompt.shouldOffer(restricted))
        assertTrue(prompt.shouldOffer(allowedButRestricted))
    }

    @Test
    fun anAlreadyUnrestrictedAppIsNeverOfferedAndNothingIsRecorded() {
        val store = FakeStore()
        assertFalse(BatteryPrompt(store).shouldOffer(unrestricted))
        assertFalse(store.batteryPromptAnswered)
    }

    @Test
    fun showingTheOfferIsNotAnAnswer() {
        val store = FakeStore()
        val prompt = BatteryPrompt(store)
        assertTrue(prompt.shouldOffer(optimized))
        // The app was closed with the offer on screen: the next library view offers it again.
        assertTrue(BatteryPrompt(store).shouldOffer(optimized))
    }

    @Test
    fun eitherButtonIsAFinalAnswerFromTheTap() {
        val store = FakeStore()
        // Saved before any Settings screen opens, so the app ending under it changes nothing.
        BatteryPrompt(store).answered()
        assertTrue(store.batteryPromptAnswered)
        assertFalse(BatteryPrompt(store).shouldOffer(optimized))
        assertFalse(BatteryPrompt(store).shouldOffer(restricted))
    }

    @Test
    fun onlyAllowedButStillRestrictedGoesOnToAppInfo() {
        assertEquals(BatterySettings.APP_INFO, BatteryPrompt.followUp(BatterySettings.REQUEST, allowedButRestricted))
        assertNull(BatteryPrompt.followUp(BatterySettings.REQUEST, unrestricted))
        assertNull(BatteryPrompt.followUp(BatterySettings.REQUEST, optimized))
        // Denied: never sent on.
        assertNull(BatteryPrompt.followUp(BatterySettings.REQUEST, restricted))
        // App info itself leads nowhere further, whatever was chosen there.
        assertNull(BatteryPrompt.followUp(BatterySettings.APP_INFO, allowedButRestricted))
    }

    @Test
    fun samsungPhonesNameSamsungAndOthersDoNot() {
        assertEquals(R.string.battery_prompt_reason_samsung, BatteryPrompt.reason("samsung"))
        assertEquals(R.string.battery_prompt_reason_samsung, BatteryPrompt.reason("Samsung"))
        assertEquals(R.string.battery_prompt_reason, BatteryPrompt.reason("Google"))
        assertEquals(R.string.battery_prompt_reason, BatteryPrompt.reason("Xiaomi"))
    }
}
