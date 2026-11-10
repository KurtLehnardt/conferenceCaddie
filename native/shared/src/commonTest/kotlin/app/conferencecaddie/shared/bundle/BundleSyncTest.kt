package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.FakeHttp
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.net.HttpResponse
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

class BundleSyncTest {
    private val base = "https://caddie.example"
    private val bundleBase = "https://caddie.example/bundles/"
    private val scope = BundleSync.scope(base, Fixtures.SLUG)
    private val root = Path(SystemTemporaryDirectory, "caddie-test-${Random.nextLong().toULong()}")
    private val files = BundleFiles(root)
    private val database = CaddieDatabase.open(":memory:")
    private val http = FakeHttp()
    private val sync = BundleSync(http, database, files) { 1_000L }
    private val entry = BundleEntry.read(Fixtures.entry)!!
    private val dir = "$bundleBase${entry.path}"

    init {
        SystemFileSystem.createDirectories(root)
        http.routes["${bundleBase}conferences.json"] = { etag: String? ->
            if (etag == "\"v1\"") HttpResponse(304, ByteArray(0)) else HttpResponse(200, Fixtures.bytes("bundle/conferences.json"), etag = "\"v1\"")
        }
        http.routes["${dir}bundle.json"] = FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json"))
        http.routes["${dir}vectors.i8"] = FakeHttp.bytes(200, Fixtures.files.getValue("vectors.i8"))
    }

    @AfterTest
    fun cleanUp() {
        files.clear()
        SystemFileSystem.delete(root, mustExist = false)
        database.close()
    }

    @Test
    fun theIndexIsCachedAndRevalidatedWithItsEtag() = runTest {
        val first = sync.index(bundleBase, refresh = true)
        assertTrue(first.fresh)
        assertEquals(2, first.index?.conferences?.size)
        val second = sync.index(bundleBase, refresh = true)
        assertTrue(second.fresh)
        assertEquals(listOf(null, "\"v1\""), http.conditional)
        assertEquals(2, second.index?.conferences?.size, "a 304 answer uses the stored copy")
    }

    @Test
    fun theIndexWorksOfflineFromItsLastGoodCopy() = runTest {
        sync.index(bundleBase, refresh = true)
        http.routes["${bundleBase}conferences.json"] = IllegalStateException("offline")
        val r = sync.index(bundleBase, refresh = true)
        assertEquals(false, r.fresh)
        assertEquals("offline", r.error)
        assertEquals(2, r.index?.conferences?.size)
        val none = BundleSync(FakeHttp(mapOf("${bundleBase}conferences.json" to IllegalStateException("offline"))), CaddieDatabase.open(":memory:"), files) { 0 }
        assertNull(none.index(bundleBase, refresh = true).index)
    }

    @Test
    fun aBrokenIndexNeverReplacesTheLastGoodOne() = runTest {
        sync.index(bundleBase, refresh = true)
        http.routes["${bundleBase}conferences.json"] = FakeHttp.json(200, """{"index_version":1}""")
        val r = sync.index(bundleBase, refresh = true)
        assertEquals(2, r.index?.conferences?.size)
        assertEquals(false, r.fresh)
    }

    @Test
    fun aBundleIsDownloadedVerifiedAndInstalledOnce() = runTest {
        val r = assertIs<BundleSync.InstallResult.Installed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, entry))
        assertTrue(r.updated)
        assertEquals(Fixtures.HASH, database.installedBundle(scope))
        assertNotNull(files.read(base, Fixtures.HASH))
        assertTrue(files.sizeBytes() >= 5655 + 1152)
        val calls = http.calls.size
        val again = assertIs<BundleSync.InstallResult.Installed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, entry))
        assertEquals(false, again.updated)
        assertEquals(calls, http.calls.size, "an installed bundle with the same hash is not downloaded again")
        assertEquals(listOf("${dir}bundle.json", "${dir}vectors.i8"), http.calls.filter { it.startsWith(dir) }, "exactly the two files")
    }

    @Test
    fun aTamperedBundleIsRefusedAndThePreviousOneStays() = runTest {
        sync.install(base, scope, bundleBase, Fixtures.SLUG, entry)
        // A new entry whose files fail verification.
        val bad = Fixtures.files.getValue("vectors.i8").copyOf().also { it[0] = 1 }
        val badHash = "b".repeat(64)
        val raw = kotlinx.serialization.json.JsonObject(
            Fixtures.entry + ("content_hash" to kotlinx.serialization.json.JsonPrimitive(badHash)) +
                ("path" to kotlinx.serialization.json.JsonPrimitive("${Fixtures.SLUG}/bbbbbbbbbbbbbbbb/")),
        )
        val badEntry = BundleEntry.read(raw)!!
        http.routes["$bundleBase${badEntry.path}bundle.json"] = FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json"))
        http.routes["$bundleBase${badEntry.path}vectors.i8"] = FakeHttp.bytes(200, bad)
        val r = assertIs<BundleSync.InstallResult.Failed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, badEntry))
        assertTrue(r.problems.isNotEmpty())
        assertEquals(Fixtures.HASH, r.kept?.contentHash)
        assertEquals(Fixtures.HASH, database.installedBundle(scope))
        assertNotNull(sync.installed(base, scope))
    }

    @Test
    fun anOversizedOrMissingFileFailsWithoutCrashing() = runTest {
        http.routes["${dir}vectors.i8"] = FakeHttp.bytes(200, ByteArray(5000))
        assertIs<BundleSync.InstallResult.Failed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, entry))
        http.routes["${dir}vectors.i8"] = FakeHttp.bytes(404, ByteArray(0))
        assertIs<BundleSync.InstallResult.Failed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, entry))
        http.routes["${dir}vectors.i8"] = IllegalStateException("offline")
        val offline = assertIs<BundleSync.InstallResult.Failed>(sync.install(base, scope, bundleBase, Fixtures.SLUG, entry))
        assertNull(offline.kept)
        assertNull(database.installedBundle(scope))
    }

    @Test
    fun aBundleOfAnotherConferenceIsRefused() = runTest {
        val r = assertIs<BundleSync.InstallResult.Failed>(sync.install(base, BundleSync.scope(base, "other"), bundleBase, "other-2099", entry))
        assertTrue(r.problems.single().contains("another conference"))
    }
}
