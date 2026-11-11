package org.albumhaven.shell.updates

import org.albumhaven.shell.ShellChannel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateManifestTest {

    private fun check(raw: String, policy: UpdatePolicy = policy(), web: IntRange? = 1..1) =
        ManifestValidator.check(raw, policy, web)

    private fun assertRejected(reason: Rejection, raw: String, policy: UpdatePolicy = policy(), web: IntRange? = 1..1) {
        assertEquals(ManifestCheck.Rejected(reason), check(raw, policy, web))
    }

    @Test
    fun `a valid newer manifest is accepted with every field`() {
        val result = check(manifestJson()) as ManifestCheck.Newer
        val manifest = result.manifest
        assertEquals(2L, manifest.versionCode)
        assertEquals("0.10.0-sandbox.763af93", manifest.versionName)
        assertEquals("https://albumhaven.org/artifacts/android/sandbox/album-haven-2.apk", manifest.apkUrl)
        assertEquals(4096L, manifest.apkSize)
        assertEquals(1..1, manifest.bridgeProtocols)
        assertEquals(manifestJson(), manifest.raw)
    }

    @Test
    fun `a stable manifest uses plain semver`() {
        val stable = policy(ShellChannel.STABLE)
        assertTrue(check(manifestJson(channel = ShellChannel.STABLE), stable) is ManifestCheck.Newer)
        assertRejected(
            Rejection.VERSION_NAME,
            manifestJson("versionName" to "0.10.1-sandbox.763af93", channel = ShellChannel.STABLE),
            stable,
        )
    }

    @Test
    fun `the same or a lower version is current and never downloaded`() {
        assertTrue(check(manifestJson("versionCode" to 1)) is ManifestCheck.Current)
        assertTrue(check(manifestJson("versionCode" to 1), policy(installedVersionCode = 5)) is ManifestCheck.Current)
        assertTrue(check(manifestJson("versionCode" to 5), policy(installedVersionCode = 5)) is ManifestCheck.Current)
    }

    @Test
    fun `malformed json and missing, extra, or mistyped fields are rejected`() {
        assertRejected(Rejection.MALFORMED, "not json")
        assertRejected(Rejection.MALFORMED, "[]")
        assertRejected(Rejection.MALFORMED, manifestJson("releaseNotesUrl" to null))
        assertRejected(Rejection.MALFORMED, manifestJson("extra" to 1))
        assertRejected(Rejection.MALFORMED, manifestJson("versionCode" to "2"))
        assertRejected(Rejection.MALFORMED, manifestJson("versionCode" to 2.5))
        assertRejected(Rejection.MALFORMED, manifestJson("versionCode" to 0))
        assertRejected(Rejection.MALFORMED, manifestJson("versionCode" to 3_000_000_000L))
        assertRejected(Rejection.MALFORMED, manifestJson("apkSize" to 0))
        assertRejected(Rejection.MALFORMED, manifestJson("apkSize" to true))
        assertRejected(Rejection.MALFORMED, manifestJson("versionName" to 2))
        assertRejected(Rejection.MALFORMED, manifestJson("publishedAt" to "2026-11-04 18:00:00"))
        assertRejected(Rejection.MALFORMED, manifestJson("publishedAt" to "2026-11-04T18:00:00+02:00"))
        assertRejected(Rejection.MALFORMED, manifestJson("publishedAt" to "2026-13-40T18:00:00Z"))
        assertRejected(Rejection.MALFORMED, manifestJson("releaseNotesUrl" to "http://albumhaven.org/releases/0.10.1"))
        assertRejected(Rejection.MALFORMED, manifestJson("releaseNotesUrl" to "https://user@albumhaven.org/x"))
    }

    @Test
    fun `an oversized manifest is rejected before parsing`() {
        val padded = manifestJson().dropLast(1) + ",\"pad\":\"" + "x".repeat(ManifestValidator.MAX_MANIFEST_BYTES) + "\"}"
        assertRejected(Rejection.MALFORMED, padded)
    }

    @Test
    fun `wrong schema, channel, and application ID are rejected`() {
        assertRejected(Rejection.SCHEMA, manifestJson("schemaVersion" to 2))
        assertRejected(Rejection.CHANNEL, manifestJson("channel" to "stable"))
        assertRejected(Rejection.CHANNEL, manifestJson(channel = ShellChannel.STABLE))
        assertRejected(Rejection.APPLICATION_ID, manifestJson("applicationId" to "org.albumhaven.app"))
        assertRejected(Rejection.APPLICATION_ID, manifestJson("applicationId" to "org.example.app.sandbox"))
    }

    @Test
    fun `sandbox version names carry the short source commit`() {
        assertRejected(Rejection.VERSION_NAME, manifestJson("versionName" to "0.10.0"))
        assertRejected(Rejection.VERSION_NAME, manifestJson("versionName" to "0.10.0-sandbox.abcdef1"))
        assertRejected(Rejection.VERSION_NAME, manifestJson("versionName" to "0.10.0-sandbox.763AF93"))
        assertRejected(Rejection.VERSION_NAME, manifestJson("versionName" to "v0.10.0-sandbox.763af93"))
        assertRejected(Rejection.VERSION_NAME, manifestJson("versionName" to "0.010.0-sandbox.763af93"))
    }

    @Test
    fun `the source commit is forty lowercase hex characters`() {
        assertRejected(Rejection.SOURCE_COMMIT, manifestJson("sourceCommit" to COMMIT.dropLast(1)))
        assertRejected(Rejection.SOURCE_COMMIT, manifestJson("sourceCommit" to COMMIT.uppercase()))
    }

    @Test
    fun `the APK must live in this channel's directory on the compiled artifact origin`() {
        listOf(
            "https://evil.example/artifacts/android/sandbox/album-haven-2.apk",
            "https://albumhaven.org.evil.example/artifacts/android/sandbox/album-haven-2.apk",
            "https://sandbox5.albumhaven.org/artifacts/android/sandbox/album-haven-2.apk",
            "http://albumhaven.org/artifacts/android/sandbox/album-haven-2.apk",
            "https://albumhaven.org:8443/artifacts/android/sandbox/album-haven-2.apk",
            "https://user@albumhaven.org/artifacts/android/sandbox/album-haven-2.apk",
            "https://albumhaven.org/artifacts/android/stable/album-haven-2.apk",
            "https://albumhaven.org/artifacts/android/sandbox/../stable/album-haven-2.apk",
            "https://albumhaven.org/artifacts/android/sandbox/nested/album-haven-2.apk",
            "https://albumhaven.org/artifacts/android/sandbox/album-haven-2.zip",
            "https://albumhaven.org/artifacts/android/sandbox/album-haven-2.apk?x=1",
            "https://albumhaven.org/artifacts/android/sandbox/album-haven-2.apk#x",
            "/artifacts/android/sandbox/album-haven-2.apk",
            "not a url",
        ).forEach { url -> assertRejected(Rejection.HOST, manifestJson("apkUrl" to url)) }
    }

    @Test
    fun `a debug artifact origin is trusted only when compiled in`() {
        val sandboxOrigin = policy(artifactOrigin = "https://sandbox5.albumhaven.org")
        val raw = manifestJson("apkUrl" to "https://sandbox5.albumhaven.org/artifacts/android/sandbox/album-haven-2.apk")
        assertTrue(check(raw, sandboxOrigin) is ManifestCheck.Newer)
        assertRejected(Rejection.HOST, raw)
        assertEquals("https://sandbox5.albumhaven.org/artifacts/android/sandbox/manifest.json", sandboxOrigin.manifestUrl)
    }

    @Test
    fun `an APK above the size bound is rejected`() {
        assertRejected(Rejection.SIZE, manifestJson("apkSize" to UpdatePolicy.MAX_APK_BYTES + 1))
        assertTrue(check(manifestJson("apkSize" to UpdatePolicy.MAX_APK_BYTES)) is ManifestCheck.Newer)
    }

    @Test
    fun `hashes are lowercase hex and the certificate is the compiled one`() {
        assertRejected(Rejection.MALFORMED, manifestJson("sha256" to APK_SHA.uppercase()))
        assertRejected(Rejection.MALFORMED, manifestJson("sha256" to APK_SHA.drop(1)))
        assertRejected(Rejection.MALFORMED, manifestJson("signingCertificateSha256" to "AB"))
        assertRejected(Rejection.CERTIFICATE, manifestJson("signingCertificateSha256" to OTHER_CERT))
    }

    @Test
    fun `the device must meet the minimum Android API`() {
        assertRejected(Rejection.ANDROID_VERSION, manifestJson("minAndroidApi" to 37))
        assertRejected(Rejection.MALFORMED, manifestJson("minAndroidApi" to 28))
        assertTrue(check(manifestJson("minAndroidApi" to 29), policy(deviceApi = 29)) is ManifestCheck.Newer)
    }

    @Test
    fun `the bridge range must be valid and open the current site`() {
        assertRejected(Rejection.MALFORMED, manifestJson("bridgeProtocolMin" to 0))
        assertRejected(Rejection.MALFORMED, manifestJson("bridgeProtocolMin" to 2, "bridgeProtocolMax" to 1))
        assertRejected(Rejection.BRIDGE, manifestJson("bridgeProtocolMin" to 2, "bridgeProtocolMax" to 2))
        assertRejected(Rejection.BRIDGE, manifestJson(), web = 2..3)
        // A site that moved on is exactly what an update is for.
        assertTrue(check(manifestJson("bridgeProtocolMin" to 2, "bridgeProtocolMax" to 2), web = 1..2) is ManifestCheck.Newer)
        // Before any document connected only the range itself is checked.
        assertTrue(check(manifestJson("bridgeProtocolMin" to 2, "bridgeProtocolMax" to 3), web = null) is ManifestCheck.Newer)
    }

    @Test
    fun `a policy without a compiled certificate is disabled`() {
        assertTrue(policy().enabled)
        assertFalse(policy().copy(expectedCertificateSha256 = "").enabled)
    }

    @Test
    fun `a downloaded APK that matches everything is verified`() {
        assertNull(DownloadVerifier.verify(manifest(), policy(), inspection()))
    }

    @Test
    fun `every downloaded APK mismatch is rejected`() {
        val manifest = manifest()
        val policy = policy()
        val archive = inspection().archive!!
        mapOf(
            inspection(size = 4095) to Rejection.SIZE_MISMATCH,
            inspection(size = 4097) to Rejection.SIZE_MISMATCH,
            inspection(sha256 = APK_SHA.replace('4', '5')) to Rejection.HASH_MISMATCH,
            inspection(archive = null) to Rejection.UNREADABLE_APK,
            inspection(archive = archive.copy(packageName = "org.albumhaven.app")) to Rejection.PACKAGE_MISMATCH,
            inspection(archive = archive.copy(versionCode = 3)) to Rejection.PACKAGE_MISMATCH,
            inspection(archive = archive.copy(versionName = "0.10.0")) to Rejection.PACKAGE_MISMATCH,
            inspection(archive = archive.copy(signerSha256 = listOf(OTHER_CERT))) to Rejection.CERTIFICATE,
            inspection(archive = archive.copy(signerSha256 = emptyList())) to Rejection.CERTIFICATE,
            inspection(archive = archive.copy(multipleSigners = true)) to Rejection.CERTIFICATE,
            // A rotated key whose current signer is not the trusted one.
            inspection(archive = archive.copy(signerSha256 = listOf(CERT, OTHER_CERT))) to Rejection.CERTIFICATE,
            inspection(installed = listOf(OTHER_CERT)) to Rejection.INSTALLED_CERTIFICATE,
            inspection(installed = emptyList()) to Rejection.INSTALLED_CERTIFICATE,
        ).forEach { (inspection, reason) -> assertEquals(reason, DownloadVerifier.verify(manifest, policy, inspection)) }
    }

    @Test
    fun `hashing helpers produce lowercase hex`() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256Hex(ByteArray(0)))
        val output = java.io.ByteArrayOutputStream()
        val (size, sha) = copyHashing("abc".byteInputStream(), output, 10)
        assertEquals(3L, size)
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", sha)
        val (limited, _) = copyHashing("abcdef".byteInputStream(), java.io.ByteArrayOutputStream(), 4)
        assertEquals(4L, limited)
    }
}
