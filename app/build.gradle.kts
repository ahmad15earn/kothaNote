plugins {
    id("com.android.application")
}

android {
    namespace = "com.kothanote.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.kothanote.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"

        ndk {
            // Phones only. Dropping the x86 emulator libraries keeps the
            // download near 140 MB instead of well over 200 MB.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    signingConfigs {
        // A stable debug key (kept in the repository on purpose) so every CI
        // build has the same signature. Without it Android refuses to install
        // an update over the previous release. This key is only for debug
        // sideload builds; it must never be used for a Play Store release.
        create("sharedDebug") {
            storeFile = file("kothanote-debug.jks")
            storePassword = "kothanote"
            keyAlias = "kothanote"
            keyPassword = "kothanote"
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
            signingConfig = signingConfigs.getByName("sharedDebug")
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }

    androidResources {
        // Model files must stay uncompressed so the native engine can open
        // them directly from the APK through AssetManager.
        noCompress += listOf("woff2", "onnx", "txt")
    }

    packaging {
        jniLibs {
            // Compress native libraries in the APK so the release download
            // stays manageable; Android extracts them once at install time.
            useLegacyPackaging = true
        }
    }
}

dependencies {
    implementation(files("libs/sherpa-onnx-2.0.2.aar"))
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.24")
}
