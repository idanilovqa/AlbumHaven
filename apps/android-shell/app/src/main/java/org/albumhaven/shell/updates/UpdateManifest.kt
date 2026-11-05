package org.albumhaven.shell.updates

import org.albumhaven.shell.ShellChannel
import org.albumhaven.shell.net.originOf
import org.albumhaven.shell.net.parseUri
import org.json.JSONException
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeParseException

/**
 * What this build trusts, compiled into each variant: its channel and application ID, the one
 * artifact origin manifests and APKs come from, and the release certificate an update must carry.
 */
data class UpdatePolicy(
    val channel: ShellChannel,
    val applicationId: String,
    val artifactOrigin: String,
    val expectedCertificateSha256: String,
    val installedVersionCode: Long,
    val deviceApi: Int,
    val maxApkBytes: Long = MAX_APK_BYTES,
) {
    val manifestUrl: String get() = "$artifactOrigin/artifacts/android/${channel.wireName}/manifest.json"

    /** Without a compiled certificate nothing can be verified, so the build offers no updates. */
    val enabled: Boolean get() = SHA256_HEX.matches(expectedCertificateSha256)

    companion object {
        const val MAX_APK_BYTES = 200L * 1024 * 1024
    }
}

/** A validated Update Manifest v1; [raw] is kept so a staged update can be validated again later. */
data class UpdateManifest(
    val versionCode: Long,
    val versionName: String,
    val sourceCommit: String,
    val apkUrl: String,
    val apkSize: Long,
    val sha256: String,
    val signingCertificateSha256: String,
    val minAndroidApi: Int,
    val bridgeProtocols: IntRange,
    val publishedAt: String,
    val releaseNotesUrl: String,
    val raw: String,
)

/** Why a manifest or a downloaded APK was refused. The wire name is path-free and safe to show. */
enum class Rejection(val wireName: String) {
    MALFORMED("malformed_manifest"),
    SCHEMA("unsupported_schema"),
    CHANNEL("wrong_channel"),
    APPLICATION_ID("wrong_application"),
    VERSION_NAME("invalid_version_name"),
    SOURCE_COMMIT("invalid_source_commit"),
    HOST("untrusted_host"),
    REDIRECT("cross_host_redirect"),
    SIZE("oversized_file"),
    CERTIFICATE("wrong_certificate"),
    ANDROID_VERSION("unsupported_android"),
    BRIDGE("incompatible_bridge"),
    SIZE_MISMATCH("size_mismatch"),
    HASH_MISMATCH("hash_mismatch"),
    PACKAGE_MISMATCH("package_mismatch"),
    INSTALLED_CERTIFICATE("installed_certificate_mismatch"),
    UNREADABLE_APK("unreadable_apk"),
}

sealed interface ManifestCheck {
    /** Valid and newer than the installed app. */
    data class Newer(val manifest: UpdateManifest) : ManifestCheck

    /** Valid, but its version code is not greater than the installed one: never downloaded. */
    data class Current(val manifest: UpdateManifest) : ManifestCheck
    data class Rejected(val reason: Rejection) : ManifestCheck
}

/** Update Manifest v1: every field is required, typed, and checked against the compiled policy. */
object ManifestValidator {
    const val MAX_MANIFEST_BYTES = 16 * 1024
    const val MIN_ANDROID_API = 29

    private val KEYS = setOf(
        "schemaVersion", "channel", "applicationId", "versionCode", "versionName", "sourceCommit",
        "apkUrl", "apkSize", "sha256", "signingCertificateSha256", "minAndroidApi",
        "bridgeProtocolMin", "bridgeProtocolMax", "publishedAt", "releaseNotesUrl",
    )
    private val STABLE_VERSION = Regex("^(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})$")
    private val SANDBOX_VERSION = Regex("^(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})\\.(0|[1-9]\\d{0,4})-sandbox\\.([0-9a-f]{7,12})$")
    private val COMMIT = Regex("^[0-9a-f]{40}$")
    private val PUBLISHED_AT = Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$")
    private val APK_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.apk$")

    /** [webProtocols] is the bridge range the current site offered; null before any document connected. */
    fun check(raw: String, policy: UpdatePolicy, webProtocols: IntRange?): ManifestCheck {
        val manifest = try {
            parse(raw, policy, webProtocols)
        } catch (rejected: RejectedException) {
            return ManifestCheck.Rejected(rejected.reason)
        }
        return if (manifest.versionCode > policy.installedVersionCode) {
            ManifestCheck.Newer(manifest)
        } else {
            ManifestCheck.Current(manifest)
        }
    }

    private class RejectedException(val reason: Rejection) : Exception(reason.wireName)

    private fun reject(reason: Rejection): Nothing = throw RejectedException(reason)

    private fun parse(raw: String, policy: UpdatePolicy, webProtocols: IntRange?): UpdateManifest {
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_MANIFEST_BYTES) reject(Rejection.MALFORMED)
        val json = try {
            JSONObject(raw)
        } catch (_: JSONException) {
            reject(Rejection.MALFORMED)
        }
        if (json.keys().asSequence().toSet() != KEYS) reject(Rejection.MALFORMED)
        if (integer(json, "schemaVersion") != 1L) reject(Rejection.SCHEMA)
        if (text(json, "channel") != policy.channel.wireName) reject(Rejection.CHANNEL)
        if (text(json, "applicationId") != policy.applicationId) reject(Rejection.APPLICATION_ID)

        val versionCode = integer(json, "versionCode").takeIf { it in 1..Int.MAX_VALUE } ?: reject(Rejection.MALFORMED)
        val sourceCommit = text(json, "sourceCommit").takeIf(COMMIT::matches) ?: reject(Rejection.SOURCE_COMMIT)
        val versionName = text(json, "versionName")
        if (!versionNameMatches(versionName, policy.channel, sourceCommit)) reject(Rejection.VERSION_NAME)

        val apkUrl = text(json, "apkUrl")
        if (!isTrustedApkUrl(apkUrl, policy)) reject(Rejection.HOST)
        val apkSize = integer(json, "apkSize").takeIf { it > 0 } ?: reject(Rejection.MALFORMED)
        if (apkSize > policy.maxApkBytes) reject(Rejection.SIZE)
        val sha256 = text(json, "sha256").takeIf(SHA256_HEX::matches) ?: reject(Rejection.MALFORMED)
        val certificate = text(json, "signingCertificateSha256").takeIf(SHA256_HEX::matches) ?: reject(Rejection.MALFORMED)
        if (certificate != policy.expectedCertificateSha256) reject(Rejection.CERTIFICATE)

        val minApi = integer(json, "minAndroidApi").takeIf { it in MIN_ANDROID_API..1000 } ?: reject(Rejection.MALFORMED)
        if (minApi > policy.deviceApi) reject(Rejection.ANDROID_VERSION)
        val bridgeMin = integer(json, "bridgeProtocolMin").takeIf { it in 1..1000 } ?: reject(Rejection.MALFORMED)
        val bridgeMax = integer(json, "bridgeProtocolMax").takeIf { it in bridgeMin..1000 } ?: reject(Rejection.MALFORMED)
        val bridge = bridgeMin.toInt()..bridgeMax.toInt()
        if (webProtocols != null && (bridge.first > webProtocols.last || webProtocols.first > bridge.last)) {
            reject(Rejection.BRIDGE)
        }

        val publishedAt = text(json, "publishedAt").takeIf(::isUtcInstant) ?: reject(Rejection.MALFORMED)
        val releaseNotesUrl = text(json, "releaseNotesUrl").takeIf(::isHttpsUrl) ?: reject(Rejection.MALFORMED)
        return UpdateManifest(
            versionCode = versionCode,
            versionName = versionName,
            sourceCommit = sourceCommit,
            apkUrl = apkUrl,
            apkSize = apkSize,
            sha256 = sha256,
            signingCertificateSha256 = certificate,
            minAndroidApi = minApi.toInt(),
            bridgeProtocols = bridge,
            publishedAt = publishedAt,
            releaseNotesUrl = releaseNotesUrl,
            raw = raw,
        )
    }

    /** Stable matches Album Haven semver; sandbox appends `-sandbox.<short-sha>` of its own source commit. */
    private fun versionNameMatches(name: String, channel: ShellChannel, commit: String): Boolean = when (channel) {
        ShellChannel.STABLE -> STABLE_VERSION.matches(name)
        ShellChannel.SANDBOX -> SANDBOX_VERSION.matchEntire(name)?.groupValues?.get(4)?.let(commit::startsWith) == true
    }

    /** The immutable APK lives on the compiled artifact origin, under this channel's own directory. */
    private fun isTrustedApkUrl(url: String, policy: UpdatePolicy): Boolean {
        val uri = parseUri(url) ?: return false
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return false
        if (originOf(uri) != policy.artifactOrigin) return false
        val prefix = "/artifacts/android/${policy.channel.wireName}/"
        val path = uri.rawPath ?: return false
        return path.startsWith(prefix) && APK_NAME.matches(path.removePrefix(prefix))
    }

    private fun isUtcInstant(value: String): Boolean = PUBLISHED_AT.matches(value) && try {
        Instant.parse(value)
        true
    } catch (_: DateTimeParseException) {
        false
    }

    private fun isHttpsUrl(value: String): Boolean {
        val uri = parseUri(value) ?: return false
        return uri.scheme == "https" && uri.host != null && uri.rawUserInfo == null
    }

    private fun text(json: JSONObject, key: String): String = json.get(key) as? String ?: reject(Rejection.MALFORMED)

    /** Whole JSON numbers only: no strings, fractions, or booleans. */
    private fun integer(json: JSONObject, key: String): Long = when (val value = json.get(key)) {
        is Int -> value.toLong()
        is Long -> value
        else -> reject(Rejection.MALFORMED)
    }
}

/** What the downloaded file and its APK say about themselves. */
data class ArchiveFacts(
    val packageName: String,
    val versionCode: Long,
    val versionName: String?,
    /** Certificate SHA-256s in rotation order; the current signer is last. */
    val signerSha256: List<String>,
    val multipleSigners: Boolean,
)

data class DownloadInspection(
    val size: Long,
    val sha256: String,
    /** Null when Android could not read the file as an APK. */
    val archive: ArchiveFacts?,
    /** The installed app's own signers, current last. */
    val installedSignerSha256: List<String>,
)

/** Every invariant the downloaded APK must meet before it reaches `PackageInstaller`. */
object DownloadVerifier {
    fun verify(manifest: UpdateManifest, policy: UpdatePolicy, inspection: DownloadInspection): Rejection? {
        if (inspection.size != manifest.apkSize) return Rejection.SIZE_MISMATCH
        if (inspection.sha256 != manifest.sha256) return Rejection.HASH_MISMATCH
        val archive = inspection.archive ?: return Rejection.UNREADABLE_APK
        if (archive.packageName != policy.applicationId) return Rejection.PACKAGE_MISMATCH
        if (archive.versionCode != manifest.versionCode || archive.versionName != manifest.versionName) {
            return Rejection.PACKAGE_MISMATCH
        }
        val signer = archive.signerSha256.lastOrNull()
        if (archive.multipleSigners || signer == null) return Rejection.CERTIFICATE
        if (signer != policy.expectedCertificateSha256 || signer != manifest.signingCertificateSha256) {
            return Rejection.CERTIFICATE
        }
        if (inspection.installedSignerSha256.lastOrNull() != signer) return Rejection.INSTALLED_CERTIFICATE
        return null
    }
}

val SHA256_HEX = Regex("^[0-9a-f]{64}$")

fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

/** Copies at most [limit] bytes, returning the byte count and SHA-256 of what was copied. */
fun copyHashing(input: InputStream, output: OutputStream, limit: Long): Pair<Long, String> {
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (total < limit) {
        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), limit - total).toInt())
        if (read < 0) break
        digest.update(buffer, 0, read)
        output.write(buffer, 0, read)
        total += read
    }
    return total to digest.digest().toHex()
}

fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
