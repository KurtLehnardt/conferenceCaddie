buildscript {
    // Floors for the build's own tools (Dependabot alerts of 2026-11-11). Every alert on native/ so far
    // is a transitive dependency of a build tool: the Android Gradle Plugin and the Kotlin plugin on
    // this classpath, Android Lint, the Unified Test Platform that runs the device tests, and the
    // Kotlin plugin's Swift export classpath. None of these modules is in the APK or the iOS framework.
    // Dependabot reads these strings, so it can propose raising a floor, but it cannot raise a
    // transitive module that has no floor yet; that alert is handled by adding one here
    // (DECISIONS.md, "Security floors for the native build's tools").
    // A constraint raises a module that is already in a graph to at least this version and never adds
    // or lowers one; nothing changes in the shipped classpaths. On the tool classpaths, a raised module
    // can bring different annotation-only dependencies of its own (Guava 33.7.2 swaps checker-qual and
    // jsr305 for jspecify). The subprojects block below applies the same list (the constraints whose
    // reason starts with "tooling floor", since Gradle adds a few of its own to this classpath) to the
    // tool classpaths inside the modules, so this list is the only place a floor is written, and
    // checkToolingFloors fails when one of them stops applying.
    dependencies {
        constraints {
            listOf(
                // 1.86 (2026-11-12) also fixes CVE-2026-17508, -18036, -18040, -71888, -71889, -71891 and
                // -71892 in bcprov and bcpkix (Bouncy Castle's release notes). Their advisories are
                // unreviewed and name no versions, so no Dependabot alert asks for 1.86.
                "org.bouncycastle:bcprov-jdk18on:1.86" to
                    "GHSA-9pwp-9qqc-pr26, GHSA-qp49-qgx5-5m26, GHSA-574f-3g2m-x479, GHSA-p93r-85wp-75v3, GHSA-c3fc-8qff-9hwx",
                // Bouncy Castle's jars are released together and must stay on one version, so bcpkix
                // (first fixed in 1.84) and bcutil (no alert) follow bcprov.
                "org.bouncycastle:bcpkix-jdk18on:1.86" to "GHSA-wg6q-6289-32hp; same release as bcprov",
                "org.bouncycastle:bcutil-jdk18on:1.86" to "same release as bcprov",
                "com.google.guava:guava:33.8.0-jre" to "GHSA-xxph-c9ww-hj94",
                "io.opentelemetry:opentelemetry-api:1.68.0" to "GHSA-ccrj-gw8r-854m, GHSA-rcgg-9c38-7xpx",
                "org.bitbucket.b_c:jose4j:0.9.7" to "GHSA-3677-xxcr-wjqv",
                "org.jdom:jdom2:2.0.6.1" to "GHSA-2363-cqg2-863c",
                "org.apache.commons:commons-lang3:3.21.0" to "GHSA-j288-q9x7-2f5v",
                // First fixed in 4.5.13; 4.5.14 is the version the plugin classpath already has.
                "org.apache.httpcomponents:httpclient:4.5.14" to "GHSA-7r82-7xv7-xcpj",
                // Not a security floor. Guava 33.4.0 brought checker-qual 3.43.0; Guava 33.7.2 no longer
                // depends on it, which would leave the 2.5.8 that tensorflow-lite-metadata (AGP) asks for.
                "org.checkerframework:checker-qual:3.43.0" to "keeps the version Guava 33.4.0 brought",
            ).forEach { (notation, reason) -> add("classpath", notation) { because("tooling floor: $reason") } }
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

// The plugin classpath's floors (buildscript block above) also hold for the tool classpaths that the
// Android and Kotlin plugins resolve inside each module: Android Lint (androidLintTool), the Unified
// Test Platform that runs the emulator tests (unified-test-platform-*) and Swift export
// (swiftExportClasspath, resolved through swiftExportClasspathResolvable), which this build does not
// use but which the dependency graph still lists. Netty is only on the test platform's classpaths, and
// its modules must move together, so its BOM raises all of them at once: 4.1.137.Final was the first
// release without the Netty alerts of 2026-11-11, and 4.1.140.Final (2026-11-12) adds the fixes of
// 4.1.138 to 4.1.140. The names are the plugins'; checkToolingFloors fails when one of them is gone,
// so a rename cannot switch a floor off without notice.
val toolingFloors = buildscript.configurations.getByName("classpath").dependencyConstraints
    .filter { it.reason.orEmpty().startsWith("tooling floor: ") }
val nettyBom = "io.netty:netty-bom:4.1.140.Final"
// Lowest allowed version per "group:name"; "group:*" covers every module of the group on the same major.
val toolingFloorVersions = toolingFloors.associate { "${it.group}:${it.name}" to it.version!! } +
    ("io.netty:*" to nettyBom.substringAfterLast(':'))

fun isFlooredToolClasspath(name: String) =
    name == "androidLintTool" || name == "swiftExportClasspath" || name.startsWith("unified-test-platform-")

subprojects {
    val moduleDependencies = dependencies
    configurations.named { isFlooredToolClasspath(it) }.configureEach {
        val configuration = name
        toolingFloors.forEach { floor ->
            moduleDependencies.constraints.add(configuration, "${floor.group}:${floor.name}:${floor.version}") {
                because(floor.reason)
            }
        }
        if (configuration.startsWith("unified-test-platform-")) {
            moduleDependencies.add(configuration, moduleDependencies.platform(nettyBom))
        }
    }
}

/**
 * Fails when a tool classpath that the floors must cover is missing, when a floored module resolves below
 * its floor in any resolvable configuration of the project (the tool classpaths, whatever else holds one,
 * and the build script's classpath), or when Bouncy Castle's jars are not on one release. Resolving the
 * tool classpaths' files also runs dependency verification on them.
 */
abstract class CheckToolingFloors : DefaultTask() {
    /** Lowest allowed version per "group:name", or per "group:*" for every module of a group on the same major. */
    @get:Input
    abstract val floors: MapProperty<String, String>

    /** Configuration names that must exist; a name ending in "*" needs at least one configuration with that prefix. */
    @get:Input
    abstract val requiredConfigurations: ListProperty<String>

    /** Floored configurations that cannot be resolved (swiftExportClasspath), so they have no graph. */
    @get:Input
    abstract val declaredOnlyConfigurations: ListProperty<String>

    @get:Input
    abstract val projectPath: Property<String>

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val toolClasspaths: ConfigurableFileCollection

    /** The graph of every resolvable configuration, by configuration name. */
    @get:Internal
    abstract val resolvedGraphs: MapProperty<String, ResolvedComponentResult>

    @TaskAction
    fun check() {
        val problems = mutableListOf<String>()
        val graphs = resolvedGraphs.get()
        val present = graphs.keys + declaredOnlyConfigurations.get()
        for (required in requiredConfigurations.get()) {
            val found = if (required.endsWith("*")) {
                present.any { it.startsWith(required.dropLast(1)) }
            } else {
                required in present
            }
            if (!found) problems += "no configuration $required; was it renamed? Its floors no longer apply."
        }
        val floorVersions = floors.get()
        val bouncyCastleFloors = floorVersions.filterKeys { it.startsWith("org.bouncycastle:") }.values.toSet()
        if (bouncyCastleFloors.size > 1) {
            problems += "the Bouncy Castle floors name different releases ${bouncyCastleFloors.sorted()}; raise all three together"
        }
        for ((configuration, root) in graphs) {
            val components = components(root)
            for (component in components) {
                val floor = floorVersions["${component.group}:${component.name}"]
                    ?: floorVersions["${component.group}:*"]?.takeIf { major(it) == major(component.version) }
                    ?: continue
                if (compareVersions(component.version, floor) < 0) {
                    problems += "$configuration resolves ${component.group}:${component.name}:${component.version}, below its floor $floor"
                }
            }
            val bouncyCastle = components.filter { it.group == "org.bouncycastle" }
            if (bouncyCastle.map { it.version }.toSet().size > 1) {
                problems += "$configuration mixes Bouncy Castle releases: " +
                    bouncyCastle.map { "${it.name}:${it.version}" }.sorted().joinToString()
            }
        }
        val where = projectPath.get()
        if (problems.isNotEmpty()) {
            throw GradleException("Tooling floors in $where:\n" + problems.joinToString("\n") { "  - $it" })
        }
        logger.lifecycle("Tooling floors hold in $where (${graphs.size} resolvable configurations).")
    }

    // Unresolved edges are skipped: the tool classpaths' files are resolved as an input, so a failure
    // there stops the task before this runs, and an unresolved edge elsewhere selects no version.
    private fun components(root: ResolvedComponentResult): Set<ModuleVersionIdentifier> {
        val seen = mutableSetOf<ResolvedComponentResult>()
        val queue = ArrayDeque(listOf(root))
        while (queue.isNotEmpty()) {
            val component = queue.removeFirst()
            if (!seen.add(component)) continue
            component.dependencies.filterIsInstance<ResolvedDependencyResult>().forEach { queue += it.selected }
        }
        return seen.mapNotNull { it.moduleVersion }.filter { it.group.isNotEmpty() }.toSet()
    }

    // The leading numbers of a version: 4.1.137.Final -> [4, 1, 137], 33.7.2-jre -> [33, 7, 2].
    private fun numbers(version: String): List<Long> =
        version.split('.', '-').takeWhile { part -> part.isNotEmpty() && part.all { it.isDigit() } }.map { it.toLong() }

    private fun major(version: String) = numbers(version).firstOrNull()

    private fun compareVersions(a: String, b: String): Int {
        val x = numbers(a)
        val y = numbers(b)
        if (x.isEmpty() || y.isEmpty()) throw GradleException("Cannot compare versions $a and $b")
        for (i in 0 until maxOf(x.size, y.size)) {
            val difference = x.getOrElse(i) { 0L }.compareTo(y.getOrElse(i) { 0L })
            if (difference != 0) return difference
        }
        return 0
    }
}

// Every module checks the tool classpaths it must have and scans all of its resolvable configurations,
// and the root project checks the plugin classpath; ./gradlew checkToolingFloors runs all four.
val requiredToolClasspaths = mapOf(
    ":shared" to listOf("androidLintTool", "swiftExportClasspath", "swiftExportClasspathResolvable"),
    ":composeApp" to listOf(
        "androidLintTool", "unified-test-platform-*", "swiftExportClasspath", "swiftExportClasspathResolvable",
    ),
    ":androidApp" to listOf("androidLintTool", "unified-test-platform-*"),
)
allprojects {
    val required = requiredToolClasspaths[path].orEmpty()
    val modulePath = path
    tasks.register<CheckToolingFloors>("checkToolingFloors") {
        group = "verification"
        description = "Checks that the floored tool classpaths exist and that no configuration resolves a floored module below its floor."
        floors.set(toolingFloorVersions)
        requiredConfigurations.set(required)
        projectPath.set(modulePath)
        // Read once, when the task is configured, so the names checked are the configurations scanned.
        val resolvable = project.configurations.filter { it.isCanBeResolved }
        declaredOnlyConfigurations.set(
            project.configurations.filter { !it.isCanBeResolved && isFlooredToolClasspath(it.name) }.map { it.name },
        )
        for (configuration in project.buildscript.configurations.filter { it.isCanBeResolved }) {
            resolvedGraphs.put("buildscript ${configuration.name}", configuration.incoming.resolutionResult.rootComponent)
            if (modulePath == ":") toolClasspaths.from(configuration)
        }
        for (configuration in resolvable) {
            resolvedGraphs.put(configuration.name, configuration.incoming.resolutionResult.rootComponent)
            if (configuration.name == "androidLintTool" || configuration.name == "swiftExportClasspathResolvable" ||
                configuration.name.startsWith("unified-test-platform-")
            ) {
                toolClasspaths.from(configuration.incoming.files)
            }
        }
    }
}
