package org.albumhaven.shell

import android.view.View
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.PrintWriter
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

private const val PORT = 18765
private const val HANDSHAKE_PAGE = """<!doctype html><title>Smoke</title>
<a id="external" href="https://example.com/">external</a>
<script>
document.title = window.AlbumHavenBridge ? 'bridge-present' : 'bridge-absent';
if (window.AlbumHavenBridge) {
  AlbumHavenBridge.onmessage = event => { window.reply = event.data; document.title = 'replied'; };
  AlbumHavenBridge.postMessage(JSON.stringify({
    protocol: 1, id: '6f0e2a5c-4c1f-4a3e-9f17-2b8f4f1f7a10', type: 'command',
    name: 'bridge.handshake', payload: { protocolMin: PROTOCOL_MIN, protocolMax: PROTOCOL_MAX },
  }));
}
</script>"""

/** Runs against the debug dev origin: -PalbumHavenDevOrigin=http://127.0.0.1:18765. */
@RunWith(AndroidJUnit4::class)
class ShellSmokeTest {
    private var server: ServerSocket? = null

    private fun serve(protocolMin: Int = 1, protocolMax: Int = 1) {
        val socket = ServerSocket()
        socket.reuseAddress = true
        socket.bind(InetSocketAddress("127.0.0.1", PORT))
        server = socket
        val body = HANDSHAKE_PAGE
            .replace("PROTOCOL_MIN", protocolMin.toString())
            .replace("PROTOCOL_MAX", protocolMax.toString())
        thread(isDaemon = true) {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: java.io.IOException) {
                    break
                }
                client.use {
                    val reader = it.getInputStream().bufferedReader()
                    while (!reader.readLine().isNullOrEmpty()) { /* Drain request headers. */ }
                    PrintWriter(it.getOutputStream()).apply {
                        print("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n$body")
                        flush()
                    }
                }
            }
        }
    }

    private fun stopServer() {
        server?.close()
        server = null
    }

    @After
    fun tearDown() = stopServer()

    private fun <T> onActivity(scenario: ActivityScenario<ShellActivity>, read: (ShellActivity) -> T): T {
        var value: Result<T>? = null
        scenario.onActivity { value = runCatching { read(it) } }
        return value!!.getOrThrow()
    }

    private fun waitUntil(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(100)
        }
        throw AssertionError("Timed out waiting for $what")
    }

    private fun evaluate(scenario: ActivityScenario<ShellActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        scenario.onActivity {
            it.findViewById<WebView>(R.id.shell_web_view).evaluateJavascript(script) { value ->
                result = value
                latch.countDown()
            }
        }
        assertTrue(latch.await(10, TimeUnit.SECONDS))
        return result
    }

    private fun webTitle(scenario: ActivityScenario<ShellActivity>): String? =
        onActivity(scenario) { it.findViewById<WebView>(R.id.shell_web_view).title }

    private fun recoveryVisible(scenario: ActivityScenario<ShellActivity>): Boolean =
        onActivity(scenario) { it.findViewById<View>(R.id.recovery_root).visibility == View.VISIBLE }

    private fun retryVisible(scenario: ActivityScenario<ShellActivity>): Boolean =
        onActivity(scenario) { it.findViewById<View>(R.id.recovery_retry).visibility == View.VISIBLE }

    private fun alertVisible(scenario: ActivityScenario<ShellActivity>): Boolean =
        onActivity(scenario) { it.findViewById<View>(R.id.recovery_alert).visibility == View.VISIBLE }

    private fun requireBridgeSupport() {
        assumeTrue(
            "The stock API-29 emulator WebView has no message listener",
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
        )
    }

    @Test
    fun outdatedWebViewFailsClosedWithoutLoadingTheSite() {
        assumeTrue(!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            assertTrue(recoveryVisible(scenario))
            assertFalse(retryVisible(scenario))
            assertEquals(null, onActivity(scenario) { it.findViewById<WebView>(R.id.shell_web_view).url })
        }
    }

    @Test
    fun handshakeNegotiatesOverRealBridge() {
        requireBridgeSupport()
        serve()
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitUntil("bridge reply") { webTitle(scenario) == "replied" }
            val reply = JSONObject(evaluate(scenario, "window.reply").let { JSONObject("{\"v\":$it}").getString("v") })
            val payload = reply.getJSONObject("payload")
            assertTrue(payload.getBoolean("ok"))
            assertEquals(BuildConfig.CHANNEL, payload.getString("variant"))
            assertEquals(BuildConfig.DEV_ORIGIN, payload.getString("origin"))
            assertEquals("webview", payload.getJSONObject("playback").getString("state"))
            assertFalse(recoveryVisible(scenario))
        }
    }

    @Test
    fun incompatibleWebShowsUpdateRequired() {
        requireBridgeSupport()
        serve(protocolMin = 9, protocolMax = 9)
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitUntil("update required") { alertVisible(scenario) }
            assertFalse(retryVisible(scenario))
        }
    }

    @Test
    fun connectionFailureRecoversThroughRetry() {
        requireBridgeSupport()
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitUntil("recovery") { alertVisible(scenario) && retryVisible(scenario) }
            serve()
            scenario.onActivity { it.findViewById<View>(R.id.recovery_retry).performClick() }
            waitUntil("page after retry") { webTitle(scenario) == "replied" && !recoveryVisible(scenario) }
        }
    }

    @Test
    fun activityRecreationKeepsThePageAndRenegotiates() {
        requireBridgeSupport()
        serve()
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitUntil("first handshake") { webTitle(scenario) == "replied" }
            scenario.recreate()
            waitUntil("recreated page") { webTitle(scenario) == "replied" && !recoveryVisible(scenario) }
            assertTrue(onActivity(scenario) { it.findViewById<WebView>(R.id.shell_web_view).url }.orEmpty().startsWith(BuildConfig.DEV_ORIGIN))
        }
    }

    @Test
    fun externalNavigationLeavesTheWebViewOnItsOrigin() {
        requireBridgeSupport()
        serve()
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitUntil("page") { webTitle(scenario) == "replied" }
            evaluate(scenario, "location.href = 'https://example.com/'")
            Thread.sleep(1_000)
            assertTrue(onActivity(scenario) { it.findViewById<WebView>(R.id.shell_web_view).url }.orEmpty().startsWith(BuildConfig.DEV_ORIGIN))
        }
    }
}
