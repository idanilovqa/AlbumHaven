package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SandboxChoiceTest {
    /** Stands in for the app's preferences, which outlive every launch. */
    private class FakeSlots : SandboxSlots {
        override var selectedSandboxSlot: Int? = null
        override fun chooseSandbox(slot: Int) {
            selectedSandboxSlot = slot
        }
    }

    private val slots = FakeSlots()
    private val sandbox = SandboxChoice(OriginPolicy(ShellChannel.SANDBOX), slots)

    @Test
    fun aFirstLaunchAsksForASandboxInsteadOfAssumingOne() {
        assertNull(sandbox.origin)
        assertTrue(sandbox.offered)
    }

    @Test
    fun theChosenSandboxConnectsAndOpensOnLaterLaunches() {
        assertEquals("https://sandbox5.albumhaven.org", sandbox.choose(5))
        assertEquals("https://sandbox5.albumhaven.org", SandboxChoice(OriginPolicy(ShellChannel.SANDBOX), slots).origin)
    }

    @Test
    fun switchSandboxReplacesTheEarlierChoice() {
        sandbox.choose(2)
        assertEquals("https://sandbox42.albumhaven.org", sandbox.choose(42))
        assertEquals("https://sandbox42.albumhaven.org", sandbox.origin)
    }

    @Test
    fun aSlotOutsideTheSandboxesIsNotKept() {
        sandbox.choose(3)
        assertNull(sandbox.choose(0))
        assertNull(sandbox.choose(100))
        assertEquals(3, slots.selectedSandboxSlot)
    }

    @Test
    fun stableOpensAlbumHavenAndOffersNoSandbox() {
        val stable = SandboxChoice(OriginPolicy(ShellChannel.STABLE), slots)
        assertEquals("https://albumhaven.org", stable.origin)
        assertFalse(stable.offered)
        assertNull(stable.choose(4))
        assertNull(slots.selectedSandboxSlot)
    }

    @Test
    fun aDevelopmentOriginOpensWithoutAChoice() {
        assertEquals("http://10.0.2.2:5000", SandboxChoice(OriginPolicy(ShellChannel.SANDBOX, "http://10.0.2.2:5000"), slots).origin)
    }

    @Test
    fun theChooserListsFiveSandboxesAndAcceptsAnyOtherTyped() {
        assertEquals(1..5, SandboxChoice.LISTED_SLOTS)
        assertEquals(7, SandboxChoice.parseSlot("7"))
        assertEquals(99, SandboxChoice.parseSlot(" 99 "))
        assertEquals(5, SandboxChoice.parseSlot("05"))
        listOf("", "0", "100", "-3", "+3", "2.5", "x").forEach { assertNull(it, SandboxChoice.parseSlot(it)) }
    }
}

class HandshakeWatchTest {
    private val watch = HandshakeWatch(ShellChannel.SANDBOX)

    @Test
    fun anAppDocumentThatNeverHandshakesWarns() {
        watch.pageStarted()
        assertTrue(watch.pageFinished("https://sandbox2.albumhaven.org/"))
        assertTrue(watch.timedOut())
        // Once per document.
        assertFalse(watch.timedOut())
    }

    @Test
    fun aHandshakeBeforeOrAfterTheLoadEndsTheWatch() {
        watch.pageStarted()
        watch.answered()
        assertFalse(watch.pageFinished("https://sandbox2.albumhaven.org/?artist=A"))

        watch.pageStarted()
        assertTrue(watch.pageFinished("https://sandbox2.albumhaven.org/?artist=A"))
        watch.answered()
        assertFalse(watch.timedOut())
    }

    @Test
    fun pagesWithoutTheBridgeAreNotWatched() {
        watch.pageStarted()
        assertFalse(watch.pageFinished("https://sandbox2.albumhaven.org/login"))
        assertFalse(watch.pageFinished("https://sandbox2.albumhaven.org/account"))
        assertFalse(watch.timedOut())
    }

    @Test
    fun aNewDocumentCancelsTheLastOnesTimeout() {
        watch.pageStarted()
        watch.pageFinished("https://sandbox2.albumhaven.org/")
        watch.pageStarted()
        assertFalse(watch.timedOut())
    }

    @Test
    fun stableNeverWarns() {
        val stable = HandshakeWatch(ShellChannel.STABLE)
        stable.pageStarted()
        assertFalse(stable.pageFinished("https://albumhaven.org/"))
        assertFalse(stable.timedOut())
    }
}
