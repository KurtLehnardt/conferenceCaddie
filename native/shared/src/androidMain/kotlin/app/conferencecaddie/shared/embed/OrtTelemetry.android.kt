package app.conferencecaddie.shared.embed

import android.system.Os

internal actual fun disableOnnxRuntimeTelemetryByEnvironment() {
    Os.setenv(ORT_DISABLE_TELEMETRY, "1", true)
}
