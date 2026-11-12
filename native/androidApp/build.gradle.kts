import com.android.build.api.artifact.SingleArtifact
import javax.xml.parsers.DocumentBuilderFactory
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

    // The instrumented smoke test (src/androidTest) launches MainActivity on a device or emulator.
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.compose.uiTestJunit4)
    debugImplementation(libs.androidx.compose.uiTestManifest)
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
        versionName = "0.4.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // One APK per ABI, because ONNX Runtime's native library is 23 to 39 MB per ABI and an APK for
    // all of them would carry every one. arm64-v8a is the APK that is signed and published on GitHub
    // Releases, for nearly every phone in use; a phone with only a 32-bit system (some low-end
    // Android Go models) cannot install it. x86_64 is built for emulators (CI's release smoke test)
    // and Chromebooks. 32-bit ARM and x86 are left out, and so is a universal APK (DECISIONS.md,
    // phase 2b).
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
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
        // Native libraries are stored compressed and extracted at install. Stored uncompressed (the
        // default), ONNX Runtime alone would make the APK, which is downloaded from GitHub Releases,
        // about 95 MB larger; the cost is that space again on the phone once installed.
        jniLibs {
            useLegacyPackaging = true
        }
    }

    // CADDIE_BLE_ENABLED is the release gate of native Bluetooth proximity (DECISIONS.md, phase 4):
    // on in debug builds, off in release builds until the exit test on real phones has passed. Off,
    // the app creates no Bluetooth platform at all (AndroidPeopleServices.create), so the feature is
    // hidden even where the backend offers it, and nothing restarts the radio.
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            buildConfigField("boolean", "CADDIE_BLE_ENABLED", "true")
        }
        getByName("release") {
            buildConfigField("boolean", "CADDIE_BLE_ENABLED", "false")
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

/**
 * Fails when the merged manifest of a variant brings back what ONNX Runtime's AAR adds and
 * src/main/AndroidManifest.xml removes: the telemetry initializer (a content provider that starts
 * with the app and uploads to Microsoft) and the ACCESS_NETWORK_STATE permission. A new ONNX Runtime
 * version could rename the provider or add another component, so any provider, receiver, service or
 * activity of ONNX Runtime fails too. Runs with every assemble.
 */
abstract class CheckOnnxRuntimeManifest : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val manifest: RegularFileProperty

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun check() {
        val android = "http://schemas.android.com/apk/res/android"
        val factory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }
        val doc = factory.newDocumentBuilder().parse(manifest.get().asFile)
        fun names(tag: String) = doc.getElementsByTagName(tag).let { list ->
            (0 until list.length).map { (list.item(it) as org.w3c.dom.Element).getAttributeNS(android, "name") }
        }
        val components = listOf("provider", "receiver", "service", "activity")
            .flatMap { tag -> names(tag).filter { it.startsWith("ai.onnxruntime.") }.map { "the $tag $it" } }
        val problems = components +
            names("uses-permission").filter { it == "android.permission.ACCESS_NETWORK_STATE" }.map { "the permission $it" }
        if (problems.isNotEmpty()) {
            throw GradleException(
                "The merged manifest has ${problems.joinToString(" and ")}, which ONNX Runtime's AAR adds and the app " +
                    "must not have. Remove each in src/main/AndroidManifest.xml with tools:node=\"remove\".",
            )
        }
        report.get().asFile.writeText("No ONNX Runtime component and no ACCESS_NETWORK_STATE in ${manifest.get().asFile.name}.\n")
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val check = tasks.register<CheckOnnxRuntimeManifest>("check${name}OnnxRuntimeManifest") {
            group = "verification"
            description = "Checks that the ${variant.name} manifest has no ONNX Runtime component and no ACCESS_NETWORK_STATE."
            manifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            report.set(layout.buildDirectory.file("reports/onnxruntime-manifest/${variant.name}.txt"))
        }
        tasks.matching { it.name == "assemble$name" || it.name == "check" }.configureEach { dependsOn(check) }
    }
}
