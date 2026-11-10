plugins {
    alias(libs.plugins.android.library)
}

// The playback engine and its decoders know nothing of the WebView shell, so the planned
// packages/native/native-media module can take them over unchanged.
android {
    namespace = "org.albumhaven.playback"
    compileSdk = 36
    // CI, the release container (cirruslabs/android-sdk:36-ndk) and developers use this exact NDK.
    ndkVersion = "27.3.13750724"

    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            // 64-bit devices and emulators; the vendored mpg123 configuration is LP64.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    // ndk-build comes with the NDK, so building the decoders needs no CMake.
    externalNativeBuild {
        ndkBuild {
            path = file("src/main/cpp/Android.mk")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The fake server, sinks and decoders the engine's tests and the app's controller tests share.
    testFixtures {
        enable = true
    }
}

dependencies {
    compileOnly(libs.androidx.annotation)
    testImplementation(libs.junit)
    // Unit tests run on the JVM, where Android's org.json is only a stub.
    testImplementation(libs.json)
    testFixturesImplementation(libs.junit)
    testFixturesImplementation(libs.json)

    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.runner)
}
