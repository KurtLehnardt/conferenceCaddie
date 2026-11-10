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

        // The Compose UI tests in commonTest also run on an Android device or emulator
        // (connectedAndroidDeviceTest), so one set of UI tests covers both platforms.
        withDeviceTestBuilder {
            sourceSetTreeName = "test"
        }.configure {
            instrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
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
            implementation(libs.compose.ui.backhandler)
            implementation(libs.compose.components.resources)
            implementation(libs.compose.uiToolingPreview)
            implementation(libs.androidx.lifecycle.runtimeCompose)
        }
        commonTest.dependencies {
            implementation(libs.kotlin.test)
            implementation(libs.compose.uiTest)
        }
        getByName("androidDeviceTest").dependencies {
            implementation(libs.androidx.test.core)
            implementation(libs.androidx.test.runner)
            implementation(libs.androidx.compose.uiTestJunit4)
            implementation(libs.androidx.compose.uiTestManifest)
        }
    }
}

dependencies {
    androidRuntimeClasspath(libs.compose.uiTooling)
}

// The query embedding model and its vocabulary ship with the app as Compose resources
// (files/embedding/), on Android in the APK's assets and on iOS in the app's compose-resources
// folder. shared downloads and verifies them (gradle/pinned-downloads.properties); this copies them
// into a resource directory of their own, which git never sees.
val embeddingResources = tasks.register<Sync>("embeddingResources") {
    dependsOn(":shared:downloadEmbeddingModel", ":shared:downloadEmbeddingVocab")
    from(rootProject.layout.projectDirectory.dir("shared/build/embedding/bge-small-en-v1.5")) {
        include("model_quantized.onnx", "vocab.txt")
        into("files/embedding")
    }
    into(layout.buildDirectory.dir("generated/embeddingResources"))
}

compose.resources {
    packageOfResClass = "app.conferencecaddie.ui.resources"
    customDirectory(
        sourceSetName = "commonMain",
        directoryProvider = embeddingResources.map { layout.buildDirectory.dir("generated/embeddingResources").get() },
    )
}
