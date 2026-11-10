package app.conferencecaddie

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.ui.talks.CaddieApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Debug builds are debuggable; release builds are not. This avoids generating BuildConfig.
        val isDebugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val core = AndroidCore.get(this, allowLocalHttp = isDebugBuild)
        // Debug builds only: a backend and a search text passed with the launch intent
        // (adb shell am start -e caddie.debug.backend http://127.0.0.1:8765 -e caddie.debug.query ...),
        // so a developer can point the app at bundles served from their machine. Release builds
        // ignore both extras.
        var debugQuery: String? = null
        if (isDebugBuild && savedInstanceState == null) {
            intent.getStringExtra(EXTRA_BACKEND)?.let { url ->
                (BackendUrl.normalise(url, allowLocalHttp = true) as? BackendUrl.Valid)?.let { core.setBackend(it) }
            }
            debugQuery = intent.getStringExtra(EXTRA_QUERY)
        }
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        setContent {
            CaddieApp(core = core, isDebugBuild = isDebugBuild, appVersion = version, initialQuery = debugQuery)
        }
    }

    private companion object {
        const val EXTRA_BACKEND = "caddie.debug.backend"
        const val EXTRA_QUERY = "caddie.debug.query"
    }
}
