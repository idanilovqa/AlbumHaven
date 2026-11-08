plugins {
    alias(libs.plugins.android.library)
}

// The playback engine and its decoders know nothing of the WebView shell, so the planned
// packages/native/native-media module can take them over unchanged.
android {
    namespace = "org.albumhaven.playback"
    compileSdk = 36
    // CI runners and developers build the decoders with this exact NDK and CMake.
    ndkVersion = "27.3.13750724"

    defaultConfig {
        minSdk = 29
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            // 64-bit devices and emulators; the vendored mpg123 configuration is LP64.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.31.6"
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
