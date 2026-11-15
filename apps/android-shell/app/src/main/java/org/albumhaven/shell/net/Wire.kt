package org.albumhaven.shell.net

import java.net.URI
import java.net.URISyntaxException

fun parseUri(value: String): URI? = try {
    URI(value)
} catch (_: URISyntaxException) {
    null
}

/** `scheme://host[:port]` of an http(s) [uri] with the default port omitted, lowercased; null for anything else. */
fun originOf(uri: URI): String? {
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "https" && scheme != "http") return null
    val host = uri.host?.lowercase() ?: return null
    val defaultPort = if (scheme == "https") 443 else 80
    val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
    return "$scheme://$host$port"
}

/** A UUID in its canonical lowercase form, as bridge message, client and device-key IDs are. */
fun isCanonicalUuid(value: String): Boolean = UUID_FORMAT.matches(value)

private val UUID_FORMAT = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
