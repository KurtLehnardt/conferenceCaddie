package app.conferencecaddie

import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.core.AndroidCore
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.platform.PlatformActions
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.EmbeddingModel
import app.conferencecaddie.ui.talks.TalkLaunch
import kotlin.concurrent.thread

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
        readInBackground(uri, null) { file -> if (callback != null) callback(file) else IncomingHandoff.offerFile(file) }
    }

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
        // A link or file that started the app; after a rotation it was handled already.
        if (savedInstanceState == null) handOff(intent)
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
                platform = this,
            )
        }
    }

    // The activity is singleTask, so a link or file that arrives while the app runs comes here.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handOff(intent)
    }

    /**
     * Hands a `caddie://` link, or a schedule file opened in or shared to the app, to the screens.
     * Only `content:` files are read: a `file:` address could name the app's own private files, and
     * the app must never read those for another app.
     */
    private fun handOff(intent: Intent?) {
        intent ?: return
        val data = intent.data
        when (intent.action) {
            Intent.ACTION_VIEW -> when (data?.scheme?.lowercase()) {
                "caddie" -> IncomingHandoff.offerLink(data.toString())
                "content" -> readInBackground(data, intent.type, IncomingHandoff::offerFile)
            }
            Intent.ACTION_SEND -> {
                val stream = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_STREAM)
                }
                if (stream?.scheme?.lowercase() == "content") readInBackground(stream, intent.type, IncomingHandoff::offerFile)
            }
        }
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
     * Reads at most [PickedFile.MAX_FILE_BYTES] (plus one byte, to tell a larger file) of [uri] off the
     * main thread, then calls [deliver] on the main thread. A file that cannot be read arrives with
     * null bytes.
     */
    private fun readInBackground(uri: Uri, typeHint: String?, deliver: (PickedFile) -> Unit) {
        thread(name = "caddie-read-file") {
            val name = runCatching {
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                }
            }.getOrNull() ?: uri.lastPathSegment.orEmpty()
            val mime = runCatching { contentResolver.getType(uri) }.getOrNull() ?: typeHint.orEmpty()
            val limit = PickedFile.MAX_FILE_BYTES
            val file = try {
                contentResolver.openInputStream(uri)?.use { input ->
                    val buffer = java.io.ByteArrayOutputStream()
                    val chunk = ByteArray(64 * 1024)
                    var total = 0
                    while (total <= limit) {
                        val n = input.read(chunk, 0, minOf(chunk.size, limit + 1 - total))
                        if (n < 0) break
                        buffer.write(chunk, 0, n)
                        total += n
                    }
                    if (total > limit) PickedFile(name.take(255), mime.take(127), null, tooLarge = true)
                    else PickedFile(name.take(255), mime.take(127), buffer.toByteArray())
                } ?: PickedFile(name.take(255), mime.take(127), null)
            } catch (_: Exception) {
                PickedFile(name.take(255), mime.take(127), null)
            }
            runOnUiThread { deliver(file) }
        }
    }
}
