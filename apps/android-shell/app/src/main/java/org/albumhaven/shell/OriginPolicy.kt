package org.albumhaven.shell

import java.net.URI
import java.net.URISyntaxException

enum class ShellChannel(val wireName: String) {
    STABLE("stable"),
    SANDBOX("sandbox");

    companion object {
        fun fromWireName(name: String): ShellChannel = entries.first { it.wireName == name }
    }
}

enum class NavigationDecision { LOAD, OPEN_EXTERNALLY, BLOCK }

/** Owns the exact origins each channel may display. Nothing here trusts page-supplied values. */
class OriginPolicy(private val channel: ShellChannel, private val devOrigin: String = "") {

    val allowedOrigins: Set<String> = buildSet {
        when (channel) {
            ShellChannel.STABLE -> add(STABLE_ORIGIN)
            ShellChannel.SANDBOX -> SANDBOX_SLOTS.forEach { add(sandboxOrigin(it)) }
        }
        if (devOrigin.isNotEmpty()) add(devOrigin)
    }

    fun initialOrigin(selectedSlot: Int): String = when {
        devOrigin.isNotEmpty() -> devOrigin
        channel == ShellChannel.STABLE -> STABLE_ORIGIN
        else -> sandboxOrigin(selectedSlot)
    }

    fun classify(url: String, selectedOrigin: String): NavigationDecision {
        val uri = parse(url) ?: return NavigationDecision.BLOCK
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

    private fun parse(url: String): URI? = try {
        URI(url)
    } catch (_: URISyntaxException) {
        null
    }

    private fun originOf(uri: URI): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val defaultPort = if (scheme == "https") 443 else 80
        val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
        return "$scheme://$host$port"
    }

    companion object {
        const val STABLE_ORIGIN = "https://albumhaven.org"
        const val DEFAULT_SANDBOX_SLOT = 2
        val SANDBOX_SLOTS = 1..99
        private val WEB_SCHEMES = setOf("http", "https")

        fun sandboxOrigin(slot: Int): String {
            require(slot in SANDBOX_SLOTS) { "Unknown sandbox slot" }
            return "https://sandbox$slot.albumhaven.org"
        }
    }
}
