package org.albumhaven.shell.updates

import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.albumhaven.shell.ShellChannel
import org.albumhaven.shell.playback.ShellSession
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

class ArtifactHttpTest {
    private val server = MockWebServer()
    private val keys = FakeKeys()
    private val ids = object : DeviceKeyIds {
        val values = mutableMapOf<String, String>()
        override fun get(origin: String) = values[origin]
        override fun set(origin: String, id: String?) {
            if (id == null) values.remove(origin) else values[origin] = id
        }
    }
    private val backend = FakeBackend()
    private lateinit var origin: String
    private lateinit var http: ArtifactHttp

    @Before
    fun start() {
        server.dispatcher = backend
        server.start()
        origin = server.url("/").toString().removeSuffix("/")
        backend.origin = origin
        val session = ShellSession({ origin }) { "__Host-album_haven_session=s; __Host-album_haven_csrf=csrf%20token" }
        http = ArtifactHttp(OkHttpClient(), session, ShellChannel.SANDBOX, keys, ids)
    }

    @After
    fun stop() {
        server.close()
    }

    private val manifestUrl get() = "$origin/artifacts/android/sandbox/manifest.json"

    private fun manifestAt(size: Long = 4096) =
        manifest().copy(apkUrl = "$origin/artifacts/android/sandbox/album-haven-2.apk", apkSize = size)

    @Test
    fun `the first manifest read attests a key with the server's challenge, then signs every request`() {
        assertEquals(FetchResult.Body("{\"schemaVersion\":1}"), http.fetchManifest(manifestUrl))
        assertEquals(FetchResult.Body("{\"schemaVersion\":1}"), http.fetchManifest(manifestUrl))
        assertEquals(1, backend.attestations)
        assertEquals(listOf(backend.attestChallenges.single()), keys.challenges)
        val manifestRequests = backend.requests.filter { it.url.encodedPath.endsWith("manifest.json") }
        assertEquals(2, manifestRequests.size)
        manifestRequests.forEach { request ->
            assertEquals("GET", request.method)
            assertEquals("no-cache", request.headers["Cache-Control"])
            assertEquals(origin, request.headers["Origin"])
            assertTrue(request.headers["Cookie"]!!.contains("__Host-album_haven_session=s"))
            assertNull(request.headers[ShellSession.CSRF_HEADER])
            assertEquals(ids.values[origin], request.headers[ArtifactHttp.DEVICE_KEY_HEADER])
        }
        backend.requests.filter { it.method == "POST" }.forEach { assertEquals("csrf token", it.headers[ShellSession.CSRF_HEADER]) }
        assertEquals(2, backend.verifiedSignatures)
    }

    @Test
    fun `the APK URL is exchanged for a download link that is checked without cookies`() {
        val resolution = http.resolveApk(manifestAt(), 1 shl 20)
        assertEquals(ArtifactHttp.Resolution.Url("$origin${FakeBackend.DOWNLOAD_PATH}"), resolution)
        val exchange = backend.requests.single { it.url.encodedPath == "/artifacts/android/sandbox/album-haven-2.apk" }
        assertEquals("POST", exchange.method)
        assertEquals("csrf token", exchange.headers[ShellSession.CSRF_HEADER])
        val head = backend.requests.last()
        assertEquals("HEAD", head.method)
        assertNull(head.headers["Cookie"])
        assertNull(head.headers[ArtifactHttp.SIGNATURE_HEADER])
    }

    @Test
    fun `a key the server forgot is replaced once`() {
        http.fetchManifest(manifestUrl)
        backend.knownKeys.clear()
        assertEquals(FetchResult.Body("{\"schemaVersion\":1}"), http.fetchManifest(manifestUrl))
        assertEquals(2, backend.attestations)
    }

    @Test
    fun `a key Android invalidated is replaced`() {
        http.fetchManifest(manifestUrl)
        keys.pairs.clear()
        assertEquals(FetchResult.Body("{\"schemaVersion\":1}"), http.fetchManifest(manifestUrl))
        assertEquals(2, backend.attestations)
    }

    @Test
    fun `a freshly attested key that is still unknown is refused, not retried forever`() {
        backend.forgetEveryKey = true
        assertEquals(FetchResult.Denied(AccessFailure.ATTESTATION_REFUSED), http.fetchManifest(manifestUrl))
        assertEquals(1, backend.attestations)
    }

    @Test
    fun `signed out, refused and unsupported devices are reported`() {
        backend.signedOut = true
        assertEquals(FetchResult.Denied(AccessFailure.SIGNED_OUT), http.fetchManifest(manifestUrl))
        assertEquals(ArtifactHttp.Resolution.Denied(AccessFailure.SIGNED_OUT), http.resolveApk(manifestAt(), 1 shl 20))

        backend.signedOut = false
        backend.refuseAttestation = true
        assertEquals(FetchResult.Denied(AccessFailure.ATTESTATION_REFUSED), http.fetchManifest(manifestUrl))

        backend.refuseAttestation = false
        keys.unsupported = true
        val before = backend.attestations
        assertEquals(FetchResult.Denied(AccessFailure.DEVICE_UNSUPPORTED), http.fetchManifest(manifestUrl))
        assertEquals(before, backend.attestations)
    }

    @Test
    fun `an untrusted host is never contacted`() {
        assertEquals(FetchResult.Refused(Rejection.HOST), http.fetchManifest("https://evil.example/manifest.json"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `the download link may redirect only within the origin`() {
        backend.downloadLocation = "/artifacts/android/download/moved"
        backend.movedLength = "4096"
        assertEquals(
            ArtifactHttp.Resolution.Url("$origin/artifacts/android/download/moved"),
            http.resolveApk(manifestAt(), 1 shl 20),
        )
        backend.downloadLocation = "https://evil.example/a.apk"
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.REDIRECT), http.resolveApk(manifestAt(), 1 shl 20))
    }

    @Test
    fun `the download link's length must match the manifest`() {
        backend.downloadLength = "4095"
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.SIZE_MISMATCH), http.resolveApk(manifestAt(), 1 shl 20))
        backend.downloadLength = "5000"
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.SIZE), http.resolveApk(manifestAt(5000), 4096))
    }

    @Test
    fun `errors and oversized manifests are refused`() {
        backend.manifestBody = "x".repeat(ManifestValidator.MAX_MANIFEST_BYTES + 1)
        assertEquals(FetchResult.Refused(Rejection.MALFORMED), http.fetchManifest(manifestUrl))
        backend.manifestCode = 404
        assertEquals(FetchResult.Failed, http.fetchManifest(manifestUrl))
        server.close()
        assertEquals(FetchResult.Failed, http.fetchManifest(manifestUrl))
    }

    @Test
    fun `the signed message matches the server's format`() {
        assertArrayEquals(
            (
                "album-haven-android-artifact-request-v1\nGET\n/artifacts/android/sandbox/manifest.json\nabc\n" +
                    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                ).toByteArray(),
            ArtifactHttp.requestMessage("GET", "/artifacts/android/sandbox/manifest.json", "abc"),
        )
    }

    private class FakeKeys : DeviceKeys {
        val pairs = mutableMapOf<String, KeyPair>()
        val challenges = mutableListOf<String>()
        var unsupported = false

        override fun create(alias: String, challenge: ByteArray): List<ByteArray>? {
            if (unsupported) return null
            challenges += Base64.getUrlEncoder().withoutPadding().encodeToString(challenge)
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
            pairs[alias] = pair
            // The fake server reads the leaf as the key itself.
            return listOf(pair.public.encoded, byteArrayOf(1))
        }

        override fun sign(alias: String, data: ByteArray): ByteArray? = pairs[alias]?.let { pair ->
            Signature.getInstance("SHA256withECDSA").run {
                initSign(pair.private)
                update(data)
                sign()
            }
        }
    }

    private class FakeBackend : Dispatcher() {
        lateinit var origin: String
        val requests = mutableListOf<RecordedRequest>()
        val knownKeys = mutableMapOf<String, PublicKey>()
        val attestChallenges = mutableListOf<String>()
        private val open = mutableSetOf<String>()
        var attestations = 0
        var verifiedSignatures = 0
        var signedOut = false
        var refuseAttestation = false
        var forgetEveryKey = false
        var manifestBody = "{\"schemaVersion\":1}"
        var manifestCode = 200
        var downloadLength = "4096"
        var downloadLocation: String? = null
        var movedLength = "4096"

        @Synchronized
        override fun dispatch(request: RecordedRequest): MockResponse {
            requests += request
            val path = request.url.encodedPath
            if (signedOut && request.method != "HEAD") return json(401, "{\"detail\":\"Authentication required.\"}")
            return when {
                path == "/artifacts/android/challenge" -> {
                    val challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(UUID.randomUUID().toString().take(32).toByteArray())
                    open += challenge
                    if (JSONObject(request.body!!.utf8()).getString("purpose") == "attest") attestChallenges += challenge
                    json(200, JSONObject().put("challenge", challenge).toString())
                }
                path == "/artifacts/android/attest" -> {
                    val body = JSONObject(request.body!!.utf8())
                    if (!open.remove(body.getString("challenge"))) return refusal("challenge_invalid")
                    if (refuseAttestation) return refusal("attestation_refused")
                    attestations++
                    val leaf = Base64.getDecoder().decode(body.getJSONArray("chain").getString(0))
                    val id = UUID.randomUUID().toString()
                    knownKeys[id] = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(leaf))
                    json(200, JSONObject().put("deviceKey", id).toString())
                }
                path.startsWith("/artifacts/android/download/") -> when {
                    path == "/artifacts/android/download/moved" -> MockResponse.Builder().addHeader("Content-Length", movedLength).build()
                    downloadLocation != null -> MockResponse.Builder().code(302).addHeader("Location", downloadLocation!!).build()
                    else -> MockResponse.Builder().addHeader("Content-Length", downloadLength).build()
                }
                else -> signed(request) ?: if (path.endsWith("manifest.json")) {
                    MockResponse.Builder().code(manifestCode).body(manifestBody).build()
                } else {
                    json(200, JSONObject().put("path", DOWNLOAD_PATH).toString())
                }
            }
        }

        /** A refusal, or null when the request is signed by a known key over an open challenge. */
        private fun signed(request: RecordedRequest): MockResponse? {
            val challenge = request.headers[ArtifactHttp.CHALLENGE_HEADER].orEmpty()
            if (!open.remove(challenge)) return refusal("challenge_invalid")
            val key = knownKeys[request.headers[ArtifactHttp.DEVICE_KEY_HEADER].orEmpty()]
            if (key == null || forgetEveryKey) return refusal("attestation_required")
            val valid = Signature.getInstance("SHA256withECDSA").run {
                initVerify(key)
                update(ArtifactHttp.requestMessage(request.method!!, request.url.encodedPath, challenge))
                verify(Base64.getDecoder().decode(request.headers[ArtifactHttp.SIGNATURE_HEADER]))
            }
            if (!valid) return refusal("signature_invalid")
            verifiedSignatures++
            return null
        }

        private fun refusal(code: String) = json(403, JSONObject().put("code", code).toString())

        private fun json(code: Int, body: String) =
            MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()

        companion object {
            const val DOWNLOAD_PATH = "/artifacts/android/download/cGF5bG9hZA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        }
    }
}
