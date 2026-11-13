package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.printToString
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.NoNotifier
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SystemSettings
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.InMemoryBleKeyStore
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PresenceMode
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.SyncStatus
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The parity screenshots of the People screens: every state the web's screenshots show
// (parity-3/web/INDEX.md), drawn by the whole app (CaddieApp over a real CaddieCore and a real
// PeopleController) with the web mock's people, at 390 and 320 dp wide, light and dark, plus twice
// the font size, landscape and the wide layout for a few screens. They only run when asked for
// (parityShotsRequested), so normal test runs skip them; see ParityShotPlatform for how each
// platform sizes the window and saves the pictures.

/**
 * One state to shoot: its web screenshot name, its window heights at 390 and 320 dp, and how to
 * reach it. [ble] gives the backend derived-v1 Bluetooth and the phone a fake radio, as in the
 * Android app where the web draws BleControls.
 */
internal class ParityState(
    val name: String,
    val h390: Int,
    val h320: Int,
    /** Extra windows beyond 390 and 320 wide (name suffix to window), shot in the light theme only. */
    val extras: Map<String, ParityWindow> = emptyMap(),
    val ble: Boolean = false,
    /** Publishes the summit as a demo conference (DemoParityStates), with a real conference after it in the list. */
    val demo: Boolean = false,
    val drive: ParityRun.() -> Unit,
)

/**
 * The people, server, controller and app of one screenshot run; with [ble], a phone with a (fake)
 * Bluetooth radio; with [demo], the summit is published as a demo conference ("demo": true, named
 * as the web mock's demo conference) and a real conference follows it in the switcher.
 */
@OptIn(ExperimentalTestApi::class)
internal class ParityRig(val ble: Boolean = false, val demo: Boolean = false) {
    val backend = TestBackend(people = true, topics = ParitySample.TOPICS, push = true, ble = ble).also {
        it.publish(if (demo) listOf(ParitySample.testConference().asDemo(DEMO_CONFERENCE_NAME), it.alpha) else listOf(ParitySample.testConference()))
    }

    /** Fixed at [ParitySample.pinnedNowMs] for the core, the app, the controller and the fake server alike. */
    val clock = TestClock(ParitySample.pinnedNowMs(backend.bundleOf(ParitySample.testConference()).conference))
    val server = FakePeopleServer({ clock.ms }, ParitySample.fakeConference())
    val people: Map<String, FakePerson> = ParitySample.PEOPLE.associate { p ->
        val person = server.seedPerson(
            ParitySample.SLUG,
            p.displayName,
            about = p.about,
            expertise = p.expertise,
            speakTopics = p.speak,
            learnTopics = p.learn,
            interests = p.interests,
            sharedTalkIds = p.shared.map { ParitySample.talk(it).id },
            openToMeet = p.openToMeet,
        )
        if (p.zone != null) person.goAround(p.zone, p.spot.orEmpty())
        p.name to person
    }
    val mutex = Mutex()
    private val mock = ParityWebMock(server, { clock.ms }, people)
    private val http = ApiHttp { method, url, headers, body, timeoutMs, maxBytes ->
        mutex.withLock { mock.send(method, url, headers, body, timeoutMs, maxBytes) }
    }
    val location = FakeDeviceLocation(LocationAccess.Precise)

    /** The phone's Bluetooth radio, when [ble]; a state sets its permission before turning it on. */
    val radio = FakeUiBleRadio(parityBlePermission)
    private val bleKeys = InMemoryBleKeyStore()
    val keyValue = InMemoryPeopleKeyValue()
    private val secure = InMemorySecureStore()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    var controller: PeopleController = newController()
    val dark = mutableStateOf(false)
    private val root = Path(SystemTemporaryDirectory, "caddie-parity-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val files: BundleFiles
    private val coreScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val core: CaddieCore

    init {
        SystemFileSystem.createDirectories(Path(root, "bundles"))
        files = BundleFiles(Path(root, "bundles"))
        core = CaddieCore(database, files, backend, coreScope, allowLocalHttp = false, clock = clock)
        core.setBackend(testBackendUrl(backend.base))
    }

    fun newController(): PeopleController = PeopleController(
        keyValue,
        http,
        PeopleServices(
            secure,
            location = location,
            notifier = if (ble) FakeNotifier() else NoNotifier,
            push = FakePushRegistrar("f".repeat(40)),
            // "Open settings" shows only where the platform can open them.
            systemSettings = if (ble) SystemSettings {} else null,
            ble = if (ble) BlePlatform(radio, bleKeys) else null,
        ),
        scope,
        allowLocalHttp = false,
        clock = clock,
        timeZone = TimeZone.UTC,
    )

    /** The whole app over this rig's core and [controller], on the rig's [clock] like everything else here. */
    @Composable
    fun App(controller: PeopleController) {
        CaddieApp(core, isDebugBuild = false, appVersion = "parity", people = controller, clock = clock)
    }

    /** The key under which the controller keeps the summit's record (PeopleStore). */
    val conferenceKey: String get() = "people:v1:${testBackendUrl(backend.base).base}#conference:${ParitySample.SLUG}"

    suspend fun <T> locked(block: FakePeopleServer.() -> T): T = mutex.withLock { server.block() }

    fun person(name: String): FakePerson = people.getValue(name)

    fun close() {
        controller.close()
        scope.cancel()
        coreScope.cancel()
        runCatching { files.clear() }
        runCatching { SystemFileSystem.delete(Path(root, "bundles"), mustExist = false) }
        runCatching { SystemFileSystem.delete(root, mustExist = false) }
        database.close()
    }
}

/** Jordan Rivera, the web screenshots' profile (parity-3/lib.mjs seedScript). */
internal val JORDAN = Profile(
    displayName = "Jordan Rivera",
    about = "Platform engineer. Kubernetes upgrades and Postgres on bare metal.",
    interests = "Getting Postgres failover under a minute without a managed service.",
    expertise = "Ran Argo CD rollouts for 40 teams and wrote the rollback runbooks.",
    linkedinUrl = "https://www.linkedin.com/in/jordan-rivera",
    contactNote = "@jordan on the CNCF Slack",
)

/** One run of one state in one window: the test, the rig, and the camera, with the steps the states share. */
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
internal class ParityRun(
    private val test: ComposeUiTest,
    val rig: ParityRig,
    private val camera: ParityCamera,
    private val file: String,
    private val bothThemes: Boolean,
) : ComposeUiTest by test {
    val controller: PeopleController get() = rig.controller
    private val slug = ParitySample.SLUG

    /** Saves the screen now as `{file}` with the light theme and, unless only light is wanted, the dark theme. */
    fun shoot() {
        for (dark in if (bothThemes) listOf(false, true) else listOf(false)) {
            rig.dark.value = dark
            waitForIdle()
            camera.shoot(file.replace("{theme}", if (dark) "dark" else "light"))
        }
        rig.dark.value = false
        waitForIdle()
    }

    /** Runs [block] on the rig's scope and waits for it. */
    fun <T> await(block: suspend () -> T): T {
        val job = rig.scope.async { block() }
        waitUntil(timeoutMillis = 30_000) { job.isCompleted }
        return job.getCompleted()
    }

    fun <T> locked(block: FakePeopleServer.() -> T): T = await { rig.locked(block) }

    /** The requests the fake has received so far, copied under its lock (usable inside waitUntil). */
    fun requests(): List<RecordedRequest> {
        while (!rig.mutex.tryLock()) Unit
        try {
            return rig.server.requests.toList()
        } finally {
            rig.mutex.unlock()
        }
    }

    fun waitFor(matcher: SemanticsMatcher, timeoutMs: Long = 20_000) {
        try {
            waitUntil(timeoutMillis = timeoutMs) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: Throwable) {
            throw AssertionError("Timed out waiting for ${matcher.description}\n" + runCatching { onRoot(useUnmergedTree = true).printToString() }.getOrDefault(""), e)
        }
    }

    fun waitGone(matcher: SemanticsMatcher) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isEmpty() }
    }

    fun tap(matcher: SemanticsMatcher, scroll: Boolean = true) {
        // The People list composes only what is in view: scroll it to the node first when need be.
        if (scroll) {
            runCatching {
                waitUntil(timeoutMillis = 10_000) {
                    onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() ||
                        runCatching { onNodeWithTag("people-screen").performScrollToNode(matcher) }.isSuccess
                }
            }
        }
        waitFor(matcher)
        val node = onAllNodes(matcher).onFirst()
        if (scroll) runCatching { node.performScrollTo() }
        node.performClick()
        waitForIdle()
    }

    fun tapText(text: String, scroll: Boolean = true) = tap(hasText(text) and hasClickAction(), scroll)

    fun tapTag(tag: String, scroll: Boolean = true) = tap(hasTestTag(tag), scroll)

    /** A matcher for the card of sample person [name]. */
    fun card(name: String) = hasTestTag("person-${rig.person(name).ref}")

    fun inCard(name: String, matcher: SemanticsMatcher) = matcher and hasAnyAncestor(card(name))

    /** Scrolls the People list to the card of [name]. */
    fun scrollToCard(name: String) {
        // The list composes only the cards in view, so scroll until the card is there.
        waitUntil(timeoutMillis = 20_000) { runCatching { onNodeWithTag("people-screen").performScrollToNode(card(name)) }.isSuccess }
        waitForIdle()
    }

    /** Scrolls the People list back to its top. */
    fun peopleTop() {
        onNodeWithTag("people-screen").performScrollToIndex(0)
        waitForIdle()
    }

    /** Waits until the People list shows cards and no longer says it is finding people. */
    fun settleCards() {
        val card = SemanticsMatcher("a person card") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("person-") == true }
        // In a short window (landscape) the cards may be below the part of the list that is composed.
        waitUntil(timeoutMillis = 20_000) {
            onAllNodes(card).fetchSemanticsNodes().isNotEmpty() || requests().any { it.method == "POST" && it.path == "/api/people/matches" }
        }
        waitGone(hasText(PeopleStrings.FINDING))
        waitForIdle()
    }

    // --- setup --------------------------------------------------------------------------------

    /**
     * The app as the web screenshots start it: Jordan Rivera's profile ([profile]), visible at the
     * summit ([visible]), with [interested] talks and [shared] talks; then [prepare] on the
     * controller, an optional [record] edit of the stored conference record (made with the controller
     * closed and a new one started over the same storage, as a relaunch would), the app, and [tab].
     */
    fun start(
        profile: Boolean = true,
        visible: Boolean = true,
        interested: List<Int> = emptyList(),
        shared: List<Int> = emptyList(),
        shareNoticeSeen: Boolean = true,
        record: ((JsonObject) -> JsonObject)? = null,
        tab: String? = "tab-People",
        prepare: suspend ParityRun.() -> Unit = {},
    ) {
        bind()
        await {
            if (profile) {
                controller.updateProfile { JORDAN }
                controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF"), TopicRef("security", "Security")), speak = listOf(TopicRef("kubernetes", "Kubernetes")))
                if (visible) check(controller.setOpenToMeet(true) == null) { "visibility failed" }
            }
            if (shareNoticeSeen) controller.markShareNoticeSeen()
            if (shared.isNotEmpty()) check(controller.shareForTalks(shared.map { ParitySample.talk(it).id }) == null) { "share failed" }
        }
        waitUntil(timeoutMillis = 20_000) { controller.state.value.sync.state != SyncStatus.State.Saving }
        for (n in interested) rig.core.setInterested(ParitySample.talk(n).id, true)
        waitUntil(timeoutMillis = 20_000) { rig.core.state.value.interested.size == interested.size }
        await { prepare() }
        if (record != null) {
            rig.controller.close()
            val raw = rig.keyValue.map[rig.conferenceKey] ?: "{}"
            rig.keyValue.map[rig.conferenceKey] = record(Json.parseToJsonElement(raw) as JsonObject).toString()
            rig.controller = rig.newController()
            bind()
        }
        setContent {
            ParitySystemTheme(rig.dark.value) {
                Box(Modifier.fillMaxSize().consumeWindowInsets(WindowInsets.safeDrawing)) {
                    rig.App(controller)
                }
            }
        }
        if (tab != null) {
            waitFor(hasTestTag(tab))
            onNodeWithTag(tab).performClick()
            waitForIdle()
        }
    }

    private fun bind() {
        controller.bind(rig.core.state)
        try {
            waitUntil(timeoutMillis = 30_000) { controller.state.value.let { it.availability == PeopleAvailability.Ready && it.zones.contains("Sample Room 1") } }
        } catch (e: Throwable) {
            val s = controller.state.value
            throw AssertionError("People never got ready: ${s.availability} zones=${s.zones} selected=${rig.core.state.value.selectedSlug} bundle=${rig.core.state.value.bundle.toString().take(700)} conferences=${rig.core.state.value.conferences.toString().take(300)}", e)
        }
    }

    /** My ref at the fake server. */
    val myRef: String get() = locked { me(slug)!!.ref }

    /** Turns presence on through the controller, as the panel would. */
    suspend fun presence(zone: String, spot: String = "", mode: PresenceMode = PresenceMode.Hour) {
        check(controller.turnOnPresence(zone, spot, mode) == null) { "presence failed" }
    }

    /** Sawyer, the broad match, is in my zone as soon as I am around (fixtures.ts joins_me_after_ms 0). */
    suspend fun sawyerJoins(zone: String) = rig.locked { rig.person("Sawyer").goAround(zone) }

    /** Blake (the web mock's MOCK_REQUESTER_REF) asks me to talk shop about eBPF; returns the meet id. */
    suspend fun blakeAsks(): String = rig.locked {
        val blake = rig.person("Blake")
        val id = blake.ask(me(slug)!!.ref, note = "I'd like to compare notes on eBPF probes in production", topicId = "ebpf")
        actAs(blake.doc, "PUT", "/api/meet/$id/details", buildJsonObject { put("spot_me", "Orange lanyard, standing by the demo screen") })
        id
    }

    /** Sends position fixes until the controller has put one to the server with my presence. */
    fun position(lat: Double = MY_LAT, lon: Double = MY_LON) {
        waitUntil(timeoutMillis = 20_000) {
            rig.location.emit(GeoFix(lat, lon, 20.0, rig.clock.ms))
            requests().any { it.method == "PUT" && it.path == "/api/presence" && it.body?.get("location").let { l -> l is JsonObject } }
        }
    }

    /** Turns presence on through the panel: the switch, the zone, then the optional day and spot, then I'm around. */
    fun presenceThroughPanel(zone: String, day: Boolean = false, spot: String = "", apply: Boolean = true) {
        tap(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL))
        waitFor(hasTestTag("presence-setup"))
        chooseZone(zone)
        if (day) tapText(ConnectStrings_DAY)
        if (spot.isNotEmpty()) {
            onNodeWithTag("presence-spot").performScrollTo().performTextInput(spot)
            waitForIdle()
        }
        if (apply) {
            tapText(ConnectStrings.I_AM_AROUND)
            waitUntil(timeoutMillis = 20_000) { controller.state.value.presence.on }
            waitFor(hasTestTag("presence-on"))
        }
    }

    fun chooseZone(zone: String, label: String = ConnectStrings.ZONE) {
        val field = hasContentDescription(label)
        waitFor(field)
        onAllNodes(field).onFirst().performScrollTo().performClick()
        waitFor(hasText(zone) and hasClickAction())
        onAllNodes(hasText(zone) and hasClickAction()).fetchSemanticsNodes().size
        onAllNodes(hasText(zone) and hasClickAction()).let { all ->
            // The menu's item is the last node with the zone's name (the field may show it too).
            val nodes = all.fetchSemanticsNodes()
            all[nodes.size - 1].performClick()
        }
        waitForIdle()
    }

    fun openSettings() {
        tap(hasContentDescription(Strings.AppBar.SETTINGS) and hasClickAction(), scroll = false)
        waitFor(hasTestTag("settings-screen"))
    }

    fun openProfile() {
        openSettings()
        tap(hasText(Strings.Settings.PROFILE) and hasClickAction())
        waitFor(hasTestTag("profile-screen"))
        waitForIdle()
    }

    fun openInbox() {
        await { controller.refreshInbox() }
        tapTag("requests-button", scroll = false)
        waitFor(hasTestTag("inbox-screen"))
        waitGone(hasText(ConnectStrings.CHECKING))
    }

    fun topOf(tag: String) {
        runCatching { onNodeWithTag(tag).performScrollToIndex(0) }
        waitForIdle()
    }

    companion object {
        /** Where the web screenshots put me (parity-3/scenarios.mjs GEO). */
        const val MY_LAT = 30.2672
        const val MY_LON = -97.7431
        const val ConnectStrings_DAY = "Until I turn it off today"
    }
}

/** A point [metres] from ([lat], [lon]) towards [bearing] degrees. */
internal fun offsetFrom(lat: Double, lon: Double, metres: Double, bearing: Double): Pair<Double, Double> {
    val r = 6_371_000.0
    val b = bearing * PI / 180
    val dLat = metres * cos(b) / r
    val dLon = metres * sin(b) / (r * cos(lat * PI / 180))
    return (lat + dLat * 180 / PI) to (lon + dLon * 180 / PI)
}

@OptIn(ExperimentalTestApi::class)
class PeopleParityShots {
    @Test
    fun parityScreenshots() {
        val only = parityShotsRequested() ?: return
        val failures = ArrayList<String>()
        for (state in PARITY_STATES + PARITY_FIX_STATES + DEMO_PARITY_STATES) {
            val wanted = only.isEmpty() || state.name in only
            if (!wanted) continue
            val windows = buildList {
                add(Triple("${state.name}-{theme}-390", ParityWindow(390, state.h390), true))
                add(Triple("${state.name}-{theme}-320", ParityWindow(320, state.h320), true))
                for ((suffix, window) in state.extras) add(Triple("${state.name}-$suffix-{theme}", window, false))
            }
            for ((file, window, both) in windows) {
                try {
                    runParityShot(window) { camera ->
                        val rig = ParityRig(ble = state.ble, demo = state.demo)
                        try {
                            ParityRun(this, rig, camera, file, both).apply(state.drive)
                        } finally {
                            rig.close()
                        }
                    }
                    println("parity: shot $file")
                } catch (e: Throwable) {
                    val line = "$file: ${e::class.simpleName}: ${e.message?.lineSequence()?.firstOrNull()?.take(900)}"
                    if (failures.isEmpty()) e.printStackTrace()
                    println("parity: FAILED $line")
                    failures += line
                }
            }
        }
        assertTrue(failures.isEmpty(), "Parity screenshots failed:\n" + failures.joinToString("\n"))
    }
}
