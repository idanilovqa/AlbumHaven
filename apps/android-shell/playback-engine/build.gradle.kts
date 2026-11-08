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
}

dependencies {
    testImplementation(libs.junit)

    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.runner)
}
