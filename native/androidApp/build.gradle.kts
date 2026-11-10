import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Android application. It shares applicationId app.conferencecaddie with the Capacitor app in
// web/android, so that once both are signed with the same release key, this app can replace it as
// an update.
plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeCompiler)
}

// Release signing for local builds comes from the environment, never from files in the
// repository: ANDROID_KEYSTORE_FILE (path to the keystore), ANDROID_KEYSTORE_PASSWORD,
// ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD. With none of them set, release builds are signed with
// the debug key so that `assembleRelease` still works without the keystore. With only some of them
// set, the build stops, because that is almost always a mistake.
//
// CI never gives Gradle the key. It passes -Pcaddie.unsignedRelease=true, builds an unsigned release
// APK, and signs it in a separate job (see .github/workflows/native.yml).
val signingVariables = listOf(
    "ANDROID_KEYSTORE_FILE",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
).associateWith { providers.environmentVariable(it).orNull?.takeIf(String::isNotEmpty) }
val missingSigningVariables = signingVariables.filterValues { it == null }.keys
if (missingSigningVariables.isNotEmpty() && missingSigningVariables.size < signingVariables.size) {
    throw GradleException(
        "Release signing needs all four ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, " +
            "ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD; these are missing: " +
            missingSigningVariables.joinToString(", "),
    )
}
val hasReleaseSigning = missingSigningVariables.isEmpty()
val unsignedRelease = providers.gradleProperty("caddie.unsignedRelease").orNull == "true"

// CI sets CADDIE_VERSION_CODE to 1000 + the workflow run number, which keeps every native build
// above the Capacitor app's versionCode. Local builds use 1.
val caddieVersionCode = providers.environmentVariable("CADDIE_VERSION_CODE").orNull?.let { value ->
    value.toIntOrNull()?.takeIf { it > 0 }
        ?: throw GradleException("CADDIE_VERSION_CODE must be a positive integer.")
} ?: 1

dependencies {
    implementation(projects.composeApp)
    implementation(libs.androidx.activity.compose)
    implementation(libs.compose.uiToolingPreview)
    implementation(libs.compose.foundation)
}

android {
    namespace = "app.conferencecaddie"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "app.conferencecaddie"
        // Android 8.0: the first version with the Bluetooth 5 extended advertising API that the
        // "near me" feature uses. The Capacitor app has the same floor (web/android/variables.gradle).
        minSdk = libs.versions.android.minSdk.get().toInt()
        targetSdk = libs.versions.android.targetSdk.get().toInt()
        versionCode = caddieVersionCode
        versionName = "0.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning && !unsignedRelease) {
            create("release") {
                storeFile = file(signingVariables.getValue("ANDROID_KEYSTORE_FILE")!!)
                storePassword = signingVariables.getValue("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = signingVariables.getValue("ANDROID_KEY_ALIAS")
                keyPassword = signingVariables.getValue("ANDROID_KEY_PASSWORD")
            }
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = when {
                unsignedRelease -> null
                hasReleaseSigning -> signingConfigs.getByName("release")
                else -> {
                    logger.warn(
                        "Conference Caddie: ANDROID_KEYSTORE_* variables are not set; " +
                            "the release build is signed with the debug key.",
                    )
                    signingConfigs.getByName("debug")
                }
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_17
    }
}
