package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.FakeHttp
import app.conferencecaddie.shared.bundle.BundleEntry
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.search.SearchRequest
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The whole client against a stand-in network: discovery, the conference list, the bundle, search,
// the interested list, and a relaunch with the network off that still shows everything cached.
class CaddieCoreTest {
    private val backend = "https://caddie.example"
    private val bundleBase = "$backend/bundles/"
    private val root = Path(SystemTemporaryDirectory, "caddie-core-${Random.nextLong().toULong()}")
    private val dbPath = Path(root, "caddie.db").toString()
    private val files = BundleFiles(Path(root, "bundles"))
    private val scopes = ArrayList<CoroutineScope>()
    private val databases = ArrayList<CaddieDatabase>()
    private val clock = object : Clock {
        override fun now(): Instant = Instant.fromEpochMilliseconds(4_076_125_200_000L) // 2099-03-02T09:00:00Z
    }

    init {
        SystemFileSystem.createDirectories(Path(root, "bundles"))
    }

    @AfterTest
    fun cleanUp() {
        scopes.forEach { it.cancel() }
        databases.forEach { it.close() }
        files.clear()
        for (name in listOf("caddie.db", "caddie.db-wal", "caddie.db-shm", "bundles")) SystemFileSystem.delete(Path(root, name), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
    }

    private fun online(): FakeHttp {
        val tier1 = Fixtures.text("capabilities/tier1-demo.json").replace("https://kurtlehnardt.github.io/conferenceCaddie/bundles/", bundleBase)
        val entry = BundleEntry.read(Fixtures.entry)!!
        return FakeHttp(
            mapOf(
                "$backend/capabilities.json" to FakeHttp.json(200, tier1),
                "${bundleBase}conferences.json" to FakeHttp.bytes(200, Fixtures.bytes("bundle/conferences.json")),
                "$bundleBase${entry.path}bundle.json" to FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json")),
                "$bundleBase${entry.path}vectors.i8" to FakeHttp.bytes(200, Fixtures.files.getValue("vectors.i8")),
            ),
        )
    }

    private suspend fun launch(http: FakeHttp, chooseBackend: Boolean = true): CaddieCore {
        val database = CaddieDatabase.open(dbPath).also { databases += it }
        if (chooseBackend) database.setSetting("backend", backend)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return CaddieCore(database, files, http, scope, allowLocalHttp = false, clock = clock).also { it.start() }
    }

    private suspend fun CaddieCore.until(predicate: (CoreState) -> Boolean): CoreState =
        withContext(Dispatchers.Default) { withTimeout(20_000) { state.first(predicate) } }

    @Test
    fun loadsSearchesAndWorksOfflineAfterARelaunch() = runTest {
        val core = launch(online())
        val ready = core.until { it.bundle is BundleState.Ready }
        assertEquals(BackendUrl.normalise(backend), ready.backend)
        val caps = assertIs<CapabilitiesState.Ready>(ready.capabilities)
        assertEquals(CapabilitiesDiscovery.Source.Static, caps.source)
        assertEquals(false, caps.forThisApp.people.enabled, "the People tab stays hidden on tier 1")
        val conferences = assertIs<ConferencesState.Ready>(ready.conferences)
        assertEquals(listOf(Fixtures.SLUG, "caddie-unavailable-2099"), conferences.conferences.map { it.conference.slug })
        assertEquals(Fixtures.SLUG, ready.selectedSlug, "the first conference with a bundle that has not ended")
        assertEquals(listOf(Fixtures.C), core.search(SearchRequest(query = "kubernetes scheduler"))?.talks?.map { it.talkId })

        core.setInterested(Fixtures.A, true)
        core.until { it.interested == listOf(Fixtures.A) }
        assertTrue(core.cacheSizeBytes() >= 5655 + 1152)

        // Relaunch with the network off.
        scopes.forEach { it.cancel() }
        databases.forEach { it.close() }
        databases.clear()
        val down = FakeHttp(
            mapOf(
                "$backend/api/capabilities" to IllegalStateException("offline"),
                "$backend/capabilities.json" to IllegalStateException("offline"),
                "${bundleBase}conferences.json" to IllegalStateException("offline"),
            ),
        )
        val again = launch(down, chooseBackend = false)
        val cached = again.until { it.bundle is BundleState.Ready }
        assertEquals(true, assertIs<CapabilitiesState.Ready>(cached.capabilities).cached)
        assertEquals(true, assertIs<ConferencesState.Ready>(cached.conferences).offline)
        assertEquals(listOf(Fixtures.A), cached.interested)
        assertEquals(listOf(Fixtures.C), again.search(SearchRequest(query = "kubernetes scheduler"))?.talks?.map { it.talkId })
        assertTrue(down.calls.none { it.endsWith("bundle.json") || it.endsWith("vectors.i8") }, "nothing is downloaded again")
    }

    @Test
    fun anUnreachableDefaultBackendFallsBackToTheTier1Demo() = runTest {
        val demo = Defaults.FALLBACK_BACKEND
        val http = FakeHttp(
            mapOf(
                "${Defaults.BACKEND}/api/capabilities" to IllegalStateException("down"),
                "${Defaults.BACKEND}/capabilities.json" to IllegalStateException("down"),
                "$demo/capabilities.json" to FakeHttp.json(200, Fixtures.text("capabilities/tier1-demo.json")),
            ),
        )
        val core = launch(http, chooseBackend = false)
        val s = core.until { it.capabilities !is CapabilitiesState.Loading && it.conferences !is ConferencesState.Loading }
        assertTrue(s.isDefaultBackend)
        val caps = assertIs<CapabilitiesState.Ready>(s.capabilities)
        assertTrue(caps.usingFallback)
        assertEquals(Defaults.FALLBACK_BUNDLE_BASE, caps.capabilities.talks.bundleBase)
        assertEquals(false, caps.capabilities.people.enabled)
        assertTrue(http.calls.contains("${Defaults.FALLBACK_BUNDLE_BASE}conferences.json"))
    }

    @Test
    fun anUnreachableOtherBackendIsShownAsUnreachable() = runTest {
        val core = launch(FakeHttp())
        val s = core.until { it.capabilities !is CapabilitiesState.Loading && it.conferences !is ConferencesState.Loading }
        assertEquals(CapabilitiesState.Unreachable, s.capabilities)
        assertIs<ConferencesState.Failed>(s.conferences)
    }

    @Test
    fun switchingBackendsKeepsEachBackendsState() = runTest {
        val core = launch(online())
        core.until { it.bundle is BundleState.Ready }
        core.setInterested(Fixtures.B, true)
        core.until { it.interested == listOf(Fixtures.B) }
        core.setBackend(BackendUrl.normalise("https://other.example") as BackendUrl.Valid)
        val other = core.until { it.backend.base == "https://other.example" && it.capabilities !is CapabilitiesState.Loading }
        assertEquals(emptyList(), other.interested)
        core.setBackend(BackendUrl.normalise(backend) as BackendUrl.Valid)
        val back = core.until { it.backend.base == backend && it.bundle is BundleState.Ready }
        assertEquals(listOf(Fixtures.B), back.interested)
    }
}
