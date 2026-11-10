package app.conferencecaddie.shared.embed

import kotlinx.cinterop.ExperimentalForeignApi
import platform.posix.setenv

@OptIn(ExperimentalForeignApi::class)
internal actual fun disableOnnxRuntimeTelemetryByEnvironment() {
    setenv(ORT_DISABLE_TELEMETRY, "1", 1)
}
