package app.conferencecaddie

import android.annotation.SuppressLint
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.core.Defaults
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.HttpResponse
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.io.files.Path
import org.json.JSONObject
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
        inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote(list)});localStorage.setItem('caddie.theme','dark')")
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

    /** A core of its own, in memory, so the test never touches the app's data. */
    private class TestCore : AutoCloseable {
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "2c-migration-${System.nanoTime()}").also { File(it, "bundles").mkdirs() }
        val database = CaddieDatabase.open(":memory:")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val core = CaddieCore(database, BundleFiles(Path(File(dir, "bundles").path)), { _, _, _ -> HttpResponse(404, ByteArray(0)) }, scope, allowLocalHttp = false)
        val key = BundleSync.scope((BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid).base, "kubecon-cloudnativecon-north-america-2026")

        fun run(dataDir: File? = null): Boolean = runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val job = if (dataDir == null) CapacitorMigration.maybeRun(context, core) else CapacitorMigration.maybeRun(context, core, dataDir)
            job?.join()
            core.awaitIdle()
            job != null
        }

        override fun close() = runBlocking {
            scope.cancel()
            database.closeWhenIdle()
            dir.deleteRecursively()
            Unit
        }
    }

    private fun entry(id: String) =
        """{"talk_id":"kubecon-cloudnativecon-north-america-2026:$id","conference":"kubecon-cloudnativecon-north-america-2026","title":"T$id","speakers":[],"start":"2026-11-11T11:00:00-07:00","end":"2026-11-11T11:30:00-07:00","url":"https://example.org/$id","tags":[],"marked_at":"2026-11-10T00:00:0${id}Z"}"""

    @Test
    fun itRunsOnceAndOnlyWhenTheOldAppsDataIsThere() {
        TestCore().use { t ->
            // No app_webview directory: nothing runs.
            val empty = File(t.dir, "data").also { it.mkdirs() }
            assertTrue(!t.run(empty))
            assertNull(runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })

            // The old app's storage holds a list: it is kept, and the marker is set with it.
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("1") + "," + entry("2") + "]")})")
            assertTrue(t.run())
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertEquals(listOf("kubecon-cloudnativecon-north-america-2026:1", "kubecon-cloudnativecon-north-america-2026:2"), runBlocking { t.database.interested(t.key) })

            // Once only: a later start does not read the storage again.
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("3") + "]")})")
            t.run()
            assertEquals(2, runBlocking { t.database.interested(t.key) }.size)
        }
    }

    @Test
    fun itGivesUpAfterThreeTriesThatCameBackEmpty() {
        TestCore().use { t ->
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("1") + "]")})")
            runBlocking { t.database.setSetting("ui:${CapacitorMigration.ATTEMPTS}", CapacitorMigration.MAX_ATTEMPTS.toString()) }
            t.run()
            assertNull(runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertTrue(runBlocking { t.database.interested(t.key) }.isEmpty())
        }
    }

    /** A request for [url], as the WebView would make it. */
    private fun request(url: String) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = false
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): MutableMap<String, String> = mutableMapOf()
    }

    @Test
    fun everyOtherRequestOfThePageIsAnsweredWithA404() {
        var gone = 0
        lateinit var view: WebView
        instrumentation.runOnMainSync { view = WebView(context) }
        val client = CapacitorMigration.MigrationClient { gone++ }
        val page = client.shouldInterceptRequest(view, request(CapacitorMigration.PAGE))
        assertEquals("text/html", page.mimeType)
        assertTrue(page.data.readBytes().decodeToString().contains("caddie.interested.v1."))
        for (url in listOf("https://example.com/", "https://localhost/", "https://localhost/other", "http://localhost/__caddie_native_migration__")) {
            val r = client.shouldInterceptRequest(view, request(url))
            assertEquals(url, 404, r.statusCode)
            assertEquals(url, 0, r.data.readBytes().size)
        }
        // A renderer that goes away ends the migration for this start, not the app.
        val detail = object : RenderProcessGoneDetail() {
            override fun didCrash() = true
            override fun rendererPriorityAtExit() = 0
        }
        assertTrue(client.onRenderProcessGone(view, detail))
        assertEquals(1, gone)
        instrumentation.runOnMainSync { view.destroy() }
    }

    @Test
    fun aListTooLargeToHandOverIsLeftOutAndTheOthersCome() {
        // Quotes double in size once escaped: the page measures what it sends.
        // 1.5 million quotes: under the limit as stored, twice over it once escaped for sending.
        val big = "[" + "\"".repeat(1_500_000) + "]"
        inOldOrigin("localStorage.setItem('caddie.interested.v1.big-2026', ${JSONObject.quote(big)});localStorage.setItem('$key', '[]')")
        try {
            val lists = read()
            assertNotNull(lists)
            assertNull(lists!!["caddie.interested.v1.big-2026"])
            assertEquals("[]", lists[key])
        } finally {
            inOldOrigin("localStorage.removeItem('caddie.interested.v1.big-2026')")
        }
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
