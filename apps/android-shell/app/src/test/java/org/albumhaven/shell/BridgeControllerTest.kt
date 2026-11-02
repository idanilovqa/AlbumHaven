package org.albumhaven.shell

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

private const val ORIGIN = "https://sandbox2.albumhaven.org"
private const val ID = "6f0e2a5c-4c1f-4a3e-9f17-2b8f4f1f7a10"

class BridgeControllerTest {
    // Shared with tests/js/runtime/android-bridge-client.test.js.
    private val fixture = JSONObject(File("../../../tests/fixtures/android-bridge-v1.json").readText())

    private class FakeHost : BridgeHost {
        var connected: Int? = null
        var incompatibleCalls = 0
        var selectedSlot: Int? = null
        var nextSelectResult = true

        override fun selectedOrigin() = ORIGIN
        override fun selectedSandboxSlot() = 2
        override fun takeConnectedSandboxSlot() = connected.also { connected = null }
        override fun selectSandbox(slot: Int, onResult: (Boolean) -> Unit) {
            selectedSlot = slot
            onResult(nextSelectResult)
        }
        override fun onIncompatibleWeb() {
            incompatibleCalls++
        }
    }

    private val host = FakeHost()
    private val sandbox = controller(ShellChannel.SANDBOX, "org.albumhaven.app.sandbox")

    private fun controller(channel: ShellChannel, id: String) =
        BridgeController(ShellIdentity(id, channel, "0.9.50", 1), host)

    private fun send(
        controller: BridgeController,
        raw: String,
        origin: String = ORIGIN,
        mainFrame: Boolean = true,
    ): JSONObject? {
        var reply: String? = null
        controller.handle(raw, origin, mainFrame) { reply = it }
        return reply?.let(::JSONObject)
    }

    private fun command(name: String, payload: String = "{}", protocol: Int = 1) =
        """{"protocol":$protocol,"id":"$ID","type":"command","name":"$name","payload":$payload}"""

    private fun handshake(min: Int = 1, max: Int = 1) =
        command("bridge.handshake", """{"protocolMin":$min,"protocolMax":$max}""")

    private fun canonical(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { canonical(value.get(it)) }
        else -> value
    }

    private fun assertSameJson(expected: JSONObject, actual: JSONObject) {
        assertEquals(canonical(expected), canonical(actual))
    }

    @Test
    fun handshakeMatchesSharedFixture() {
        val reply = send(sandbox, fixture.getJSONObject("handshakeRequest").toString())!!
        assertSameJson(fixture.getJSONObject("handshakeResponse"), reply)
    }

    @Test
    fun stableAdvertisesNoSandboxState() {
        val stable = controller(ShellChannel.STABLE, "org.albumhaven.app")
        val payload = send(stable, handshake())!!.getJSONObject("payload")
        assertEquals("stable", payload.getString("variant"))
        assertEquals(fixture.getJSONObject("capabilities").getJSONArray("stable").length(), payload.getJSONArray("capabilities").length())
        assertFalse(payload.has("sandbox"))
    }

    @Test
    fun connectedSandboxIsReportedOnce() {
        host.connected = 3
        val first = send(sandbox, handshake())!!.getJSONObject("payload").getJSONObject("sandbox")
        val second = send(sandbox, handshake())!!.getJSONObject("payload").getJSONObject("sandbox")
        assertEquals(3, first.getInt("connectedSlot"))
        assertTrue(second.isNull("connectedSlot"))
    }

    @Test
    fun rejectedEnvelopesReceiveNoReply() {
        val cases = fixture.getJSONArray("rejectedEnvelopes")
        for (index in 0 until cases.length()) {
            val raw = cases.getString(index)
            assertThrows(raw, BridgeFormatException::class.java) { BridgeCodec.parse(raw) }
            assertNull(raw, send(sandbox, raw))
        }
    }

    @Test
    fun oversizedMessageIsRejected() {
        val filler = "x".repeat(BridgeCodec.MAX_MESSAGE_BYTES)
        assertNull(send(sandbox, command("bridge.handshake", """{"filler":"$filler"}""")))
    }

    @Test
    fun otherOriginsAndSubframesAreIgnored() {
        assertNull(send(sandbox, handshake(), origin = "https://sandbox3.albumhaven.org"))
        assertNull(send(sandbox, handshake(), mainFrame = false))
    }

    @Test
    fun responsesAndEventsFromWebAreIgnored() {
        assertNull(send(sandbox, """{"protocol":1,"id":"$ID","type":"event","name":"bridge.handshake","payload":{}}"""))
    }

    @Test
    fun commandsRequireHandshakeForTheCurrentDocument() {
        val select = command("sandbox.select", """{"slot":3}""")
        assertEquals("handshake_required", errorCode(send(sandbox, select)))
        send(sandbox, handshake())
        assertTrue(send(sandbox, select)!!.getJSONObject("payload").getBoolean("ok"))
        sandbox.reset()
        assertEquals("handshake_required", errorCode(send(sandbox, select)))
    }

    @Test
    fun incompatibleRangeFailsClosed() {
        assertEquals("incompatible_bridge", errorCode(send(sandbox, handshake(min = 2, max = 3))))
        assertEquals(1, host.incompatibleCalls)
        assertEquals("handshake_required", errorCode(send(sandbox, command("sandbox.select", """{"slot":3}"""))))
    }

    @Test
    fun malformedRangeIsNotTreatedAsIncompatibleWeb() {
        assertEquals("invalid_payload", errorCode(send(sandbox, handshake(min = 3, max = 1))))
        assertEquals(0, host.incompatibleCalls)
    }

    @Test
    fun newerWebNegotiatesDownToSharedProtocol() {
        assertEquals(1, send(sandbox, handshake(min = 1, max = 4))!!.getInt("protocol"))
    }

    @Test
    fun wrongProtocolAfterHandshakeIsRejected() {
        send(sandbox, handshake())
        assertEquals("incompatible_bridge", errorCode(send(sandbox, command("sandbox.select", """{"slot":3}""", protocol = 2))))
        assertNull(host.selectedSlot)
    }

    @Test
    fun sandboxSelectValidatesSlot() {
        send(sandbox, handshake())
        listOf("""{"slot":0}""", """{"slot":100}""", """{"slot":"3"}""", "{}").forEach {
            assertEquals(it, "invalid_payload", errorCode(send(sandbox, command("sandbox.select", it))))
        }
        assertNull(host.selectedSlot)
    }

    @Test
    fun sandboxSelectReportsConnectionFailure() {
        send(sandbox, handshake())
        host.nextSelectResult = false
        assertEquals("connection_failed", errorCode(send(sandbox, command("sandbox.select", """{"slot":3}"""))))
    }

    @Test
    fun stableCannotSelectSandbox() {
        val stable = controller(ShellChannel.STABLE, "org.albumhaven.app")
        send(stable, handshake())
        assertEquals("unsupported_command", errorCode(send(stable, command("sandbox.select", """{"slot":3}"""))))
        assertNull(host.selectedSlot)
    }

    @Test
    fun playbackCommandsAreUnsupportedBeforeNativePlayback() {
        send(sandbox, handshake())
        assertEquals("unsupported_command", errorCode(send(sandbox, command("playback.play"))))
    }

    private fun errorCode(reply: JSONObject?): String =
        reply!!.getJSONObject("payload").getJSONObject("error").getString("code")
}
