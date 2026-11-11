package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.datetime.TimeZone
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// People links through the app's one link path, as the platforms hand them over: a tapped
// notification's caddie://people?around=1, caddie://inbox and caddie://meet/{id}, and the web's
// people routes on caddie://e, offered to IncomingHandoff and read by AppLink, open their pages. A
// zone link only offers presence: nothing is written until the person taps "I'm around". The app is
// CaddieApp on TestBackend with a real controller over the in-memory People API. Run on the iOS
// simulator and on Android, with the v2 test API (see PeopleShellUiTest): a link that opens the app
// is routed when the controller, on a background thread, says people features are on.
@OptIn(ExperimentalTestApi::class)
class PeopleLinksUiTest {
    private val slug = "alpha-conf-2099"
    private val backend = TestBackend(people = true)
    private val root = Path(SystemTemporaryDirectory, "caddie-people-links-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(testBackendUrl(backend.base))
    }
    private val clock = TestClock()
    private val server = FakePeopleServer({ clock.ms }, FakeConference.alpha())

    // The controller works on other threads: every request runs under one lock, and the test reads
    // what was sent from this list.
    private val mutex = Mutex()
    private val calls = MutableStateFlow<List<RecordedRequest>>(emptyList())
    private val http = ApiHttp { method, url, headers, body, timeoutMs, maxBytes ->
        mutex.withLock {
            calls.update { it + RecordedRequest(method, url, headers, body?.decodeToString()) }
            server.send(method, url, headers, body, timeoutMs, maxBytes)
        }
    }
    private val controller = PeopleController(
        InMemoryPeopleKeyValue(),
        http,
        PeopleServices(InMemorySecureStore()),
        scope,
        allowLocalHttp = false,
        clock = clock,
        timeZone = TimeZone.UTC,
    ).also { it.bind(core.state) }

    @BeforeTest
    fun nothingWaiting() = IncomingHandoff.clear()

    @AfterTest
    fun cleanUp() {
        IncomingHandoff.clear()
        controller.close()
        runBlocking { scope.coroutineContext.job.cancelAndJoin() }
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        runBlocking { database.closeWhenIdle() }
    }

    private fun calls(method: String, path: String): List<RecordedRequest> = calls.value.filter { it.method == method && it.path == path }

    private fun ComposeUiTest.waitFor(matcher: SemanticsMatcher) {
        try {
            waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        } catch (e: Throwable) {
            throw AssertionError("Timed out waiting for ${matcher.description}\n" + onRoot(useUnmergedTree = true).printToString(), e)
        }
    }

    private fun ComposeUiTest.waitGone(matcher: SemanticsMatcher) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isEmpty() }
    }

    private fun ComposeUiTest.waitReady() {
        waitUntil(timeoutMillis = 20_000) {
            controller.state.value.availability == PeopleAvailability.Ready && controller.state.value.zones.contains("Expo hall")
        }
    }

    private fun ComposeUiTest.start() {
        setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", people = controller) } }
        waitFor(hasTestTag("people-screen"))
    }

    /** Runs a controller action from the test's thread. */
    private fun <T> act(block: suspend () -> T): T = runBlocking { block() }

    /** A named profile, visible at the conference, so the people pages have something to read. */
    private fun makeVisible() = act {
        controller.updateProfile { it.copy(displayName = "Me Myself", about = "Tester.", interests = "tracing") }
        controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = emptyList())
        check(controller.setOpenToMeet(true) == null)
    }

    @Test
    fun aNotificationsLinkOpensItsPage() = runComposeUiTest {
        waitReady()
        makeVisible()
        start()

        IncomingHandoff.offerLink("caddie://inbox")
        waitFor(hasTestTag("inbox-screen"))
        onNodeWithTag("page-inbox").assertExists()
        onNodeWithTag("tab-People").assertIsSelected()

        // A meet opens over the People tab in place of Requests, and asks the server for that meet.
        IncomingHandoff.offerLink("caddie://meet/doesnotexist")
        waitFor(hasText(ConnectStrings.MEET_NOT_FOUND))
        onNodeWithTag("page-meet").assertExists()
        onNodeWithTag("page-inbox").assertDoesNotExist()
        assertTrue(calls.value.any { it.method == "GET" && it.path.endsWith("/doesnotexist") }, "the meet was read")

        // A nudge: the People tab with Around now on, and no page over it.
        IncomingHandoff.offerLink("caddie://people?around=1")
        waitGone(hasTestTag("page-meet"))
        waitFor(hasText(PeopleStrings.PEOPLE_AROUND_NOW))
        onNode(hasAnyAncestor(hasTestTag("around-now-chip")) and isToggleable()).assertIsOn()
        onNodeWithTag("tab-People").assertIsSelected()
    }

    @Test
    fun theWebsPeopleRoutesOpenTheirPages() = runComposeUiTest {
        waitReady()
        start()
        IncomingHandoff.offerLink("caddie://e/$slug#/inbox")
        waitFor(hasTestTag("inbox-screen"))
        IncomingHandoff.offerLink("caddie://e/$slug#/profile")
        waitFor(hasTestTag("profile-screen"))
        onNodeWithTag("page-profile").assertExists()
        // People leaves every page.
        IncomingHandoff.offerLink("caddie://e/$slug#/people")
        waitGone(hasTestTag("profile-screen"))
        onNodeWithTag("page-inbox").assertDoesNotExist()
        waitFor(hasTestTag("people-screen"))
    }

    @Test
    fun aLinkThatOpenedTheAppOpensItsPage() = runComposeUiTest {
        // Handed over before the screens exist, as a tap that starts the app is.
        IncomingHandoff.offerLink("caddie://inbox")
        setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", people = controller) } }
        waitFor(hasTestTag("inbox-screen"))
        onNodeWithTag("tab-People").assertIsSelected()
    }

    @Test
    fun aZoneLinkFromAnotherAppTurnsNothingOnUntilThePersonTaps() = runComposeUiTest {
        waitReady()
        // Visible, and the presence notice seen, which is what once let a link turn presence on.
        makeVisible()
        act {
            check(controller.turnOnPresence("Hallway", "") == null)
            controller.turnOffPresence()
        }
        assertFalse(controller.state.value.presence.on)
        val puts = calls("PUT", "/api/presence").size
        start()

        IncomingHandoff.offerLink("caddie://e/$slug#/here/expo-hall")
        waitFor(hasTestTag("presence-setup"))
        waitForIdle()
        assertEquals(puts, calls("PUT", "/api/presence").size, "no presence write before the tap")
        assertFalse(controller.state.value.presence.on)

        onNodeWithText(ConnectStrings.I_AM_AROUND).performClick()
        waitUntil(timeoutMillis = 20_000) { controller.state.value.presence.on }
        assertEquals(puts + 1, calls("PUT", "/api/presence").size)
        assertEquals("Expo hall", controller.state.value.presence.zone)
    }
}
