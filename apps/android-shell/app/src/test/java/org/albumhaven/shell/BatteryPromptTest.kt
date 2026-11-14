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
    fun noThanksIsNeverOfferedAgain() {
        val store = FakeStore()
        BatteryPrompt(store).declined()
        assertTrue(store.batteryPromptAnswered)
        assertFalse(BatteryPrompt(store).shouldOffer(optimized))
    }

    @Test
    fun anyAnswerInAndroidsDialogIsFinal() {
        for (after in listOf(unrestricted, optimized)) {
            val store = FakeStore()
            assertNull(BatteryPrompt(store).returned(BatterySettings.REQUEST, after))
            assertTrue(store.batteryPromptAnswered)
            assertFalse(BatteryPrompt(store).shouldOffer(optimized))
        }
    }

    @Test
    fun allowedButStillRestrictedGoesOnToAppInfoOnce() {
        val store = FakeStore()
        val prompt = BatteryPrompt(store)
        assertEquals(BatterySettings.APP_INFO, prompt.returned(BatterySettings.REQUEST, allowedButRestricted))
        assertTrue(store.batteryPromptAnswered)
        assertNull(prompt.returned(BatterySettings.APP_INFO, allowedButRestricted))
    }

    @Test
    fun aDeniedRestrictedAppIsNotSentOnToAppInfo() {
        assertNull(BatteryPrompt(FakeStore()).returned(BatterySettings.REQUEST, restricted))
    }

    @Test
    fun samsungPhonesNameSamsungAndOthersDoNot() {
        assertEquals(R.string.battery_prompt_reason_samsung, BatteryPrompt.reason("samsung"))
        assertEquals(R.string.battery_prompt_reason_samsung, BatteryPrompt.reason("Samsung"))
        assertEquals(R.string.battery_prompt_reason, BatteryPrompt.reason("Google"))
        assertEquals(R.string.battery_prompt_reason, BatteryPrompt.reason("Xiaomi"))
    }
}
