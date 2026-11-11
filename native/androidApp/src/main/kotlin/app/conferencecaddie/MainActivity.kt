package app.conferencecaddie

import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.EmbeddingModel
import app.conferencecaddie.ui.talks.TalkLaunch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Debug builds are debuggable; release builds are not. This avoids generating BuildConfig.
        val isDebugBuild = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val core = AndroidCore.get(this, allowLocalHttp = isDebugBuild)
        // Debug launch options arrive as intent extras: am start -e caddie.tab Search ... Besides the
        // shell's options, caddie.backend points the app at a backend (plain http to this machine is
        // allowed in debug builds) and caddie.query types a search. Release builds ignore them all.
        val get: (String) -> String? = { intent?.getStringExtra(it) }
        val launch = if (isDebugBuild) DebugLaunch.from(get) else DebugLaunch()
        var query: String? = null
        val talkLaunch = if (isDebugBuild && savedInstanceState == null) TalkLaunch.from(get) else TalkLaunch()
        if (isDebugBuild && savedInstanceState == null) {
            get("caddie.backend")?.let { url ->
                (BackendUrl.normalise(url, allowLocalHttp = true) as? BackendUrl.Valid)?.let { core.setBackend(it) }
            }
            query = get("caddie.query")
        }
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        setContent {
            CaddieApp(
                core = core,
                isDebugBuild = isDebugBuild,
                appVersion = version,
                launch = launch,
                initialQuery = query,
                talkLaunch = talkLaunch,
                embedder = { EmbeddingModel.load() },
            )
        }
    }
}
