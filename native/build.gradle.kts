buildscript {
    // Security floors for the build's own tools (Dependabot alerts of 2026-11-11). Every alert on native/
    // so far is a transitive dependency of a build tool: the Android Gradle Plugin and the Kotlin
    // plugin on this classpath, Android Lint, the Unified Test Platform that runs the device tests, and
    // the Kotlin plugin's Swift export classpath. None of these modules is in the APK or the iOS
    // framework, and Dependabot cannot raise a transitive version, so its security updates fail; the
    // floors are kept here by hand (DECISIONS.md, "Security floors for the native build's tools").
    // A constraint raises a module that is already in a graph to at least this version and never adds
    // one. The subprojects block below applies the same list (the constraints whose reason starts with
    // "security floor", since Gradle adds a few of its own to this classpath) to the tool classpaths
    // inside the modules, so this list is the only place a floor is written.
    dependencies {
        constraints {
            listOf(
                "org.bouncycastle:bcprov-jdk18on:1.85" to
                    "GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26, GHSA-574f-3g2m-x479, GHSA-p93r-85wp-75v3, GHSA-c3fc-8qff-9hwx",
                // Bouncy Castle's jars are released together and must stay on one version.
                "org.bouncycastle:bcpkix-jdk18on:1.85" to "GHSA-wg6q-6289-32hp; same release as bcprov",
                "org.bouncycastle:bcutil-jdk18on:1.85" to "same release as bcprov",
                "com.google.guava:guava:33.7.2-jre" to "GHSA-xxph-c9ww-hj94",
                "io.opentelemetry:opentelemetry-api:1.67.0" to "GHSA-ccrj-gw8r-854m, GHSA-rcgg-9c38-7xpx",
                "org.bitbucket.b_c:jose4j:0.9.6" to "GHSA-3677-xxcr-wjqv",
                "org.jdom:jdom2:2.0.6.1" to "GHSA-2363-cqg2-863c",
                "org.apache.commons:commons-lang3:3.18.0" to "GHSA-j288-q9x7-2f5v",
                "org.apache.httpcomponents:httpclient:4.5.14" to "GHSA-7r82-7xv7-xcpj",
            ).forEach { (notation, advisories) -> add("classpath", notation) { because("security floor: $advisories") } }
        }
    }
}

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

// The plugin classpath's security floors (buildscript block above) also hold for the tool classpaths
// that the Android and Kotlin plugins resolve inside each module: Android Lint (androidLintTool), the
// Unified Test Platform that runs the emulator tests (unified-test-platform-*) and Swift export, which
// this build does not use but which the dependency graph still lists. The names are the plugins'; if
// one changes, the submitted dependency graph shows the old version again and Dependabot reopens the
// alert. Netty is only on the test platform's classpaths, and its modules must move together, so its
// BOM raises all of them at once: 4.1.137.Final is the first release without the open Netty alerts.
val toolingSecurityFloors = buildscript.configurations.getByName("classpath").dependencyConstraints
    .filter { it.reason.orEmpty().startsWith("security floor: ") }
subprojects {
    val moduleDependencies = dependencies
    configurations.named {
        it == "androidLintTool" || it == "swiftExportClasspath" || it.startsWith("unified-test-platform-")
    }.configureEach {
        val configuration = name
        toolingSecurityFloors.forEach { floor ->
            moduleDependencies.constraints.add(configuration, "${floor.group}:${floor.name}:${floor.version}") {
                because(floor.reason)
            }
        }
        if (configuration.startsWith("unified-test-platform-")) {
            moduleDependencies.add(configuration, moduleDependencies.platform("io.netty:netty-bom:4.1.137.Final"))
        }
    }
}
