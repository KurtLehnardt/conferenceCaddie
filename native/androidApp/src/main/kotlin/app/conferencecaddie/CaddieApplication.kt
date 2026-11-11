package app.conferencecaddie

import android.app.Application
import android.content.ComponentCallbacks2
import android.content.pm.ApplicationInfo
import app.conferencecaddie.shared.AndroidPeopleServices
import app.conferencecaddie.shared.ble.AndroidBleRadio
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.shared.embed.OnnxRuntimeTelemetry

class CaddieApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // ONNX Runtime reads ORT_DISABLE_TELEMETRY when it starts. Android runs the app's content
        // providers before this (AndroidX Startup and Compose resources; none loads ONNX Runtime,
        // whose own provider the manifest removes) and creates the activity after it, so this sets
        // the variable on the main thread before the core starts any thread and before the query
        // model can be loaded. openEncoder refuses to start ONNX Runtime without it.
        OnnxRuntimeTelemetry.disableForProcess()
        // When the system restarts the Bluetooth service in a new process (it is sticky), nothing
        // else has created the people features: this creates them as MainActivity does, and their
        // runtime restores the Bluetooth session and starts the radio again. Opening the database is
        // deferred to its own thread, so this is quick on the main thread.
        AndroidBleRadio.onSystemRestart = { context ->
            val isDebugBuild = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
            AndroidCore.get(context, allowLocalHttp = isDebugBuild)
            AndroidCore.people(context, AndroidPeopleServices.create(context, R.drawable.ic_stat_caddie), allowLocalHttp = isDebugBuild)
        }
    }

    // The query model takes about 60 MB once loaded, and loads again in well under a second from the
    // APK. It is given back when the app's process goes to the background list, the point at which
    // Android suggests releasing what is quick to rebuild (from Android 15 on, the only level an app
    // in the background still receives), and when memory is critical while the app runs. The next
    // text search loads it again.
    @Suppress("DEPRECATION") // TRIM_MEMORY_RUNNING_CRITICAL is still sent before Android 15.
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_BACKGROUND || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL) {
            AndroidCore.existing()?.releaseEmbedder()
        }
    }
}
