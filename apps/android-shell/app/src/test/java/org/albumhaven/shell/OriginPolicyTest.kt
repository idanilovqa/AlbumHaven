package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    private val stable = OriginPolicy(ShellChannel.STABLE)
    private val sandbox = OriginPolicy(ShellChannel.SANDBOX)

    @Test
    fun stableAllowsOnlyProductionOrigin() {
        assertEquals(setOf("https://albumhaven.org"), stable.allowedOrigins)
        assertEquals("https://albumhaven.org", stable.initialOrigin(selectedSlot = 7))
    }

    @Test
    fun sandboxAllowsExactlyNinetyNineSlots() {
        assertEquals(99, sandbox.allowedOrigins.size)
        assertTrue("https://sandbox1.albumhaven.org" in sandbox.allowedOrigins)
        assertTrue("https://sandbox99.albumhaven.org" in sandbox.allowedOrigins)
        assertFalse("https://sandbox100.albumhaven.org" in sandbox.allowedOrigins)
        assertFalse("https://albumhaven.org" in sandbox.allowedOrigins)
        assertEquals("https://sandbox7.albumhaven.org", sandbox.initialOrigin(selectedSlot = 7))
    }

    @Test(expected = IllegalArgumentException::class)
    fun sandboxOriginRejectsUnknownSlot() {
        OriginPolicy.sandboxOrigin(0)
    }

    @Test
    fun devOriginIsOnlyAddedWhenConfigured() {
        val dev = OriginPolicy(ShellChannel.STABLE, "http://10.0.2.2:5000")
        assertEquals("http://10.0.2.2:5000", dev.initialOrigin(selectedSlot = 2))
        assertEquals(NavigationDecision.LOAD, dev.classify("http://10.0.2.2:5000/login", "http://10.0.2.2:5000"))
    }

    @Test
    fun sameOriginLoadsInWebView() {
        val origin = OriginPolicy.STABLE_ORIGIN
        listOf(
            "https://albumhaven.org",
            "https://albumhaven.org/",
            "https://ALBUMHAVEN.org/album/1?x=1#y",
            "https://albumhaven.org:443/login",
        ).forEach { assertEquals(it, NavigationDecision.LOAD, stable.classify(it, origin)) }
    }

    @Test
    fun otherWebOriginsOpenExternally() {
        val origin = OriginPolicy.STABLE_ORIGIN
        listOf(
            "http://albumhaven.org/",
            "https://albumhaven.org:8443/",
            "https://www.albumhaven.org/",
            "https://albumhaven.org.example.com/",
            "https://sandbox2.albumhaven.org/",
            "https://last.fm/user/x",
            "mailto:owner@example.com",
        ).forEach { assertEquals(it, NavigationDecision.OPEN_EXTERNALLY, stable.classify(it, origin)) }
    }

    @Test
    fun sandboxTreatsUnselectedSlotAsExternal() {
        assertEquals(
            NavigationDecision.OPEN_EXTERNALLY,
            sandbox.classify("https://sandbox3.albumhaven.org/", "https://sandbox2.albumhaven.org"),
        )
    }

    @Test
    fun dangerousOrDeceptiveUrlsAreBlocked() {
        val origin = OriginPolicy.STABLE_ORIGIN
        listOf(
            "javascript:alert(1)",
            "file:///data/data/org.albumhaven.app/shared_prefs/shell.xml",
            "content://downloads/1",
            "intent://scan/#Intent;scheme=zxing;end",
            "data:text/html,hello",
            "about:blank",
            "https://albumhaven.org@evil.example/",
            "https://user:pass@albumhaven.org/",
            "https://albumhaven.org\\@evil.example/",
            "not a url",
            "",
        ).forEach { assertEquals(it, NavigationDecision.BLOCK, stable.classify(it, origin)) }
    }
}
