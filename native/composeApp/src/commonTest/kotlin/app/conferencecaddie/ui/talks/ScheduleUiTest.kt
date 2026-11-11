package app.conferencecaddie.ui.talks

import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsNotSelected
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
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.CaddieTheme
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

// The full schedule on the Search tab (web/src/components/schedule.tsx FullSchedule): the "Search |
// Schedule" switch, the day chips, the start-time groups with their stars, the schedule's own
// filters, events, Jump to now, and the shell's other layouts. On the iOS simulator and an Android
// emulator.
@OptIn(ExperimentalTestApi::class)
class ScheduleUiTest {
    private val backend = TestBackend().also { it.publish(listOf(it.gamma, it.alpha, it.beta)) }
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-schedule-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val gamma = backend.gamma.slug

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

    private fun ComposeUiTest.gone(tag: String) = waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isEmpty() }

    private fun ComposeUiTest.openSchedule() {
        waitFor(tag = "search-view-switch")
        onNode(hasText(Strings.Search.VIEW_SCHEDULE) and hasAnyAncestor(hasTestTag("search-view-switch"))).performClick()
        waitFor(tag = "schedule-screen")
    }

    @Test
    fun theSearchTabSwitchesToTheScheduleAndKeepsBothViews() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search)) }
        waitFor(tag = "talk-$gamma:1")
        openSchedule()

        // The first day (the conference is not running today), its count, and its start times in
        // order, with the talks at 9:00 side by side in one group.
        onNodeWithTag("day-chip-2099-05-05").assertIsSelected()
        onNodeWithTag("day-chip-2099-05-06").assertIsNotSelected()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 3, events = false))
        onNodeWithText(Format.time(540)).assertIsDisplayed()
        waitFor(tag = "sched-$gamma:1")
        waitFor(tag = "sched-$gamma:2")
        onNodeWithTag("sched-$gamma:4").assertDoesNotExist()
        onNodeWithTag("schedule-screen").performScrollToNode(hasTestTag("schedule-footnote"))
        waitFor(text = Strings.Schedule.footnote("UTC"))

        // The second day.
        onNodeWithTag("day-chip-2099-05-06").performClick()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-06"), 2, events = false))
        waitFor(tag = "sched-$gamma:5")
        onNodeWithTag("sched-$gamma:1").assertDoesNotExist()

        // The star marks a talk, with the toast's Undo.
        onNodeWithTag("sched-star-$gamma:5").performClick()
        waitFor(text = Strings.Toasts.ADDED)
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested == listOf("$gamma:5") }

        // Search and back: the schedule keeps its day.
        onNode(hasText(Strings.Search.VIEW_SEARCH) and hasAnyAncestor(hasTestTag("search-view-switch"))).performClick()
        waitFor(tag = "search-screen")
        openSchedule()
        onNodeWithTag("day-chip-2099-05-06").assertIsSelected()
    }

    @Test
    fun theScheduleHasItsOwnFiltersAndShowsEvents() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search)) }
        waitFor(tag = "talk-$gamma:1")
        openSchedule()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 3, events = false))

        // No time chips: the day chips and Jump to now replace them.
        onNodeWithText(Strings.Chips.HAPPENING_NOW).assertDoesNotExist()
        onNodeWithText(Strings.Chips.DAY).assertDoesNotExist()
        onNodeWithText(Strings.Chips.TIME).assertDoesNotExist()

        // The sheet has no Day or Time either, and its track narrows the day.
        onNodeWithText(Strings.Chips.FILTERS).performClick()
        waitFor(tag = "filter-sheet")
        val inSheet = hasAnyAncestor(hasTestTag("filter-sheet"))
        onNode(hasText(Strings.FilterSheet.ANY_DAY) and inSheet).assertDoesNotExist()
        onNode(hasText(Strings.FilterSheet.ANY_TIME) and inSheet).assertDoesNotExist()
        onNode(hasText("Observability") and inSheet).performScrollTo().performClick()
        waitFor(text = Strings.FilterSheet.show(1, includeEvents = false)).performClick()
        gone("filter-sheet")
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 1, events = false))
        onNodeWithTag("sched-$gamma:1").assertDoesNotExist()

        // The search view's filters are its own.
        onNode(hasText(Strings.Search.VIEW_SEARCH) and hasAnyAncestor(hasTestTag("search-view-switch"))).performClick()
        waitFor(text = Strings.Search.count(5, browse = true, includeEvents = false))
        openSchedule()

        // Clear all, then events and showcases: the event has its label and no star.
        onNodeWithText(Strings.Chips.CLEAR_ALL).performScrollTo().performClick()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 3, events = false))
        onNodeWithText(Strings.Chips.EVENTS).performScrollTo().performClick()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 4, events = true))
        onNodeWithTag("schedule-screen").performScrollToNode(hasTestTag("sched-$gamma:4"))
        onNode(hasText(Strings.Schedule.EVENT) and hasAnyAncestor(hasTestTag("sched-$gamma:4"))).assertIsDisplayed()
        onNodeWithTag("sched-star-$gamma:4").assertDoesNotExist()

        // A row opens its talk.
        onNodeWithText("Sponsor showcase").performClick()
        waitFor(tag = "talk-sheet")
    }

    /** The full schedule on its own, with the clock at [nowIso] in the conference's zone (UTC). */
    private fun ComposeUiTest.showSchedule(nowIso: String, size: DpSize = DpSize(390.dp, 844.dp), fontScale: Float = 1f) {
        val nowMs = kotlin.time.Instant.parse(nowIso).toEpochMilliseconds()
        waitUntil(timeoutMillis = 20_000) { (core.state.value.bundle as? BundleState.Ready)?.bundle?.conference?.slug == gamma }
        val ready = core.state.value.bundle as BundleState.Ready
        assertEquals(gamma, ready.bundle.conference.slug)
        setContent {
            val modelScope = rememberCoroutineScope { Dispatchers.Main.immediate }
            val model = remember { ScheduleModel(modelScope) { core.search(it) } }
            TestDevice(size, fontScale) {
                CaddieTheme {
                    ScheduleScreen(model, ready.bundle, emptySet(), nowMs, onToggleInterested = {}, onOpenTalk = {})
                }
            }
        }
    }

    @Test
    fun jumpToNowGoesToTheSlotInProgressOnToday() = runComposeUiTest {
        showSchedule("2099-05-05T10:05:00Z")
        // Today's chip says so and is chosen; the button shows while the conference runs.
        onNodeWithTag("day-chip-2099-05-05").assertIsSelected()
        onNodeWithTag("day-chip-2099-05-05").assert(hasText(Strings.Schedule.TODAY))
        waitFor(tag = "jump-to-now")

        // From the other day, Jump to now comes back to today and its 10:00 slot.
        onNodeWithTag("day-chip-2099-05-06").performClick()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-06"), 2, events = false))
        onNodeWithTag("jump-to-now").performClick()
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 3, events = false))
        onNodeWithTag("day-chip-2099-05-05").assertIsSelected()
        waitFor(tag = "sched-$gamma:3").assertIsDisplayed()
    }

    @Test
    fun noJumpToNowWhileTheConferenceIsNotRunning() = runComposeUiTest {
        showSchedule("2099-06-01T10:00:00Z")
        waitFor(text = Strings.Schedule.count(Format.day("2099-05-05"), 3, events = false))
        onNodeWithTag("jump-to-now").assertDoesNotExist()
        onNodeWithText(Strings.Schedule.TODAY).assertDoesNotExist()
    }

    @Test
    fun aWideWindowAndLandscapeKeepTheScheduleInTheColumn() = runComposeUiTest {
        setContent {
            TestDevice(DpSize(1024.dp, 768.dp)) {
                CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search))
            }
        }
        waitFor(tag = "talk-$gamma:1")
        openSchedule()
        onNodeWithTag("nav-rail").assertIsDisplayed()
        waitFor(tag = "sched-$gamma:1")
        val screen = onNodeWithTag("schedule-screen").getUnclippedBoundsInRoot()
        assertTrue(screen.right - screen.left <= 721.dp, "the schedule is wider than the web's 720 dp column")
        // The schedule's chips wrap in the wide layout, so the last one is on screen.
        onNodeWithText(Strings.Chips.EVENTS).assertIsDisplayed()
    }

    @Test
    fun aPhoneInLandscapeShowsTheSchedule() = runComposeUiTest {
        showSchedule("2099-05-05T09:10:00Z", size = DpSize(844.dp, 390.dp))
        waitFor(tag = "sched-$gamma:1")
        onNodeWithTag("schedule-screen").performScrollToNode(hasTestTag("sched-$gamma:3"))
        onNodeWithTag("sched-$gamma:3").assertIsDisplayed()
        onNodeWithTag("jump-to-now").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun aSmallPhoneAtTwiceTheFontSizeKeepsTheScheduleUsable() = runComposeUiTest {
        showSchedule("2099-05-05T09:10:00Z", size = DpSize(320.dp, 640.dp), fontScale = 2f)
        waitFor(tag = "sched-$gamma:1")
        onNodeWithTag("day-chip-2099-05-06").performScrollTo().performClick()
        waitFor(tag = "sched-$gamma:6")
        onNodeWithTag("schedule-screen").performScrollToNode(hasTestTag("sched-star-$gamma:6"))
        onNodeWithTag("sched-star-$gamma:6").assertIsDisplayed()
        // The star keeps a whole touch target at twice the font size.
        val star = onNodeWithTag("sched-star-$gamma:6").getUnclippedBoundsInRoot()
        assertTrue(star.right - star.left >= 44.dp && star.bottom - star.top >= 44.dp, "the star's touch target shrank")
        onNode(hasContentDescription(Strings.Schedule.interested("GitOps at scale"))).assertIsDisplayed()
    }
}
