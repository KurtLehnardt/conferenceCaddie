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
import app.conferencecaddie.ui.talks.Restoration
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

// A people route that waits for people features survives the activity's re-creation: the app keeps
// the shell request only in memory, so the layer keeps the waiting route in saved state. These tests
// emulate the re-creation with the app's request gone, as it is after a real one. Run on the iOS
// simulator and on Android.
@OptIn(ExperimentalTestApi::class)
class PeopleWaitingRouteUiTest {
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

    private fun ComposeUiTest.countOf(nav: ShellNavigation, page: PeoplePage) = nav.pages.count { it == page }

    @Test
    fun aWaitingRouteSurvivesARecreationAndOpensOnceWhenPeopleFeaturesTurnOn() = runComposeUiTest {
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        var request by mutableStateOf<ShellRequest?>(ShellRequest(1, Tab.People, people = AppLink.PeopleRoute.Meet("m-42")))
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        waitForIdle()
        onNodeWithTag("page-meet").assertDoesNotExist()

        // The activity is re-created while the route waits, and the app no longer holds the request.
        runOnIdle { request = null }
        restoration.emulateSaveAndRestore()
        waitForIdle()
        onNodeWithTag("page-meet").assertDoesNotExist()

        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("page-meet")
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Meet("m-42")), nav.pages) }

        // It was shown once: Back closes it and it does not open again.
        runOnIdle { nav.back() }
        waitForIdle()
        runOnIdle { assertEquals(0, countOf(nav, PeoplePage.Meet("m-42"))) }
    }

    @Test
    fun aNewerRequestReplacesOneStillWaitingAcrossARecreation() = runComposeUiTest {
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        var request by mutableStateOf<ShellRequest?>(ShellRequest(1, Tab.People, people = AppLink.PeopleRoute.Meet("m-1")))
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        waitForIdle()
        runOnIdle { request = null }
        restoration.emulateSaveAndRestore()
        waitForIdle()
        // The app starts counting its requests again, so the new one has the old one's id.
        runOnIdle { request = ShellRequest(1, Tab.People, people = AppLink.PeopleRoute.Inbox) }
        waitForIdle()

        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("page-inbox")
        runOnIdle { assertEquals(listOf<PeoplePage>(PeoplePage.Inbox), nav.pages) }
    }

    @Test
    fun aRouteAlreadyShownDoesNotOpenAgainAfterARecreation() = runComposeUiTest {
        val controller = testController(scope)
        scope.launch { controller.updateContext(peopleContext()) }
        lateinit var nav: ShellNavigation
        val held = ShellRequest(1, Tab.People, people = AppLink.PeopleRoute.Inbox)
        var request by mutableStateOf<ShellRequest?>(held)
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { _, _, _ -> }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        waitForTag("page-inbox")
        runOnIdle { nav.back() }
        waitForIdle()
        runOnIdle { assertEquals(0, countOf(nav, PeoplePage.Inbox)) }

        // Re-created with the request still held (it is only forgotten with the app's memory).
        restoration.emulateSaveAndRestore()
        waitForIdle()
        runOnIdle { assertEquals(0, countOf(nav, PeoplePage.Inbox)) }
        onNodeWithTag("page-inbox").assertDoesNotExist()

        // And re-created again once the app has let go of it.
        runOnIdle { request = null }
        restoration.emulateSaveAndRestore()
        waitForIdle()
        onNodeWithTag("page-inbox").assertDoesNotExist()
    }

    @Test
    fun aWaitingRouteIsGivenUpWithAToastWhenPeopleFeaturesAreOff() = runComposeUiTest {
        val controller = testController(scope)
        lateinit var nav: ShellNavigation
        val toasts = mutableListOf<String>()
        var request by mutableStateOf<ShellRequest?>(ShellRequest(1, Tab.People, people = AppLink.PeopleRoute.Meet("m-42")))
        val restoration = Restoration(this)
        restoration.setContent {
            nav = rememberShellNavigation()
            val ui = rememberPeopleUi(controller, nav, talks, true, true, null, { message, _, _ -> toasts += message }, {}, {}, request)!!
            TestPhone { App(ui.shellState(shellState()), content = content(ui), navigation = nav, request = request) }
        }
        waitForIdle()
        runOnIdle { assertTrue(toasts.isEmpty(), "the route waits while the answer is coming") }

        // The backend answers with people features off: the route is given up with the toast.
        val off = peopleContext().copy(capabilities = Capabilities(people = Capabilities.People(enabled = false)))
        scope.launch { controller.updateContext(off) }
        waitUntil(timeoutMillis = 20_000) { toasts.isNotEmpty() }
        runOnIdle {
            assertEquals(listOf(Strings.Blockers.NOT_AVAILABLE_HERE), toasts)
            assertTrue(nav.pages.isEmpty())
        }
        onNodeWithTag("page-meet").assertDoesNotExist()

        // It does not come back after a re-creation, nor when people features turn on later.
        runOnIdle { request = null }
        restoration.emulateSaveAndRestore()
        waitForIdle()
        scope.launch { controller.updateContext(peopleContext()) }
        waitForTag("tab-People")
        waitForIdle()
        onNodeWithTag("page-meet").assertDoesNotExist()
        runOnIdle {
            assertTrue(nav.pages.isEmpty())
            assertEquals(1, toasts.size)
        }
    }
}
