package app.conferencecaddie

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Capacitor app's Interested lists, read from its WebView's local storage at its origin
 * (`https://localhost`), on a device or emulator. The test writes the storage the way the old app
 * did, through a WebView at that origin, and removes it afterwards.
 */
@RunWith(AndroidJUnit4::class)
class CapacitorMigrationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val key = "caddie.interested.v1.kubecon-cloudnativecon-north-america-2026"

    /** Runs [script] in a WebView at the old app's origin and waits for it to finish. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun inOldOrigin(script: String) {
        val latch = CountDownLatch(1)
        lateinit var view: WebView
        instrumentation.runOnMainSync {
            view = WebView(context)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.addJavascriptInterface(
                object {
                    @JavascriptInterface
                    fun done() = latch.countDown()
                },
                "Test",
            )
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    WebResourceResponse("text/html", "utf-8", "<!doctype html><script>$script;Test.done()</script>".byteInputStream())
            }
            view.loadUrl("https://localhost/2c-seed")
        }
        assertTrue("the page did not run", latch.await(20, TimeUnit.SECONDS))
        instrumentation.runOnMainSync { view.destroy() }
    }

    private fun read(): Map<String, String>? {
        val latch = CountDownLatch(1)
        var result: Map<String, String>? = null
        instrumentation.runOnMainSync {
            CapacitorMigration.read(context) {
                result = it
                latch.countDown()
            }
        }
        assertTrue("the migration did not finish", latch.await(30, TimeUnit.SECONDS))
        return result
    }

    @After
    fun cleanUp() = inOldOrigin("localStorage.removeItem('$key');localStorage.removeItem('caddie.theme')")

    @Test
    fun theOldAppsListsAreReadFromItsStorage() {
        val list = """[{"talk_id":"kubecon-cloudnativecon-north-america-2026:1","title":"T"}]"""
        inOldOrigin("localStorage.setItem('$key', ${org.json.JSONObject.quote(list)});localStorage.setItem('caddie.theme','dark')")
        val lists = read()
        assertNotNull(lists)
        assertEquals(list, lists!![key])
        // Only the Interested lists are handed over.
        assertNull(lists["caddie.theme"])
    }

    @Test
    fun nothingStoredIsAnEmptyResult() {
        assertEquals(emptyMap<String, String>(), read())
    }

    @Test
    fun theHandOverIsBounded() {
        assertNull(CapacitorMigration.parse("x".repeat(5_000_000)))
        assertNull(CapacitorMigration.parse("not json"))
        val many = (1..150).joinToString(",", "{", "}") { "\"caddie.interested.v1.c$it\":\"[]\"" }
        assertEquals(100, CapacitorMigration.parse(many)!!.size)
        assertEquals(mapOf("caddie.interested.v1.a" to "[]"), CapacitorMigration.parse("{\"caddie.interested.v1.a\":\"[]\",\"caddie.interested.v1.b\":3}"))
    }
}
