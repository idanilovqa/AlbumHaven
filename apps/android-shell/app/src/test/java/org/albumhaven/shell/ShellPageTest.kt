package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val ORIGIN = "https://sandbox4.albumhaven.org"

class ShellPageTest {
    private val page = ShellPage(OriginPolicy(ShellChannel.SANDBOX))

    @Test
    fun aLongSessionKeepsOnlyItsLatestUrlWithinAFewKilobytes() {
        repeat(10_000) { page.visited("$ORIGIN/?artist=Artist%20$it&mobile_page=album&mobile_album=$it", ORIGIN) }
        val latest = "$ORIGIN/?artist=Artist%209999&mobile_page=album&mobile_album=9999"
        assertEquals(latest, page.url)
        // Everything the Activity saves: two strings, written to a parcel as UTF-16.
        assertTrue((ORIGIN.length + page.url!!.length) * 2 < 8 * 1024)
    }

    @Test
    fun anOverlongOrForeignUrlIsNeverKept() {
        page.visited("$ORIGIN/?q=" + "x".repeat(ShellPage.MAX_URL_LENGTH), ORIGIN)
        assertNull(page.url)
        page.visited("https://sandbox5.albumhaven.org/?artist=A", ORIGIN)
        assertNull(page.url)
        page.visited("about:blank", ORIGIN)
        assertNull(page.url)
        page.visited(null, ORIGIN)
        assertNull(page.url)
    }

    @Test
    fun restoreReopensTheSavedPageOfTheSameOrigin() {
        val saved = "$ORIGIN/?artist=A&mobile_page=album&mobile_album=7"
        assertEquals(saved, page.restore(ORIGIN, saved, ORIGIN))
        // Saved again unchanged if the Activity stops before the page loads.
        assertEquals(saved, page.url)
    }

    @Test
    fun restoreFallsBackToTheSiteRoot() {
        assertEquals(ORIGIN, page.restore(null, null, ORIGIN))
        assertEquals(ORIGIN, page.restore(ORIGIN, null, ORIGIN))
        // A page of the sandbox the app used before the switch.
        assertEquals(ORIGIN, page.restore("https://sandbox5.albumhaven.org", "https://sandbox5.albumhaven.org/?q=a", ORIGIN))
        assertEquals(ORIGIN, page.restore(ORIGIN, "https://evil.example/", ORIGIN))
        assertEquals(ORIGIN, page.restore(ORIGIN, "$ORIGIN/?q=" + "x".repeat(ShellPage.MAX_URL_LENGTH), ORIGIN))
        assertNull(page.url)
    }
}
