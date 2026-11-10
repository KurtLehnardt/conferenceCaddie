rootProject.name = "ConferenceCaddie"
enableFeaturePreview("TYPESAFE_PROJECT_ACCESSORS")

pluginManagement {
    repositories {
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google {
            mavenContent {
                includeGroupAndSubgroups("androidx")
                includeGroupAndSubgroups("com.android")
                includeGroupAndSubgroups("com.google")
            }
        }
        mavenCentral()
    }
}

// shared: the platform-neutral core (models, capabilities, platform interfaces).
// composeApp: the Compose Multiplatform UI, built as an Android library and as the iOS framework.
// androidApp: the Android application that hosts the UI. The iOS host is the Xcode project in iosApp/.
include(":shared")
include(":composeApp")
include(":androidApp")
