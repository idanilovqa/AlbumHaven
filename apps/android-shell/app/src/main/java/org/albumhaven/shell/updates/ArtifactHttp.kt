package org.albumhaven.shell.updates

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.albumhaven.shell.ShellChannel
import org.albumhaven.shell.playback.ShellSession
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.util.Base64

/** Why the signed-in origin would not hand this install its artifacts. Wire names are path-free. */
enum class AccessFailure(val wireName: String) {
    SIGNED_OUT("signed_out"),
    ATTESTATION_REFUSED("attestation_refused"),
    DEVICE_UNSUPPORTED("device_unsupported"),
}

/** Android Keystore as the artifact client needs it. */
interface DeviceKeys {
    /**
     * Replaces [alias] with a new hardware-backed P-256 signing key whose attestation carries
     * [challenge], returning its certificate chain leaf first, or null when this device cannot attest.
     */
    fun create(alias: String, challenge: ByteArray): List<ByteArray>?

    /** ECDSA-SHA256 by [alias]; null when the key is gone or permanently invalidated. */
    fun sign(alias: String, data: ByteArray): ByteArray?
}

/** The server's name for this install's key, per origin. Not a credential: every use is signed. */
interface DeviceKeyIds {
    fun get(origin: String): String?
    fun set(origin: String, id: String?)
}

/**
 * Reads update artifacts from the origin this app is signed in to, as that WebView session plus
 * an attested device key. Once per key: challenge, then attest a new Keystore key with it. Each
 * manifest read or APK exchange then signs a fresh server challenge. A key the server no longer
 * knows, or one Android invalidated, is replaced once. The APK exchange yields a short-lived
 * download link, checked here with HEAD (no cookies) before `DownloadManager` receives it.
 * Redirects are followed only within the origin, and only for that cookie-less link.
 */
class ArtifactHttp(
    client: OkHttpClient,
    private val session: ShellSession,
    private val channel: ShellChannel,
    private val keys: DeviceKeys,
    private val ids: DeviceKeyIds,
) {
    private val client = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** The manifest is small and revalidated on every check. */
    fun fetchManifest(url: String): FetchResult = when (val signed = signed("GET", url)) {
        is Signed.Ok -> signed.response.use { response ->
            if (response.code != 200) return FetchResult.Failed
            readBounded(response, ManifestValidator.MAX_MANIFEST_BYTES)?.let(FetchResult::Body)
                ?: FetchResult.Refused(Rejection.MALFORMED)
        }
        is Signed.Refused -> FetchResult.Refused(signed.reason)
        is Signed.Denied -> FetchResult.Denied(signed.reason)
        Signed.Failed -> FetchResult.Failed
    }

    /**
     * Exchanges [manifest]'s immutable APK URL for its download link and checks it with HEAD
     * before `DownloadManager`, which follows redirects itself, receives it.
     */
    fun resolveApk(manifest: UpdateManifest, maxBytes: Long): Resolution {
        val link = when (val signed = signed("POST", manifest.apkUrl)) {
            is Signed.Ok -> signed.response.use { response ->
                val path = if (response.code == 200) json(response)?.optString("path") else null
                if (path == null || !DOWNLOAD_PATH.matches(path)) return Resolution.Failed
                session.origin() + path
            }
            is Signed.Refused -> return Resolution.Refused(signed.reason)
            is Signed.Denied -> return Resolution.Denied(signed.reason)
            Signed.Failed -> return Resolution.Failed
        }
        val outcome = head(link)
        if (outcome !is Opened) return (outcome as? Refused)?.let { Resolution.Refused(it.reason) } ?: Resolution.Failed
        return outcome.response.use { response ->
            val length = response.header("Content-Length")?.toLongOrNull()
            when {
                response.code != 200 -> Resolution.Failed
                length != null && length > maxBytes -> Resolution.Refused(Rejection.SIZE)
                length != null && length != manifest.apkSize -> Resolution.Refused(Rejection.SIZE_MISMATCH)
                else -> Resolution.Url(outcome.url)
            }
        }
    }

    sealed interface Resolution {
        data class Url(val url: String) : Resolution
        data class Refused(val reason: Rejection) : Resolution
        data class Denied(val reason: AccessFailure) : Resolution
        data object Failed : Resolution
    }

    // --- Signed requests ----------------------------------------------------------------------

    private sealed interface Signed {
        class Ok(val response: Response) : Signed
        data class Refused(val reason: Rejection) : Signed
        data class Denied(val reason: AccessFailure) : Signed
        data object Failed : Signed
    }

    /** Ends a signed request early with [result]. */
    private class Stop(val result: Signed) : Exception(null, null, false, false)

    private fun signed(method: String, url: String): Signed {
        val origin = session.origin()
        val uri = parseUri(url)
        if (uri == null || originOf(uri) != origin) return Signed.Refused(Rejection.HOST)
        val path = uri.rawPath ?: return Signed.Refused(Rejection.HOST)
        return try {
            var replaced = false
            repeat(MAX_ATTEMPTS) {
                val keyId = ids.get(origin) ?: attest(origin).also { replaced = true }
                val challenge = challenge(origin, "request")
                val signature = keys.sign(alias(origin), requestMessage(method, path, challenge))
                if (signature == null) {
                    // Android invalidated or lost the key; attest a new one.
                    ids.set(origin, null)
                    if (replaced) throw Stop(Signed.Failed)
                    return@repeat
                }
                val request = session.authorize(Request.Builder(), withCsrf = method != "GET")
                    .url(url)
                    .header("Cache-Control", "no-cache")
                    .header(DEVICE_KEY_HEADER, keyId)
                    .header(CHALLENGE_HEADER, challenge)
                    .header(SIGNATURE_HEADER, Base64.getEncoder().encodeToString(signature))
                    .method(method, if (method == "GET") null else ByteArray(0).toRequestBody(null))
                    .build()
                val response = execute(request)
                if (response.code != 403) return if (response.code == 401) {
                    response.close()
                    Signed.Denied(AccessFailure.SIGNED_OUT)
                } else {
                    Signed.Ok(response)
                }
                when (refusalCode(response)) {
                    "attestation_required", "signature_invalid" -> {
                        // The server forgot this key; a freshly attested key that fails is refused.
                        ids.set(origin, null)
                        if (replaced) throw Stop(Signed.Denied(AccessFailure.ATTESTATION_REFUSED))
                    }
                    "challenge_invalid" -> Unit
                    "attestation_refused" -> throw Stop(Signed.Denied(AccessFailure.ATTESTATION_REFUSED))
                    else -> throw Stop(Signed.Failed)
                }
            }
            Signed.Failed
        } catch (stop: Stop) {
            stop.result
        }
    }

    /** Creates and registers a new device key, returning the server's id for it. */
    private fun attest(origin: String): String {
        val challenge = challenge(origin, "attest")
        val raw = try {
            Base64.getUrlDecoder().decode(challenge)
        } catch (_: IllegalArgumentException) {
            throw Stop(Signed.Failed)
        }
        val chain = keys.create(alias(origin), raw) ?: throw Stop(Signed.Denied(AccessFailure.DEVICE_UNSUPPORTED))
        val body = JSONObject()
            .put("protocol", 1)
            .put("channel", channel.wireName)
            .put("challenge", challenge)
            .put("chain", JSONArray(chain.map { Base64.getEncoder().encodeToString(it) }))
        val answer = post(origin, "/artifacts/android/attest", body)
        val id = answer.optString("deviceKey").takeIf(DEVICE_KEY::matches) ?: throw Stop(Signed.Failed)
        ids.set(origin, id)
        return id
    }

    private fun challenge(origin: String, purpose: String): String {
        val body = JSONObject().put("protocol", 1).put("channel", channel.wireName).put("purpose", purpose)
        return post(origin, "/artifacts/android/challenge", body).optString("challenge").takeIf(CHALLENGE::matches)
            ?: throw Stop(Signed.Failed)
    }

    private fun post(origin: String, path: String, body: JSONObject): JSONObject {
        val request = session.authorize(Request.Builder(), withCsrf = true)
            .url(origin + path)
            .header("Cache-Control", "no-store")
            .post(body.toString().toRequestBody(JSON))
            .build()
        return execute(request).use { response ->
            when (response.code) {
                200 -> json(response) ?: throw Stop(Signed.Failed)
                401 -> throw Stop(Signed.Denied(AccessFailure.SIGNED_OUT))
                403 -> throw Stop(
                    if (refusalCode(response) == "attestation_refused") {
                        Signed.Denied(AccessFailure.ATTESTATION_REFUSED)
                    } else {
                        Signed.Failed
                    },
                )
                else -> throw Stop(Signed.Failed)
            }
        }
    }

    private fun execute(request: Request): Response = try {
        client.newCall(request).execute()
    } catch (_: IOException) {
        throw Stop(Signed.Failed)
    } catch (_: IllegalArgumentException) {
        throw Stop(Signed.Refused(Rejection.HOST))
    }

    private fun refusalCode(response: Response): String? = response.use { json(it)?.optString("code") }

    private fun json(response: Response): JSONObject? = readBounded(response, MAX_JSON_BYTES)?.let {
        try {
            JSONObject(it)
        } catch (_: JSONException) {
            null
        }
    }

    private fun readBounded(response: Response, maxBytes: Int): String? {
        val source = response.body.source()
        return if (!source.request(maxBytes + 1L)) source.buffer.readUtf8() else null
    }

    private fun alias(origin: String) = "album-haven-artifacts:$origin"

    // --- The cookie-less download link --------------------------------------------------------

    private sealed interface Outcome
    private class Opened(val url: String, val response: Response) : Outcome
    private class Refused(val reason: Rejection) : Outcome
    private data object Failed : Outcome

    private fun head(start: String): Outcome {
        val origin = session.origin()
        var url = start
        repeat(MAX_REDIRECTS + 1) {
            if (originOf(parseUri(url) ?: return Refused(Rejection.HOST)) != origin) {
                return Refused(if (url == start) Rejection.HOST else Rejection.REDIRECT)
            }
            val request = Request.Builder().url(url).header("Cache-Control", "no-cache").head().build()
            val response = try {
                client.newCall(request).execute()
            } catch (_: IOException) {
                return Failed
            } catch (_: IllegalArgumentException) {
                return Refused(Rejection.HOST)
            }
            if (!response.isRedirect) return Opened(url, response)
            val location = response.header("Location")
            response.close()
            url = location?.let { resolve(url, it) } ?: return Failed
        }
        return Failed
    }

    private fun resolve(base: String, location: String): String? = try {
        URI(base).resolve(location).toString()
    } catch (_: IllegalArgumentException) {
        null
    }

    companion object {
        const val DEVICE_KEY_HEADER = "X-Album-Haven-Device-Key"
        const val CHALLENGE_HEADER = "X-Album-Haven-Challenge"
        const val SIGNATURE_HEADER = "X-Album-Haven-Signature"
        private const val MAX_REDIRECTS = 3
        private const val MAX_ATTEMPTS = 3
        private const val MAX_JSON_BYTES = 16 * 1024
        private val JSON = "application/json".toMediaType()
        private val CHALLENGE = Regex("^[A-Za-z0-9_-]{43}$")
        private val DEVICE_KEY = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        private val DOWNLOAD_PATH = Regex("^/artifacts/android/download/[A-Za-z0-9_-]{1,512}\\.[A-Za-z0-9_-]{43}$")

        /** Mirrors `request_message` in music_app/services/android_artifact_access.py. */
        fun requestMessage(method: String, path: String, challenge: String): ByteArray =
            listOf(
                "album-haven-android-artifact-request-v1", method, path, challenge, sha256Hex(ByteArray(0)),
            ).joinToString("\n").toByteArray(Charsets.UTF_8)
    }
}
