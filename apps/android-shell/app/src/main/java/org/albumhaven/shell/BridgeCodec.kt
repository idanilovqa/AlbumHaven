package org.albumhaven.shell

import org.json.JSONException
import org.json.JSONObject

class BridgeMessage(
    val protocol: Int,
    val id: String,
    val type: String,
    val name: String,
    val payload: JSONObject,
)

/** Thrown for a message whose envelope is unusable, so no correlated reply is possible. */
class BridgeFormatException(message: String) : Exception(message)

/** Bridge v1 envelope: validated UTF-8 JSON of at most 64 KiB. */
object BridgeCodec {
    const val MAX_MESSAGE_BYTES = 64 * 1024

    private val ENVELOPE_KEYS = setOf("protocol", "id", "type", "name", "payload")
    private val MESSAGE_TYPES = setOf("command", "response", "event")
    private val ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val NAME = Regex("^[a-z]+(\\.[a-zA-Z]+)+$")

    fun parse(raw: String): BridgeMessage {
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_BYTES) {
            throw BridgeFormatException("Message is too large")
        }
        val json = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            throw BridgeFormatException("Message is not a JSON object")
        }
        if (json.keys().asSequence().toSet() != ENVELOPE_KEYS) {
            throw BridgeFormatException("Message has unexpected fields")
        }
        val protocol = json.get("protocol") as? Int
        val id = json.get("id") as? String
        val type = json.get("type") as? String
        val name = json.get("name") as? String
        val payload = json.get("payload") as? JSONObject
        if (protocol == null || protocol < 1) throw BridgeFormatException("Invalid protocol")
        if (id == null || !ID.matches(id)) throw BridgeFormatException("Invalid id")
        if (type == null || type !in MESSAGE_TYPES) throw BridgeFormatException("Invalid type")
        if (name == null || !NAME.matches(name)) throw BridgeFormatException("Invalid name")
        if (payload == null) throw BridgeFormatException("Invalid payload")
        return BridgeMessage(protocol, id, type, name, payload)
    }

    fun success(request: BridgeMessage, protocol: Int, payload: JSONObject = JSONObject()): String =
        response(request, protocol, payload.put("ok", true))

    fun failure(request: BridgeMessage, protocol: Int, code: String, message: String): String =
        response(
            request,
            protocol,
            JSONObject()
                .put("ok", false)
                .put("error", JSONObject().put("code", code).put("message", message)),
        )

    private fun response(request: BridgeMessage, protocol: Int, payload: JSONObject): String =
        JSONObject()
            .put("protocol", protocol)
            .put("id", request.id)
            .put("type", "response")
            .put("name", request.name)
            .put("payload", payload)
            .toString()
}
