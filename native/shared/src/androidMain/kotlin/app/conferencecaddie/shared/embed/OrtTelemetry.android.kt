package app.conferencecaddie.shared.embed

import android.system.Os

internal actual fun disableOnnxRuntimeTelemetryByEnvironment() {
    Os.setenv(ORT_DISABLE_TELEMETRY, "1", true)
}

// Os.getenv reads the process environment as it is now; System.getenv may not see a later setenv.
internal actual fun onnxRuntimeTelemetryDisabled(): Boolean = Os.getenv(ORT_DISABLE_TELEMETRY) == "1"
