package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.platform.PlatformActions
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// My schedule (web/src/components/interested.tsx and app.tsx): the List or Day switch and the Day
// timeline with talks at the same time side by side, the choice kept on the device, and the
// Interested options (Clear list with Undo, and the native Share list). On the iOS simulator and an
// Android emulator.
@OptIn(ExperimentalTestApi::class)
class MyScheduleUiTest {
    private val backend = TestBackend().also { it.publish(listOf(it.gamma, it.alpha, it.beta)) }
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-my-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val gamma = backend.gamma.slug
    private val marked = listOf("$gamma:1", "$gamma:2", "$gamma:3", "$gamma:5")

    /** Captures what the app shares. */
    private class FakePlatform : PlatformActions {
        var shared: Pair<String, String>? = null
        override fun pickScheduleFile(onPicked: (PickedFile?) -> Unit) = onPicked(null)
        override fun shareText(text: String, subject: String) {
            shared = text to subject
        }
    }

    @AfterTest
    fun cleanUp() = runTest {
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

    private fun ComposeUiTest.show(platform: PlatformActions = PlatformActions.None, size: DpSize? = null, fontScale: Float = 1f) = setContent {
        val app = @androidx.compose.runtime.Composable {
            CaddieApp(
                core, isDebugBuild = false, appVersion = "test",
                launch = DebugLaunch(tab = Tab.Interested),
                talkLaunch = TalkLaunch(mark = marked),
                platform = platform,
            )
        }
        if (size != null) TestDevice(size, fontScale) { app() } else app()
    }

    private fun ComposeUiTest.dayView() {
        waitFor(tag = "my-schedule-view")
        onNode(hasText(Strings.Interested.VIEW_DAY) and hasAnyAncestor(hasTestTag("my-schedule-view"))).performClick()
        waitFor(tag = "day-timeline")
    }

    @Test
    fun theDayViewPutsTalksAtTheSameTimeSideBySide() = runComposeUiTest {
        show()
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }
        // The List view: the days in capitals, then the talks.
        waitFor(text = Format.dayLong("2099-05-05").uppercase())
        dayView()

        // The first day: three cards, the two at 9:00 sharing the width, the 10:00 one alone.
        onNodeWithTag("day-chip-2099-05-05").assertIsSelected()
        val a = waitFor(tag = "timeline-$gamma:1").getUnclippedBoundsInRoot()
        val b = onNodeWithTag("timeline-$gamma:2").getUnclippedBoundsInRoot()
        val c = onNodeWithTag("timeline-$gamma:3").getUnclippedBoundsInRoot()
        assertTrue(b.left >= a.right - 1.dp, "talks at the same time overlap instead of sitting side by side")
        assertTrue((c.right - c.left) > (a.right - a.left) * 1.8f, "a talk alone does not take the whole width")
        assertTrue(c.top > a.top, "the 10:00 talk is not below the 9:00 talks")
        // Each card opens its talk.
        onNodeWithTag("timeline-$gamma:3").performClick()
        waitFor(tag = "talk-sheet")
        onNode(hasContentDescription(Strings.Common.CLOSE) and hasAnyAncestor(hasTestTag("talk-sheet"))).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("talk-sheet")).fetchSemanticsNodes().isEmpty() }

        // The second day.
        onNodeWithTag("day-chip-2099-05-06").performClick()
        waitFor(tag = "timeline-$gamma:5")
        onNodeWithTag("timeline-$gamma:1").assertDoesNotExist()
        waitFor(text = Strings.Interested.footnote("UTC"))

        // The choice is kept on the device: a new composition opens on Day.
        waitUntil(timeoutMillis = 20_000) { kotlinx.coroutines.runBlocking { core.uiSetting("myschedule.view.v1") } == "day" }
    }

    @Test
    fun clearListAsksFirstAndCanBeUndone() = runComposeUiTest {
        show()
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }

        onNodeWithTag("overflow-menu").assertIsDisplayed().performClick()
        waitFor(tag = "menu-clear").performClick()
        waitFor(tag = "clear-dialog")
        waitFor(text = Strings.Interested.clearBody(marked.size))
        onNode(hasText(Strings.Interested.CLEAR) and hasAnyAncestor(hasTestTag("clear-dialog"))).performClick()

        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.isEmpty() }
        waitFor(text = Strings.Interested.EMPTY)
        waitFor(text = Strings.Toasts.CLEARED)
        onNodeWithText(Strings.Toasts.UNDO).performClick()
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.toSet() == marked.toSet() }
        waitFor(tag = "interested-screen").performScrollToNode(hasTestTag("talk-$gamma:5"))

        // Cancel leaves the list alone.
        onNodeWithTag("overflow-menu").performClick()
        waitFor(tag = "menu-clear").performClick()
        waitFor(tag = "clear-dialog")
        onNode(hasText(Strings.Common.CANCEL) and hasAnyAncestor(hasTestTag("clear-dialog"))).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("clear-dialog")).fetchSemanticsNodes().isEmpty() }
        assertEquals(marked.toSet(), core.state.value.interested.toSet())
    }

    @Test
    fun shareListSendsTheScheduleAsText() = runComposeUiTest {
        val platform = FakePlatform()
        show(platform)
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }
        onNodeWithTag("overflow-menu").performClick()
        waitFor(tag = "menu-share").assertIsEnabled().performClick()
        waitUntil(timeoutMillis = 20_000) { platform.shared != null }
        val (text, subject) = platform.shared!!
        assertEquals(Strings.Share.subject("Gamma Summit"), subject)
        assertTrue(Format.dayLong("2099-05-05") in text && Format.dayLong("2099-05-06") in text, text)
        assertTrue("9:00–9:30 AM  Opening keynote on platform engineering" in text, text)
        assertTrue("https://caddie.test/$gamma/session/5" in text, text)
        assertTrue(text.indexOf("Opening keynote") < text.indexOf("Securing the software supply chain"), "the talks are not in time order")
        assertTrue(text.trimEnd().endsWith(Strings.Share.footer("UTC")), text)
    }

    @Test
    fun theMenuIsDisabledForAnEmptyList() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Interested)) }
        waitFor(text = Strings.Interested.EMPTY)
        onNodeWithTag("overflow-menu").performClick()
        waitFor(tag = "menu-clear").assertIsNotEnabled()
        onNodeWithTag("menu-share").assertIsNotEnabled()
    }

    @Test
    fun theDayViewInAWideWindowAndInLandscape() = runComposeUiTest {
        show(size = DpSize(1024.dp, 768.dp))
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }
        dayView()
        onNodeWithTag("nav-rail").assertIsDisplayed()
        val screen = onNodeWithTag("interested-screen").getUnclippedBoundsInRoot()
        assertTrue(screen.right - screen.left <= 721.dp, "My schedule is wider than the web's 720 dp column")
        waitFor(tag = "timeline-$gamma:3").assertIsDisplayed()
    }

    @Test
    fun aPhoneInLandscapeShowsTheDayView() = runComposeUiTest {
        show(size = DpSize(844.dp, 390.dp))
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }
        dayView()
        onNodeWithTag("interested-screen").performScrollToNode(hasTestTag("timeline-$gamma:3"))
        onNodeWithTag("timeline-$gamma:3").assertIsDisplayed()
    }

    @Test
    fun aSmallPhoneAtTwiceTheFontSizeKeepsMyScheduleUsable() = runComposeUiTest {
        show(size = DpSize(320.dp, 640.dp), fontScale = 2f)
        waitFor(tag = "interested-screen")
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested.size == marked.size }
        dayView()
        onNodeWithTag("day-chip-2099-05-06").performScrollTo().performClick()
        waitFor(tag = "timeline-$gamma:5").assertIsDisplayed()
        // The menu still opens and Clear list is reachable.
        onNodeWithTag("overflow-menu").performClick()
        waitFor(tag = "menu-clear").assertIsDisplayed()
    }
}
