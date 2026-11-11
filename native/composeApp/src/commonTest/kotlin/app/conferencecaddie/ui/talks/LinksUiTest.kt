package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.platform.IncomingHandoff
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// caddie:// links from the platforms (Android's intents, iOS's onOpenURL) through the hand-off: a
// conference link opens its conference, tab, view and day as the web's routes do; a connect link
// only ever asks, naming the server; anything else is dropped. On the iOS simulator and an Android
// emulator.
@OptIn(ExperimentalTestApi::class)
class LinksUiTest {
    private val backend = TestBackend().also { it.publish(listOf(it.alpha, it.beta, it.gamma)) }
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-links-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val alpha = backend.alpha.slug
    private val gamma = backend.gamma.slug

    @BeforeTest
    fun nothingWaiting() = IncomingHandoff.clear()

    @AfterTest
    fun cleanUp() = runTest {
        IncomingHandoff.clear()
        scope.coroutineContext.job.cancelAndJoin()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    private fun ComposeUiTest.waitFor(tag: String? = null, text: String? = null): SemanticsNodeInteraction {
        val matcher = if (tag != null) hasTestTag(tag) else hasText(text!!)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        return if (tag != null) onNodeWithTag(tag) else onNodeWithText(text!!)
    }

    private fun ComposeUiTest.start(tab: Tab = Tab.ForYou) {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = tab)) }
        waitUntil(timeoutMillis = 20_000) { core.state.value.selectedSlug == alpha }
    }

    @Test
    fun aConferenceLinkOpensTheScheduleOnItsDay() = runComposeUiTest {
        start()
        IncomingHandoff.offerLink("caddie://e/$gamma#/search?view=schedule&day=2099-05-06")
        waitUntil(timeoutMillis = 20_000) { core.state.value.selectedSlug == gamma }
        waitFor(tag = "schedule-screen")
        onNodeWithTag("tab-Search").assertIsSelected()
        waitFor(tag = "day-chip-2099-05-06").assertIsSelected()
        waitFor(tag = "sched-$gamma:5")
        assertNull(IncomingHandoff.latest.value, "the link was not taken")
    }

    @Test
    fun aLinkToMyScheduleOpensItsDayView() = runComposeUiTest {
        start(Tab.Search)
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.isEmpty() && core.state.value.bundle is app.conferencecaddie.shared.core.BundleState.Ready }
        core.setInterested("$alpha:1", true)
        core.setInterested("$alpha:3", true)
        IncomingHandoff.offerLink("caddie://e/$alpha#/interested?view=day")
        waitFor(tag = "day-timeline")
        onNodeWithTag("tab-Interested").assertIsSelected()
        waitFor(tag = "timeline-$alpha:1")
        waitFor(tag = "timeline-$alpha:3")
    }

    @Test
    fun aLinkWithoutAConferenceShowsTheTabOfTheOneOpen() = runComposeUiTest {
        start()
        IncomingHandoff.offerLink("caddie://e#/search")
        waitFor(tag = "search-screen")
        onNodeWithTag("tab-Search").assertIsSelected()
        assertEquals(alpha, core.state.value.selectedSlug)
    }

    @Test
    fun aConnectLinkAsksBeforeSwitching() = runComposeUiTest {
        start()
        IncomingHandoff.offerLink("caddie://connect?url=https%3A%2F%2Fother.example%2Fcaddie%2F")
        waitFor(tag = "connect-confirmation")
        waitFor(text = Strings.Connect.prompt("https://other.example/caddie"))
        // Declining leaves everything as it was.
        onNode(hasText(Strings.Common.CANCEL) and hasAnyAncestor(hasTestTag("connect-confirmation"))).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("connect-confirmation")).fetchSemanticsNodes().isEmpty() }
        assertEquals(backend.base, core.state.value.backend.base)
    }

    private fun ComposeUiTest.offerAndWait(url: String) {
        IncomingHandoff.offerLink(url)
        waitUntil(timeoutMillis = 20_000) { IncomingHandoff.latest.value == null }
        waitForIdle()
    }

    @Test
    fun linksThatAreNotTheAppsOwnAreDropped() = runComposeUiTest {
        start()
        // Plain http and credentials in a connect link, another scheme, and a slug that is not one.
        offerAndWait("caddie://connect?url=http%3A%2F%2Fother.example")
        offerAndWait("caddie://connect?url=https%3A%2F%2Fuser%3Apass%40other.example")
        offerAndWait("caddie://e/..%2F..%2Fetc#/search")
        offerAndWait("caddie://somewhere-else/e/$gamma")
        assertEquals(false, IncomingHandoff.offerLink("https://evil.example/e/$gamma#/search"))
        onNodeWithTag("connect-confirmation").assertDoesNotExist()
        assertEquals(alpha, core.state.value.selectedSlug)
        onNodeWithTag("tab-For you").assertIsSelected()

        // A conference this backend does not list says so and changes nothing.
        IncomingHandoff.offerLink("caddie://e/no-such-conference-2099#/search")
        waitFor(text = Strings.Blockers.NOT_AVAILABLE_HERE)
        assertEquals(alpha, core.state.value.selectedSlug)
    }
}
