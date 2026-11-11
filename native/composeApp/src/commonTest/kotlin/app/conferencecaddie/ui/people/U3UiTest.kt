package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.NoNotifier
import app.conferencecaddie.shared.NoPush
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.PushRegistrar
import app.conferencecaddie.shared.SystemSettings
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PeopleContext
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.theme.Caddie
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

// The rig of U3's screen tests (presence, nudges, asks, Requests, Meet up): a real PeopleController
// over FakePeopleServer on a TestClock, a PeopleHost that records its toasts, and the screens drawn
// in the app's theme with that clock and a recording "open settings". This file also holds the
// tests that cut across the screens: a large font size and the privacy rules against a server that
// says too much.

internal const val SLUG = "alpha-conf-2099"

/** The fixes of a phone about 100 m north of a seeded person's stored position (40.76789, -111.89012). */
internal const val MY_LAT = 40.76879
internal const val MY_LON = -111.89012

/** A push registrar that hands out [token], or null as a refused permission does. */
internal class FakePushRegistrar(private val token: String?) : PushRegistrar {
    override val channel: String = "fcm"

    override suspend fun register(): app.conferencecaddie.shared.PushToken? = token?.let { app.conferencecaddie.shared.PushToken("fcm", it) }

    override suspend fun unregister() = Unit
}

/**
 * One test's world. Every request of the controller and every read or action of the test on the
 * fake server runs under one lock ([locked]), since the controller works on another thread.
 */
internal class U3Rig(
    access: LocationAccess = LocationAccess.Precise,
    push: PushRegistrar = NoPush,
    /** Bluetooth's radio and key store, or null for a phone without them. */
    ble: BlePlatform? = null,
    notifier: Notifier = NoNotifier,
) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val clock = TestClock()
    val server = FakePeopleServer({ clock.ms }, FakeConference.alpha())
    val location = FakeDeviceLocation(access)
    private val mutex = Mutex()

    /** Rewrites the JSON answer of a request, for a server that sends what it should not. */
    @kotlin.concurrent.Volatile
    var rewrite: ((method: String, path: String, body: JsonObject) -> JsonObject)? = null

    /** Every request the controller sent, oldest first; safe to read from the test's thread. */
    val calls = MutableStateFlow<List<RecordedRequest>>(emptyList())

    /** The recorded requests with [method] to [path]. */
    fun calls(method: String, path: String): List<RecordedRequest> = calls.value.filter { it.method == method && it.path == path }

    private val http = ApiHttp { method, url, headers, body, timeoutMs, maxBytes ->
        mutex.withLock {
            calls.update { it + RecordedRequest(method, url, headers, body?.decodeToString()) }
            val answer = server.send(method, url, headers, body, timeoutMs, maxBytes)
            val edit = rewrite ?: return@withLock answer
            val path = url.substring(maxOf(0, url.indexOf("/api/"))).substringBefore('?')
            val json = Json.parseToJsonElement(answer.body.decodeToString()) as? JsonObject ?: return@withLock answer
            HttpResponse(answer.status, edit(method, path, json).toString().encodeToByteArray(), headers = answer.headers)
        }
    }

    /** How often "Open settings" opened the app's page in the system settings. */
    val settingsOpened = MutableStateFlow(0)

    val controller = PeopleController(
        InMemoryPeopleKeyValue(),
        http,
        PeopleServices(
            InMemorySecureStore(),
            location = location,
            notifier = notifier,
            push = push,
            systemSettings = SystemSettings { settingsOpened.update { it + 1 } },
            ble = ble,
        ),
        scope,
        allowLocalHttp = false,
        clock = clock,
        timeZone = TimeZone.UTC,
    )
    val nav = app.conferencecaddie.ui.shell.ShellNavigation()
    val toasts = MutableStateFlow<List<String>>(emptyList())
    val host = PeopleHost(controller, nav, scope, { message, _ -> toasts.update { it + message } }, {}, {})
    val state: PeopleUiState get() = controller.state.value

    /** The summit's context; [ble] offers derived-v1 Bluetooth with the server's defaults. */
    fun context(push: Boolean = false, gpsBands: Boolean = true, ble: Boolean = false) = PeopleContext(
        backend = testBackendUrl(),
        capabilities = Capabilities(
            people = Capabilities.People(enabled = true, presence = true, gpsBands = gpsBands, meets = true, circles = true, reports = true),
            ble = if (ble) Capabilities.Ble(mode = Capabilities.BleMode.DerivedV1) else Capabilities.Ble(),
            push = Capabilities.Push(fcm = push),
        ).forThisApp(),
        conference = ConferenceInfo(SLUG, "Alpha Conference", "UTC"),
        bundle = null,
    )

    suspend fun <T> locked(block: FakePeopleServer.() -> T): T = mutex.withLock { server.block() }

    /** A named profile, visible conference-wide. */
    suspend fun makeVisible(name: String = "Me Myself") {
        controller.updateProfile { it.copy(displayName = name, about = "Tester.", interests = "tracing") }
        controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = emptyList())
        check(controller.setOpenToMeet(true) == null)
    }

    /** Ada: visible, around in [zone], with evidence about eBPF. */
    suspend fun seedAda(zone: String? = "Hallway", located: Boolean = false, spot: String = ""): FakePerson = locked {
        seedPerson(
            SLUG,
            "Ada Seed",
            about = "Platform engineer.",
            expertise = "Ran eBPF tracing for 200 clusters.",
            speakTopics = listOf("ebpf"),
            around = null,
        ).also { if (zone != null) it.goAround(zone, spot = spot, located = located) }
    }

    /** Ada as a Person the app can ask. */
    fun person(ada: FakePerson) = Person(ada.ref, ada.displayName)

    /** I ask [ada] and she accepts: the meet's id. */
    suspend fun activeMeet(ada: FakePerson): String {
        val id = (controller.ask(person(ada), "Hello there") as ApiResult.Ok).value.meetId
        locked { ada.accept(id) }
        return id
    }

    /** Presence on with my position: precise fixes until the server holds one. */
    suspend fun locateMe() {
        check(controller.sharePosition(true) == app.conferencecaddie.shared.people.PositionOutcome.On)
    }

    fun close() {
        controller.close()
        scope.cancel()
    }
}

/** Runs [block] on the rig's scope and waits for it, rethrowing its failure. */
@OptIn(ExperimentalTestApi::class, ExperimentalCoroutinesApi::class)
internal fun <T> ComposeUiTest.u3Await(rig: U3Rig, block: suspend () -> T): T {
    val job = rig.scope.async { block() }
    waitUntil(timeoutMillis = 20_000) { job.isCompleted }
    return job.getCompleted()
}

/** Waits until a node with [text] (or containing it, with [substring]) exists. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3WaitForText(text: String, substring: Boolean = false) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText(text, substring = substring)).fetchSemanticsNodes().isNotEmpty() }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3WaitForTag(tag: String) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
}

@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3WaitForNoTag(tag: String) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isEmpty() }
}

/** True while no node shows [text], even as part of a longer text. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3NoText(text: String): Boolean =
    onAllNodes(hasText(text, substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty()

/** Waits until the rig's toasts include [message]. */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3WaitForToast(rig: U3Rig, message: String) {
    waitUntil(timeoutMillis = 20_000) { message in rig.toasts.value }
}

/**
 * Draws [content] in the app's theme on the test phone, at [fontScale]. The rig's clock and "open
 * settings" reach the screens through its host.
 */
@OptIn(ExperimentalTestApi::class)
internal fun ComposeUiTest.u3Show(rig: U3Rig, fontScale: Float = 1f, content: @Composable (PeopleUiState) -> Unit) {
    setContent {
        TestPhone(fontScale) {
            CaddieTheme {
                val state by rig.controller.state.collectAsState()
                Box(Modifier.fillMaxSize().background(Caddie.colors.bg)) { content(state) }
                PeopleSheets(state, rig.host)
            }
        }
    }
}

/** The People home's parts that U3 owns, in the web's order. */
@Composable
internal fun U3PresenceHome(state: PeopleUiState, rig: U3Rig, onSeeWho: () -> Unit = {}) {
    PeopleScreenColumn {
        StillHereRow(state, rig.host)
        NudgeBanner(state, rig.host, onSeeWho)
        PresenceControls(state, rig.host)
    }
}

@OptIn(ExperimentalTestApi::class)
class U3UiTest {
    private val rigs = ArrayList<U3Rig>()

    private fun rig(access: LocationAccess = LocationAccess.Precise): U3Rig = U3Rig(access).also { rigs += it }

    @AfterTest
    fun cleanUp() = rigs.forEach { it.close() }

    @Test
    fun presenceCardAndMeetUpWorkAtTwiceTheFontSize() = runComposeUiTest {
        val rig = rig()
        u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            check(rig.controller.turnOnPresence("Hallway", "by the coffee cart") == null)
        }
        u3Show(rig, fontScale = 2f) { state -> U3PresenceHome(state, rig) }
        onNodeWithText(ConnectStrings.PRESENCE_LABEL).assertIsDisplayed()
        onNodeWithText("Hallway · by the coffee cart").assertIsDisplayed()
        onNodeWithText(ConnectStrings.turnsOffIn(60)).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.CHANGE_ZONE).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.USE_MY_POSITION).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.ZONE_ONLY).performScrollTo().assertIsDisplayed()

        // The setup panel at 2x: every control can be reached.
        onNodeWithText(ConnectStrings.CHANGE_ZONE).performScrollTo().performClick()
        u3WaitForTag("presence-setup")
        onNodeWithText(PeopleText.DURATION_LABELS.getValue(app.conferencecaddie.shared.people.PresenceMode.Day)).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.SPOT_HINT).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.SAVE).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.CANCEL).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun meetUpWorksAtTwiceTheFontSize() = runComposeUiTest {
        val rig = rig()
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway", located = true, spot = "by the stairs")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            rig.activeMeet(ada)
        }
        u3Show(rig, fontScale = 2f) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them")
        onNodeWithText(ConnectStrings.NO_MEETING_POINT).assertIsDisplayed()
        onNodeWithText("Hallway · by the stairs").performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.HOW_TO_SPOT_ME).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.CAVEAT).performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.FOUND_EACH_OTHER).performScrollTo().assertIsDisplayed()
        onNodeWithTag("meet-cancel").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun requestsWorkAtTwiceTheFontSize() = runComposeUiTest {
        val rig = rig()
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Expo hall")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            rig.locked { ada.ask(me(SLUG)!!.ref, "Can we compare eBPF notes?", "ebpf") }
        }
        u3Show(rig, fontScale = 2f) { state -> InboxScreen(state, rig.host) }
        u3WaitForTag("incoming-$id")
        onNodeWithText(ConnectStrings.incomingTopic("Ada Seed", "eBPF")).assertIsDisplayed()
        onNodeWithText("Can we compare eBPF notes?").performScrollTo().assertIsDisplayed()
        onNodeWithTag("accept-$id").performScrollTo().assertIsDisplayed()
        onNodeWithTag("decline-$id").performScrollTo().assertIsDisplayed()
        onNodeWithText(ConnectStrings.expiresIn(15)).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun meetUpShowsNoZoneSpotOrDistanceBeforeTheMeetIsActive() = runComposeUiTest {
        val rig = rig()
        // A server that says too much: zone, spot lines and a distance on a meet nobody accepted.
        rig.rewrite = { method, path, body ->
            if (method == "GET" && path.startsWith("/api/meet/") && path != "/api/meet/inbox") {
                val other = body["other"] as JsonObject
                JsonObject(
                    body + ("other" to JsonObject(
                        other + mapOf(
                            "zone" to kotlinx.serialization.json.JsonPrimitive("Hall B"),
                            "spot" to kotlinx.serialization.json.JsonPrimitive("SECRET-SPOT"),
                            "spot_me" to kotlinx.serialization.json.JsonPrimitive("SECRET-SPOT-ME"),
                            "distance_m" to kotlinx.serialization.json.JsonPrimitive(40),
                            "bearing_deg" to kotlinx.serialization.json.JsonPrimitive(90),
                        ),
                    )),
                )
            } else {
                body
            }
        }
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Expo hall", "") == null)
            (rig.controller.ask(rig.person(ada), "Hello there") as ApiResult.Ok).value.meetId
        }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-waiting")
        onNodeWithText("Waiting for Ada Seed. No reply yet.").assertIsDisplayed()
        onNodeWithTag("meet-them-zone").assertDoesNotExist()
        onNodeWithTag("meet-distance").assertDoesNotExist()
        kotlin.test.assertTrue(u3NoText("Hall B"))
        kotlin.test.assertTrue(u3NoText("SECRET"))
        kotlin.test.assertTrue(u3NoText("About 40 m"))
        onNodeWithText(ConnectStrings.NOT_SAID_SPOT).assertExists()
    }

    @Test
    fun aSameZoneAskShowsTheirZoneButNoSpotLineUntilActive() = runComposeUiTest {
        val rig = rig()
        rig.rewrite = { method, path, body ->
            if (method == "GET" && path.startsWith("/api/meet/") && path != "/api/meet/inbox") {
                val other = body["other"] as JsonObject
                JsonObject(
                    body + ("other" to JsonObject(
                        other + mapOf(
                            "spot" to kotlinx.serialization.json.JsonPrimitive("SECRET-SPOT"),
                            "spot_me" to kotlinx.serialization.json.JsonPrimitive("SECRET-SPOT-ME"),
                        ),
                    )),
                )
            } else {
                body
            }
        }
        val id = u3Await(rig) {
            rig.controller.updateContext(rig.context())
            rig.makeVisible()
            val ada = rig.seedAda("Hallway")
            check(rig.controller.turnOnPresence("Hallway", "") == null)
            (rig.controller.ask(rig.person(ada), "Hello there") as ApiResult.Ok).value.meetId
        }
        u3Show(rig) { state -> MeetScreen(id, state, rig.host) }
        u3WaitForTag("meet-them-zone")
        // Both around in the same zone: the zone, as the server and the privacy rules allow it.
        onNodeWithText("Hallway").assertIsDisplayed()
        kotlin.test.assertTrue(u3NoText("SECRET"))
        onNodeWithTag("meet-distance").assertDoesNotExist()
    }
}
