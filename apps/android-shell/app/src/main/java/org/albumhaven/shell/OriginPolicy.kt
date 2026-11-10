package org.albumhaven.shell

import org.albumhaven.shell.net.originOf
import org.albumhaven.shell.net.parseUri

enum class ShellChannel(val wireName: String) {
    STABLE("stable"),
    SANDBOX("sandbox");

    companion object {
        fun fromWireName(name: String): ShellChannel = entries.first { it.wireName == name }

        /**
         * The sandbox build logs playback stops at warning level and lets its page be inspected over
         * USB, so a stop nobody asked for can be traced on the owner's phone (November 7, 2026).
         */
        val tracesPlayback: Boolean get() = BuildConfig.CHANNEL == SANDBOX.wireName
    }
}

enum class NavigationDecision { LOAD, OPEN_EXTERNALLY, BLOCK }

/** Owns the exact origins each channel may display. Nothing here trusts page-supplied values. */
class OriginPolicy(val channel: ShellChannel, private val devOrigin: String = "") {

    val allowedOrigins: Set<String> = buildSet {
        when (channel) {
            ShellChannel.STABLE -> add(STABLE_ORIGIN)
            ShellChannel.SANDBOX -> SANDBOX_SLOTS.forEach { add(sandboxOrigin(it)) }
        }
        if (devOrigin.isNotEmpty()) add(devOrigin)
    }

    /** Null on a sandbox build until a sandbox is chosen: no slot is assumed. */
    fun initialOrigin(selectedSlot: Int?): String? = when {
        devOrigin.isNotEmpty() -> devOrigin
        channel == ShellChannel.STABLE -> STABLE_ORIGIN
        else -> selectedSlot?.let(::sandboxOrigin)
    }

    fun classify(url: String, selectedOrigin: String): NavigationDecision {
        val uri = parseUri(url) ?: return NavigationDecision.BLOCK
        return when {
            uri.scheme.equals("mailto", ignoreCase = true) -> NavigationDecision.OPEN_EXTERNALLY
            uri.scheme?.lowercase() !in WEB_SCHEMES || uri.rawUserInfo != null -> NavigationDecision.BLOCK
            originOf(uri) == selectedOrigin -> NavigationDecision.LOAD
            uri.host == null -> NavigationDecision.BLOCK
            else -> NavigationDecision.OPEN_EXTERNALLY
        }
    }

    fun isSameOrigin(url: String, selectedOrigin: String): Boolean =
        classify(url, selectedOrigin) == NavigationDecision.LOAD

    companion object {
        /** This build's channel and development origin. */
        val forBuild by lazy { OriginPolicy(ShellChannel.fromWireName(BuildConfig.CHANNEL), BuildConfig.DEV_ORIGIN) }

        const val STABLE_ORIGIN = "https://albumhaven.org"
        val SANDBOX_SLOTS = 1..99
        private val WEB_SCHEMES = setOf("http", "https")

        fun sandboxOrigin(slot: Int): String {
            require(slot in SANDBOX_SLOTS) { "Unknown sandbox slot" }
            return "https://sandbox$slot.albumhaven.org"
        }
    }
}
