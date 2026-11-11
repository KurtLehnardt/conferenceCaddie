package app.conferencecaddie

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import app.conferencecaddie.shared.core.CaddieCore
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Keeps the Interested lists of the Capacitor app (v0.3.0 and earlier) when the native app is
 * installed over it: same application id, same key, so the same data directory, where the old app's
 * WebView kept its local storage. Android's WebView reads that storage itself: a hidden WebView loads
 * a page the app serves at the old app's origin (`https://localhost`, Capacitor's default), whose
 * script hands the `caddie.interested.v1.*` keys to [CaddieCore.importLegacyInterested]. No network
 * request is made: every request the page makes is answered here, and the page holds nothing but that
 * script.
 *
 * It runs once, and only when the old app's WebView data exists. The people profile and the device
 * secret in the same storage are left for phase 3, which can read them the same way.
 */
internal object CapacitorMigration {
    private const val DONE = "legacy.capacitor.interested.v1"
    private const val ORIGIN = "https://localhost"
    private const val PAGE = "$ORIGIN/__caddie_native_migration__"
    private const val TIMEOUT_MS = 15_000L

    /** Starts the migration on the main thread if it has not run and there is something to read. */
    fun maybeRun(context: Context, core: CaddieCore) {
        val app = context.applicationContext
        if (!File(app.applicationInfo.dataDir, "app_webview").isDirectory) return
        CoroutineScope(Dispatchers.Main).launch {
            if (core.uiSetting(DONE) != null) return@launch
            read(app) { lists ->
                if (lists != null) {
                    core.importLegacyInterested(lists)
                    core.setUiSetting(DONE, "1")
                }
            }
        }
    }

    /**
     * Reads the old app's lists with a WebView at its origin and calls [done] on the main thread with
     * them, or with null when the WebView could not run (it is tried again at the next start).
     */
    @SuppressLint("SetJavaScriptEnabled")
    internal fun read(context: Context, done: (Map<String, String>?) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        var finished = false
        lateinit var view: WebView
        fun finish(result: Map<String, String>?) {
            main.post {
                if (finished) return@post
                finished = true
                runCatching { view.destroy() }
                done(result)
            }
        }
        view = try {
            WebView(context)
        } catch (_: Throwable) {
            // No WebView on this device (disabled or being updated).
            done(null)
            return
        }
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.addJavascriptInterface(
            object {
                @JavascriptInterface
                fun result(json: String) = finish(parse(json))
            },
            "CaddieMigration",
        )
        view.webViewClient = object : WebViewClient() {
            // Every request is answered here: the page, and nothing else.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                if (request.url.toString() == PAGE) {
                    WebResourceResponse("text/html", "utf-8", SCRIPT_PAGE.byteInputStream())
                } else {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not found", emptyMap(), "".byteInputStream())
                }
        }
        main.postDelayed({ finish(null) }, TIMEOUT_MS)
        view.loadUrl(PAGE)
    }

    /** The lists the page found: storage keys and their values, at most 100 keys and 4 MB. */
    internal fun parse(json: String): Map<String, String>? {
        if (json.length > MAX_JSON) return null
        val o = runCatching { Json.parseToJsonElement(json) as? JsonObject }.getOrNull() ?: return null
        return o.entries.take(100).mapNotNull { (k, v) ->
            (v as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { k to it }
        }.toMap()
    }

    private const val MAX_JSON = 4_500_000

    // Collects the lists, each at most 2 MB and 4 MB in all, and hands them over as one JSON object.
    private val SCRIPT_PAGE = """
        <!doctype html><meta charset="utf-8"><script>
        (function () {
          var out = {}, total = 0, n = 0;
          try {
            for (var i = 0; i < localStorage.length && n < 100; i++) {
              var k = localStorage.key(i);
              if (!k || k.indexOf('caddie.interested.v1.') !== 0) continue;
              var v = localStorage.getItem(k) || '';
              if (v.length > 2000000 || total + v.length > 4000000) continue;
              out[k] = v; total += v.length; n++;
            }
          } catch (e) {}
          CaddieMigration.result(JSON.stringify(out));
        })();
        </script>
    """.trimIndent()
}
