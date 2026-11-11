package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.FakeHttp
import app.conferencecaddie.shared.bundle.BundleEntry
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.TalkSearch
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// The whole client against a stand-in network: discovery, the conference list, the bundle, search,
// the interested list, a relaunch with the network off that still shows everything cached, and a
// relaunch on a network that never answers, which must show everything stored before any answer.
class CaddieCoreTest {
    private val backend = "https://caddie.example"
    private val bundleBase = "$backend/bundles/"
    private val root = Path(SystemTemporaryDirectory, "caddie-core-${Random.nextLong().toULong()}")
    private val dbPath = Path(root, "caddie.db").toString()
    private val files = BundleFiles(Path(root, "bundles"))
    private val scopes = ArrayList<CoroutineScope>()
    private val databases = ArrayList<CaddieDatabase>()
    private var nowMs = 4_076_125_200_000L // 2099-03-02T09:00:00Z
    private val clock = object : Clock {
        override fun now(): Instant = Instant.fromEpochMilliseconds(nowMs)
    }
    private val entry = BundleEntry.read(Fixtures.entry)!!
    private val scopeA = BundleSync.scope(backend, Fixtures.SLUG)

    init {
        SystemFileSystem.createDirectories(Path(root, "bundles"))
    }

    @AfterTest
    fun cleanUp() = runTest {
        // Every job must have stopped before its database closes.
        stopAll()
        files.clear()
        for (child in SystemFileSystem.list(root)) SystemFileSystem.delete(child, mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
    }

    private suspend fun stopAll() {
        scopes.forEach { it.coroutineContext.job.cancelAndJoin() }
        scopes.clear()
        databases.forEach { it.closeWhenIdle() }
        databases.clear()
    }

    private fun tier1(base: String = bundleBase) =
        Fixtures.text("capabilities/tier1-demo.json").replace("https://kurtlehnardt.github.io/conferenceCaddie/bundles/", base)

    private fun online(base: String = bundleBase, capabilitiesUrl: String = "$backend/capabilities.json"): FakeHttp = FakeHttp(
        mapOf(
            capabilitiesUrl to FakeHttp.json(200, tier1(base)),
            "${base}conferences.json" to FakeHttp.bytes(200, Fixtures.bytes("bundle/conferences.json")),
            "$base${entry.path}bundle.json" to FakeHttp.bytes(200, Fixtures.files.getValue("bundle.json")),
            "$base${entry.path}vectors.i8" to FakeHttp.bytes(200, Fixtures.files.getValue("vectors.i8")),
        ),
    )

    private fun offline(vararg urls: String) = FakeHttp(urls.associateWith { IllegalStateException("offline") })

    private suspend fun launch(http: FakeHttp, chooseBackend: Boolean = true, allowLocalHttp: Boolean = false): CaddieCore {
        val database = CaddieDatabase.open(dbPath).also { databases += it }
        if (chooseBackend) database.setSetting("backend", backend)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return CaddieCore(database, files, http, scope, allowLocalHttp = allowLocalHttp, clock = clock).also { it.start() }
    }

    private suspend fun CaddieCore.until(timeoutMs: Long = 20_000, predicate: (CoreState) -> Boolean): CoreState =
        withContext(Dispatchers.Default) { withTimeout(timeoutMs) { state.first(predicate) } }

    private fun CoreState.settled() = capabilities.let { it is CapabilitiesState.Ready && !it.checking } &&
        conferences !is ConferencesState.Loading && bundle !is BundleState.Loading

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
        val marked = core.until { it.interested == listOf(Fixtures.A) }
        assertEquals("Securing MCP servers in production", marked.interestedSnapshots[Fixtures.A]?.title, "a copy is kept with the mark")
        assertTrue(core.cacheSizeBytes() >= 5655 + 1152)

        // Relaunch with the network off.
        stopAll()
        val down = offline("$backend/api/capabilities", "$backend/capabilities.json", "${bundleBase}conferences.json")
        val again = launch(down, chooseBackend = false)
        val cached = again.until { it.settled() && (it.conferences as? ConferencesState.Ready)?.offline == true }
        val cachedCaps = assertIs<CapabilitiesState.Ready>(cached.capabilities)
        assertEquals(true, cachedCaps.cached)
        assertEquals(false, cachedCaps.checking)
        assertEquals(true, assertIs<BundleState.Ready>(cached.bundle).offline)
        assertEquals(listOf(Fixtures.A), cached.interested)
        assertEquals(listOf(Fixtures.C), again.search(SearchRequest(query = "kubernetes scheduler"))?.talks?.map { it.talkId })
        assertTrue(down.calls.none { it.endsWith("bundle.json") || it.endsWith("vectors.i8") }, "nothing is downloaded again")
    }

    @Test
    fun aNetworkThatNeverAnswersStillShowsEverythingStoredAtOnce() = runTest {
        val first = launch(online())
        first.until { it.bundle is BundleState.Ready }
        first.setInterested(Fixtures.B, true)
        first.until { it.interested == listOf(Fixtures.B) }
        stopAll()

        val never = FakeHttp(
            listOf("$backend/api/capabilities", "$backend/capabilities.json", "${bundleBase}conferences.json")
                .associateWith { FakeHttp.Never },
        )
        val core = launch(never, chooseBackend = false)
        // Well inside one request timeout: nothing waits for the network.
        val s = core.until(timeoutMs = 5_000) { it.bundle is BundleState.Ready }
        val caps = assertIs<CapabilitiesState.Ready>(s.capabilities)
        assertTrue(caps.cached && caps.checking, "the stored capabilities, marked as being checked")
        assertEquals(Fixtures.SLUG, s.selectedSlug)
        assertIs<ConferencesState.Ready>(s.conferences)
        assertEquals(listOf(Fixtures.B), s.interested)
        assertEquals(listOf(Fixtures.C), core.search(SearchRequest(query = "kubernetes scheduler"))?.talks?.map { it.talkId })

        // The switcher is not blocked by the request that hangs.
        core.selectConference("caddie-unavailable-2099")
        val switched = core.until(timeoutMs = 5_000) { it.selectedSlug == "caddie-unavailable-2099" }
        assertEquals(emptyList(), switched.interested)
        core.selectConference(Fixtures.SLUG)
        core.until(timeoutMs = 5_000) { it.selectedSlug == Fixtures.SLUG && it.bundle is BundleState.Ready }
        assertTrue(never.calls.isNotEmpty(), "the capabilities are still being asked for")
    }

    @Test
    fun aSlowNetworkShowsLoadingThenTheBundle() = runTest {
        val http = online()
        for (url in listOf("$backend/capabilities.json", "${bundleBase}conferences.json", "$bundleBase${entry.path}bundle.json")) {
            http.routes[url] = FakeHttp.Delayed(300, http.routes[url])
        }
        val core = launch(http)
        val loading = core.until { it.bundle is BundleState.Loading }
        assertEquals(Fixtures.SLUG, loading.selectedSlug)
        val ready = core.until { it.bundle is BundleState.Ready }
        assertEquals(false, assertIs<BundleState.Ready>(ready.bundle).offline)
    }

    @Test
    fun anUnreachableDefaultBackendFallsBackToTheTier1DemoAndKeepsItOffline() = runTest {
        val demo = Defaults.FALLBACK_BACKEND
        val base = Defaults.FALLBACK_BUNDLE_BASE
        val http = online(base, capabilitiesUrl = "$demo/capabilities.json")
        http.routes["${Defaults.BACKEND}/api/capabilities"] = IllegalStateException("down")
        http.routes["${Defaults.BACKEND}/capabilities.json"] = IllegalStateException("down")
        val core = launch(http, chooseBackend = false)
        val s = core.until { it.bundle is BundleState.Ready && it.settled() }
        assertTrue(s.isDefaultBackend)
        val caps = assertIs<CapabilitiesState.Ready>(s.capabilities)
        assertTrue(caps.usingFallback)
        assertEquals(base, caps.capabilities.talks.bundleBase)
        assertEquals(false, caps.capabilities.people.enabled)
        assertTrue(http.calls.contains("${base}conferences.json"))

        // Relaunch with every host down: the demo's list and bundle stay usable.
        stopAll()
        val down = offline(
            "${Defaults.BACKEND}/api/capabilities",
            "${Defaults.BACKEND}/capabilities.json",
            "$demo/api/capabilities",
            "$demo/capabilities.json",
            "${base}conferences.json",
        )
        val again = launch(down, chooseBackend = false)
        val offline = again.until { it.settled() && (it.conferences as? ConferencesState.Ready)?.offline == true }
        val cachedCaps = assertIs<CapabilitiesState.Ready>(offline.capabilities)
        assertTrue(cachedCaps.usingFallback && cachedCaps.cached)
        assertEquals(Fixtures.SLUG, offline.selectedSlug)
        assertIs<BundleState.Ready>(offline.bundle)
    }

    @Test
    fun aBundleBaseWithNothingPublishedYetHasNoConferences() = runTest {
        val core = launch(FakeHttp(mapOf("$backend/capabilities.json" to FakeHttp.json(200, tier1()))))
        val s = core.until { it.conferences !is ConferencesState.Loading }
        assertEquals(ConferencesState.NoBundles, s.conferences)
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
        assertFalse(other.isDefaultBackend)
        core.setBackend(BackendUrl.normalise(backend) as BackendUrl.Valid)
        val back = core.until { it.backend.base == backend && it.bundle is BundleState.Ready }
        assertEquals(listOf(Fixtures.B), back.interested)
        core.setBackend(BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid)
        assertTrue(core.until { it.backend.base == Defaults.BACKEND }.isDefaultBackend, "the default base is the default however it was chosen")
    }

    @Test
    fun aMarkLandsInTheTalksOwnConferenceDuringASwitch() = runTest {
        val core = launch(online())
        core.until { it.bundle is BundleState.Ready }
        // The switch and the tap race; the tap names a talk of the first conference.
        core.selectConference("caddie-unavailable-2099")
        core.setInterested(Fixtures.A, true)
        val s = core.until { it.selectedSlug == "caddie-unavailable-2099" && it.bundle !is BundleState.Loading }
        assertEquals(emptyList(), s.interested)
        core.selectConference(Fixtures.SLUG)
        assertEquals(listOf(Fixtures.A), core.until { it.selectedSlug == Fixtures.SLUG && it.interested.isNotEmpty() }.interested)
    }

    @Test
    fun aBundleWhoseFilesAreGoneIsDownloadedAgain() = runTest {
        val core = launch(online())
        core.until { it.bundle is BundleState.Ready }
        stopAll()
        // As after an iOS restore: the database names the bundle, its files are not there.
        files.clear()
        val http = online()
        val again = launch(http, chooseBackend = false)
        val s = again.until { it.bundle is BundleState.Ready && it.settled() }
        assertEquals(Fixtures.HASH, assertIs<BundleState.Ready>(s.bundle).bundle.contentHash)
        assertTrue(http.calls.any { it.endsWith("bundle.json") }, "the files were fetched again")
        assertNotNull(files.read(backend, Fixtures.HASH))
    }

    @Test
    fun aListOrBundleOnlyANewerAppCanReadKeepsTheCopyAndSaysSo() = runTest {
        val core = launch(online())
        core.until { it.bundle is BundleState.Ready }
        stopAll()

        // The list moves to index_version 2: the stored copy stays in use, not offline.
        val newerIndex = JsonObject(Fixtures.index + ("index_version" to JsonPrimitive(2))).toString()
        val http = online()
        http.routes["${bundleBase}conferences.json"] = FakeHttp.json(200, newerIndex)
        val again = launch(http, chooseBackend = false)
        val s = again.until { it.settled() && (it.conferences as? ConferencesState.Ready)?.updateApp == true }
        assertEquals(false, assertIs<ConferencesState.Ready>(s.conferences).offline)
        assertIs<BundleState.Ready>(s.bundle)
        stopAll()

        // The conference's bundle moves to bundle_version 2: the installed one stays, marked.
        val conferences = (Fixtures.index["conferences"] as JsonArray).map { c ->
            val o = c as JsonObject
            if ((o["slug"] as JsonPrimitive).content != Fixtures.SLUG) {
                o
            } else {
                JsonObject(o + ("bundle" to JsonObject(Fixtures.entry + ("bundle_version" to JsonPrimitive(2)))))
            }
        }
        val http2 = online()
        http2.routes["${bundleBase}conferences.json"] = FakeHttp.json(200, JsonObject(Fixtures.index + ("conferences" to JsonArray(conferences))).toString())
        val third = launch(http2, chooseBackend = false)
        val t = third.until { it.settled() && (it.bundle as? BundleState.Ready)?.updateApp == true }
        assertEquals(Fixtures.HASH, assertIs<BundleState.Ready>(t.bundle).bundle.contentHash)
    }

    @Test
    fun capabilitiesAreFetchedAgainOnlyAfterTheirMaxAge() = runTest {
        val http = online()
        val core = launch(http)
        core.until { it.bundle is BundleState.Ready && it.settled() }
        val count = { url: String -> http.calls.count { it == url } }
        val caps = "$backend/capabilities.json"
        val list = "${bundleBase}conferences.json"
        // Each refresh is waited for until it has finished, not only until its request went out:
        // a refresh made while another runs does nothing.
        core.awaitIdle()
        assertEquals(1, count(caps))
        // Half an hour later the list is due (15 minutes) but the capabilities are not (an hour).
        nowMs += 30 * 60 * 1000L
        core.refresh()
        core.awaitIdle()
        assertEquals(2, count(list))
        assertEquals(1, count(caps), "inside the default max-age of an hour")
        nowMs += 31 * 60 * 1000L
        core.refresh()
        core.awaitIdle()
        assertEquals(2, count(caps))
    }

    @Test
    fun myScheduleShowsTheCopyOfATalkTheBundleDropped() {
        val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
        val memory = CaddieDatabase.open(":memory:").also { databases += it }
        val gone = InterestedTalk.from(bundle.talksById.getValue(Fixtures.A)).copy(talkId = "${Fixtures.SLUG}:9999", title = "Dropped talk")
        val state = CoreState(
            backend = BackendUrl.normalise(backend) as BackendUrl.Valid,
            isDefaultBackend = false,
            selectedSlug = Fixtures.SLUG,
            bundle = BundleState.Ready(bundle, TalkSearch(bundle, scopeA, memory)),
            interested = listOf(Fixtures.B, gone.talkId, "${Fixtures.SLUG}:no-copy"),
            interestedSnapshots = mapOf(gone.talkId to gone),
        )
        assertEquals(listOf(Fixtures.B, gone.talkId), state.interestedTalks().map { it.talkId }, "a talk with neither is left out")
        assertEquals("Dropped talk", state.interestedTalks()[1].title)
    }

    @Test
    fun aServerThatNeedsANewerAppWithNothingSavedSaysSo() = runTest {
        val core = launch(FakeHttp(mapOf("$backend/capabilities.json" to FakeHttp.json(200, Fixtures.text("capabilities/too-new-v2.json")))))
        core.awaitIdle()
        val s = core.state.value
        assertEquals(CapabilitiesState.UpdateApp, s.capabilities)
        assertEquals(ConferencesState.Failed("update_app"), s.conferences)
    }

    @Test
    fun onlyATypedServerMayNameALocalHttpBundleBase() = runTest {
        // An https server whose document names a plain http bundle base on this machine, as a
        // developer's would; the build is a debug build.
        val local = "http://127.0.0.1:8710/bundles/"
        val http = online(base = local)
        val core = launch(http, chooseBackend = false, allowLocalHttp = true)
        core.awaitIdle()
        val server = BackendUrl.normalise(backend) as BackendUrl.Valid
        core.setBackend(server, typed = false)
        core.awaitIdle()
        assertEquals(ConferencesState.NoBundles, core.state.value.conferences, "from a link, the http bundle base is refused")
        assertTrue(http.calls.none { it.startsWith(local) })
        core.setBackend(server, typed = true)
        core.awaitIdle()
        assertIs<ConferencesState.Ready>(core.state.value.conferences, "typed in Settings, it is used")
        assertTrue(http.calls.contains("${local}conferences.json"))
    }

    @Test
    fun aDismissedResetNoticeStaysDismissed() = runTest {
        val core = launch(online())
        core.dismissStorageReset()
        core.awaitIdle()
        assertEquals(false, core.state.value.storageReset)
        assertEquals(false, core.state.value.storageInMemory)
    }

    @Test
    fun defaultConferenceJudgesTodayInTheConferencesZone() {
        val fixture = app.conferencecaddie.shared.bundle.ConferenceIndex.read(Fixtures.index).conferences
            .first { it.conference.slug == Fixtures.SLUG }
        assertEquals("Europe/Amsterdam", fixture.conference.timeZone)
        assertEquals("2099-03-02", fixture.conference.endDate)
        val later = fixture.copy(conference = fixture.conference.copy(slug = "later-2099", startDate = "2099-04-01", endDate = "2099-04-01"))
        val list = listOf(fixture, later)
        // At 23:30 UTC on its last day it is already the next day in Amsterdam, so the conference
        // has ended there; judged in UTC it would still be running.
        assertEquals("later-2099", CaddieCore.defaultConference(list, Instant.parse("2099-03-02T23:30:00Z").toEpochMilliseconds()))
        assertEquals(Fixtures.SLUG, CaddieCore.defaultConference(list, Instant.parse("2099-03-02T08:00:00Z").toEpochMilliseconds()))
    }
}
