package org.albumhaven.shell.updates

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

class ArtifactHttpTest {
    private val server = MockWebServer()
    private lateinit var origin: String
    private lateinit var http: ArtifactHttp

    @Before
    fun start() {
        server.start()
        origin = server.url("/").toString().removeSuffix("/")
        http = ArtifactHttp(OkHttpClient(), origin)
    }

    @After
    fun stop() {
        server.close()
    }

    private fun manifestAt(path: String, size: Long = 4096) =
        manifest().copy(apkUrl = "$origin$path", apkSize = size)

    @Test
    fun `the manifest is fetched without cookies and revalidated`() {
        server.enqueue(MockResponse.Builder().body("{\"ok\":1}").build())
        assertEquals(FetchResult.Body("{\"ok\":1}"), http.fetchManifest("$origin/artifacts/android/sandbox/manifest.json"))
        val request = server.takeRequest()
        assertEquals("/artifacts/android/sandbox/manifest.json", request.url.encodedPath)
        assertEquals("no-cache", request.headers["Cache-Control"])
        assertNull(request.headers["Cookie"])
    }

    @Test
    fun `same-origin redirects are followed and cross-host redirects refused`() {
        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/moved.json").build())
        server.enqueue(MockResponse.Builder().body("{}").build())
        assertEquals(FetchResult.Body("{}"), http.fetchManifest("$origin/manifest.json"))

        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "https://evil.example/manifest.json").build())
        assertEquals(FetchResult.Refused(Rejection.REDIRECT), http.fetchManifest("$origin/manifest.json"))

        server.enqueue(MockResponse.Builder().code(301).addHeader("Location", "https://evil.example/a.apk").build())
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.REDIRECT), http.resolveApk(manifestAt("/a.apk"), 1 shl 20))
    }

    @Test
    fun `an untrusted manifest host is never contacted`() {
        assertEquals(FetchResult.Refused(Rejection.HOST), http.fetchManifest("https://evil.example/manifest.json"))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun `errors and oversized manifests are refused`() {
        server.enqueue(MockResponse.Builder().code(404).build())
        assertEquals(FetchResult.Failed, http.fetchManifest("$origin/manifest.json"))
        server.enqueue(MockResponse.Builder().body("x".repeat(ManifestValidator.MAX_MANIFEST_BYTES + 1)).build())
        assertEquals(FetchResult.Refused(Rejection.MALFORMED), http.fetchManifest("$origin/manifest.json"))
        server.close()
        assertEquals(FetchResult.Failed, http.fetchManifest("$origin/manifest.json"))
    }

    @Test
    fun `the APK is resolved with HEAD and its length must match the manifest`() {
        server.enqueue(MockResponse.Builder().addHeader("Content-Length", "4096").build())
        assertEquals(ArtifactHttp.Resolution.Url("$origin/a.apk"), http.resolveApk(manifestAt("/a.apk"), 1 shl 20))
        assertEquals("HEAD", server.takeRequest().method)

        server.enqueue(MockResponse.Builder().code(302).addHeader("Location", "/b.apk").build())
        server.enqueue(MockResponse.Builder().addHeader("Content-Length", "4096").build())
        assertEquals(ArtifactHttp.Resolution.Url("$origin/b.apk"), http.resolveApk(manifestAt("/a.apk"), 1 shl 20))

        server.enqueue(MockResponse.Builder().addHeader("Content-Length", "4095").build())
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.SIZE_MISMATCH), http.resolveApk(manifestAt("/a.apk"), 1 shl 20))

        server.enqueue(MockResponse.Builder().addHeader("Content-Length", "5000").build())
        assertEquals(ArtifactHttp.Resolution.Refused(Rejection.SIZE), http.resolveApk(manifestAt("/a.apk", 5000), 4096))

        server.enqueue(MockResponse.Builder().code(500).build())
        assertEquals(ArtifactHttp.Resolution.Failed, http.resolveApk(manifestAt("/a.apk"), 1 shl 20))
    }
}
