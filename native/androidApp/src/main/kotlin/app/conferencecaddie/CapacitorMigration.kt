package app.conferencecaddie

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.conferencecaddie.shared.core.CaddieCore
import java.io.File
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Keeps the Interested lists of the Capacitor app (v0.3.0 and earlier) when the native app is
 * installed over it: same application id, same key, so the same data directory, where the old app's
 * WebView kept its local storage. Android's WebView reads that storage itself: a hidden WebView loads
 * a page the app serves at the old app's origin (`https://localhost`, Capacitor's default), whose
 * script hands the `caddie.interested.v1.*` keys to [CaddieCore.importLegacyInterested]. Nothing is
 * fetched: network loads are blocked, every request the page could make is answered here (the page
 * itself, else 404), Safe Browsing is off for this WebView and the manifest opts out of WebView
 * metrics.
 *
 * It runs only when the old app's WebView data exists, after the first frame, until the core has
 * kept the lists (the marker is written with the marks, in one transaction) or three tries have
 * come back empty-handed (no WebView, a crashed renderer, a timeout). The people profile and the
 * device secret in the same storage are left for phase 3, which can read them the same way.
 */
internal object CapacitorMigration {
    const val DONE = "legacy.capacitor.interested.v1"
    const val ATTEMPTS = "legacy.capacitor.interested.attempts"
    const val MAX_ATTEMPTS = 3
    internal const val ORIGIN = "https://localhost"
    internal const val PAGE = "$ORIGIN/__caddie_native_migration__"
    private const val TIMEOUT_MS = 15_000L

    /**
     * Starts the migration if it is due, and returns its job (null when the old app's data is not
     * there). [dataDir] is the app's data directory; tests pass another. A failure is never thrown:
     * it is tried again at the next start.
     */
    fun maybeRun(context: Context, core: CaddieCore, dataDir: File = File(context.applicationInfo.dataDir)): Job? {
        if (!File(dataDir, "app_webview").isDirectory) return null
        val app = context.applicationContext
        val handler = CoroutineExceptionHandler { _, _ -> /* tried again at the next start */ }
        return CoroutineScope(SupervisorJob() + Dispatchers.Main + handler).launch {
            if (core.uiSetting(DONE) != null) return@launch
            val attempts = core.uiSetting(ATTEMPTS)?.toIntOrNull() ?: 0
            if (attempts >= MAX_ATTEMPTS) return@launch
            val lists = suspendCancellableCoroutine { cont ->
                // After the first frame, when the main thread is idle: a WebView takes a moment to start.
                Looper.myQueue().addIdleHandler {
                    read(app) { if (cont.isActive) cont.resume(it) }
                    false
                }
            }
            if (lists != null) {
                core.importLegacyInterested(lists, DONE)
            } else {
                core.setUiSetting(ATTEMPTS, (attempts + 1).toString())
            }
        }
    }

    /**
     * Reads the old app's lists with a WebView at its origin and calls [done] on the main thread with
     * them, or with null when the WebView could not run. Call it on the main thread.
     */
    @SuppressLint("SetJavaScriptEnabled")
    internal fun read(context: Context, done: (Map<String, String>?) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        var finished = false
        var view: WebView? = null
        lateinit var timeout: Runnable
        fun finish(result: Map<String, String>?) {
            main.post {
                if (finished) return@post
                finished = true
                main.removeCallbacks(timeout)
                runCatching { view?.destroy() }
                done(result)
            }
        }
        timeout = Runnable { finish(null) }
        val v = try {
            WebView(context)
        } catch (_: Throwable) {
            // No WebView on this device (disabled or being updated).
            done(null)
            return
        }
        view = v
        v.settings.javaScriptEnabled = true
        v.settings.domStorageEnabled = true
        v.settings.allowFileAccess = false
        v.settings.allowContentAccess = false
        v.settings.blockNetworkLoads = true
        v.settings.safeBrowsingEnabled = false
        v.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun result(json: String) = finish(parse(json))
            },
            "CaddieMigration",
        )
        v.webViewClient = MigrationClient { finish(null) }
        main.postDelayed(timeout, TIMEOUT_MS)
        v.loadUrl(PAGE)
    }

    /**
     * Answers every request of the migration's WebView: the page, and a 404 for anything else. A
     * renderer that crashes (or is ended for memory) ends the migration for this start instead of
     * the app.
     */
    internal class MigrationClient(private val onGone: () -> Unit) : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = answer(request.url.toString())

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }

        fun answer(url: String): WebResourceResponse =
            if (url == PAGE) {
                WebResourceResponse("text/html", "utf-8", SCRIPT_PAGE.byteInputStream())
            } else {
                WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), "".byteInputStream())
            }
    }

    /** The lists the page found: storage keys and their values, at most 100 keys and [MAX_JSON] characters. */
    internal fun parse(json: String): Map<String, String>? {
        if (json.length > MAX_JSON) return null
        val o = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
        return o.entries.take(100).mapNotNull { (k, v) ->
            (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { k to it }
        }.toMap()
    }

    internal const val MAX_JSON = 4_500_000

    // Collects the lists and hands them over as one JSON object. Sizes are measured as they will be
    // sent, escapes included: a list longer than 2.1 MB that way is left out, and so is any list
    // that would take the whole past 4.4 MB, so one large list never fails the hand-over of the
    // others.
    internal val SCRIPT_PAGE = """
        <!doctype html><meta charset="utf-8"><script>
        (function () {
          var out = {}, total = 2, n = 0;
          try {
            for (var i = 0; i < localStorage.length && n < 100; i++) {
              var k = localStorage.key(i);
              if (!k || k.indexOf('caddie.interested.v1.') !== 0) continue;
              var v = localStorage.getItem(k) || '';
              var size = JSON.stringify(k).length + JSON.stringify(v).length + 2;
              if (size > 2100000 || total + size > 4400000) continue;
              out[k] = v; total += size; n++;
            }
          } catch (e) {}
          CaddieMigration.result(JSON.stringify(out));
        })();
        </script>
    """.trimIndent()
}
