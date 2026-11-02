plugins {
    alias(libs.plugins.android.application)
}

// Debug-only local server, for example -PalbumHavenDevOrigin=http://10.0.2.2:5000.
val devOrigin = providers.gradleProperty("albumHavenDevOrigin").getOrElse("")

android {
    namespace = "org.albumhaven.shell"
    compileSdk = 36

    defaultConfig {
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.10.0"
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

dependencies {
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation(libs.androidx.webkit)

    testImplementation(libs.junit)
    testImplementation(libs.json)

    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.test.runner)
}
