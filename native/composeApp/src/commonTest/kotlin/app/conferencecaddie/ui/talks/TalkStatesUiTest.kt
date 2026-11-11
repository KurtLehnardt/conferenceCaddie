package app.conferencecaddie.ui.talks

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

// What the talk screens show when something is missing or failing: a bundle that cannot be
// downloaded, one that fails verification, one for a newer app, a conference without one, an
// offline relaunch, a marked talk a new bundle drops, a failed search, and a configuration change.
// They run on the iOS simulator and on an Android emulator.
@OptIn(ExperimentalTestApi::class)
class TalkStatesUiTest {
    private val backend = TestBackend()
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-states-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val scopes = ArrayList<CoroutineScope>()
    private val alpha = backend.alpha.slug

    @AfterTest
    fun cleanUp() = runTest {
        // Every job must have stopped before the database closes, the screens' searches included:
        // closeWhenIdle waits for any statement a search still has queued.
        scopes.forEach { it.coroutineContext.job.cancelAndJoin() }
        files.clear()
        SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
        SystemFileSystem.delete(root, mustExist = false)
        database.closeWhenIdle()
    }

    /** A core on [backend]; [relaunch] starts one from what the previous one stored instead. */
    private fun core(relaunch: Boolean = false): CaddieCore {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
            if (relaunch) it.start() else it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
        }
    }

    private fun ComposeUiTest.waitFor(tag: String? = null, text: String? = null): SemanticsNodeInteraction {
        val matcher = if (tag != null) hasTestTag(tag) else hasText(text!!)
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isNotEmpty() }
        return if (tag != null) onNodeWithTag(tag) else onNodeWithText(text!!)
    }

    private fun ComposeUiTest.showApp(core: CaddieCore, tab: Tab = Tab.Search) =
        setContent { CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = tab)) }

    @Test
    fun aBundleThatCannotBeDownloadedIsOfflineUntilRetried() = runComposeUiTest {
        backend.unreachableBundles = setOf(alpha)
        showApp(core())
        waitFor(tag = "bundle-failed")
        waitFor(text = Strings.Offline.NOT_SAVED_TITLE)
        backend.unreachableBundles = emptySet()
        onNodeWithText(Strings.Common.RETRY).performClick()
        waitFor(tag = "talk-$alpha:1")
    }

    @Test
    fun aBundleThatFailsVerificationIsRefused() = runComposeUiTest {
        backend.corruptBundles = setOf(alpha)
        showApp(core())
        waitFor(tag = "bundle-failed")
        waitFor(text = TalkStrings.BUNDLE_INVALID)
    }

    @Test
    fun aBundleForANewerAppAsksForAnUpdate() = runComposeUiTest {
        backend.publish(listOf(backend.alpha, backend.beta), newerBundles = setOf(alpha))
        val core = core()
        // A bundle_version 2 entry has no usable bundle, so the default is beta; choose alpha.
        waitUntil(timeoutMillis = 20_000) { core.state.value.bundle is BundleState.Ready }
        core.selectConference(alpha)
        showApp(core)
        waitFor(tag = "bundle-failed")
        waitFor(text = TalkStrings.UPDATE_APP_TITLE)
    }

    @Test
    fun aConferenceWithoutABundleCannotBeSearched() = runComposeUiTest {
        backend.publish(listOf(backend.alpha, backend.beta), unpublished = setOf(alpha))
        val core = core()
        waitUntil(timeoutMillis = 20_000) { core.state.value.bundle is BundleState.Ready }
        core.selectConference(alpha)
        showApp(core)
        waitFor(text = Strings.Blockers.SCHEDULE_NOT_AVAILABLE)
        waitFor(text = Strings.Blockers.cantBeSearched(backend.alpha.name))
    }

    @Test
    fun anOfflineRelaunchShowsTheBadgeAndTheSavedSchedule() = runComposeUiTest {
        val first = core()
        waitUntil(timeoutMillis = 20_000) { (first.state.value.bundle as? BundleState.Ready)?.bundle?.conference?.slug == alpha }
        first.setInterested(backend.bundleOf(backend.alpha).talksById.getValue("$alpha:3"), true)
        waitUntil(timeoutMillis = 20_000) { first.state.value.interested.isNotEmpty() }
        backend.offline = true
        showApp(core(relaunch = true))
        waitFor(text = Strings.Offline.BADGE)
        waitFor(tag = "talk-$alpha:1")
        waitFor(tag = "tab-Interested").performClick()
        waitFor(tag = "interested-screen")
        onNodeWithTag("interested-screen").performScrollToNode(hasTestTag("talk-$alpha:3"))
    }

    @Test
    fun aNewerAppNoticeShowsAboveTheSavedSchedule() = runComposeUiTest {
        val core = core()
        showApp(core)
        waitFor(tag = "talk-$alpha:1")
        backend.publish(listOf(backend.alpha, backend.beta), newerBundles = setOf(alpha))
        core.refresh(force = true)
        waitFor(tag = "update-notice")
        waitFor(tag = "talk-$alpha:1")
    }

    @Test
    fun aMarkedTalkANewBundleDropsStaysInMySchedule() = runComposeUiTest {
        val core = core()
        showApp(core, tab = Tab.Interested)
        waitUntil(timeoutMillis = 20_000) { core.state.value.bundle is BundleState.Ready }
        core.setInterested(backend.bundleOf(backend.alpha).talksById.getValue("$alpha:3"), true)
        waitFor(tag = "interested-screen")
        backend.publish(listOf(backend.alpha.without("3"), backend.beta))
        core.refresh(force = true)
        waitUntil(timeoutMillis = 20_000) {
            (core.state.value.bundle as? BundleState.Ready)?.bundle?.talksById?.containsKey("$alpha:3") == false
        }
        onNodeWithTag("interested-screen").performScrollToNode(hasTestTag("talk-$alpha:3"))
        waitFor(text = "Kubernetes scheduling deep dive")
        // The tab's count is what the list shows.
        onNode(hasContentDescription(Strings.Tabs.interestedWithCount(1))).assertExists()
    }

    @Test
    fun aFailedSearchOffersRetry() = runComposeUiTest {
        val bundle = backend.bundleOf(backend.alpha)
        var fail = true
        setContent {
            val scope = rememberCoroutineScope()
            val model = remember {
                SearchModel(scope) { request: SearchRequest ->
                    if (fail) error("search failed")
                    // A result without the database: browse mode over the bundle's talks.
                    app.conferencecaddie.shared.search.SearchResult(
                        total = bundle.talks.count { it.isTalk },
                        searchText = request.query,
                        timePhrases = emptyList(),
                        suggestions = emptyList(),
                        happeningNowAvailable = true,
                        talks = bundle.talks.filter { it.isTalk },
                        facets = app.conferencecaddie.shared.search.Facets(emptyList(), emptyList(), null, emptyList(), emptyList()),
                    )
                }
            }
            LaunchedEffect(Unit) { model.onConference(bundle.conference.slug, bundle.contentHash) }
            SearchScreen(model, bundle, emptySet(), 0L, {}, {}, {})
        }
        waitFor(tag = "search-error")
        waitFor(text = Strings.Blockers.SOMETHING_WRONG)
        waitFor(text = Strings.Search.UNAVAILABLE)
        fail = false
        onNodeWithText(Strings.Common.RETRY).performClick()
        waitFor(text = Strings.Search.count(3, browse = true, includeEvents = false))
        onNodeWithTag("search-error").assertDoesNotExist()
    }

    @Test
    fun aConfigurationChangeKeepsTheSearchAndTheOpenTalk() = runComposeUiTest {
        // The activity's store, which outlives a rotation; the composition does not.
        val owner = object : ViewModelStoreOwner {
            override val viewModelStore = ViewModelStore()
        }
        val core = core()
        val tester = Restoration(this)
        tester.setContent {
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                CaddieApp(core, isDebugBuild = false, appVersion = "test", launch = DebugLaunch(tab = Tab.Search))
            }
        }
        waitFor(tag = "talk-$alpha:1")
        onNodeWithTag("search-field").performTextReplacement("kubernetes")
        waitFor(text = Strings.Search.count(2, browse = false, includeEvents = false))
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("talk-$alpha:3"))
        // The title itself: a card is taller than a short screen once it has Why this rank, and a tap
        // at the middle of the whole card can land on one of its buttons.
        onNodeWithText("Kubernetes scheduling deep dive", useUnmergedTree = true).performClick()
        waitFor(tag = "talk-sheet")

        tester.emulateSaveAndRestore()

        waitFor(tag = "talk-sheet")
        waitFor(text = "Maintainer")
        onNode(hasContentDescription(Strings.Common.CLOSE) and hasAnyAncestor(hasTestTag("talk-sheet"))).performClick()
        waitUntil(timeoutMillis = 20_000) { onAllNodes(hasTestTag("talk-sheet")).fetchSemanticsNodes().isEmpty() }
        waitFor(text = Strings.Search.count(2, browse = false, includeEvents = false))
        onNodeWithTag("talk-$alpha:1").assertDoesNotExist()
        owner.viewModelStore.clear()
    }
}
