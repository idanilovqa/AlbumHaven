package org.albumhaven.shell

import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackPort
import org.albumhaven.shell.updates.UpdateState
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** The stable identity reported in the handshake. */
class ShellIdentity(
    val applicationId: String,
    val channel: ShellChannel,
    val versionName: String,
    val versionCode: Long,
)

/** Native operations the bridge may request. Implementations run on the main thread. */
interface BridgeHost {
    fun selectedOrigin(): String
    /** Null when a development origin was opened without a chosen sandbox. */
    fun selectedSandboxSlot(): Int?
    fun takeConnectedSandboxSlot(): Int?
    fun selectSandbox(slot: Int, onResult: (connected: Boolean) -> Unit)

    /** This app cannot run the site offering [webProtocols]: no shared protocol, or a required capability is missing. */
    fun onIncompatibleWeb(webProtocols: IntRange)
    fun onForegroundReady(token: Long)

    /** The document negotiated the bridge. */
    fun onBridgeConnected()
}

/** The APK updater as the bridge sees it (`updates.manual.v1`). Each call returns false when it does not apply now. */
interface UpdatePort {
    val state: UpdateState
    fun check(webProtocols: IntRange): Boolean
    /** Downloads the available update and, once it is verified, installs it. */
    fun download(): Boolean
    fun install(): Boolean
}

/** The shell's record of the current origin's copy of its last view (`app.copy.v1`; see [AppCopies]). */
interface AppCopyPort {
    /** The page reports whether its origin now has a copy. */
    fun reported(stored: Boolean)

    /** The page must delete its copy: a sandbox switch left this origin while no page could. */
    val forgetPending: Boolean
}

/** Validates and answers web messages for one document; call [reset] when a page starts or the Activity goes. */
class BridgeController(
    private val identity: ShellIdentity,
    private val host: BridgeHost,
    private val playback: NativePlaybackPort,
    /** Null when this build has no compiled update certificate, so it offers no updates. */
    private val updates: UpdatePort? = null,
    /** Saves page-built files (`files.save.v1`); null where nothing can store them. */
    private val files: FileSaves? = null,
    /** Opens pages with a copy at once (`app.copy.v1`); null where the shell does not. */
    private val copies: AppCopyPort? = null,
) {

    private val playbackBridge = PlaybackBridge(playback)
    private var negotiatedProtocol: Int? = null

    /** The range the document offered, so an update is accepted only if it can open the current site. */
    private var webProtocols: IntRange? = null

    /** Posts to the document that negotiated the bridge; events go nowhere before a handshake. */
    private var eventSink: ((String) -> Unit)? = null

    /** Commands to that document still unanswered, by message ID: each one's name and who waits. */
    private val pageCommands = mutableMapOf<String, Pair<String, (JSONObject?) -> Unit>>()

    fun reset() {
        negotiatedProtocol = null
        webProtocols = null
        eventSink = null
        files?.reset()
        val unanswered = pageCommands.values.toList()
        pageCommands.clear()
        unanswered.forEach { (_, done) -> done(null) }
        playback.documentDetached()
    }

    /**
     * Asks the negotiated document for a cookie-less link to its same-origin [path]
     * (`downloads.link.v1`), which the page requests from the server with its own session. [done]
     * gets the page's answer, or null once the page refuses, the document goes, or
     * [abandonPageCommand] gives up. Returns the request's ID, or null, after answering null,
     * when no document negotiated. Call on the main thread.
     */
    fun requestDownloadLink(path: String, done: (String?) -> Unit): String? =
        askPage(DOWNLOAD_LINK, JSONObject().put("path", path)) { payload ->
            done((payload?.opt("url") as? String)?.takeIf { payload.opt("ok") == true })
        }

    /**
     * Asks the negotiated document to delete its origin's copy (`app.copy.v1`) before a sandbox
     * switch leaves it. [done] runs once the page answered, the document went, or
     * [abandonPageCommand] gave up; at once when no document offers the capability.
     */
    fun requestCopyForget(done: () -> Unit): String? {
        if (copies == null) {
            done()
            return null
        }
        return askPage(APP_COPY_FORGET, JSONObject()) { done() }
    }

    /** Answers null for a command still unanswered; a later answer from the page is ignored. */
    fun abandonPageCommand(id: String) {
        pageCommands.remove(id)?.second?.invoke(null)
    }

    private fun askPage(name: String, payload: JSONObject, done: (JSONObject?) -> Unit): String? {
        if (eventSink == null || negotiatedProtocol == null) {
            done(null)
            return null
        }
        val id = UUID.randomUUID().toString()
        pageCommands[id] = name to done
        post("command", id, name, payload)
        return id
    }

    private fun answerPageCommand(message: BridgeMessage) {
        if (message.protocol != negotiatedProtocol || pageCommands[message.id]?.first != message.name) return
        pageCommands.remove(message.id)?.second?.invoke(message.payload)
    }

    /** Sends a native playback event to the negotiated document. Call on the main thread. */
    fun emit(event: NativePlaybackEvent) {
        if (eventSink == null) return
        val (name, payload) = PlaybackBridge.encode(event)
        emit(name, payload)
    }

    /** Sends update progress and results to the negotiated document. Call on the main thread. */
    fun emit(update: UpdateState) {
        if (updates != null) emit(UPDATE_STATE_EVENT, update.toJson())
    }

    private fun emit(name: String, payload: JSONObject) = post("event", UUID.randomUUID().toString(), name, payload)

    private fun post(type: String, id: String, name: String, payload: JSONObject) {
        val sink = eventSink ?: return
        val protocol = negotiatedProtocol ?: return
        sink(
            JSONObject()
                .put("protocol", protocol)
                .put("id", id)
                .put("type", type)
                .put("name", name)
                .put("payload", payload)
                .toString(),
        )
    }

    fun handle(raw: String, sourceOrigin: String, isMainFrame: Boolean, reply: (String) -> Unit) {
        if (!isMainFrame || sourceOrigin != host.selectedOrigin()) return
        val message = try {
            BridgeCodec.parse(raw)
        } catch (_: BridgeFormatException) {
            return
        }
        if (message.type == "response") {
            answerPageCommand(message)
            return
        }
        if (message.type != "command") return
        if (message.name == HANDSHAKE) {
            handshake(message, reply)
            return
        }
        val protocol = negotiatedProtocol
        when {
            protocol == null ->
                reply(BridgeCodec.failure(message, PROTOCOL_MAX, "handshake_required", "Handshake required"))
            message.protocol != protocol ->
                reply(BridgeCodec.failure(message, protocol, "incompatible_bridge", "Wrong protocol"))
            message.name == SANDBOX_SELECT && SANDBOX_CAPABILITY in capabilities() ->
                selectSandbox(message, protocol, reply)
            message.name in UPDATE_COMMANDS && updates != null ->
                update(message, protocol, updates, reply)
            message.name == FILES_SAVE && files != null ->
                files.handle(message.payload) { respond(message, protocol, it, reply) }
            message.name == APP_COPY_STATE && copies != null ->
                reportCopy(message, protocol, copies, reply)
            message.name == FOREGROUND_READY ->
                foregroundReady(message, protocol, reply)
            else -> respond(message, protocol, playbackBridge.handle(message.name, message.payload), reply)
        }
    }

    private fun respond(message: BridgeMessage, protocol: Int, result: PlaybackBridge.Result?, reply: (String) -> Unit) {
        when (result) {
            is PlaybackBridge.Result.Ok -> reply(BridgeCodec.success(message, protocol, result.payload))
            is PlaybackBridge.Result.Failed -> reply(BridgeCodec.failure(message, protocol, result.code, result.message))
            null -> reply(BridgeCodec.failure(message, protocol, "unsupported_command", "Unsupported command"))
        }
    }

    private fun handshake(message: BridgeMessage, reply: (String) -> Unit) {
        val webMin = message.payload.opt("protocolMin") as? Int
        val webMax = message.payload.opt("protocolMax") as? Int
        val required = requiredCapabilities(message.payload)
        if (webMin == null || webMax == null || webMin > webMax || required == null) {
            reply(BridgeCodec.failure(message, PROTOCOL_MAX, "invalid_payload", "Invalid handshake"))
            return
        }
        val selected = minOf(PROTOCOL_MAX, webMax)
        if (selected < maxOf(PROTOCOL_MIN, webMin)) {
            reply(BridgeCodec.failure(message, PROTOCOL_MAX, "incompatible_bridge", "No shared protocol"))
            host.onIncompatibleWeb(webMin..webMax)
            return
        }
        if (!capabilities().containsAll(required)) {
            reply(BridgeCodec.failure(message, PROTOCOL_MAX, "update_required", "Missing required capability"))
            host.onIncompatibleWeb(webMin..webMax)
            return
        }
        negotiatedProtocol = selected
        webProtocols = webMin..webMax
        eventSink = reply
        reply(BridgeCodec.success(message, selected, handshakePayload(selected)))
        playback.documentAttached()
        host.onBridgeConnected()
    }

    /** The capabilities the site cannot run without; absent means none. Null when malformed. */
    private fun requiredCapabilities(payload: JSONObject): Set<String>? {
        val names = payload.opt("requiredCapabilities") ?: return emptySet()
        if (names !is JSONArray || names.length() > MAX_REQUIRED_CAPABILITIES) return null
        return (0 until names.length()).map { index ->
            (names.get(index) as? String)?.takeIf(CAPABILITY::matches) ?: return null
        }.toSet()
    }

    private fun handshakePayload(selected: Int): JSONObject {
        val payload = JSONObject()
            .put("applicationId", identity.applicationId)
            .put("variant", identity.channel.wireName)
            .put("versionName", identity.versionName)
            .put("versionCode", identity.versionCode)
            .put("bridgeProtocol", selected)
            .put("bridgeProtocolMin", PROTOCOL_MIN)
            .put("bridgeProtocolMax", PROTOCOL_MAX)
            .put("capabilities", JSONArray(capabilities()))
            .put("origin", host.selectedOrigin())
            .put("playback", PlaybackBridge.snapshotJson(playback.snapshot))
        updates?.let { payload.put("updates", it.state.toJson()) }
        copies?.let { payload.put("appCopy", JSONObject().put("forget", it.forgetPending)) }
        if (identity.channel == ShellChannel.SANDBOX) {
            payload.put(
                "sandbox",
                JSONObject()
                    .put("slot", host.selectedSandboxSlot() ?: JSONObject.NULL)
                    .put("connectedSlot", host.takeConnectedSandboxSlot() ?: JSONObject.NULL),
            )
        }
        return payload
    }

    // Native output replaces the interim WebView player; the two never run together.
    private fun capabilities(): List<String> = buildList {
        if (identity.channel == ShellChannel.SANDBOX) add(SANDBOX_CAPABILITY)
        addAll(PlaybackBridge.CAPABILITIES)
        if (updates != null) add(UPDATES_CAPABILITY)
        add(DOWNLOAD_LINKS_CAPABILITY)
        if (files != null) add(FILES_CAPABILITY)
        if (copies != null) add(APP_COPY_CAPABILITY)
    }

    private fun reportCopy(message: BridgeMessage, protocol: Int, copies: AppCopyPort, reply: (String) -> Unit) {
        val stored = message.payload.opt("stored") as? Boolean
        if (stored == null || message.payload.length() != 1) {
            reply(BridgeCodec.failure(message, protocol, "invalid_payload", "Invalid copy state"))
            return
        }
        copies.reported(stored)
        reply(BridgeCodec.success(message, protocol))
    }

    private fun foregroundReady(message: BridgeMessage, protocol: Int, reply: (String) -> Unit) {
        val value = message.payload.opt("token")
        val token = if (value is Int || value is Long) (value as Number).toLong() else null
        if (token == null || token <= 0 || message.payload.length() != 1) {
            reply(BridgeCodec.failure(message, protocol, "invalid_payload", "Invalid foreground token"))
            return
        }
        host.onForegroundReady(token)
        reply(BridgeCodec.success(message, protocol))
    }

    /** Commands take no arguments; progress and results follow as `updates.state` events. */
    private fun update(message: BridgeMessage, protocol: Int, updates: UpdatePort, reply: (String) -> Unit) {
        if (message.payload.length() != 0) {
            reply(BridgeCodec.failure(message, protocol, "invalid_payload", "Unexpected fields"))
            return
        }
        val applied = when (message.name) {
            UPDATE_CHECK -> updates.check(checkNotNull(webProtocols))
            UPDATE_DOWNLOAD -> updates.download()
            else -> updates.install()
        }
        reply(
            if (applied) {
                BridgeCodec.success(message, protocol, JSONObject().put("updates", updates.state.toJson()))
            } else {
                BridgeCodec.failure(message, protocol, "update_unavailable", "Not available in this update state")
            },
        )
    }

    private fun selectSandbox(message: BridgeMessage, protocol: Int, reply: (String) -> Unit) {
        val slot = message.payload.opt("slot") as? Int
        if (slot == null || slot !in OriginPolicy.SANDBOX_SLOTS) {
            reply(BridgeCodec.failure(message, protocol, "invalid_payload", "Unknown sandbox"))
            return
        }
        host.selectSandbox(slot) { connected ->
            reply(
                if (connected) {
                    BridgeCodec.success(message, protocol)
                } else {
                    BridgeCodec.failure(message, protocol, "connection_failed", "Sandbox is unreachable")
                },
            )
        }
    }

    companion object {
        const val PROTOCOL_MIN = 1
        const val PROTOCOL_MAX = 1
        const val SANDBOX_CAPABILITY = "sandbox.select.v1"
        const val UPDATES_CAPABILITY = "updates.manual.v1"

        /** Same-origin downloads go through a cookie-less link the shell asks the page for. */
        const val DOWNLOAD_LINKS_CAPABILITY = "downloads.link.v1"
        const val FILES_CAPABILITY = "files.save.v1"
        const val APP_COPY_CAPABILITY = "app.copy.v1"
        private const val APP_COPY_STATE = "copy.state"
        private const val FOREGROUND_READY = "shell.foregroundReady"
        private const val APP_COPY_FORGET = "copy.forget"
        private const val DOWNLOAD_LINK = "downloads.link"
        private const val FILES_SAVE = "files.save"
        private const val UPDATE_CHECK = "updates.check"
        private const val UPDATE_DOWNLOAD = "updates.download"
        private const val UPDATE_INSTALL = "updates.install"
        private val UPDATE_COMMANDS = setOf(UPDATE_CHECK, UPDATE_DOWNLOAD, UPDATE_INSTALL)
        private const val UPDATE_STATE_EVENT = "updates.state"
        private const val HANDSHAKE = "bridge.handshake"
        private const val SANDBOX_SELECT = "sandbox.select"
        private const val MAX_REQUIRED_CAPABILITIES = 64
        private val CAPABILITY = Regex("^[a-z][a-z_]*(\\.[a-z][a-z_]*)*\\.v[1-9][0-9]*$")
    }
}
