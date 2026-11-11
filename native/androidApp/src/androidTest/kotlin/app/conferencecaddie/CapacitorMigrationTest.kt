package app.conferencecaddie

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import android.webkit.RenderProcessGoneDetail
import app.conferencecaddie.shared.AndroidSecureStore
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SecureStore
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.core.Defaults
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.DeviceCredentials
import app.conferencecaddie.shared.people.LegacyPeople
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleKeyValue
import java.io.File
import java.security.KeyStore
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
    fun cleanUp() = inOldOrigin("localStorage.removeItem('$key');localStorage.removeItem('caddie.theme');localStorage.removeItem('${LegacyPeople.DEVICE_KEY}');localStorage.removeItem('${LegacyPeople.PROFILE_KEY}')")

    @Test
    fun theOldAppsListsAreReadFromItsStorage() {
        val list = """[{"talk_id":"kubecon-cloudnativecon-north-america-2026:1","title":"T"}]"""
        inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote(list)});localStorage.setItem('caddie.theme','dark')")
        val lists = read()
        assertNotNull(lists)
        assertEquals(list, lists!![key])
        // Only the Interested lists and the people keys are handed over.
        assertNull(lists["caddie.theme"])
    }

    @Test
    fun nothingStoredIsAnEmptyResult() {
        assertEquals(emptyMap<String, String>(), read())
    }

    /**
     * A core and a people controller of their own, so the test never touches the app's data: the
     * core in memory, the people records in a map, and the credential in a Keystore-backed store of
     * its own file and key alias, which [close] removes. [secureFailing] makes that store fail, as a
     * Keystore error does.
     */
    private class TestCore : AutoCloseable {
        val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.cacheDir, "2c-migration-${System.nanoTime()}").also { File(it, "bundles").mkdirs() }
        val database = CaddieDatabase.open(":memory:")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val core = CaddieCore(database, BundleFiles(Path(File(dir, "bundles").path)), { _, _, _ -> HttpResponse(404, ByteArray(0)) }, scope, allowLocalHttp = false)
        val backend = BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid
        val key = BundleSync.scope(backend.base, "kubecon-cloudnativecon-north-america-2026")

        val records = HashMap<String, String>()
        val kv = object : PeopleKeyValue {
            override suspend fun get(key: String): String? = synchronized(records) { records[key] }
            override suspend fun set(key: String, value: String?) {
                synchronized(records) { if (value == null) records.remove(key) else records[key] = value }
            }
        }
        val storeFile = "2c-migration-store-${System.nanoTime()}"
        val storeAlias = "caddie-migration-test"
        val secure = AndroidSecureStore(context, fileName = storeFile, keyAlias = storeAlias)
        @Volatile var secureFailing = false
        private val flaky = object : SecureStore {
            override suspend fun get(key: String): String? = if (secureFailing) error("keystore") else secure.get(key)
            override suspend fun put(key: String, value: String) = if (secureFailing) error("keystore") else secure.put(key, value)
            override suspend fun remove(key: String) = if (secureFailing) error("keystore") else secure.remove(key)
        }
        val people = PeopleController.create(kv, { _, _, _, _, _, _ -> HttpResponse(404, ByteArray(0)) }, PeopleServices(flaky), scope, allowLocalHttp = false)

        fun run(dataDir: File? = null): Boolean = runBlocking {
            val job = if (dataDir == null) CapacitorMigration.maybeRun(context, core, people = { people }) else CapacitorMigration.maybeRun(context, core, dataDir, people = { people })
            job?.join()
            core.awaitIdle()
            job != null
        }

        fun storedCredential(): String? = runBlocking { secure.get(DeviceCredentials.storeKey(backend)) }

        fun storedProfile(): String? = synchronized(records) { records["people:v1:${backend.base}#profile"] }

        override fun close() = runBlocking {
            people.close()
            scope.cancel()
            database.closeWhenIdle()
            dir.deleteRecursively()
            context.deleteSharedPreferences(storeFile)
            KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(storeAlias)
            Unit
        }
    }

    // Fake values of the contract's shape (22 and 43 base64url characters). The secret is unique to
    // this test, so the log check below can look for it.
    private val fakeId = "legacyProfileId0123456"
    private val fakeSecret = "legacyTestSecret" + "0123456789".repeat(2) + "abcdefg"
    private val fakeHeader = "$fakeId.$fakeSecret"
    private val deviceJson = """{"profile_id":"$fakeId","secret":"$fakeSecret"}"""
    private val profileJson = """{"display_name":"Ada","about":"Platform engineer","interests":"","expertise":"","linkedin_url":"","contact_note":"","topics":{}}"""

    /** Seeds the old app's people keys, with a value under [LegacyPeople.DEVICE_KEY] when [device] is not null. */
    private fun seedPeople(device: String?, profile: String? = profileJson) {
        val set = StringBuilder()
        if (device != null) set.append("localStorage.setItem('${LegacyPeople.DEVICE_KEY}', ${JSONObject.quote(device)});")
        if (profile != null) set.append("localStorage.setItem('${LegacyPeople.PROFILE_KEY}', ${JSONObject.quote(profile)});")
        inOldOrigin(set.toString())
    }

    /** This process's log, which the test can read because the app's own lines are visible to it. */
    private fun logcat(): String = Runtime.getRuntime().exec(arrayOf("logcat", "-d")).inputStream.bufferedReader().use { it.readText() }

    @Test
    fun theOldAppsCredentialAndProfileAreTakenOverOnce() {
        TestCore().use { t ->
            assertEquals(fakeSecret.length, 43)
            seedPeople(deviceJson)
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("1") + "]")})")
            assertTrue(t.run())
            assertEquals(fakeHeader, t.storedCredential())
            assertTrue("the profile is kept: ${t.storedProfile()}", t.storedProfile()?.contains("\"Ada\"") == true)
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertEquals(listOf("kubecon-cloudnativecon-north-america-2026:1"), runBlocking { t.database.interested(t.key) })
            // Neither the WebView, the controller nor the store wrote any part of the credential to the log.
            val log = logcat()
            assertTrue("the log could be read", log.isNotEmpty())
            assertTrue("the credential is not in the log", !log.contains(fakeSecret) && !log.contains(fakeId))

            // Once only: another value stored later is never read.
            seedPeople("""{"profile_id":"anotherProfileId012345","secret":"${"z".repeat(43)}"}""")
            t.run()
            assertEquals(fakeHeader, t.storedCredential())
        }
    }

    @Test
    fun aCredentialThisAppAlreadyHoldsIsKept() {
        TestCore().use { t ->
            val own = "nativeProfileId0123456." + "n".repeat(43)
            runBlocking { t.secure.put(DeviceCredentials.storeKey(t.backend), own) }
            seedPeople(deviceJson)
            assertTrue(t.run())
            assertEquals(own, t.storedCredential())
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
        }
    }

    @Test
    fun aMalformedCredentialIsRefusedAndTheListsStillCome() {
        TestCore().use { t ->
            seedPeople("""{"profile_id":"short","secret":"${"s".repeat(43)}"}""", profile = "not json")
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("1") + "]")})")
            assertTrue(t.run())
            assertNull(t.storedCredential())
            assertNull(t.storedProfile())
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertEquals(1, runBlocking { t.database.interested(t.key) }.size)
        }
    }

    @Test
    fun aSecureStoreThatFailsLeavesTheWholeRunForTheNextStart() {
        TestCore().use { t ->
            t.secureFailing = true
            seedPeople(deviceJson)
            inOldOrigin("localStorage.setItem('$key', ${JSONObject.quote("[" + entry("1") + "]")})")
            assertTrue(t.run())
            assertNull(runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.ATTEMPTS) })
            assertTrue("the lists wait for the credential", runBlocking { t.database.interested(t.key) }.isEmpty())
            assertNull("the profile waits with the credential", t.storedProfile())

            // The next start finds the store working and finishes everything.
            t.secureFailing = false
            assertTrue(t.run())
            assertEquals(fakeHeader, t.storedCredential())
            assertEquals("1", runBlocking { t.core.uiSetting(CapacitorMigration.DONE) })
            assertEquals(1, runBlocking { t.database.interested(t.key) }.size)
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
        val script = page.data.readBytes().decodeToString()
        assertTrue(script.contains("caddie.interested.v1.") && script.contains(LegacyPeople.DEVICE_KEY) && script.contains(LegacyPeople.PROFILE_KEY))
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
