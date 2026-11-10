package org.albumhaven.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class WebTextZoomTest {
    @Test
    fun followsTheSystemFontScaleLikeChrome() {
        assertEquals(100, webTextZoom(1.0f))
        assertEquals(115, webTextZoom(1.15f))
        assertEquals(130, webTextZoom(1.3f))
        assertEquals(85, webTextZoom(0.85f))
    }

    @Test
    fun anUnusableScaleKeepsTheDefault() {
        assertEquals(100, webTextZoom(0f))
        assertEquals(100, webTextZoom(Float.NaN))
    }
}
