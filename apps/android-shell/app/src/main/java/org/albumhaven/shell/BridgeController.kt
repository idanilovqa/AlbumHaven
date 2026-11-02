package org.albumhaven.shell

import org.json.JSONArray
import org.json.JSONObject

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
    fun onIncompatibleWeb()
}

/** Validates and answers web messages for one document; call [reset] when a page starts. */
class BridgeController(private val identity: ShellIdentity, private val host: BridgeHost) {

    private var negotiatedProtocol: Int? = null

    fun reset() {
        negotiatedProtocol = null
    }

    fun handle(raw: String, sourceOrigin: String, isMainFrame: Boolean, reply: (String) -> Unit) {
        if (!isMainFrame || sourceOrigin != host.selectedOrigin()) return
        val message = try {
            BridgeCodec.parse(raw)
        } catch (_: BridgeFormatException) {
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
            else ->
                reply(BridgeCodec.failure(message, protocol, "unsupported_command", "Unsupported command"))
        }
    }

    private fun handshake(message: BridgeMessage, reply: (String) -> Unit) {
        val webMin = message.payload.opt("protocolMin") as? Int
        val webMax = message.payload.opt("protocolMax") as? Int
        if (webMin == null || webMax == null || webMin > webMax) {
            reply(BridgeCodec.failure(message, PROTOCOL_MAX, "invalid_payload", "Invalid protocol range"))
            return
        }
        val selected = minOf(PROTOCOL_MAX, webMax)
        if (selected < maxOf(PROTOCOL_MIN, webMin)) {
            reply(BridgeCodec.failure(message, PROTOCOL_MAX, "incompatible_bridge", "No shared protocol"))
            host.onIncompatibleWeb()
            return
        }
        negotiatedProtocol = selected
        reply(BridgeCodec.success(message, selected, handshakePayload(selected)))
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
            .put("playback", JSONObject().put("state", "unavailable"))
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

    private fun capabilities(): List<String> =
        if (identity.channel == ShellChannel.SANDBOX) listOf(SANDBOX_CAPABILITY) else emptyList()

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
        private const val HANDSHAKE = "bridge.handshake"
        private const val SANDBOX_SELECT = "sandbox.select"
    }
}
