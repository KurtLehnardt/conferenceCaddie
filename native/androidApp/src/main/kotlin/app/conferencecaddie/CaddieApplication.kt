package app.conferencecaddie

import android.app.Activity
import android.app.Application
import android.content.ComponentCallbacks2
import android.os.Bundle
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
        // else has created the people features: this creates them through CaddiePeople, the one
        // place MainActivity and the background nudge job get them from, so the process never builds
        // a second set of platform services and the nudge scheduler starts as it would with the app.
        // Their runtime restores the Bluetooth session and starts the radio again. Opening the
        // database is deferred to its own thread, so this is quick on the main thread.
        AndroidBleRadio.onSystemRestart = { context -> CaddiePeople.controller(context) }
        // The background nudge job starts a cold process with no activity and needs to know that.
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                startedActivities++
            }

            override fun onActivityStopped(activity: Activity) {
                startedActivities--
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
            override fun onActivityResumed(activity: Activity) = Unit
            override fun onActivityPaused(activity: Activity) = Unit
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
            override fun onActivityDestroyed(activity: Activity) = Unit
        })
    }

    companion object {
        @Volatile private var startedActivities = 0

        /** True while an activity of the app is started (visible), the app's definition of being in the foreground. */
        val hasStartedActivity: Boolean get() = startedActivities > 0
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
