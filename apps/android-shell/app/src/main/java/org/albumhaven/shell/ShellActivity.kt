package org.albumhaven.shell

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.albumhaven.shell.playback.PlaybackServiceBinder
import org.albumhaven.shell.playback.PlaybackServiceHandle
import org.albumhaven.shell.updates.UpdateState
import org.albumhaven.shell.updates.Updater
import org.albumhaven.shell.updates.Updates
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ShellActivity : ComponentActivity(), BridgeHost {

    private val originPolicy = OriginPolicy.forBuild
    /** Sandbox probes and download requests, which touch the network and storage. */
    private val ioExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var preferences: ShellPreferences
    private lateinit var sandboxes: SandboxChoice

    // Unset only while a sandbox build waits for its first sandbox; every page belongs to it.
    private lateinit var siteOrigin: String
    private lateinit var bridge: BridgeController

    // The bridge exists only once the playback service is bound, so it always has a player. The page
    // loads meanwhile; its messages wait in earlyBridgeMessages.
    private var playback: PlaybackServiceHandle? = null
    private var playbackBound = false
    private val page = ShellPage(originPolicy)
    private var updater: Updater? = null
    private val updateEvents: (UpdateState) -> Unit = { state ->
        // Settings and Update required show one failure message; the details are only logged.
        if (state is UpdateState.Failed) Log.w(TAG, "Update failed: ${state.error.wireName} (${state.reason ?: "no reason"})")
        bridge.emit(state)
        updateRequired?.let { flow ->
            flow.onState(state)
            showUpdateRequired()
        }
    }

    /** Set while the native Update required screen covers a site this app cannot run. */
    private var updateRequired: UpdateRequiredFlow? = null
    private val playbackConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val service = (binder as PlaybackServiceBinder).handle
            playback = service
            if (::siteOrigin.isInitialized) service.selectOrigin(siteOrigin)
            bridge = BridgeController(
                ShellIdentity(packageName, originPolicy.channel, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong()),
                this@ShellActivity,
                service.port,
                updater?.let(::ShellUpdatePort),
                FileSaves(MediaStoreDownloads(contentResolver), ioExecutor, mainHandler::post, ::onFileSaved),
            )
            service.setEventListener { event -> bridge.emit(event) }
            updater?.addListener(updateEvents)
            earlyBridgeMessages.forEach { it() }
            earlyBridgeMessages.clear()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            playback = null
        }
    }
    private lateinit var webView: WebView
    private lateinit var recovery: RecoveryPanel
    private lateinit var lastScreen: LastScreen
    private lateinit var lastScreenView: ImageView
    private lateinit var sandboxWarning: View
    private val handshakes = HandshakeWatch(originPolicy.channel)
    private val handshakeTimeout = Runnable {
        if (!handshakes.timedOut() || recovery.choosingSandbox) return@Runnable
        Log.w(TAG, "bridge_handshake_timeout")
        sandboxWarning.isVisible = true
    }

    private var mainFrameFailed = false
    private var incompatibleWeb = false
    private var sandboxProbePending = false
    private var clearHistoryOnNextPage = false

    /** The loading document's bridge messages from before the playback service bound, answered once it has. */
    private val earlyBridgeMessages = mutableListOf<() -> Unit>()
    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooser = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileChooserCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileChooserCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_shell)
        applySystemBarInsets(findViewById(R.id.shell_root))

        preferences = ShellPreferences(this)
        sandboxes = SandboxChoice(originPolicy, preferences)
        val origin = sandboxes.origin
        updater = Updates.get(this)
        // Once per process: a cold launch checks when the last successful check is six hours old.
        // Before a sandbox is chosen there is no origin to check.
        if (origin != null) updater?.passiveCheckIfDue()
        recovery = RecoveryPanel(findViewById(R.id.recovery_root))
        lastScreen = LastScreen(cacheDir, ioExecutor)
        lastScreenView = findViewById(R.id.last_screen)
        webView = findViewById(R.id.shell_web_view)
        sandboxWarning = findViewById(R.id.sandbox_warning)
        findViewById<View>(R.id.sandbox_warning_switch).setOnClickListener { showSandboxChoice() }
        findViewById<View>(R.id.sandbox_warning_dismiss).setOnClickListener { sandboxWarning.isVisible = false }

        // The system WebView is too old for the bridge; updating this app cannot fix that.
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            recovery.showUpdate(UpdateRequiredView(UpdateStep.REQUIRED), onAction = null)
            return
        }
        configureWebView()
        onBackPressedDispatcher.addCallback(this) {
            // The page under the chooser stays where it is.
            if (!recovery.choosingSandbox && webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
        }
        if (origin != null) siteOrigin = origin
        val startUrl = origin?.let { page.restore(savedInstanceState?.getString(STATE_ORIGIN), savedInstanceState?.getString(STATE_URL), it) }
        Log.i(TAG, "create saved_state=${savedInstanceState != null} saved_page=${page.url != null} has_origin=${origin != null}")
        logProcessExitReasons()
        // The page loads while the playback service binds; the bridge answers it once bound.
        // Only a page Android ended in the background comes back as it was; a full restart opens Home.
        if (startUrl != null) open(startUrl, asLeft = page.url != null) else showSandboxChoice()
        playbackBound = bindService(
            PlaybackService.shellBindIntent(this),
            playbackConnection,
            BIND_AUTO_CREATE,
        )
    }

    /** Why this app's earlier processes ended, once per process, so a device session tells a crash from a kill. */
    private fun logProcessExitReasons() {
        if (exitReasonsLogged || Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        exitReasonsLogged = true
        val activityManager = getSystemService(ActivityManager::class.java)
        ioExecutor.execute {
            activityManager.getHistoricalProcessExitReasons(packageName, 0, EXIT_REASONS_LOGGED).forEach {
                Log.i(TAG, "process_exit reason=${it.reason} status=${it.status} importance=${it.importance} at=${it.timestamp} process=${it.processName}")
            }
        }
    }

    /** Only the origin and the page's URL: never the WebView's state, which outgrows the transaction limit. */
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (!::siteOrigin.isInitialized) return
        outState.putString(STATE_ORIGIN, siteOrigin)
        outState.putString(STATE_URL, page.url)
    }

    override fun onStart() {
        super.onStart()
        if (::siteOrigin.isInitialized) page.onStart(siteOrigin)?.let { open(it, asLeft = true) }
    }

    override fun onResume() {
        super.onResume()
        // Returning from Android's install-source setting.
        updater?.onForeground()
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
        // Only a page the user actually sees is pictured; never a native screen or an older picture.
        val url = page.url
        if (url != null && ::siteOrigin.isInitialized && !recovery.showing && !lastScreenView.isVisible) {
            lastScreen.capture(this, webView, siteOrigin, url)
        }
    }

    override fun onDestroy() {
        // Playback belongs to the service and outlives the Activity; only its document and listeners go.
        playback?.setEventListener(null)
        if (::bridge.isInitialized) bridge.reset()
        updater?.removeListener(updateEvents)
        if (playbackBound) unbindService(playbackConnection)
        playback = null
        // A download already asked for is still handed to Android.
        ioExecutor.shutdown()
        mainHandler.removeCallbacksAndMessages(null)
        fileChooserCallback?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }

    override fun selectedOrigin(): String = siteOrigin

    override fun selectedSandboxSlot(): Int? = preferences.selectedSandboxSlot

    override fun takeConnectedSandboxSlot(): Int? = preferences.takeConnectedSandboxSlot()

    override fun onBridgeConnected() {
        handshakes.answered()
        sandboxWarning.isVisible = false
    }

    override fun onIncompatibleWeb(webProtocols: IntRange) {
        handshakes.answered()
        incompatibleWeb = true
        updateRequired = updater?.let { UpdateRequiredFlow(ShellUpdatePort(it), webProtocols) }
        showUpdateRequired()
    }

    /** A build without an update certificate offers no update, so its screen has no action. */
    private fun showUpdateRequired() {
        if (!incompatibleWeb || recovery.choosingSandbox) return
        val flow = updateRequired
        recovery.showUpdate(flow?.view ?: UpdateRequiredView(UpdateStep.REQUIRED), flow?.let { { it.act() } })
    }

    override fun selectSandbox(slot: Int, onResult: (connected: Boolean) -> Unit) {
        val origin = OriginPolicy.sandboxOrigin(slot)
        if (sandboxProbePending) {
            onResult(false)
            return
        }
        sandboxProbePending = true
        ioExecutor.execute {
            val reachable = isReachable(origin)
            mainHandler.post {
                if (isDestroyed) return@post
                sandboxProbePending = false
                onResult(reachable)
                if (reachable) {
                    preferences.switchSandbox(slot)
                    switchTo(origin)
                }
            }
        }
    }

    /** Switch sandbox, on a sandbox build's native screens; null leaves it out. */
    private val switchSandbox: (() -> Unit)? get() = if (sandboxes.offered) ::showSandboxChoice else null

    /** Covers everything until a sandbox is chosen; the chosen one connects at once, and the user signs in there. */
    private fun showSandboxChoice() {
        sandboxWarning.isVisible = false
        val initialSlot = preferences.selectedSandboxSlot ?: SandboxChoice.SUGGESTED_SLOT
        recovery.showSandboxChoice(initialSlot) { slot -> sandboxes.choose(slot)?.let(::switchTo) }
    }

    private fun switchTo(origin: String) {
        siteOrigin = origin
        // Playback, its claim and its queue stay with the origin that started them.
        playback?.selectOrigin(origin)
        // Back must never return to the previous sandbox origin.
        clearHistoryOnNextPage = true
        page.switched()
        open(origin)
    }

    private inner class ShellUpdatePort(private val updater: Updater) : UpdatePort {
        override val state get() = updater.state
        override fun check(webProtocols: IntRange) = updater.check(webProtocols)
        override fun download() = updater.download()
        override fun install() = updater.install(::prepareForPackageReplacement)
    }

    /** Sessions are flushed and playback is stopped, checkpointed and released before the package is replaced. */
    private fun prepareForPackageReplacement(done: () -> Unit) {
        CookieManager.getInstance().flush()
        playback?.prepareForPackageReplacement(done) ?: done()
    }

    private fun isReachable(origin: String): Boolean = try {
        val connection = URL("$origin/login").openConnection() as HttpURLConnection
        connection.instanceFollowRedirects = false
        connection.connectTimeout = PROBE_TIMEOUT_MS
        connection.readTimeout = PROBE_TIMEOUT_MS
        try {
            connection.responseCode < 500
        } finally {
            connection.disconnect()
        }
    } catch (_: java.io.IOException) {
        false
    }

    /**
     * Covers the page until [url] first draws: with the picture of it [asLeft] by the user when there
     * is one, else with the Connecting screen, which also replaces a picture that waits too long.
     */
    private fun open(url: String, asLeft: Boolean = false) {
        mainFrameFailed = false
        val picture = if (asLeft) lastScreen.load(siteOrigin, url, resources.configuration.orientation) else null
        hideLastScreen()
        if (picture != null) {
            recovery.hide()
            lastScreenView.setImageBitmap(picture)
            lastScreenView.isVisible = true
            mainHandler.postDelayed(lastScreenTimeout, LAST_SCREEN_MAX_MS)
        } else {
            recovery.showLoading(originHost(), switchSandbox)
        }
        webView.visibility = View.VISIBLE
        webView.loadUrl(url)
    }

    private val lastScreenTimeout = Runnable {
        hideLastScreen()
        if (!recovery.showing) recovery.showLoading(originHost(), switchSandbox)
    }

    private fun hideLastScreen() {
        mainHandler.removeCallbacks(lastScreenTimeout)
        lastScreenView.isVisible = false
        lastScreenView.setImageDrawable(null)
    }

    /**
     * A WebView whose renderer is gone must not be used again. Only the WebView is replaced; the
     * playback service, its claim and the bridge stay, and the bridge waits for the next document.
     */
    private fun replaceWebView() {
        val gone = webView
        val parent = gone.parent as ViewGroup
        val index = parent.indexOfChild(gone)
        parent.removeView(gone)
        gone.destroy()
        webView = WebView(this).apply {
            id = R.id.shell_web_view
            setBackgroundColor(getColor(R.color.canvas))
        }
        parent.addView(webView, index, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        configureWebView()
        documentGone()
    }

    /** The document goes with its bridge, its unanswered messages and the wait for its handshake. */
    private fun documentGone() {
        earlyBridgeMessages.clear()
        if (::bridge.isInitialized) bridge.reset()
        handshakes.pageStarted()
        mainHandler.removeCallbacks(handshakeTimeout)
        sandboxWarning.isVisible = false
    }

    private fun originHost(): String = siteOrigin.toUri().host.orEmpty()

    private fun applySystemBarInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            // The keyboard covers the page, as in Chrome; it never pushes the app's own UI, such as the
            // bottom player, upward.
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            // The native screens end above it instead, so the chooser's field stays in view as it is typed in.
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.findViewById<View>(R.id.recovery_root).updateLayoutParams<FrameLayout.LayoutParams> {
                bottomMargin = (keyboard - bars.bottom).coerceAtLeast(0)
            }
            WindowInsetsCompat.CONSUMED
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG || ShellChannel.tracesPlayback)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            // Chrome scales page text by the system font size; a WebView does not unless told to.
            textZoom = webTextZoom(resources.configuration.fontScale)
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = ShellWebViewClient()
        webView.webChromeClient = ShellChromeClient()
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            downloadThroughLink(url, userAgent, contentDisposition, mimeType)
        }
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_OBJECT,
            originPolicy.allowedOrigins,
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            val deliver = {
                bridge.handle(message.data.orEmpty(), sourceOrigin.toString().removeSuffix("/"), isMainFrame) {
                    replyProxy.postMessage(it)
                }
            }
            if (::bridge.isInitialized) deliver() else earlyBridgeMessages += deliver
        }
    }

    /**
     * The Download Manager keeps its requests in its own database, so it never gets the session:
     * the page exchanges the same-origin path for a five-minute cookie-less link, which alone is
     * enqueued. A path the page or server refuses only says "Download unavailable".
     */
    private fun downloadThroughLink(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        val origin = siteOrigin
        val path = sameOriginPath(url, origin) ?: return
        val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
        if (!::bridge.isInitialized) return toast(R.string.download_unavailable)
        val pending = bridge.requestDownloadLink(path) { link ->
            if (isDestroyed) return@requestDownloadLink
            val download = LinkDownload.of(origin, link, userAgent, mimeType, fileName)
            if (download == null) {
                toast(R.string.download_unavailable)
                return@requestDownloadLink
            }
            // Without a working Download Manager the page simply stays where it is.
            enqueueDownload(ioExecutor) {
                val request = DownloadManager.Request(download.url.toUri())
                    .setMimeType(download.mimeType)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, download.fileName)
                download.headers.forEach(request::addRequestHeader)
                getSystemService(DownloadManager::class.java).enqueue(request)
            }
        }
        pending?.let { mainHandler.postDelayed({ bridge.abandonDownloadLink(it) }, BRIDGE_TIMEOUT_MS) }
    }

    private fun onFileSaved(saved: Boolean) {
        if (!isDestroyed) toast(if (saved) R.string.download_saved else R.string.download_unavailable)
    }

    private fun toast(@StringRes message: Int) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

    private fun openExternally(url: String) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, url.toUri())
                    .addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: ActivityNotFoundException) {
            // Nothing can handle the link; the page stays where it is.
        }
    }

    /** [cause] is a fixed code, logged in every build; [url] is the page Retry loads again. */
    private fun showConnectionFailure(cause: String, url: String?) {
        Log.w(TAG, "main_frame_failed $cause")
        mainFrameFailed = true
        page.failed(url, siteOrigin)
        webView.visibility = View.INVISIBLE
        hideLastScreen()
        if (recovery.choosingSandbox) return
        recovery.showError({ open(page.retryUrl(siteOrigin)) }, switchSandbox)
    }

    private inner class ShellWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return when (originPolicy.classify(url, siteOrigin)) {
                NavigationDecision.LOAD -> false
                NavigationDecision.OPEN_EXTERNALLY -> {
                    if (request.isForMainFrame && request.hasGesture()) openExternally(url)
                    true
                }
                NavigationDecision.BLOCK -> true
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            // The same origin's next document re-attaches to the running queue from its handshake.
            documentGone()
            incompatibleWeb = false
            updateRequired = null
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            hideLastScreen()
            if (!mainFrameFailed && !incompatibleWeb && !recovery.choosingSandbox) recovery.hide()
        }

        // Also follows the history the page pushes, which is where the web app keeps its view.
        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
            page.visited(url, siteOrigin)
        }

        override fun onPageFinished(view: WebView, url: String) {
            // Back must never return to the previous sandbox origin, which bypasses URL checks.
            if (clearHistoryOnNextPage) view.clearHistory()
            clearHistoryOnNextPage = false
            if (!mainFrameFailed && handshakes.pageFinished(url)) mainHandler.postDelayed(handshakeTimeout, BRIDGE_TIMEOUT_MS)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showConnectionFailure("error=${error.errorCode}", request.url.toString())
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) showConnectionFailure("http=${response.statusCode}", request.url.toString())
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (originPolicy.isSameOrigin(error.url, siteOrigin)) showConnectionFailure("tls=${error.primaryError}", error.url)
        }

        // The renderer, the app's largest process, is often killed in the background. Its page then
        // loads again only when the user returns.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            val started = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
            Log.w(TAG, "renderer_gone crashed=${detail.didCrash()} priority=${detail.rendererPriorityAtExit()} started=$started")
            replaceWebView()
            // A page lost under the chooser is not needed: the chosen sandbox loads its own.
            if (!recovery.choosingSandbox) page.rendererGone(started, siteOrigin)?.let { open(it, asLeft = true) }
            return true
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            val text = message.message()
            if (!ShellChannel.tracesPlayback || !text.startsWith(PLAYBACK_TRACE)) return false
            Log.w(TAG, text)
            return true
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback
            try {
                fileChooser.launch(fileChooserParams.createIntent())
            } catch (_: ActivityNotFoundException) {
                fileChooserCallback?.onReceiveValue(null)
                fileChooserCallback = null
            }
            return true
        }
    }

    private companion object {
        const val TAG = "AlbumHavenShell"
        const val PLAYBACK_TRACE = "[playback-stop]"
        const val BRIDGE_OBJECT = "AlbumHavenBridge"
        const val STATE_ORIGIN = "shell_origin"
        const val STATE_URL = "shell_url"
        const val PROBE_TIMEOUT_MS = 5_000
        const val EXIT_REASONS_LOGGED = 5

        /** Exit reasons are logged once per process, not for every Activity it creates. */
        var exitReasonsLogged = false

        /** As long as the page's own bridge commands, its handshake among them, wait for the shell. */
        const val BRIDGE_TIMEOUT_MS = 15_000L

        /** A page still not drawn after this long shows the Connecting screen, so a picture never looks frozen. */
        const val LAST_SCREEN_MAX_MS = 6_000L
    }
}
