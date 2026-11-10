package app.conferencecaddie.shared.embed

// The JVM cannot change its own environment; the Gradle test tasks set ORT_DISABLE_TELEMETRY for the
// test processes instead (shared/build.gradle.kts), and the session also turns telemetry events off.
internal actual fun disableOnnxRuntimeTelemetryByEnvironment() = Unit
