package org.albumhaven.shell

import org.albumhaven.shell.net.parseUri

/** Where a sandbox build keeps its chosen slot across launches; [ShellPreferences] in the app. */
interface SandboxSlots {
    /** Null until a sandbox is chosen. */
    val selectedSandboxSlot: Int?
    fun chooseSandbox(slot: Int)
}

/**
 * A sandbox build's choice of server: asked for on first launch, before any site loads, and again
 * from Switch sandbox on the native Connecting, error and unsupported-sandbox screens.
 */
class SandboxChoice(private val policy: OriginPolicy, private val slots: SandboxSlots) {
    /** Only a sandbox build offers Switch sandbox. */
    val offered: Boolean get() = policy.channel == ShellChannel.SANDBOX

    /** The origin to open, or null while a sandbox must be chosen first. */
    val origin: String? get() = policy.initialOrigin(slots.selectedSandboxSlot)

    /** Keeps [slot] for later launches and returns its origin; null for no sandbox build or slot. */
    fun choose(slot: Int): String? {
        if (!offered || slot !in OriginPolicy.SANDBOX_SLOTS) return null
        slots.chooseSandbox(slot)
        return OriginPolicy.sandboxOrigin(slot)
    }

    companion object {
        /** The slots the chooser offers as buttons; any other is typed. */
        val LISTED_SLOTS = 1..5

        /** Prefilled when no sandbox was chosen before: the sandbox that hosts Android work. */
        const val SUGGESTED_SLOT = 5

        /** The typed slot, or null for anything but a whole number in 1..99. */
        fun parseSlot(text: String): Int? =
            text.trim().takeIf { it.all(Char::isDigit) }?.toIntOrNull()?.takeIf { it in OriginPolicy.SANDBOX_SLOTS }
    }
}

/**
 * Notices, on a sandbox build, a sandbox whose site does not support the Android app: its app
 * document finished loading but never completed the bridge handshake within the bridge timeout.
 * Only the app document at `/` runs the bridge; sign-in and account pages never handshake.
 */
class HandshakeWatch(private val channel: ShellChannel) {
    private var answered = false
    private var watching = false

    fun pageStarted() {
        answered = false
        watching = false
    }

    /** The handshake succeeded, or was refused with the Update required screen. */
    fun answered() {
        answered = true
        watching = false
    }

    /** The main-frame document at [url] loaded; true starts the timeout. */
    fun pageFinished(url: String): Boolean {
        watching = channel == ShellChannel.SANDBOX && !answered && parseUri(url)?.path in APP_DOCUMENT_PATHS
        return watching
    }

    /** The timeout ran out; true shows the warning. */
    fun timedOut(): Boolean = watching.also { watching = false }

    private companion object {
        val APP_DOCUMENT_PATHS = setOf("", "/")
    }
}
