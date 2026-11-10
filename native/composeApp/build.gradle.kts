import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The Compose Multiplatform UI. On Android it is a library that androidApp hosts; on iOS it is the
// "ComposeApp" framework that the Xcode project in iosApp/ embeds. The framework re-exports
// :shared, so Swift code can implement the shared interfaces (BleRadio, SecureStore and so on).
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.androidMultiplatformLibrary)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

kotlin {
    android {
        namespace = "app.conferencecaddie.ui"
        compileSdk = libs.versions.android.compileSdk.get().toInt()
        minSdk = libs.versions.android.minSdk.get().toInt()

        compilerOptions {
            jvmTarget = JvmTarget.JVM_17
        }
        androidResources {
            enable = true
        }
    }

    listOf(
        iosArm64(),
        iosSimulatorArm64(),
    ).forEach { iosTarget ->
        iosTarget.binaries.framework {
            baseName = "ComposeApp"
            isStatic = true
            binaryOption("bundleId", "app.conferencecaddie.ComposeApp")
            export(projects.shared)
        }
    }

    sourceSets {
        commonMain.dependencies {
            api(projects.shared)

            implementation(libs.compose.runtime)
            implementation(libs.compose.foundation)
            implementation(libs.compose.material3)
            implementation(libs.compose.material.icons.core)
            implementation(libs.compose.ui)
            implementation(libs.compose.components.resources)
            implementation(libs.compose.uiToolingPreview)
            implementation(libs.androidx.lifecycle.runtimeCompose)
        }
    }
}

dependencies {
    androidRuntimeClasspath(libs.compose.uiTooling)
}
