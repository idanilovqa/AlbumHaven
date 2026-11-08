import com.android.build.api.variant.BuildConfigField
import java.security.KeyStore
import java.security.MessageDigest

plugins {
    alias(libs.plugins.android.application)
}

// Debug-only local server, for example -PalbumHavenDevOrigin=http://10.0.2.2:5000.
val devOrigin = providers.gradleProperty("albumHavenDevOrigin").getOrElse("")

// Release builds trust their channel's release signing certificate (SHA-256 of the DER certificate,
// 64 lowercase hex). Without one the build offers no updates. Debug builds trust the debug key.
val releaseCertificates = mapOf(
    "stable" to providers.gradleProperty("albumHavenStableCertificateSha256").getOrElse(""),
    "sandbox" to providers.gradleProperty("albumHavenSandboxCertificateSha256").getOrElse(""),
)

// Promotion assigns these; local builds keep the defaults below.
val versionCodeOverride = providers.gradleProperty("albumHavenVersionCode").map(String::toInt)
val versionNameOverride = providers.gradleProperty("albumHavenVersionName")

fun certificateSha256(storeFile: File?, storePassword: String?, alias: String?): String {
    if (storeFile == null || !storeFile.isFile || storePassword == null || alias == null) return ""
    val store = KeyStore.getInstance(storeFile, storePassword.toCharArray())
    val certificate = store.getCertificate(alias) ?: return ""
    return MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
}

android {
    namespace = "org.albumhaven.shell"
    compileSdk = 36

    defaultConfig {
        minSdk = 29
        targetSdk = 36
        versionCode = versionCodeOverride.getOrElse(1)
        versionName = versionNameOverride.getOrElse("0.10.0")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
        resValues = true
    }

    flavorDimensions += "channel"
    productFlavors {
        create("stable") {
            dimension = "channel"
            applicationId = "org.albumhaven.app"
            buildConfigField("String", "CHANNEL", "\"stable\"")
            resValue("string", "app_name", "Album Haven")
        }
        create("sandbox") {
            dimension = "channel"
            applicationId = "org.albumhaven.app.sandbox"
            buildConfigField("String", "CHANNEL", "\"sandbox\"")
            resValue("string", "app_name", "Album Haven Sandbox")
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "DEV_ORIGIN", "\"$devOrigin\"")
            manifestPlaceholders["cleartextTraffic"] = devOrigin.startsWith("http://")
        }
        release {
            buildConfigField("String", "DEV_ORIGIN", "\"\"")
            manifestPlaceholders["cleartextTraffic"] = false
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    onVariants { variant ->
        val certificate = if (variant.buildType == "debug") {
            val debug = android.signingConfigs.getByName("debug")
            certificateSha256(debug.storeFile, debug.storePassword, debug.keyAlias)
        } else {
            releaseCertificates.getValue(checkNotNull(variant.flavorName))
        }
        require(certificate.isEmpty() || Regex("^[0-9a-f]{64}$").matches(certificate)) {
            "Update certificate must be 64 lowercase hexadecimal characters"
        }
        variant.buildConfigFields?.put(
            "UPDATE_CERTIFICATE_SHA256",
            BuildConfigField("String", "\"$certificate\"", "Signing certificate an update must carry"),
        )
    }
}

dependencies {
    implementation(project(":playback-engine"))
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation(libs.androidx.webkit)
    implementation(libs.media3.session)
    implementation(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.json)
    testImplementation(libs.okhttp.mockwebserver)

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.runner)
}
