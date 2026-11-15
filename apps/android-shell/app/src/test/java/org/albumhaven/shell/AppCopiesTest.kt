package org.albumhaven.shell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val SITE = "https://sandbox9.albumhaven.org"
private const val OTHER = "https://sandbox8.albumhaven.org"

class AppCopiesTest {
    private class MemoryStore : AppCopyStore {
        val saved = mutableMapOf<String, Long>()
        val forget = mutableSetOf<String>()
        override fun copySavedAt(origin: String) = saved[origin]
        override fun keepCopy(origin: String, savedAt: Long) { saved[origin] = savedAt }
        override fun dropCopy(origin: String) { saved.remove(origin) }
        override fun forgetPending(origin: String) = origin in forget
        override fun setForgetPending(origin: String, pending: Boolean) { if (pending) forget += origin else forget -= origin }
    }

    private var clock = 1_000_000L
    private val store = MemoryStore()
    private val copies = AppCopies(store) { clock }

    @Test
    fun iar008FirstLaunchHasNoCopy() {
        assertFalse(copies.exists(SITE))
    }

    @Test
    fun aReportedCopySkipsConnectingOnlyForItsOrigin() {
        copies.reported(SITE, stored = true)
        assertTrue(copies.exists(SITE))
        assertFalse(copies.exists(OTHER))
    }

    @Test
    fun iar007ACopyOlderThanSevenDaysIsNotUsed() {
        copies.reported(SITE, stored = true)
        clock += AppCopies.MAX_AGE_MS
        assertTrue(copies.exists(SITE))
        clock += 1
        assertFalse(copies.exists(SITE))
    }

    @Test
    fun aClockSetBackIsNotTrusted() {
        copies.reported(SITE, stored = true)
        clock -= 1
        assertFalse(copies.exists(SITE))
    }

    @Test
    fun iar006SigningOutDropsTheCopy() {
        copies.reported(SITE, stored = true)
        // The sign-in page's start (ShellActivity), as the page deleted the copy on leaving.
        copies.reported(SITE, stored = false)
        assertFalse(copies.exists(SITE))
    }

    @Test
    fun iar006LeavingASandboxDropsItsCopyUntilItsPageConfirmsTheDeletion() {
        copies.reported(SITE, stored = true)
        copies.leaving(SITE)
        assertFalse(copies.exists(SITE))
        assertTrue(copies.forgetPending(SITE))

        // A page that saves again before it was told to forget is still not trusted.
        copies.reported(SITE, stored = true)
        assertFalse(copies.exists(SITE))

        copies.reported(SITE, stored = false)
        assertFalse(copies.forgetPending(SITE))
        copies.reported(SITE, stored = true)
        assertTrue(copies.exists(SITE))
    }
}
