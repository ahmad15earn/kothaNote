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
        versionCode = 2
        versionName = "1.1.0"

        ndk {
            // Phones only. Dropping the x86 emulator libraries keeps the
            // download near 140 MB instead of well over 200 MB.
            abiFilters += listOf("arm64-v8a", "armeabi-v7a")
        }
    }

    buildTypes {
        debug {
            isDebuggable = true
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
