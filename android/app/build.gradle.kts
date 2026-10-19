plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release versions come from the tag (BOOKSYNC_VERSION), like the server and the extension.
val appVersion = BookSyncVersion.name(System.getenv("BOOKSYNC_VERSION"))

android {
    namespace = "io.booksync.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.booksync.android"
        minSdk = 26
        targetSdk = 37
        versionCode = BookSyncVersion.code(appVersion)
        versionName = appVersion
        // Only the ABIs the Go core is built for (Makefile android-aar). Otherwise
        // androidx's 32-bit libraries would make the app installable on 32-bit
        // devices, where it would fail to load libgojni.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }

    signingConfigs {
        // Release signing comes from the environment (CI secrets); without it
        // the release build is unsigned and only the debug key applies to debug.
        val storeFile = System.getenv("ANDROID_KEYSTORE_FILE")
        if (storeFile != null) {
            create("release") {
                this.storeFile = file(storeFile)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    buildFeatures { compose = true }

    lint {
        // A lint finding must never land, as for the Go and TS code.
        warningsAsErrors = true
        abortOnError = true
        // These only report that something newer was released upstream, so they
        // turn red without any change here and would block a release. Upgrades
        // are deliberate commits instead.
        disable += setOf("AndroidGradlePluginVersion", "GradleDependency", "OldTargetApi")
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all { test ->
            // Robolectric fetches its Android jars at test time; allow a mirror.
            System.getenv("ROBOLECTRIC_REPO_URL")?.let { test.systemProperty("robolectric.dependency.repo.url", it) }
        }
    }
}

dependencies {
    implementation(files("libs/booksync-core.aar"))
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.icons.core)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.work.runtime)
    implementation(libs.coroutines.android)
    implementation(libs.serialization.json)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.work.testing)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    debugImplementation(libs.compose.ui.test.manifest)
}
