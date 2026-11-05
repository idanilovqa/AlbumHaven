package org.albumhaven.shell.updates

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.URI

/**
 * Reads public update artifacts from the one compiled artifact origin. Redirects are followed
 * by hand and only within that origin; a cross-host redirect refuses the artifact. No cookies
 * or credentials are ever sent.
 */
class ArtifactHttp(client: OkHttpClient, private val artifactOrigin: String) {
    private val client = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** The manifest is small and revalidated on every check. */
    fun fetchManifest(url: String): FetchResult {
        val outcome = open(url, head = false)
        if (outcome !is Opened) return (outcome as? Refused)?.let { FetchResult.Refused(it.reason) } ?: FetchResult.Failed
        return outcome.response.use { response ->
            if (response.code != 200) return FetchResult.Failed
            val body = response.body.source()
            if (!body.request(ManifestValidator.MAX_MANIFEST_BYTES + 1L)) {
                FetchResult.Body(body.readUtf8())
            } else {
                FetchResult.Refused(Rejection.MALFORMED)
            }
        }
    }

    /**
     * Resolves [manifest]'s APK URL before `DownloadManager`, which follows redirects itself,
     * receives it. Returns the final same-origin URL, or why the APK is refused.
     */
    fun resolveApk(manifest: UpdateManifest, maxBytes: Long): Resolution {
        val outcome = open(manifest.apkUrl, head = true)
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
        data object Failed : Resolution
    }

    private sealed interface Outcome
    private class Opened(val url: String, val response: Response) : Outcome
    private class Refused(val reason: Rejection) : Outcome
    private data object Failed : Outcome

    private fun open(start: String, head: Boolean): Outcome {
        var url = start
        repeat(MAX_REDIRECTS + 1) {
            if (originOf(parseUri(url) ?: return Refused(Rejection.HOST)) != artifactOrigin) {
                return Refused(if (url == start) Rejection.HOST else Rejection.REDIRECT)
            }
            val request = Request.Builder()
                .url(url)
                .header("Cache-Control", "no-cache")
                .apply { if (head) head() }
                .build()
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

    private companion object {
        const val MAX_REDIRECTS = 3
    }
}
