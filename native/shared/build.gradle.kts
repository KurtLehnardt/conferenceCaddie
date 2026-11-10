import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The platform-neutral core: models, the capabilities document and the interfaces that each
// platform implements (embeddings, Bluetooth, notifications, secure storage). No UI lives here.
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidMultiplatformLibrary)
    alias(libs.plugins.kotlinxSerialization)
}

kotlin {
    android {
        namespace = "app.conferencecaddie.shared"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()

        compilerOptions {
            jvmTarget = JvmTarget.JVM_17
        }

        // Runs commonTest on the JVM as Android host tests, so Linux CI exercises the shared code.
        withHostTest {}
    }

    // iosX64 is left out: Compose Multiplatform 1.12 publishes no x86_64 simulator artifacts, and
    // Xcode 27 runs only on Apple silicon.
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
        }
    }
}
