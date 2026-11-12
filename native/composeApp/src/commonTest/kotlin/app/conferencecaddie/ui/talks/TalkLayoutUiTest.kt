package app.conferencecaddie.ui.talks

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
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
import androidx.compose.ui.test.v2.runComposeUiTest
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.ui.TestDevice
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
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

// The talk screens in the shell's other layouts: a tablet-sized window (the rail, a centred column
// of at most 720 dp and chip rows that wrap), a phone in landscape, and a 320 dp phone at twice the
// font size. They run on the iOS simulator and on an Android emulator.
@OptIn(ExperimentalTestApi::class)
class TalkLayoutUiTest {
    private val backend = TestBackend()
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-layout-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val alpha = backend.alpha.slug

    @AfterTest
    fun cleanUp() = runTest {
        // Every job must have stopped before the database closes, the screens' searches included:
        // closeWhenIdle waits for any statement a search still has queued.
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

    private fun ComposeUiTest.show(size: DpSize, fontScale: Float = 1f) = setContent {
        TestDevice(size, fontScale) {
            CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search))
        }
    }

    @Test
    fun aWideWindowCentresTheTalksAndWrapsTheChips() = runComposeUiTest {
        show(DpSize(1024.dp, 768.dp))
        waitFor(tag = "talk-$alpha:1")
        onNodeWithTag("nav-rail").assertIsDisplayed()
        val screen = onNodeWithTag("search-screen").getUnclippedBoundsInRoot()
        assertTrue(screen.right - screen.left <= 721.dp, "the talk screen is wider than the web's 720 dp column")
        // The chips wrap rather than scroll, so the last one is on screen without scrolling.
        onNodeWithText(Strings.Chips.EVENTS).assertIsDisplayed()
        onNodeWithText(Strings.Chips.HIDE_SPONSOR).assertIsDisplayed()
    }

    @Test
    fun aPhoneInLandscapeOpensATalk() = runComposeUiTest {
        show(DpSize(844.dp, 390.dp))
        waitFor(tag = "talk-$alpha:1")
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("talk-$alpha:3"))
        onNodeWithText("Kubernetes scheduling deep dive").performClick()
        waitFor(tag = "talk-sheet")
        val inSheet = hasAnyAncestor(hasTestTag("talk-sheet"))
        onNode(hasText("Maintainer") and inSheet).performScrollTo().assertIsDisplayed()
        onNode(hasContentDescription(Strings.Common.CLOSE) and inSheet).assertIsDisplayed().performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("talk-sheet")).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun aSmallPhoneAtTwiceTheFontSizeKeepsTheTalksUsable() = runComposeUiTest {
        show(DpSize(320.dp, 640.dp), fontScale = 2f)
        waitFor(tag = "talk-$alpha:1")
        onNodeWithTag("search-field").assertIsDisplayed()
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("talk-$alpha:3"))
        val card = hasAnyAncestor(hasTestTag("talk-$alpha:3"))
        onNode(hasText(Strings.Talk.INTERESTED) and card).performScrollTo().assertIsDisplayed().performClick()
        waitUntil(timeoutMillis = 20_000) { core.state.value.interested == listOf("$alpha:3") }
        waitFor(tag = "tab-Interested").performClick()
        waitFor(tag = "interested-screen")
        onNodeWithTag("interested-screen").performScrollToNode(hasTestTag("talk-$alpha:3"))
        onNodeWithTag("talk-$alpha:3").assertIsDisplayed()
    }
}
