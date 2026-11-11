package app.conferencecaddie

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import app.conferencecaddie.shared.AndroidNotifier
import app.conferencecaddie.shared.AndroidPermissions
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.NotificationTaps
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.EmbeddingModel
import app.conferencecaddie.ui.talks.TalkLaunch

class MainActivity : ComponentActivity() {
    // The platform services ask for permissions through this activity (AndroidPermissions). The
    // launcher is registered on every creation, so an answer that arrives after a re-creation still
    // reaches the waiting request.
    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { AndroidPermissions.deliver(it) }
    private val permissionHost = object : AndroidPermissions.Host {
        override fun launch(permissions: Array<String>) = permissionLauncher.launch(permissions)
        override fun shouldShowRationale(permission: String) = shouldShowRequestPermissionRationale(permission)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        AndroidPermissions.attach(permissionHost)
        // A re-created activity keeps the intent that started it, so only a fresh start is a tap.
        if (savedInstanceState == null) deliverNotificationTap(intent)
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deliverNotificationTap(intent)
    }

    override fun onDestroy() {
        AndroidPermissions.detach(permissionHost, finishing = isFinishing)
        super.onDestroy()
    }

    /**
     * Hands a tapped notification's caddie:// link to the screens (see AndroidNotifier). This
     * activity is exported, so only a link that comes with the app's own tap key counts; the link
     * and the key are then removed from the intent the activity keeps.
     */
    private fun deliverNotificationTap(intent: Intent?) {
        val link = AndroidNotifier.tappedDeepLink(this, intent) ?: return
        intent?.removeExtra(AndroidNotifier.EXTRA_DEEP_LINK)
        intent?.removeExtra(AndroidNotifier.EXTRA_TAP_KEY)
        NotificationTaps.deliver(link)
    }
}
