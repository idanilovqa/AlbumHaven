package org.albumhaven.shell.playback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The answers the web's `noteListenWriteFailure` tells apart, read the same way on Android. */
class ListenWriteOutcomeTest {
    private fun answered(status: Int, ok: Boolean, error: String? = null, retryAfterMs: Long? = null) =
        ListenEffectResult.Answered(status, JSONObject().put("ok", ok).apply { error?.let { put("error", it) } }, retryAfterMs)

    @Test
    fun answersAreAcceptedUnavailableTransientOrRefused() {
        assertEquals(ListenWriteOutcome.Accepted, ListenWriteOutcome.of(answered(200, ok = true)))
        assertEquals(
            ListenWriteOutcome.LastfmUnavailable,
            ListenWriteOutcome.of(answered(409, ok = false, error = ListenWriteOutcome.LASTFM_UNAVAILABLE_ERROR)),
        )
        assertEquals(ListenWriteOutcome.Transient(), ListenWriteOutcome.of(ListenEffectResult.Unreachable))
        assertEquals(ListenWriteOutcome.Transient(), ListenWriteOutcome.of(answered(503, ok = false)))
        assertEquals(ListenWriteOutcome.Transient(30_000), ListenWriteOutcome.of(answered(429, ok = false, retryAfterMs = 30_000)))
        // A conflicting sequence, an invalid body, a missing claim and a refused 2xx are final.
        listOf(answered(409, ok = false, error = "conflict"), answered(400, ok = false), answered(403, ok = false), answered(200, ok = false))
            .forEach { assertEquals(ListenWriteOutcome.Refused, ListenWriteOutcome.of(it)) }
    }

    @Test
    fun retryAfterIsDelaySecondsOrAnHttpDate() {
        val now = 1_793_613_600_000L // 2026-11-02T10:00:00Z
        assertEquals(30_000L, ListenWriteOutcome.retryAfterMs("30", now))
        assertEquals(45_000L, ListenWriteOutcome.retryAfterMs("Mon, 02 Nov 2026 10:00:45 GMT", now))
        assertEquals(0L, ListenWriteOutcome.retryAfterMs("Mon, 02 Nov 2026 09:00:00 GMT", now))
        assertNull(ListenWriteOutcome.retryAfterMs(null, now))
        assertNull(ListenWriteOutcome.retryAfterMs("soon", now))
    }
}
