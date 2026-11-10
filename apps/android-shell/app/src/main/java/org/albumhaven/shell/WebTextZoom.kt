package org.albumhaven.shell

import kotlin.math.roundToInt

/** The WebView text zoom that matches Chrome on the same device: the system font scale as a percentage. */
internal fun webTextZoom(fontScale: Float): Int =
    if (fontScale.isFinite() && fontScale > 0f) (fontScale * 100f).roundToInt() else 100
