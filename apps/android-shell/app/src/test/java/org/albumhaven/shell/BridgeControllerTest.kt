package org.albumhaven.shell

import org.albumhaven.shell.playback.CommandSource
import org.albumhaven.shell.playback.ControllerHarness
import org.albumhaven.shell.playback.ControllerPlaybackPort
import org.albumhaven.shell.playback.CurrentItemReason
import org.albumhaven.shell.playback.QueueItem
import org.albumhaven.playback.engine.RATE
import org.albumhaven.playback.engine.SyntheticTrack
import org.albumhaven.shell.playback.NativePlaybackEvent
import org.albumhaven.shell.playback.NativePlaybackSnapshot
import org.albumhaven.shell.playback.NativePlaybackState
import org.albumhaven.shell.updates.UpdateState
import org.albumhaven.shell.updates.manifest
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
    private val fixture = JSONObject(File("../../../tests/fixtures/android-bridge/v1.json").readText())

    private class FakeHost : BridgeHost {
        var connected: Int? = null
        var bridgeConnections = 0
        val foregroundReady = mutableListOf<Long>()
        val incompatible = mutableListOf<IntRange>()
        var selectedSlot: Int? = null
        var nextSelectResult = true

        override fun selectedOrigin() = ORIGIN
        override fun selectedSandboxSlot() = 2
        override fun takeConnectedSandboxSlot() = connected.also { connected = null }
        override fun selectSandbox(slot: Int, onResult: (Boolean) -> Unit) {
            selectedSlot = slot
            onResult(nextSelectResult)
        }
        override fun onIncompatibleWeb(webProtocols: IntRange) {
            incompatible += webProtocols
        }
        override fun onBridgeConnected() {
            bridgeConnections++
        }
        override fun onForegroundReady(token: Long) {
            foregroundReady += token
        }
    }

    private class FakeUpdates : UpdatePort {
        override var state: UpdateState = UpdateState.Idle(null)
        val calls = mutableListOf<String>()
        var checkedWith: IntRange? = null
        var applies = true

        override fun check(webProtocols: IntRange): Boolean {
            calls += "check"
            checkedWith = webProtocols
            return applies
        }
        override fun download() = applies.also { calls += "download" }
        override fun install() = applies.also { calls += "install" }
    }

    private class FakeCopies : AppCopyPort {
        val reports = mutableListOf<Boolean>()
        override var forgetPending = false
        override fun reported(stored: Boolean) { reports += stored }
    }

    private val copies = FakeCopies()
    private val host = FakeHost()
    private val updates = FakeUpdates()
    private val playback = ControllerHarness()
    private val attachments = mutableListOf<Boolean>()
    private val savedFiles = mutableListOf<String>()
    private val files = FileSaves({ name, _, _ -> savedFiles.add(name) }, { it.run() }, Runnable::run) {}
    private val sandbox = controller(ShellChannel.SANDBOX, "org.albumhaven.app.sandbox")

    private fun controller(
        channel: ShellChannel,
        id: String,
        updates: UpdatePort? = this.updates,
        files: FileSaves? = this.files,
        copies: AppCopyPort? = this.copies,
    ) =
        BridgeController(
            ShellIdentity(id, channel, "0.9.50", 1), host, ControllerPlaybackPort({ playback.controller }, attachment = attachments::add),
            updates, files, copies,
        )

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
        is Int -> value.toLong()
        else -> value
    }

    private fun assertSameJson(expected: JSONObject, actual: JSONObject) {
        assertEquals(canonical(expected), canonical(actual))
    }

    @Test
    fun onlyANegotiatedDocumentCountsAsAttachedUntilItsPageGoes() {
        assertEquals("incompatible_bridge", errorCode(send(sandbox, handshake(min = 2, max = 3))))
        assertEquals(emptyList<Boolean>(), attachments)

        assertEquals(0, host.bridgeConnections)
        send(sandbox, handshake())
        assertEquals(listOf(true), attachments)
        // The shell stops waiting for the handshake that tells it the sandbox supports the app.
        assertEquals(1, host.bridgeConnections)
        // A page start, a reload, an error panel and a gone Activity all reset the bridge.
        sandbox.reset()
        assertEquals(listOf(true, false), attachments)
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
        assertEquals(listOf(2..3), host.incompatible)
        assertEquals("handshake_required", errorCode(send(sandbox, command("sandbox.select", """{"slot":3}"""))))
    }

    @Test
    fun malformedRangeIsNotTreatedAsIncompatibleWeb() {
        assertEquals("invalid_payload", errorCode(send(sandbox, handshake(min = 3, max = 1))))
        assertEquals(emptyList<IntRange>(), host.incompatible)
    }

    private fun requiring(capabilities: String) =
        command("bridge.handshake", """{"protocolMin":1,"protocolMax":2,"requiredCapabilities":$capabilities}""")

    @Test
    fun aSiteRequiringOnlyAdvertisedCapabilitiesNegotiates() {
        assertTrue(ok(send(sandbox, requiring("""["playback.native.v1","updates.manual.v1"]"""))))
        assertTrue(ok(send(sandbox, requiring("[]"))))
        assertEquals(emptyList<IntRange>(), host.incompatible)
    }

    @Test
    fun aMissingRequiredCapabilityRefusesTheSiteAndAsksForAnUpdate() {
        val stable = controller(ShellChannel.STABLE, "org.albumhaven.app")
        assertEquals("update_required", errorCode(send(stable, requiring("""["sandbox.select.v1"]"""))))
        assertEquals("update_required", errorCode(send(sandbox, requiring("""["playback.native.v1","playback.lyrics.v1"]"""))))
        assertEquals(listOf(1..2, 1..2), host.incompatible)
        assertEquals("handshake_required", errorCode(send(sandbox, command("playback.snapshot"))))
    }

    @Test
    fun malformedRequiredCapabilitiesAreRejectedWithoutAskingForAnUpdate() {
        listOf("\"playback.native.v1\"", "[1]", "[\"Bad Name\"]", "[\"playback.native\"]", "{}",
            "[" + List(65) { "\"playback.native.v1\"" }.joinToString(",") + "]").forEach {
            assertEquals(it, "invalid_payload", errorCode(send(sandbox, requiring(it))))
        }
        assertEquals(emptyList<IntRange>(), host.incompatible)
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
    fun nativePlaybackReplacesTheInterimWebViewCapability() {
        for (channel in listOf("stable", "sandbox")) {
            val advertised = fixture.getJSONObject("capabilities").getJSONArray(channel)
            val names = (0 until advertised.length()).map(advertised::getString)
            assertTrue(names.containsAll(PlaybackBridge.CAPABILITIES))
            assertFalse(names.contains("playback.webview.v1"))
        }
    }

    @Test
    fun loadQueueFixtureIsAcceptedAndEchoesItsRevision() {
        send(sandbox, handshake())
        val reply = send(sandbox, fixture.getJSONObject("loadQueueRequest").toString())!!
        assertEquals("playback.loadQueue", reply.getString("name"))
        assertTrue(reply.getJSONObject("payload").getBoolean("ok"))
        assertEquals(1, reply.getJSONObject("payload").getInt("queueRevision"))
    }

    @Test
    fun queueRevisionsMustIncreaseAndTransportCommandsNameTheAppliedOne() {
        send(sandbox, handshake())
        assertEquals("no_queue", errorCode(send(sandbox, command("playback.play", """{"queueRevision":1}"""))))
        assertTrue(ok(send(sandbox, load(revision = 2))))
        assertEquals("stale_revision", errorCode(send(sandbox, load(revision = 2))))
        assertEquals("stale_revision", errorCode(send(sandbox, load(revision = 1))))
        assertEquals(
            "stale_revision",
            errorCode(send(sandbox, command("playback.seek", """{"queueRevision":1,"positionMs":0}"""))),
        )
        assertTrue(ok(send(sandbox, command("playback.seek", """{"queueRevision":2,"positionMs":1000}"""))))
        assertTrue(ok(send(sandbox, command("playback.next", """{"queueRevision":2}"""))))
        assertTrue(ok(send(sandbox, command("playback.previous", """{"queueRevision":2}"""))))
        assertTrue(
            ok(send(sandbox, command("playback.setLoop", """{"queueRevision":2,"startFrame":0,"endFrame":44100,"sampleRate":44100}"""))),
        )
        assertTrue(
            ok(send(sandbox, command("playback.setLoop", """{"queueRevision":2,"startFrame":0,"endFrame":96000,"sampleRate":96000,"kind":"long-loop"}"""))),
        )
        assertTrue(ok(send(sandbox, command("playback.clearLoop", """{"queueRevision":2}"""))))
        assertTrue(ok(send(sandbox, load(revision = 3, keepCurrent = "true"))))
        assertTrue(ok(send(sandbox, command("playback.pause"))))
        assertTrue(ok(send(sandbox, command("playback.stop"))))
        assertTrue(ok(send(sandbox, load(revision = 4))))
        assertTrue(ok(send(sandbox, load(revision = 5, items = """[{"playbackRef":"opaque-ref","title":"T","artist":"A","album":"B","artworkUrl":null,"durationMs":1000,"trackNumber":"1","listenKey":"lk1-0123abcd","queueGroup":0,"year":"1999"}]"""))))
        assertEquals("stale_revision", errorCode(send(sandbox, command("playback.play", """{"queueRevision":2}"""))))
    }

    @Test
    fun foregroundReadinessAcceptsOnlyOnePositiveIntegerWithoutTouchingPlayback() {
        send(sandbox, handshake())
        val before = playback.controller.snapshot

        assertTrue(ok(send(sandbox, command("shell.foregroundReady", """{"token":7}"""))))
        assertEquals(listOf(7L), host.foregroundReady)
        assertEquals(before, playback.controller.snapshot)

        for (payload in listOf("{}", """{"token":0}""", """{"token":-1}""", """{"token":"7"}""", """{"token":7,"extra":true}""")) {
            assertEquals("invalid_payload", errorCode(send(sandbox, command("shell.foregroundReady", payload))))
        }
        assertEquals(listOf(7L), host.foregroundReady)
    }

    @Test
    fun invalidPlaybackPayloadsAreRejected() {
        send(sandbox, handshake())
        val item = """{"playbackRef":"opaque-ref","title":"T","artist":"A","album":"B","artworkUrl":null,"durationMs":1000,"trackNumber":"1","listenKey":"lk1-0123abcd","queueGroup":0}"""
        val cases = listOf(
            load(items = "[]"),
            load(items = "[" + item.replace("\"durationMs\":1000", "\"durationMs\":1000,\"path\":\"/music/a.flac\"") + "]"),
            load(items = "[" + item.replace("opaque-ref", "has space") + "]"),
            load(items = "[" + item.replace("\"T\"", "\"T\\u0001\"") + "]"),
            load(items = "[" + item.replace("null", "\"/cover?path=x\"") + "]"),
            load(items = "[" + item.replace("null", "\"https://elsewhere.example/a.jpg\"") + "]"),
            load(items = "[" + item.replace("1000", "1000.5") + "]"),
            load(items = "[" + item.replace(",\"trackNumber\":\"1\"", "") + "]"),
            load(items = "[" + item.replace("\"trackNumber\":\"1\"", "\"trackNumber\":1") + "]"),
            load(items = "[" + item.replace(",\"listenKey\":\"lk1-0123abcd\"", "") + "]"),
            load(items = "[" + item.replace("lk1-0123abcd", "C:/Music/a.flac") + "]"),
            load(items = "[" + item.replace("lk1-0123abcd", "") + "]"),
            load(items = "[" + item.replace(",\"queueGroup\":0", "") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":-1") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":1") + "," + item + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":0,\"resumeToken\":\"C:/Music/a.flac\"") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":0,\"resumeToken\":null") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":0,\"resumeToken\":\"\"") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":0,\"year\":1999") + "]"),
            load(items = "[" + item.replace("\"queueGroup\":0", "\"queueGroup\":0,\"rating\":5") + "]"),
            load(keepCurrent = "1"),
            command("playback.setLoop", """{"queueRevision":1,"startFrame":0,"endFrame":48000,"sampleRate":48000,"kind":"loop"}"""),
            // Loop points are counted at the track's own rate, which every loop names.
            command("playback.setLoop", """{"queueRevision":1,"startFrame":0,"endFrame":48000}"""),
            command("playback.setLoop", """{"queueRevision":1,"startFrame":0,"endFrame":48000,"sampleRate":0}"""),
            command("playback.setLoop", """{"queueRevision":1,"startFrame":0,"endFrame":48000,"sampleRate":384000}"""),
            load(items = "[" + List(PlaybackBridge.MAX_QUEUE_ITEMS + 1) { item }.joinToString(",") + "]"),
            load(currentIndex = 1),
            load(positionMs = "-1"),
            load(loop = """{"startFrame":10,"endFrame":10,"sampleRate":48000}"""),
            load(loop = """{"startFrame":10,"endFrame":20}"""),
            load(autoplay = "\"yes\""),
            load(revision = 0),
            command("playback.loadQueue", """{"queueRevision":1}"""),
            command("playback.seek", """{"queueRevision":1}"""),
            command("playback.pause", """{"now":true}"""),
            command("playback.snapshot", """{"x":1}"""),
        )
        cases.forEach { assertEquals(it, "invalid_payload", errorCode(send(sandbox, it))) }
        assertEquals(NativePlaybackState.IDLE, playback.controller.snapshot.state)
    }

    @Test
    fun snapshotIsPathFreeAndNamesTheNativeClient() {
        send(sandbox, handshake())
        val payload = send(sandbox, command("playback.snapshot"))!!.getJSONObject("payload")
        assertEquals("idle", payload.getString("state"))
        val expected = fixture.getJSONObject("handshakeResponse").getJSONObject("payload").getJSONObject("playback")
        assertEquals(expected.getString("clientId"), payload.getString("clientId"))
    }

    @Test
    fun eventsReachOnlyTheNegotiatedDocument() {
        val sent = mutableListOf<String>()
        val event = NativePlaybackEvent.CurrentItem(
            NativePlaybackSnapshot(playback.controller.clientId, NativePlaybackState.PLAYING, 4, 1, 250, 180_000),
            CurrentItemReason.ADVANCE,
        )
        sandbox.emit(event)
        sandbox.handle(handshake(), ORIGIN, true) { sent += it }
        sandbox.emit(event)
        sandbox.reset()
        sandbox.emit(event)

        assertEquals(2, sent.size)
        val message = BridgeCodec.parse(sent[1])
        assertEquals("event", message.type)
        assertEquals("playback.currentItem", message.name)
        assertEquals(4, message.payload.getInt("queueRevision"))
        assertEquals(1, message.payload.getInt("currentIndex"))
        assertEquals("advance", message.payload.getString("reason"))
        assertFalse(sent[1].contains("path"))
    }

    @Test
    fun theWebCannotRelayListenWritesOrReleaseTheClaim() {
        send(sandbox, handshake())
        listOf(
            command("playback.listenEffect", """{"effect":"complete","body":{"title":"Signal 1"}}"""),
            command("playback.releaseOwnership"),
        ).forEach { assertEquals("unsupported_command", errorCode(send(sandbox, it))) }
    }

    @Test
    fun stateEventMatchesTheSharedFixture() {
        val expected = fixture.getJSONObject("stateEvent")
        val payload = expected.getJSONObject("payload")
        val (name, encoded) = PlaybackBridge.encode(
            NativePlaybackEvent.State(
                NativePlaybackSnapshot(
                    payload.getString("clientId"), NativePlaybackState.PLAYING, 1, 0, 1_250, 180_000,
                ),
            ),
        )
        assertEquals(expected.getString("name"), name)
        assertSameJson(payload, encoded)
    }

    @Test
    fun onlyChangesMadeBySystemControlsNameTheirInitiatorAndQueueMetadataNeverReachesTheWeb() {
        val item = QueueItem("opaque-ref", "T", "A", "B", null, 1_000, listenKey = "lk1-0123abcd")
        val snapshot = NativePlaybackSnapshot(
            playback.controller.clientId, NativePlaybackState.PAUSED, 2, 0, 500, 1_000, items = listOf(item),
        )
        val web = PlaybackBridge.encode(NativePlaybackEvent.State(snapshot)).second
        val system = PlaybackBridge.encode(NativePlaybackEvent.State(snapshot, CommandSource.SYSTEM)).second
        val next = PlaybackBridge.encode(
            NativePlaybackEvent.CurrentItem(snapshot, CurrentItemReason.NEXT, source = CommandSource.SYSTEM),
        ).second

        assertFalse(web.has("initiator"))
        assertEquals("system", system.getString("initiator"))
        assertEquals("system", next.getString("initiator"))
        listOf(web, system, next).forEach { payload ->
            assertFalse(payload.has("items"))
            assertFalse(payload.toString().contains("opaque-ref"))
        }
    }

    private fun load(
        revision: Int = 1,
        items: String = """[{"playbackRef":"opaque-ref","title":"T","artist":"A","album":"B","artworkUrl":null,"durationMs":1000,"trackNumber":"1","listenKey":"lk1-0123abcd","queueGroup":0}]""",
        currentIndex: Int = 0,
        positionMs: String = "0",
        loop: String = "null",
        autoplay: String = "false",
        keepCurrent: String? = null,
    ) = command(
        "playback.loadQueue",
        """{"queueRevision":$revision,"items":$items,"currentIndex":$currentIndex,""" +
            """"positionMs":$positionMs,"loop":$loop,"autoplay":$autoplay""" +
            (keepCurrent?.let { ""","keepCurrent":$it""" } ?: "") + "}",
    )

    private fun ok(reply: JSONObject?): Boolean = reply!!.getJSONObject("payload").getBoolean("ok")

    @Test
    fun updateCommandsReachTheUpdaterWithTheSiteBridgeRange() {
        send(sandbox, handshake(1, 2))
        for (name in listOf("updates.check", "updates.download", "updates.install")) {
            val payload = send(sandbox, command(name))!!.getJSONObject("payload")
            assertTrue(payload.getBoolean("ok"))
            assertEquals("idle", payload.getJSONObject("updates").getString("state"))
        }
        assertEquals(listOf("check", "download", "install"), updates.calls)
        assertEquals(1..2, updates.checkedWith)
    }

    @Test
    fun updateCommandsNeedAHandshakeAnEmptyPayloadAndAnApplicableState() {
        assertEquals("handshake_required", errorCode(send(sandbox, command("updates.check"))))
        send(sandbox, handshake())
        assertEquals("invalid_payload", errorCode(send(sandbox, command("updates.download", """{"url":"https://evil.example/a.apk"}"""))))
        updates.applies = false
        assertEquals("update_unavailable", errorCode(send(sandbox, command("updates.install"))))
        assertEquals(listOf("install"), updates.calls)
    }

    @Test
    fun aBuildWithoutUpdatesAdvertisesAndAcceptsNone() {
        val plain = controller(ShellChannel.STABLE, "org.albumhaven.app", updates = null)
        val payload = send(plain, handshake())!!.getJSONObject("payload")
        val names = payload.getJSONArray("capabilities").let { array -> (0 until array.length()).map(array::getString) }
        assertFalse(names.contains("updates.manual.v1"))
        assertFalse(payload.has("updates"))
        assertEquals("unsupported_command", errorCode(send(plain, command("updates.check"))))
    }

    @Test
    fun updateEventsMatchTheSharedFixtureAndGoOnlyToTheNegotiatedDocument() {
        val expected = fixture.getJSONObject("updateStateEvent")
        val sent = mutableListOf<JSONObject>()
        val state = UpdateState.Downloading(manifest(), 1721)
        sandbox.emit(state)
        sandbox.handle(handshake(), ORIGIN, true) { sent += JSONObject(it) }
        sandbox.emit(state)
        val event = sent.last()
        assertEquals(2, sent.size)
        assertEquals(expected.getString("name"), event.getString("name"))
        assertEquals("event", event.getString("type"))
        assertSameJson(expected.getJSONObject("payload"), event.getJSONObject("payload"))
        sandbox.reset()
        sandbox.emit(state)
        assertEquals(2, sent.size)
    }

    private fun errorCode(reply: JSONObject?): String =
        reply!!.getJSONObject("payload").getJSONObject("error").getString("code")

    private val link = fixture.getJSONObject("downloadLinkResponse").getJSONObject("payload").getString("url")

    /** A negotiated sandbox document, recording everything the shell posts to it. */
    private fun negotiated(): MutableList<JSONObject> {
        val sent = mutableListOf<JSONObject>()
        sandbox.handle(handshake(), ORIGIN, true) { sent += JSONObject(it) }
        sent.clear()
        return sent
    }

    private fun answer(id: String, payload: String, protocol: Int = 1) =
        """{"protocol":$protocol,"id":"$id","type":"response","name":"downloads.link","payload":$payload}"""

    @Test
    fun aDownloadLinkIsAskedOfTheNegotiatedDocumentAndItsAnswerIsTheLink() {
        val sent = negotiated()
        val links = mutableListOf<String?>()
        val path = "/utilities/integrations/foobar/assets/text-tools-standard-preset?download=1"
        val id = sandbox.requestDownloadLink(path) { links += it }!!
        val expected = fixture.getJSONObject("downloadLinkRequest").put("id", id)
        assertSameJson(expected, sent.single())

        val response = fixture.getJSONObject("downloadLinkResponse").put("id", id)
        assertNull(send(sandbox, response.toString()))
        assertEquals(listOf<String?>(link), links)
        // Answered once; a repeat is ignored.
        send(sandbox, answer(id, """{"ok":true,"url":"$link"}"""))
        assertEquals(listOf<String?>(link), links)
    }

    /** A malformed link is refused when it would be enqueued (DownloadsTest). */
    @Test
    fun aRefusedOrMalformedAnswerIsNoLink() {
        negotiated()
        val answers = listOf(
            """{"ok":false,"error":{"code":"download_unavailable","message":"Download unavailable."}}""",
            """{"ok":true}""",
            """{"ok":true,"url":7}""",
            """{"ok":"true","url":"$link"}""",
        )
        for (payload in answers) {
            val links = mutableListOf<String?>()
            val id = sandbox.requestDownloadLink("/a") { links += it }!!
            send(sandbox, answer(id, payload))
            assertEquals(payload, listOf<String?>(null), links)
        }
    }

    @Test
    fun anAnswerForAnotherRequestOrProtocolIsIgnored() {
        negotiated()
        val links = mutableListOf<String?>()
        val id = sandbox.requestDownloadLink("/a") { links += it }!!
        send(sandbox, answer(ID, """{"ok":true,"url":"$link"}"""))
        send(sandbox, answer(id, """{"ok":true,"url":"$link"}""", protocol = 2))
        send(sandbox, answer(id, """{"ok":true,"url":"$link"}"""), origin = "https://sandbox3.albumhaven.org")
        assertEquals(emptyList<String?>(), links)
    }

    @Test
    fun withoutANegotiatedDocumentOrOnceItGoesThereIsNoLink() {
        val links = mutableListOf<String?>()
        assertNull(sandbox.requestDownloadLink("/a") { links += it })
        assertEquals(listOf<String?>(null), links)

        negotiated()
        val id = sandbox.requestDownloadLink("/a") { links += it }!!
        sandbox.reset()
        assertEquals(listOf<String?>(null, null), links)
        send(sandbox, answer(id, """{"ok":true,"url":"$link"}"""))
        assertEquals(listOf<String?>(null, null), links)
    }

    @Test
    fun anAbandonedRequestIsNoLinkAndItsLateAnswerIsIgnored() {
        negotiated()
        val links = mutableListOf<String?>()
        val id = sandbox.requestDownloadLink("/a") { links += it }!!
        sandbox.abandonPageCommand(id)
        send(sandbox, answer(id, """{"ok":true,"url":"$link"}"""))
        sandbox.abandonPageCommand(id)
        assertEquals(listOf<String?>(null), links)
    }

    @Test
    fun filesAreSavedOnlyByABuildThatCanStoreThem() {
        val request = fixture.getJSONObject("fileSaveRequest")
        val file = request.getJSONObject("payload").toString()
        send(sandbox, handshake())
        assertTrue(ok(send(sandbox, request.toString())))
        assertEquals(listOf(request.getJSONObject("payload").getString("name")), savedFiles)

        val plain = controller(ShellChannel.STABLE, "org.albumhaven.app", files = null)
        val names = send(plain, handshake())!!.getJSONObject("payload").getJSONArray("capabilities").let { array -> (0 until array.length()).map(array::getString) }
        assertFalse(names.contains("files.save.v1"))
        assertTrue(names.contains("downloads.link.v1"))
        assertEquals("unsupported_command", errorCode(send(plain, command("files.save", file))))
    }

    @Test
    fun aPageReportsItsCopyAndIsToldWhenASwitchLeftItsOriginUnannounced() {
        send(sandbox, handshake())
        assertTrue(ok(send(sandbox, command("copy.state", """{"stored":true}"""))))
        assertTrue(ok(send(sandbox, command("copy.state", """{"stored":false}"""))))
        assertEquals(listOf(true, false), copies.reports)
        for (invalid in listOf("""{}""", """{"stored":"true"}""", """{"stored":true,"url":"/"}""")) {
            assertEquals(invalid, "invalid_payload", errorCode(send(sandbox, command("copy.state", invalid))))
        }
        assertEquals(listOf(true, false), copies.reports)

        copies.forgetPending = true
        val payload = send(sandbox, handshake())!!.getJSONObject("payload")
        assertTrue(payload.getJSONObject("appCopy").getBoolean("forget"))
    }

    @Test
    fun aShellWithoutCopiesOffersNoneAndForgetsAtOnce() {
        val plain = controller(ShellChannel.SANDBOX, "org.albumhaven.app.sandbox", copies = null)
        val payload = send(plain, handshake())!!.getJSONObject("payload")
        val names = payload.getJSONArray("capabilities").let { array -> (0 until array.length()).map(array::getString) }
        assertFalse(names.contains("app.copy.v1"))
        assertFalse(payload.has("appCopy"))
        assertEquals("unsupported_command", errorCode(send(plain, command("copy.state", """{"stored":true}"""))))
        var forgotten = 0
        assertNull(plain.requestCopyForget { forgotten++ })
        assertEquals(1, forgotten)
    }

    @Test
    fun theShellAsksThePageToForgetItsCopyBeforeASwitch() {
        val sent = negotiated()
        var forgotten = 0
        val id = sandbox.requestCopyForget { forgotten++ }!!
        val asked = sent.single()
        assertEquals("command", asked.getString("type"))
        assertEquals("copy.forget", asked.getString("name"))
        assertEquals(0, asked.getJSONObject("payload").length())
        // An answer named for another command is not this one's.
        send(sandbox, """{"protocol":1,"id":"$id","type":"response","name":"downloads.link","payload":{"ok":true}}""")
        assertEquals(0, forgotten)
        send(sandbox, """{"protocol":1,"id":"$id","type":"response","name":"copy.forget","payload":{"ok":true}}""")
        assertEquals(1, forgotten)

        // Unanswered, the switch still goes ahead once the shell stops waiting, or the page goes.
        sandbox.abandonPageCommand(sandbox.requestCopyForget { forgotten++ }!!)
        sandbox.requestCopyForget { forgotten++ }
        sandbox.reset()
        assertEquals(3, forgotten)
    }
}
