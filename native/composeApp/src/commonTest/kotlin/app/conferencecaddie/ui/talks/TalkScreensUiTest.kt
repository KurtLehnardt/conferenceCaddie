package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// The talk flows end to end, from the shared core through the shell: switch conference, search with
// a time phrase and a filter, open a talk, mark it interested and find it under Interested. The
// backend is TestBackend, in memory. They run on the iOS simulator and on an Android emulator.
@OptIn(ExperimentalTestApi::class)
class TalkScreensUiTest {
    private val backend = TestBackend()
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }

    @AfterTest
    fun cleanUp() {
        scope.cancel()
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.close()
    }

    private fun ComposeUiTest.waitFor(tag: String? = null, text: String? = null): SemanticsNodeInteraction {
        val matcher = if (tag != null) hasTestTag(tag) else hasText(text!!)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        return if (tag != null) onNodeWithTag(tag) else onNodeWithText(text!!)
    }

    @Test
    fun searchWithATimePhraseAndAFilterThenMarkATalk() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search)) }

        waitFor(tag = "talk-alpha-conf-2099:1")
        waitFor(text = Strings.Search.count(3, browse = true, includeEvents = false))

        // "after lunch" leaves the text and filters; "kubernetes" finds two talks, both after lunch.
        onNodeWithTag("search-field").performTextReplacement("kubernetes after lunch")
        waitFor(text = "After lunch")
        waitFor(text = Strings.Search.count(2, browse = false, includeEvents = false))
        onNodeWithTag("talk-alpha-conf-2099:1").assertDoesNotExist()

        // The track name is suggested; applying it keeps both, and the Track chip shows it.
        try {
            waitFor(text = "${Strings.Search.SUGGESTION_TRACK}: Kubernetes")
        } catch (e: Throwable) {
            throw AssertionError(onRoot(useUnmergedTree = true).printToString(), e)
        }
        onNodeWithText("${Strings.Search.SUGGESTION_TRACK}: Kubernetes").performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText("${Strings.Search.SUGGESTION_TRACK}: Kubernetes")).fetchSemanticsNodes().isEmpty() }

        // Removing the phrase stops it filtering, but the text keeps the words.
        onNodeWithText("After lunch").performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasText("After lunch")).fetchSemanticsNodes().isEmpty() }
        waitFor(text = Strings.Search.count(2, browse = false, includeEvents = false))

        // Open a talk: the sheet shows the speaker's tagline and the related talks. The list is
        // lazy, so on a short screen the card is brought into view first.
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("talk-alpha-conf-2099:3"))
        onNodeWithText("Kubernetes scheduling deep dive").performClick()
        waitFor(tag = "talk-sheet")
        waitFor(text = "Maintainer").assertIsDisplayed()
        waitFor(tag = "related-talks")

        // Mark it, then find it in My schedule.
        val inSheet = hasAnyAncestor(hasTestTag("talk-sheet"))
        onNode(hasText(Strings.Talk.INTERESTED) and inSheet).performClick()
        waitFor(text = Strings.Toasts.ADDED)
        onNode(hasContentDescription(Strings.Common.CLOSE) and inSheet).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("talk-sheet")).fetchSemanticsNodes().isEmpty() }
        waitFor(tag = "tab-Interested").performClick()
        waitFor(tag = "interested-screen")
        waitFor(text = Strings.Interested.TITLE)
        onNodeWithTag("interested-screen").performScrollToNode(hasTestTag("talk-alpha-conf-2099:3"))
        waitFor(tag = "talk-alpha-conf-2099:3")
    }

    @Test
    fun theSwitcherChangesConference() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search)) }

        waitFor(tag = "talk-alpha-conf-2099:1")
        onNodeWithTag("conference-switcher").performClick()
        waitFor(text = "Beta Conference").performClick()
        waitFor(text = Strings.Search.count(1, browse = true, includeEvents = false))
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("talk-beta-conf-2099:1"))
        onNodeWithTag("talk-alpha-conf-2099:1").assertDoesNotExist()
    }

    @Test
    fun filtersSheetNarrowsAndClears() = runComposeUiTest {
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search)) }

        waitFor(tag = "talk-alpha-conf-2099:1")
        // The Has slides chip narrows to the one talk with slides.
        onNodeWithText(Strings.Chips.HAS_SLIDES).performScrollTo().performClick()
        waitFor(text = Strings.Search.count(1, browse = true, includeEvents = false))
        // The sheet's counts already reflect it, and its button names the total.
        onNodeWithText(Strings.Chips.FILTERS).performScrollTo().performClick()
        waitFor(tag = "filter-sheet")
        waitFor(text = Strings.FilterSheet.show(1, includeEvents = false)).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("filter-sheet")).fetchSemanticsNodes().isEmpty() }
        onNodeWithText(Strings.Chips.CLEAR_ALL).performScrollTo().performClick()
        waitFor(text = Strings.Search.count(3, browse = true, includeEvents = false))
    }
}
