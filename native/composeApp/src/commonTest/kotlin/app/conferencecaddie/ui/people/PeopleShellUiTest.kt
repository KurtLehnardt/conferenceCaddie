package app.conferencecaddie.ui.people

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.NotificationTaps
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.TabContent
import app.conferencecaddie.ui.shell.rememberShellNavigation
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

// The People layer in the shell: notification taps, the offline gate and the evidence text. The
// controller is a real one over an in-memory API; the screens are their owners' (stubs for now), so
// these tests look only at what the layer itself decides. Run on the iOS simulator and on Android.
//
// The tests use the v2 test API, which runs the composition's coroutines on the main thread. The
// People tab first appears when the controller, on a background thread, says people features are
// on, and taps arrive from the test's thread; the v1 API would compose on those threads, where an
// Android lazy list cannot start.
@OptIn(ExperimentalTestApi::class)
class PeopleShellUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
        NotificationTaps.handled()
    }

    private fun shellState(online: Boolean = true) = ShellState(
        capabilities = Capabilities(people = Capabilities.People(enabled = true)),
        conferences = SampleData.CONFERENCES,
        selectedConferenceId = SampleData.CONFERENCES.first().id,
        serverBase = TEST_BASE,
        officialServerBase = TEST_BASE,
        online = online,
        appVersion = "test",
    )

    private fun content(ui: PeopleUi) = TabContent(
        people = ui.tab,
        appBarActions = ui.appBarActions,
        peoplePage = ui.page,
        settingsPeople = ui.settings,
    )

    private fun ComposeUiTest.waitForTag(tag: String) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun notificationTapsOpenTheirScreens() = runComposeUiTest {
        NotificationTaps.handled()
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {})!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav) }
        }
        // The People tab waits for the controller: no tab until its people features are on.
        onNodeWithTag("tab-People").assertDoesNotExist()
        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("tab-People")
        onNodeWithTag("tab-People").assertIsSelected()

        NotificationTaps.deliver("caddie://inbox")
        waitForTag("page-inbox")
        onNodeWithTag("tab-People").assertIsSelected()
        waitUntil(timeoutMillis = 20_000) { NotificationTaps.taps.replayCache.isEmpty() }

        // A meet opens over the People tab, so Back returns there.
        NotificationTaps.deliver("caddie://meet/m-42")
        waitForTag("page-meet")
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Meet("m-42")), nav.pages) }

        // A nudge opens People with Around now.
        NotificationTaps.deliver("caddie://people?around=1")
        waitUntil(timeoutMillis = 20_000) { nav.pages.isEmpty() }
        onNodeWithTag("tab-People").assertIsSelected()
        waitForTag("people-home")

        // Anything else is ignored, and handled so it is not replayed.
        runOnIdle { nav.openPage(PeoplePage.Inbox) }
        NotificationTaps.deliver("caddie://connect?url=https://elsewhere.example")
        waitUntil(timeoutMillis = 20_000) { NotificationTaps.taps.replayCache.isEmpty() }
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Inbox), nav.pages) }
    }

    @Test
    fun aTapThatArrivesFirstWaitsForPeopleFeatures() = runComposeUiTest {
        NotificationTaps.handled()
        // The tap that opened the app is there before the screens are.
        NotificationTaps.deliver("caddie://inbox")
        val controller = testController(scope)
        setContent {
            val nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {})!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav) }
        }
        waitForIdle()
        onNodeWithTag("page-inbox").assertDoesNotExist()
        assertTrue(NotificationTaps.taps.replayCache.isNotEmpty())
        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("page-inbox")
    }

    @Test
    fun peopleRequestsAndMeetUpNeedAConnectionButProfileDoesNot() = runComposeUiTest {
        val nav = ShellNavigation()
        val host = PeopleHost(testController(scope), nav, scope, { _, _ -> }, {}, {})
        var online by mutableStateOf(false)
        setContent {
            val ui = PeopleUi(readyState(), host, talks, online = online, searchable = true)
            TestPhone { App(ui.shellState(shellState(online = online)), content = content(ui), navigation = nav) }
        }

        // The People tab: the web's NeedsConnection, word for word, and the Offline badge.
        onNodeWithTag("people-offline").assertExists()
        onNodeWithText(Strings.Offline.PEOPLE_TITLE).assertIsDisplayed()
        onNodeWithText(Strings.Offline.NEEDS_CONNECTION_BODY).assertExists()
        onNodeWithText(Strings.Offline.BADGE).assertExists()

        runOnIdle { nav.openPage(PeoplePage.Inbox) }
        onNodeWithTag("page-inbox").assertExists()
        onNodeWithTag("people-offline").assertExists()

        runOnIdle { nav.openPage(PeoplePage.Meet("m1")) }
        onNodeWithTag("page-meet").assertExists()
        onNodeWithTag("people-offline").assertExists()

        // Profile still works offline.
        runOnIdle { nav.openPage(PeoplePage.Profile) }
        onNodeWithTag("page-profile").assertExists()
        onNodeWithTag("people-offline").assertDoesNotExist()

        // Back online, the screens come back.
        runOnIdle { nav.openPage(PeoplePage.Inbox) }
        online = true
        waitForIdle()
        onNodeWithTag("people-offline").assertDoesNotExist()
        onNodeWithTag("page-inbox").assertExists()
    }

    @Test
    fun evidenceShowsMarkupAsText() = runComposeUiTest {
        setContent {
            TestPhone {
                CaddieTheme {
                    EvidenceText("Ran <mark>Postgres</mark> &amp; <b>bold</b> &lt;mark&gt;x&lt;/mark&gt; <script>alert(1)</script>")
                }
            }
        }
        onNodeWithText("Ran Postgres & <b>bold</b> <mark>x</mark> <script>alert(1)</script>").assertIsDisplayed()
    }
}
