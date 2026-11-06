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
    fun selectedSandboxSlot(): Int
    fun takeConnectedSandboxSlot(): Int?
    fun selectSandbox(slot: Int, onResult: (connected: Boolean) -> Unit)

    /** This app cannot run the site offering [webProtocols]: no shared protocol, or a required capability is missing. */
    fun onIncompatibleWeb(webProtocols: IntRange)
}

/** The APK updater as the bridge sees it (`updates.manual.v1`). Each call returns false when it does not apply now. */
interface UpdatePort {
    val state: UpdateState
    fun check(webProtocols: IntRange): Boolean
    fun download(): Boolean
    fun install(): Boolean
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
) {

    private val playbackBridge = PlaybackBridge(playback)
    private var negotiatedProtocol: Int? = null

    /** The range the document offered, so an update is accepted only if it can open the current site. */
    private var webProtocols: IntRange? = null

    /** Posts to the document that negotiated the bridge; events go nowhere before a handshake. */
    private var eventSink: ((String) -> Unit)? = null

    /** Unanswered `downloads.link` requests to that document, by message ID. */
    private val downloadLinks = mutableMapOf<String, (String?) -> Unit>()

    fun reset() {
        negotiatedProtocol = null
        webProtocols = null
        eventSink = null
        files?.reset()
        val unanswered = downloadLinks.values.toList()
        downloadLinks.clear()
        unanswered.forEach { it(null) }
        playback.documentDetached()
    }

    /**
     * Asks the negotiated document for a cookie-less link to its same-origin [path]
     * (`downloads.link.v1`), which the page requests from the server with its own session. [done]
     * gets the link's path, or null once the page refuses, the document goes, or
     * [abandonDownloadLink] gives up. Returns the request's ID, or null, after answering null,
     * when no document negotiated. Call on the main thread.
     */
    fun requestDownloadLink(path: String, done: (String?) -> Unit): String? {
        if (eventSink == null || negotiatedProtocol == null) {
            done(null)
            return null
        }
        val id = UUID.randomUUID().toString()
        downloadLinks[id] = done
        post("command", id, DOWNLOAD_LINK, JSONObject().put("path", path))
        return id
    }

    /** Answers null for a request still unanswered; a later answer from the page is ignored. */
    fun abandonDownloadLink(id: String) {
        downloadLinks.remove(id)?.invoke(null)
    }

    private fun answerDownloadLink(message: BridgeMessage) {
        if (message.name != DOWNLOAD_LINK || message.protocol != negotiatedProtocol) return
        val done = downloadLinks.remove(message.id) ?: return
        val payload = message.payload
        done((payload.opt("url") as? String)?.takeIf { payload.opt("ok") == true && isDownloadLink(it) })
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
            answerDownloadLink(message)
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
        if (identity.channel == ShellChannel.SANDBOX) {
            payload.put(
                "sandbox",
                JSONObject()
                    .put("slot", host.selectedSandboxSlot())
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
