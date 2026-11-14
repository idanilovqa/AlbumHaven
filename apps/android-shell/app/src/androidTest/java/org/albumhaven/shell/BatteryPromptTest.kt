package org.albumhaven.shell

import android.content.Context
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.WebView
import androidx.core.content.edit
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.webkit.WebViewFeature
import mockwebserver3.MockResponse
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern

/**
 * Owner decision (2026-11-14): on every phone where battery saving can close the app in the
 * background, the library offers once to set Battery to Unrestricted; any answer is final, and an
 * offer left unanswered comes back on the next library view.
 */
@RunWith(AndroidJUnit4::class)
class BatteryPromptTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val context: Context = instrumentation.targetContext
    private val packageName = context.packageName
    private var origin: DeviceOrigin? = null

    @Before
    fun startOptimizedAndUnanswered() {
        setUnrestricted(false)
        context.getSharedPreferences("shell", Context.MODE_PRIVATE).edit(commit = true) { remove("battery_prompt_answered") }
    }

    @After
    fun tearDown() {
        origin?.close()
        setUnrestricted(false)
    }

    @Test
    fun androidsOwnQuestionSetsUnrestrictedOnAllowAndNothingOnDeny() {
        askAndroid()
        answerAndroid(DENY)
        waitUntil("Android's question gone") { !device.hasObject(By.text(Pattern.compile(DENY, Pattern.CASE_INSENSITIVE))) }
        assertFalse(ignoringOptimizations())

        askAndroid()
        answerAndroid(ALLOW)
        waitUntil("Unrestricted") { ignoringOptimizations() }
    }

    @Test
    fun theLibraryOffersItAndAllowSetsUnrestrictedForGood() = withLibrary {
        launch { scenario ->
            val card = waitForOffer()
            assertEquals("Keep Album Haven running", text("battery_prompt_title"))
            assertEquals(
                "Battery saving can close it in the background, so the library reloads when you come back.",
                text("battery_prompt_reason"),
            )
            assertEquals("Set to Unrestricted", text("battery_prompt_allow"))
            assertEquals("No thanks", text("battery_prompt_decline"))
            // Non-blocking: the page stays on screen around it, and nothing else covers it.
            assertTrue(card.visibleBounds.bottom < device.displayHeight / 2)
            assertPageShown(scenario)
            // A tap on the card's text stays on the card; the page under it never sees it.
            device.findObject(By.res(packageName, "battery_prompt_reason")).click()
            Thread.sleep(500)
            assertPageShown(scenario)

            device.findObject(By.res(packageName, "battery_prompt_allow")).click()
            answerAndroid(ALLOW)
            waitUntil("back in the app") { scenario.state == Lifecycle.State.RESUMED && device.currentPackageName == packageName }
            waitUntil("the offer gone") { !device.hasObject(By.res(packageName, "battery_prompt")) }
            assertTrue(ignoringOptimizations())
            assertPageShown(scenario)
        }
        setUnrestricted(false)
        launch { scenario -> assertNoOffer(scenario) }
    }

    @Test
    fun denyInAndroidsQuestionIsFinal() = withLibrary {
        launch { scenario ->
            waitForOffer()
            device.findObject(By.res(packageName, "battery_prompt_allow")).click()
            answerAndroid(DENY)
            waitUntil("back in the app") { scenario.state == Lifecycle.State.RESUMED && device.currentPackageName == packageName }
            waitUntil("the offer gone") { !device.hasObject(By.res(packageName, "battery_prompt")) }
            assertFalse(ignoringOptimizations())
            assertPageShown(scenario)
        }
        launch { scenario -> assertNoOffer(scenario) }
    }

    @Test
    fun noThanksIsFinal() = withLibrary {
        launch { scenario ->
            waitForOffer()
            device.findObject(By.res(packageName, "battery_prompt_decline")).click()
            waitUntil("the offer gone") { !device.hasObject(By.res(packageName, "battery_prompt")) }
            assertEquals(packageName, device.currentPackageName)
            assertPageShown(scenario)
        }
        launch { scenario -> assertNoOffer(scenario) }
        assertFalse(ignoringOptimizations())
    }

    @Test
    fun anUnansweredOfferComesBackOnTheNextLaunch() = withLibrary {
        launch { waitForOffer() }
        launch { waitForOffer() }
    }

    @Test
    fun anAlreadyUnrestrictedAppIsNeverOffered() = withLibrary {
        setUnrestricted(true)
        launch { scenario -> assertNoOffer(scenario) }
    }

    @Test
    fun theSignInPageIsNotTheLibrary() {
        assumeBridge()
        origin = DeviceOrigin { request ->
            if (request.url.encodedPath == "/login") DeviceOrigin.html(DeviceOrigin.LIBRARY_PAGE)
            else MockResponse.Builder().code(302).addHeader("Location", "/login").build()
        }.start(DeviceOrigin.DEV_PORT)
        launch { scenario ->
            assertNoOffer(scenario)
            assertTrue(onActivity(scenario) { it.findViewById<WebView>(R.id.shell_web_view).url }.orEmpty().endsWith("/login"))
        }
    }

    private fun withLibrary(body: () -> Unit) {
        assumeBridge()
        origin = DeviceOrigin { DeviceOrigin.html(DeviceOrigin.LIBRARY_PAGE) }.start(DeviceOrigin.DEV_PORT)
        body()
    }

    private fun assumeBridge() = assumeTrue(
        "The stock API-29 emulator WebView has no message listener, so the shell shows no library",
        WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
    )

    private fun launch(body: (ActivityScenario<ShellActivity>) -> Unit) =
        ActivityScenario.launch(ShellActivity::class.java).use { scenario ->
            waitForPage(scenario)
            body(scenario)
        }

    private fun waitForOffer() = device.wait(Until.findObject(By.res(packageName, "battery_prompt")), OFFER_WAIT_MS)
        ?: throw AssertionError("The battery offer never appeared")

    /** Well past the offer's delay after the handshake, with the library on screen. */
    private fun assertNoOffer(scenario: ActivityScenario<ShellActivity>) {
        assertFalse(device.wait(Until.hasObject(By.res(packageName, "battery_prompt")), OFFER_WAIT_MS))
        assertPageShown(scenario)
    }

    private fun text(id: String): String = device.findObject(By.res(packageName, id)).text

    private fun askAndroid() {
        context.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** Android's own dialog; its buttons are upper-cased on some versions. */
    private fun answerAndroid(answer: String) {
        val button = device.wait(Until.findObject(By.text(Pattern.compile(answer, Pattern.CASE_INSENSITIVE))), DIALOG_WAIT_MS)
        assertNotNull("Android's \"$answer\"", button)
        button.click()
    }

    private fun ignoringOptimizations() = context.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    private fun setUnrestricted(on: Boolean) {
        // Read to the end: closing the output early can end the command before it changes anything.
        val output = instrumentation.uiAutomation.executeShellCommand("dumpsys deviceidle whitelist ${if (on) "+" else "-"}$packageName")
        ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
        waitUntil("Unrestricted=$on") { ignoringOptimizations() == on }
    }

    private fun waitForPage(scenario: ActivityScenario<ShellActivity>) = waitUntil("the page") { pageShown(scenario) }

    private fun assertPageShown(scenario: ActivityScenario<ShellActivity>) = assertTrue("the page on screen", pageShown(scenario))

    private fun pageShown(scenario: ActivityScenario<ShellActivity>) = onActivity(scenario) { activity ->
        val web = activity.findViewById<WebView>(R.id.shell_web_view)
        web.title == "replied" && web.url.orEmpty().startsWith(BuildConfig.DEV_ORIGIN) && web.isShown &&
            activity.findViewById<View>(R.id.recovery_root).visibility != View.VISIBLE
    }

    private fun <T> onActivity(scenario: ActivityScenario<ShellActivity>, read: (ShellActivity) -> T): T {
        var value: T? = null
        scenario.onActivity { value = read(it) }
        @Suppress("UNCHECKED_CAST")
        return value as T
    }

    private companion object {
        const val ALLOW = "Allow"
        const val DENY = "Deny"
        const val OFFER_WAIT_MS = 6_000L
        const val DIALOG_WAIT_MS = 10_000L
    }
}
