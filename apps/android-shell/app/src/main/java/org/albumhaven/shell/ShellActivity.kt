package org.albumhaven.shell

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.View
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
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.albumhaven.shell.playback.NativePlaybackEvent
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class ShellActivity : ComponentActivity(), BridgeHost {

    private val channel = ShellChannel.fromWireName(BuildConfig.CHANNEL)
    private val originPolicy = OriginPolicy(channel, BuildConfig.DEV_ORIGIN)
    private val probeExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var preferences: ShellPreferences
    private lateinit var selectedOrigin: String
    private lateinit var bridge: BridgeController

    // The page loads only once the playback service is bound, so the bridge always has a controller.
    private var playbackService: PlaybackService? = null
    private var playbackBound = false
    private var pendingWebState: Bundle? = null
    private val playbackEvents: (NativePlaybackEvent) -> Unit = { event -> bridge.emit(event) }
    private val playbackConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val service = (binder as PlaybackService.LocalBinder).service
            playbackService = service
            service.selectOrigin(selectedOrigin)
            service.addListener(playbackEvents)
            if (!isDestroyed) loadSelectedOrigin()
        }

        override fun onServiceDisconnected(name: ComponentName) {
            playbackService = null
        }
    }
    private lateinit var webView: WebView
    private lateinit var recovery: RecoveryPanel

    private var mainFrameFailed = false
    private var incompatibleWeb = false
    private var sandboxProbePending = false
    private var clearHistoryOnNextPage = false
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
        selectedOrigin = originPolicy.initialOrigin(preferences.selectedSandboxSlot)
        bridge = BridgeController(
            ShellIdentity(packageName, channel, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong()),
            this,
            ControllerPlaybackPort { checkNotNull(playbackService).controller },
        )
        recovery = RecoveryPanel(findViewById(R.id.recovery_root)) { reload() }
        webView = findViewById(R.id.shell_web_view)

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            recovery.show(RecoveryState.UPDATE_REQUIRED, originHost())
            return
        }
        configureWebView()
        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
        }
        pendingWebState = savedInstanceState
            ?.takeIf { it.getString(STATE_ORIGIN) == selectedOrigin }
            ?.getBundle(STATE_WEB_VIEW)
        recovery.show(RecoveryState.LOADING, originHost())
        playbackBound = bindService(
            PlaybackService.shellBindIntent(this),
            playbackConnection,
            BIND_AUTO_CREATE,
        )
    }

    private fun loadSelectedOrigin() {
        val state = pendingWebState
        pendingWebState = null
        if (state?.let { webView.restoreState(it) } == null) webView.loadUrl(selectedOrigin)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_ORIGIN, selectedOrigin)
        outState.putBundle(STATE_WEB_VIEW, pendingWebState ?: Bundle().also { webView.saveState(it) })
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        // Playback belongs to the service and outlives the Activity; only this listener goes.
        playbackService?.removeListener(playbackEvents)
        if (playbackBound) unbindService(playbackConnection)
        playbackService = null
        probeExecutor.shutdownNow()
        mainHandler.removeCallbacksAndMessages(null)
        fileChooserCallback?.onReceiveValue(null)
        webView.destroy()
        super.onDestroy()
    }

    override fun selectedOrigin(): String = selectedOrigin

    override fun selectedSandboxSlot(): Int = preferences.selectedSandboxSlot

    override fun takeConnectedSandboxSlot(): Int? = preferences.takeConnectedSandboxSlot()

    override fun onIncompatibleWeb() {
        incompatibleWeb = true
        recovery.show(RecoveryState.UPDATE_REQUIRED, originHost())
    }

    override fun selectSandbox(slot: Int, onResult: (connected: Boolean) -> Unit) {
        val origin = OriginPolicy.sandboxOrigin(slot)
        if (sandboxProbePending) {
            onResult(false)
            return
        }
        sandboxProbePending = true
        probeExecutor.execute {
            val reachable = isReachable(origin)
            mainHandler.post {
                if (isDestroyed) return@post
                sandboxProbePending = false
                onResult(reachable)
                if (reachable) {
                    preferences.selectedSandboxSlot = slot
                    selectedOrigin = origin
                    // Playback, its claim and its queue stay with the origin that started them.
                    playbackService?.selectOrigin(origin)
                    clearHistoryOnNextPage = true
                    reload()
                }
            }
        }
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

    private fun reload() {
        mainFrameFailed = false
        recovery.show(RecoveryState.LOADING, originHost())
        webView.visibility = View.VISIBLE
        webView.loadUrl(selectedOrigin)
    }

    private fun originHost(): String = selectedOrigin.toUri().host.orEmpty()

    private fun applySystemBarInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.webViewClient = ShellWebViewClient()
        webView.webChromeClient = ShellChromeClient()
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            enqueueSameOriginDownload(url, userAgent, contentDisposition, mimeType)
        }
        WebViewCompat.addWebMessageListener(
            webView,
            BRIDGE_OBJECT,
            originPolicy.allowedOrigins,
        ) { _, message, sourceOrigin, isMainFrame, replyProxy ->
            bridge.handle(message.data.orEmpty(), sourceOrigin.toString().removeSuffix("/"), isMainFrame) {
                replyProxy.postMessage(it)
            }
        }
    }

    private fun enqueueSameOriginDownload(url: String, userAgent: String, contentDisposition: String?, mimeType: String?) {
        if (!originPolicy.isSameOrigin(url, selectedOrigin)) return
        val request = DownloadManager.Request(url.toUri())
            .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url).orEmpty())
            .addRequestHeader("User-Agent", userAgent)
            .setMimeType(mimeType)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(
                this,
                Environment.DIRECTORY_DOWNLOADS,
                URLUtil.guessFileName(url, contentDisposition, mimeType),
            )
        getSystemService(DownloadManager::class.java).enqueue(request)
    }

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

    private fun showConnectionFailure(cause: String) {
        if (BuildConfig.DEBUG) Log.w(TAG, "Main frame failed: $cause")
        mainFrameFailed = true
        webView.visibility = View.INVISIBLE
        recovery.show(RecoveryState.ERROR, originHost())
    }

    private inner class ShellWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url.toString()
            return when (originPolicy.classify(url, selectedOrigin)) {
                NavigationDecision.LOAD -> false
                NavigationDecision.OPEN_EXTERNALLY -> {
                    if (request.isForMainFrame && request.hasGesture()) openExternally(url)
                    true
                }
                NavigationDecision.BLOCK -> true
            }
        }

        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
            bridge.reset()
            // The same origin's next document re-attaches to the running queue from its handshake.
            playbackService?.controller?.documentStarted()
            incompatibleWeb = false
        }

        override fun onPageCommitVisible(view: WebView, url: String) {
            if (!mainFrameFailed && !incompatibleWeb) recovery.hide()
        }

        override fun onPageFinished(view: WebView, url: String) {
            // Back must never return to the previous sandbox origin, which bypasses URL checks.
            if (clearHistoryOnNextPage) view.clearHistory()
            clearHistoryOnNextPage = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showConnectionFailure("error ${error.errorCode} ${error.description}")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && response.statusCode >= 500) showConnectionFailure("HTTP ${response.statusCode}")
        }

        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            if (originPolicy.isSameOrigin(error.url, selectedOrigin)) showConnectionFailure("TLS ${error.primaryError}")
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            recreate()
            return true
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
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
        const val BRIDGE_OBJECT = "AlbumHavenBridge"
        const val STATE_ORIGIN = "shell_origin"
        const val STATE_WEB_VIEW = "shell_web_view"
        const val PROBE_TIMEOUT_MS = 5_000
    }
}
