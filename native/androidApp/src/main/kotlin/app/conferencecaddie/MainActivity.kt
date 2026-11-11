package app.conferencecaddie

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import app.conferencecaddie.shared.AndroidNotifier
import app.conferencecaddie.shared.AndroidPermissions
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.AndroidPeopleServices
import app.conferencecaddie.shared.NotificationTaps
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.platform.PlatformActions
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.EmbeddingModel
import app.conferencecaddie.ui.talks.TalkLaunch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class MainActivity : ComponentActivity(), PlatformActions {
    // The file picker (the Storage Access Framework). The result comes back to whichever instance of
    // the activity is current, so after a rotation a chosen file still reaches the import, through the
    // hand-off, instead of the callback of the screen that asked.
    private var onPicked: ((PickedFile?) -> Unit)? = null
    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = onPicked
        onPicked = null
        if (uri == null) {
            callback?.invoke(null)
            return@registerForActivityResult
        }
        // After a recreation the callback is gone: the file is handed over as one the person picked,
        // which is read at once.
        readInBackground(uri, null, supersede = false) { file -> if (callback != null) callback(file) else IncomingHandoff.offerFile(file, picked = true) }
    }

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
        // Extras another app crafted can fail to unparcel; such an option is simply absent.
        val get: (String) -> String? = { name -> runCatching { intent?.getStringExtra(name) }.getOrNull() }
        val launch = if (isDebugBuild) DebugLaunch.from(get) else DebugLaunch()
        var query: String? = null
        val talkLaunch = if (isDebugBuild && savedInstanceState == null) TalkLaunch.from(get) else TalkLaunch()
        if (isDebugBuild && savedInstanceState == null) {
            get("caddie.backend")?.let { url ->
                (BackendUrl.normalise(url, allowLocalHttp = true) as? BackendUrl.Valid)?.let { core.setBackend(it) }
            }
            query = get("caddie.query")
        }
        // A link or file that started the app; after a rotation it was handled already.
        if (savedInstanceState == null) {
            handOff(intent)
            // Once, after an update over the Capacitor app: its Interested lists.
            CapacitorMigration.maybeRun(this, core)
        }
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: ""
        // The people features, next to the core, with the platform services: the Keystore-backed
        // secure store, location, notifications and the permission prompts of this activity.
        val peopleServices = AndroidPeopleServices.create(applicationContext, R.drawable.ic_stat_caddie)
        val people = AndroidCore.people(this, peopleServices, allowLocalHttp = isDebugBuild)
        setContent {
            CaddieApp(
                core = core,
                isDebugBuild = isDebugBuild,
                appVersion = version,
                launch = launch,
                initialQuery = query,
                talkLaunch = talkLaunch,
                embedder = { EmbeddingModel.load() },
                people = people,
                platform = this,
            )
        }
    }

    // The activity is singleTask, so a link or file that arrives while the app runs comes here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deliverNotificationTap(intent)
        handOff(intent)
    }

    override fun onDestroy() {
        AndroidPermissions.detach(permissionHost, finishing = isFinishing)
        super.onDestroy()
    }

    /** Hands a tapped notification's caddie:// link to the screens (see AndroidNotifier). */
    private fun deliverNotificationTap(intent: Intent?) {
        val link = AndroidNotifier.tappedDeepLink(intent) ?: return
        intent?.removeExtra(AndroidNotifier.EXTRA_DEEP_LINK)
        NotificationTaps.deliver(link)
    }

    /** Hands a `caddie://` link, or a schedule file opened in or shared to the app, to the screens ([IncomingIntents]). */
    private fun handOff(intent: Intent?) {
        IncomingIntents.handOff(
            intent,
            onLink = { IncomingHandoff.offerLink(it) },
            onFile = { uri, type -> readInBackground(uri, type) { IncomingHandoff.offerFile(it) } },
        )
    }

    override fun pickScheduleFile(onPicked: (PickedFile?) -> Unit) {
        this.onPicked = onPicked
        try {
            // Text-like types; application/octet-stream lets a calendar file whose type the
            // provider does not know be chosen too. The import checks what the file really is.
            picker.launch(arrayOf("text/*", "application/json", "application/octet-stream"))
        } catch (_: ActivityNotFoundException) {
            this.onPicked = null
            onPicked(null)
        }
    }

    override fun shareText(text: String, subject: String) {
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, text)
            .putExtra(Intent.EXTRA_SUBJECT, subject)
            .putExtra(Intent.EXTRA_TITLE, subject)
        runCatching { startActivity(Intent.createChooser(send, null)) }
    }

    /**
     * Reads [uri] on the app's one reading thread ([IncomingIntents.read]), then calls [deliver] on the
     * main thread. With [supersede], a newer incoming file replaces this one: a read that has not
     * started is skipped, and one that has finished is not delivered.
     */
    private fun readInBackground(uri: Uri, typeHint: String?, supersede: Boolean = true, deliver: (PickedFile) -> Unit) {
        val generation = if (supersede) latestIncoming.incrementAndGet() else null
        val current = { generation == null || generation == latestIncoming.get() }
        reader.execute {
            if (!current()) return@execute
            val file = IncomingIntents.read(contentResolver, uri, typeHint)
            runOnUiThread { if (current()) deliver(file) }
        }
    }

    private companion object {
        // One thread reads every file another app hands over, so a burst of intents holds at most
        // one file in memory at a time.
        val reader: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "caddie-read-file") }
        val latestIncoming = AtomicLong()
    }
}
