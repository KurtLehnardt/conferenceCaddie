plugins {
    alias(libs.plugins.androidApplication) apply false
    alias(libs.plugins.androidMultiplatformLibrary) apply false
    alias(libs.plugins.composeCompiler) apply false
    alias(libs.plugins.composeMultiplatform) apply false
    alias(libs.plugins.kotlinMultiplatform) apply false
    alias(libs.plugins.kotlinxSerialization) apply false
}

// The iOS simulator tests run on the Kotlin plugin's default simulator unless -Pcaddie.iosTestDevice
// names another one (a simulator's name or UDID), so several checkouts can run them side by side.
subprojects {
    tasks.withType<org.jetbrains.kotlin.gradle.targets.native.tasks.KotlinNativeSimulatorTest>().configureEach {
        providers.gradleProperty("caddie.iosTestDevice").orNull?.let { device.set(it) }
    }
}
