package org.albumhaven.shell.updates

import org.albumhaven.shell.ShellChannel
import org.json.JSONObject

const val CERT = "767897311e40ca5ed50fd8d59f376a05dc38ba4ea01dbec6cfd358169a748509"
const val OTHER_CERT = "0000000000000000000000000000000000000000000000000000000000000001"
const val COMMIT = "763af930aa11bb22cc33dd44ee55ff6677889900"
const val APK_SHA = "4f2b9c0e8d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c"
const val ARTIFACT_ORIGIN = "https://albumhaven.org"

fun policy(
    channel: ShellChannel = ShellChannel.SANDBOX,
    installedVersionCode: Long = 1,
    artifactOrigin: String = ARTIFACT_ORIGIN,
    deviceApi: Int = 36,
) = UpdatePolicy(
    channel = channel,
    applicationId = if (channel == ShellChannel.STABLE) "org.albumhaven.app" else "org.albumhaven.app.sandbox",
    artifactOrigin = artifactOrigin,
    expectedCertificateSha256 = CERT,
    installedVersionCode = installedVersionCode,
    deviceApi = deviceApi,
)

/** A valid sandbox Update Manifest v1, with [changes] applied; a null value removes the field. */
fun manifestJson(vararg changes: Pair<String, Any?>, channel: ShellChannel = ShellChannel.SANDBOX): String {
    val sandbox = channel == ShellChannel.SANDBOX
    val json = JSONObject()
        .put("schemaVersion", 1)
        .put("channel", channel.wireName)
        .put("applicationId", if (sandbox) "org.albumhaven.app.sandbox" else "org.albumhaven.app")
        .put("versionCode", 2)
        .put("versionName", if (sandbox) "0.10.0-sandbox.763af93" else "0.10.1")
        .put("sourceCommit", COMMIT)
        .put("apkUrl", "$ARTIFACT_ORIGIN/artifacts/android/${channel.wireName}/album-haven-2.apk")
        .put("apkSize", 4096)
        .put("sha256", APK_SHA)
        .put("signingCertificateSha256", CERT)
        .put("minAndroidApi", 29)
        .put("bridgeProtocolMin", 1)
        .put("bridgeProtocolMax", 1)
        .put("publishedAt", "2026-11-04T18:00:00Z")
        .put("releaseNotesUrl", "https://albumhaven.org/releases/0.10.1")
    changes.forEach { (key, value) -> if (value == null) json.remove(key) else json.put(key, value) }
    return json.toString()
}

fun manifest(vararg changes: Pair<String, Any?>): UpdateManifest =
    (ManifestValidator.check(manifestJson(*changes), policy(), 1..1) as ManifestCheck.Newer).manifest

fun inspection(
    size: Long = 4096,
    sha256: String = APK_SHA,
    archive: ArchiveFacts? = ArchiveFacts("org.albumhaven.app.sandbox", 2, "0.10.0-sandbox.763af93", listOf(CERT), false),
    installed: List<String> = listOf(CERT),
) = DownloadInspection(size, sha256, archive, installed)
