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
import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.ui.App
import app.conferencecaddie.ui.ShellRequest
import app.conferencecaddie.ui.shell.PeoplePage
import app.conferencecaddie.ui.shell.SampleData
import app.conferencecaddie.ui.shell.ShellNavigation
import app.conferencecaddie.ui.shell.ShellState
import app.conferencecaddie.ui.shell.Tab
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

// The People layer in the shell: the people routes of the shell's requests (which links and
// notification taps become, PeopleLinksUiTest), the offline gate and the evidence text. The
// controller is a real one over an in-memory API, so these tests look only at what the layer itself
// decides. Run on the iOS simulator and on Android.
//
// The tests use the v2 test API, which runs the composition's coroutines on the main thread. The
// People tab first appears when the controller, on a background thread, says people features are
// on; the v1 API would compose on that thread, where an Android lazy list cannot start.
@OptIn(ExperimentalTestApi::class)
class PeopleShellUiTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val talks = PeopleTalks(bundle = null, interested = emptyList(), nowMs = 0)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
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

    private var lastId = 0L

    /** The shell's request for [route], as CaddieApp makes it from a link. */
    private fun requestFor(route: AppLink.PeopleRoute) = ShellRequest(++lastId, Tab.People, people = route)

    @Test
    fun peopleRoutesOpenTheirScreens() = runComposeUiTest {
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        var request by mutableStateOf<ShellRequest?>(null)
        setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        // The People tab waits for the controller: no tab until its people features are on.
        onNodeWithTag("tab-People").assertDoesNotExist()
        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("tab-People")
        onNodeWithTag("tab-People").assertIsSelected()

        request = requestFor(AppLink.PeopleRoute.Inbox)
        waitForTag("page-inbox")
        onNodeWithTag("tab-People").assertIsSelected()

        // A meet opens over the People tab, so Back returns there.
        request = requestFor(AppLink.PeopleRoute.Meet("m-42"))
        waitForTag("page-meet")
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Meet("m-42")), nav.pages) }

        // A nudge opens People with Around now.
        request = requestFor(AppLink.PeopleRoute.Home(aroundNow = true))
        waitUntil(timeoutMillis = 20_000) { nav.pages.isEmpty() }
        onNodeWithTag("tab-People").assertIsSelected()
        waitForTag("people-home")

        // Profile opens over what shows, as from Settings.
        runOnIdle { nav.openSettings() }
        request = requestFor(AppLink.PeopleRoute.Profile)
        waitForTag("page-profile")
        runOnIdle { assertEquals(PeoplePage.Profile, nav.pages.last()) }

        // A request is shown once: leaving its page, the same request does not open it again.
        request = requestFor(AppLink.PeopleRoute.Inbox)
        waitForTag("page-inbox")
        runOnIdle { nav.back() }
        waitForIdle()
        runOnIdle { assertTrue(nav.pages.none { it == PeoplePage.Inbox }) }
    }

    @Test
    fun aRouteThatArrivesFirstWaitsForPeopleFeatures() = runComposeUiTest {
        // The tap that opened the app reaches the layer before people features are known.
        val request = requestFor(AppLink.PeopleRoute.Inbox)
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        waitForIdle()
        onNodeWithTag("page-inbox").assertDoesNotExist()
        // The shell left the tab alone for it: nothing was picked meanwhile.
        runOnIdle { assertEquals(null, nav.tab) }
        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("page-inbox")
        onNodeWithTag("tab-People").assertIsSelected()
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
