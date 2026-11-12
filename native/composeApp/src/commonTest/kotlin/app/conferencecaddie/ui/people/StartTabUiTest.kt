package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.v2.runComposeUiTest
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.ui.TABS_WAIT_MS
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.talks.CaddieApp
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The tab the app opens on when the capabilities arrive after the first screen, as on a first start
// against a tier 3 server with nothing stored: the shell does not know yet that People is offered.
// The tab bar draws no tab until then (People comes first and would move the others), or until
// TABS_WAIT_MS has passed; People opens once it appears, unless the person picked a tab after the
// wait, and then their tab stays. CaddieApp over a real CaddieCore on TestBackend (people features on), whose capabilities
// document is held back, and a PeopleController on the fake People server. Runs on the iOS simulator
// and on Android.
//
// The tests use the v2 test API, which runs the composition's coroutines on the main thread. The
// People tab first appears when the controller, on a background thread, says people features are
// on; the v1 API would compose it on that thread, where an Android lazy list cannot start.
@OptIn(ExperimentalTestApi::class)
class StartTabUiTest {
    private val backend = TestBackend(people = true)
    private val capabilitiesSent = CompletableDeferred<Unit>()

    // TestBackend, with the capabilities document held back until the test lets it go.
    private val http = Http { url, ifNoneMatch, maxBytes ->
        if (url.endsWith("/capabilities.json")) capabilitiesSent.await()
        backend.get(url, ifNoneMatch, maxBytes)
    }
    private val root = Path(SystemTemporaryDirectory, "caddie-start-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, http, scope, allowLocalHttp = false).also { it.setBackend(testBackendUrl(backend.base)) }
    private val clock = TestClock()
    private val controller = testPeopleController(FakePeopleServer({ clock.ms }, FakeConference.alpha()), scope, clock).also {
        it.bind(core.state)
    }

    @AfterTest
    fun cleanUp() = runTest {
        // Every job must have stopped before the database closes, the screens' searches included.
        controller.close()
        scope.coroutineContext.job.cancelAndJoin()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    private fun ComposeUiTest.waitForTag(tag: String) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty() }
    }

    // The people features are on, a conference is selected and its bundle is installed: nothing that
    // could still move the tab bar is left to arrive.
    private fun ComposeUiTest.waitUntilSettled() {
        waitUntil(timeoutMillis = 20_000) {
            controller.state.value.availability == PeopleAvailability.Ready && core.state.value.bundle is BundleState.Ready
        }
        waitForIdle()
    }

    @Test
    fun aFirstStartOpensPeopleWhenTheCapabilitiesArriveLate() = runComposeUiTest {
        setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", people = controller) } }
        waitForIdle()

        // Nothing is known yet: the tab bar is there but draws no tab, so no tab moves under a
        // finger and the app does not open on For you only to move to People a moment later.
        onNodeWithTag("tabs-pending").assertExists()
        onNodeWithTag("tab-${Strings.Tabs.PEOPLE}").assertDoesNotExist()
        onNodeWithTag("tab-${Strings.Tabs.FOR_YOU}").assertDoesNotExist()
        onNodeWithTag("tab-${Strings.Tabs.SEARCH}").assertDoesNotExist()

        capabilitiesSent.complete(Unit)
        waitForTag("tab-${Strings.Tabs.PEOPLE}")
        waitUntilSettled()
        onNodeWithTag("tab-${Strings.Tabs.PEOPLE}").assertIsSelected()
        onNodeWithTag("tab-${Strings.Tabs.FOR_YOU}").assertIsNotSelected()
        waitForTag("people-home")

        // Checking the capabilities again does not move the tab.
        core.refresh(force = true)
        waitUntilSettled()
        onNodeWithTag("tab-${Strings.Tabs.PEOPLE}").assertIsSelected()
    }

    @Test
    fun aTabPickedAfterTheWaitStaysPickedWhenTheCapabilitiesArrive() = runComposeUiTest {
        setContent { TestPhone { CaddieApp(core, isDebugBuild = false, appVersion = "test", people = controller) } }
        waitForIdle()
        onNodeWithTag("tab-${Strings.Tabs.SEARCH}").assertDoesNotExist()

        // The server is slow: after the wait the tab bar shows the tabs it has, and the person taps
        // Search while the app is still asking the server what it offers.
        mainClock.advanceTimeBy(TABS_WAIT_MS)
        waitForTag("tab-${Strings.Tabs.SEARCH}")
        onNodeWithTag("tab-${Strings.Tabs.PEOPLE}").assertDoesNotExist()
        onNodeWithTag("tab-${Strings.Tabs.SEARCH}").performClick()
        onNodeWithTag("tab-${Strings.Tabs.SEARCH}").assertIsSelected()

        capabilitiesSent.complete(Unit)
        waitForTag("tab-${Strings.Tabs.PEOPLE}")
        waitUntilSettled()
        onNodeWithTag("tab-${Strings.Tabs.SEARCH}").assertIsSelected()
        onNodeWithTag("tab-${Strings.Tabs.PEOPLE}").assertIsNotSelected()
        onNodeWithTag("tab-body-${Tab.Search.name}").assertExists()
    }
}
