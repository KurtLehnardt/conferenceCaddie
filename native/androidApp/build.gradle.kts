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

// Native Bluetooth proximity is gated per build (DECISIONS.md, phase 4): on in every debug build, off
// in release builds until the exit test on real phones has passed. -Pcaddie.bleEnabled=true turns it
// on in a release build too, an optimised build for that exit test only. One switch drives both the
// BuildConfig flag and the Bluetooth manifest (src/ble/AndroidManifest.xml), so a build either has
// the whole feature or declares none of it.
val bleInRelease = when (val value = providers.gradleProperty("caddie.bleEnabled").orNull) {
    null, "false" -> false
    "true" -> true
    else -> throw GradleException("caddie.bleEnabled must be true or false, not \"$value\".")
}

fun bleEnabledFor(buildType: String?): Boolean = buildType == "debug" || (buildType == "release" && bleInRelease)

// An Android App Bundle (bundleRelease, for Google Play) carries every ABI, and Play serves each
// device only its own. AGP refuses to build a bundle while the APK ABI splits below are on
// (https://issuetracker.google.com/402800800), so they are off in a build that asks for a bundle
// task. Build the APKs and the bundle in separate Gradle runs: in one run together the APKs would
// not be split.
val buildsBundle = gradle.startParameter.taskNames.any { it.substringAfterLast(':').startsWith("bundle") }

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
    // phase 2b). The bundle for Google Play has no splits and every ABI (buildsBundle above).
    splits {
        abi {
            isEnable = !buildsBundle
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

    // CADDIE_BLE_ENABLED is the release gate of native Bluetooth proximity (bleEnabledFor above). Off,
    // the app creates no Bluetooth platform at all (AndroidPeopleServices.create), so the feature is
    // hidden even where the backend offers it, nothing restarts the radio, and the manifest declares
    // no Bluetooth permission and no BleRadioService (androidComponents below).
    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        getByName("debug") {
            buildConfigField("boolean", "CADDIE_BLE_ENABLED", bleEnabledFor("debug").toString())
        }
        getByName("release") {
            buildConfigField("boolean", "CADDIE_BLE_ENABLED", bleEnabledFor("release").toString())
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
 * activity of ONNX Runtime fails too. Runs with every assemble and bundle.
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

/**
 * Fails when the merged manifest of a variant disagrees with its Bluetooth gate (bleEnabledFor). With
 * the gate off (a release build without -Pcaddie.bleEnabled=true) it must declare no Bluetooth
 * permission, no FOREGROUND_SERVICE_CONNECTED_DEVICE, no Bluetooth hardware and no BleRadioService,
 * whatever a library adds; with it on it must declare the service and the permissions the radio
 * needs. Runs with every assemble and bundle.
 */
abstract class CheckBluetoothManifest : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val manifest: RegularFileProperty

    @get:Input
    abstract val bleEnabled: Property<Boolean>

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
        val service = "app.conferencecaddie.shared.ble.BleRadioService"
        val permissions = names("uses-permission")
        val bluetooth = permissions
            .filter { it.startsWith("android.permission.BLUETOOTH") || it == "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" }
            .map { "the permission $it" } +
            names("uses-feature").filter { it.startsWith("android.hardware.bluetooth") }.map { "the feature $it" } +
            names("service").filter { it == service }.map { "the service $it" }
        val file = manifest.get().asFile.name
        if (bleEnabled.get()) {
            val needed = listOf(
                "android.permission.BLUETOOTH_ADVERTISE",
                "android.permission.BLUETOOTH_SCAN",
                "android.permission.BLUETOOTH_CONNECT",
                "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
            ).filter { it !in permissions }.map { "the permission $it" } +
                listOf(service).filter { it !in names("service") }.map { "the service $it" }
            if (needed.isNotEmpty()) {
                throw GradleException(
                    "Bluetooth proximity is on in this build, but the merged manifest lacks ${needed.joinToString(" and ")}. " +
                        "They are declared in src/ble/AndroidManifest.xml.",
                )
            }
            report.get().asFile.writeText("Bluetooth on: ${bluetooth.size} Bluetooth entries in $file.\n")
        } else {
            if (bluetooth.isNotEmpty()) {
                throw GradleException(
                    "Bluetooth proximity is off in this build (CADDIE_BLE_ENABLED), but the merged manifest has " +
                        "${bluetooth.joinToString(" and ")}. Only src/ble/AndroidManifest.xml may declare them, and it is " +
                        "merged only where Bluetooth is on.",
                )
            }
            report.get().asFile.writeText("Bluetooth off: no Bluetooth entries in $file.\n")
        }
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar { it.uppercase() }
        val ble = bleEnabledFor(variant.buildType)
        // The Bluetooth manifest joins the variant's own manifests only where the feature is on.
        if (ble) variant.sources.manifests.addStaticManifestFile("src/ble/AndroidManifest.xml")
        val onnxCheck = tasks.register<CheckOnnxRuntimeManifest>("check${name}OnnxRuntimeManifest") {
            group = "verification"
            description = "Checks that the ${variant.name} manifest has no ONNX Runtime component and no ACCESS_NETWORK_STATE."
            manifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            report.set(layout.buildDirectory.file("reports/onnxruntime-manifest/${variant.name}.txt"))
        }
        val bluetoothCheck = tasks.register<CheckBluetoothManifest>("check${name}BluetoothManifest") {
            group = "verification"
            description = "Checks that the ${variant.name} manifest declares Bluetooth exactly when CADDIE_BLE_ENABLED is on."
            manifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            bleEnabled.set(ble)
            report.set(layout.buildDirectory.file("reports/bluetooth-manifest/${variant.name}.txt"))
        }
        tasks.matching { it.name == "assemble$name" || it.name == "bundle$name" || it.name == "check" }.configureEach {
            dependsOn(onnxCheck, bluetoothCheck)
        }
    }
}
