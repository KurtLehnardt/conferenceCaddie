package app.conferencecaddie.shared.embed

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.toKString
import platform.posix.getenv
import platform.posix.setenv

@OptIn(ExperimentalForeignApi::class)
internal actual fun disableOnnxRuntimeTelemetryByEnvironment() {
    setenv(ORT_DISABLE_TELEMETRY, "1", 1)
}

@OptIn(ExperimentalForeignApi::class)
internal actual fun onnxRuntimeTelemetryDisabled(): Boolean = getenv(ORT_DISABLE_TELEMETRY)?.toKString() == "1"
