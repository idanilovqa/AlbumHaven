package org.albumhaven.shell

import android.content.Intent
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.webkit.WebViewFeature
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Owner report (2026-11-09): the app crashed when it opened a system Settings screen, as its
 * update flow does for "Appear on top": the page's picture was taken of a window whose surface
 * was already gone. The user leaves the app for each Settings screen it opens and comes back.
 */
@RunWith(AndroidJUnit4::class)
class LeaveForSettingsTest {
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val packageName = InstrumentationRegistry.getInstrumentation().targetContext.packageName
    private val origin = DeviceOrigin { DeviceOrigin.html(PAGE) }.start(DeviceOrigin.DEV_PORT)

    @After
    fun tearDown() = origin.close()

    @Test
    fun leavingForEachSettingsScreenTheAppOpensDoesNotCrashIt() {
        assumeTrue(
            "The stock API-29 emulator WebView has no message listener, so no page is shown to picture",
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
        )
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitForPage(scenario)
            val settingsScreens = listOf(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, "package:$packageName".toUri()),
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri()),
            )
            for (screen in settingsScreens) {
                scenario.onActivity { it.startActivity(screen) }
                waitUntil("${screen.action} on screen") { device.currentPackageName != packageName }
                waitUntil("the app stopped behind ${screen.action}") { scenario.state == Lifecycle.State.CREATED }
                // The picture is saved off the main thread; a crash there ends this process and the test.
                Thread.sleep(2_000)
                device.pressBack()
                waitUntil("the app back from ${screen.action}") { scenario.state == Lifecycle.State.RESUMED }
                waitForPage(scenario)
            }
        }
    }

    /** The page is on screen, answered over the bridge, and nothing covers it. */
    private fun waitForPage(scenario: ActivityScenario<ShellActivity>) = waitUntil("the page") {
        var shown = false
        scenario.onActivity { activity ->
            val web = activity.findViewById<WebView>(R.id.shell_web_view)
            shown = web.title == "replied" && web.url.orEmpty().startsWith(BuildConfig.DEV_ORIGIN) && web.isShown &&
                activity.findViewById<View>(R.id.recovery_root).visibility != View.VISIBLE
        }
        shown
    }.also {
        assertEquals(packageName, device.currentPackageName)
        assertFalse(device.hasObject(By.res(packageName, "recovery_root")))
    }

    private companion object {
        const val PAGE = """<!doctype html><title>Library</title><body style="background:#2a6">Library
<script>
AlbumHavenBridge.onmessage = () => { document.title = 'replied'; };
AlbumHavenBridge.postMessage(JSON.stringify({
  protocol: 1, id: '6f0e2a5c-4c1f-4a3e-9f17-2b8f4f1f7a11', type: 'command',
  name: 'bridge.handshake', payload: { protocolMin: 1, protocolMax: 1 },
}));
</script>"""
    }
}
