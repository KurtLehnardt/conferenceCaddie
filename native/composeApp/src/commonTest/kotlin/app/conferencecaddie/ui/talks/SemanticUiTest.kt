package app.conferencecaddie.ui.talks

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.embed.BgeEmbedder
import app.conferencecaddie.ui.shell.DebugLaunch
import app.conferencecaddie.ui.shell.Tab
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.CaddieTheme
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.test.runTest
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory

/**
 * Answers fixed vectors by query, so the screens' ranking can be checked by hand against
 * TestBackend's talks (1: e0, 3: e1, 4: e2). An unknown query gets a zero vector.
 */
private class FixedEmbedder(private val vectors: Map<String, Int>) : Embedder {
    override val modelId = BgeEmbedder.MODEL_ID
    override val dimensions = 384
    override suspend fun embed(texts: List<String>): List<FloatArray> = texts.map { input ->
        FloatArray(384).also { v -> vectors[input.removePrefix(BgeEmbedder.QUERY_INSTRUCTION)]?.let { v[it] = 1f } }
    }
}

// The phase 2b flows end to end through the shell, on the iOS simulator and an Android emulator: For
// you from picked topics, the learn text and marked talks; the topic picker; Why this rank; the note
// when meaning-based matching is unavailable; and the official link of a related talk.
@OptIn(ExperimentalTestApi::class)
class SemanticUiTest {
    private val backend = TestBackend()
    private val root = Path(SystemTemporaryDirectory, "caddie-ui-${Random.nextLong().toULong()}")
    private val database = CaddieDatabase.open(":memory:")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
    private val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false).also {
        it.setBackend(BackendUrl.normalise(backend.base) as BackendUrl.Valid)
    }
    private val embedder = FixedEmbedder(mapOf("kubernetes" to 1, "tracing probes" to 0, "placing pods" to 1))
    private val opened = ArrayList<String>()
    private val uriHandler = object : UriHandler {
        override fun openUri(uri: String) {
            opened += uri
        }
    }

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

    private fun ComposeUiTest.app(tab: Tab, talkLaunch: TalkLaunch = TalkLaunch(), model: Embedder? = embedder, failing: Boolean = false) {
        setContent {
            CompositionLocalProvider(LocalUriHandler provides uriHandler) {
                CaddieApp(
                    core,
                    isDebugBuild = false,
                    appVersion = "test",
                    launch = DebugLaunch(tab = tab),
                    talkLaunch = talkLaunch,
                    embedder = if (failing) ({ error("the model is missing") }) else ({ model }),
                )
            }
        }
    }

    // Cards are clickable, so their texts merge into the card's node; [unmerged] finds a text by
    // where it sits inside a card (a reason line, the ranking panel).
    private fun ComposeUiTest.waitFor(matcher: SemanticsMatcher, unmerged: Boolean = false): SemanticsNodeInteraction {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty() }
        return onNode(matcher, useUnmergedTree = unmerged)
    }

    private fun ComposeUiTest.waitGone(matcher: SemanticsMatcher) {
        waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher).fetchSemanticsNodes().isEmpty() }
    }

    private fun chip(label: String, count: Int, group: String) =
        hasContentDescription(Strings.Topics.chipLabel(label, count)) and hasAnyAncestor(hasTestTag(group))

    @Test
    fun forYouAsksForTopicsThenSuggestsTalksWithTheirReasons() = runComposeUiTest {
        app(Tab.ForYou)
        waitFor(hasTestTag("for-you-prompt"))
        onNodeWithTag("for-you-prompt-pick").performClick()
        waitFor(hasTestTag("topic-sheet"))
        // Common topics by talk count: Kubernetes (2), then eBPF and Scheduling (1 each).
        waitFor(chip("Kubernetes", 2, "topic-common")).performClick()
        waitFor(hasText(Strings.Topics.count(1)))
        waitFor(hasContentDescription(Strings.Topics.chipLabel("Kubernetes", null)) and hasAnyAncestor(hasTestTag("topic-chosen")))
        onNodeWithTag("topic-done").performClick()
        waitGone(hasTestTag("topic-sheet"))

        waitFor(hasTestTag("for-you-alpha-conf-2099:3"))
        waitFor(hasTestTag("for-you-alpha-conf-2099:4"))
        onNode(hasTestTag("for-you-alpha-conf-2099:1")).assertDoesNotExist()
        waitFor(hasText("${Strings.ForYou.WHY_LABEL} Kubernetes") and hasAnyAncestor(hasTestTag("for-you-alpha-conf-2099:3")), unmerged = true)

        // Marking a suggestion leaves it out; the marked talk then finds talks like it (talk 4 is
        // as near to it as talk 1, and has the topic too).
        onNodeWithTag("for-you-interested-alpha-conf-2099:3").performScrollTo().performClick()
        waitFor(hasText(Strings.Toasts.ADDED))
        waitGone(hasTestTag("for-you-alpha-conf-2099:3"))
        waitFor(hasTestTag("for-you-alpha-conf-2099:4"))
    }

    @Test
    fun theTopicPickerFindsTopicsAndTheLearnTextSuggestsByMeaning() = runComposeUiTest {
        app(Tab.ForYou, TalkLaunch(sheet = "topics"))
        waitFor(hasTestTag("topic-sheet"))
        onNodeWithTag("topic-find").performTextReplacement("kub")
        waitFor(chip("Kubernetes", 2, "topic-hits"))
        onNodeWithTag("topic-find").performTextReplacement("zzz")
        waitFor(hasText(Strings.Topics.NO_MATCH))
        onNodeWithTag("topic-find").performTextReplacement("")
        waitFor(hasTestTag("topic-common"))

        // The learn text alone: talk 1 is nearest to "tracing probes", with a passage from its abstract.
        onNode(hasContentDescription(Strings.Topics.TEXT_LABEL)).performScrollTo().performTextReplacement("tracing probes")
        onNodeWithTag("topic-done").performClick()
        waitGone(hasTestTag("topic-sheet"))
        waitFor(hasTestTag("for-you-alpha-conf-2099:1"))
        waitFor(hasText("Probes and maps.") and hasAnyAncestor(hasTestTag("for-you-alpha-conf-2099:1")), unmerged = true)
        assertEquals("tracing probes", core.state.value.learn.text)
    }

    @Test
    fun quickTapsInTheTopicPickerAreAllKept() = runComposeUiTest {
        waitUntil(timeoutMillis = 20_000) { core.state.value.bundle is BundleState.Ready }
        val bundle = (core.state.value.bundle as BundleState.Ready).bundle
        val id = { label: String -> bundle.topicsById.values.single { it.label == label }.topicId }
        val saved = ArrayList<List<String>>()
        // [selected] never catches up here, as with a core that has not yet stored the first tap
        // when the second arrives: each tap must build on the one before, not on [selected].
        setContent {
            CaddieTheme {
                TopicPickerSheet(bundle, selected = emptyList(), text = "", interested = emptyList(), onTopics = { saved += it }, onText = {}, onClose = {})
            }
        }
        waitFor(chip("Kubernetes", 2, "topic-common")).performClick()
        onNode(chip("eBPF", 1, "topic-common")).performClick()
        onNode(chip("Scheduling", 1, "topic-common")).performClick()
        assertEquals(listOf(id("Kubernetes"), id("eBPF"), id("Scheduling")), saved.last())
        waitFor(hasText(Strings.Topics.count(3)))
        // Removing one keeps the others.
        onNode(chip("eBPF", 1, "topic-common")).performClick()
        assertEquals(listOf(id("Kubernetes"), id("Scheduling")), saved.last())
        waitFor(hasText(Strings.Topics.count(2)))
    }

    @Test
    fun whyThisRankShowsTheFusedKeywordAndMeaningRanks() = runComposeUiTest {
        app(Tab.Search)
        waitFor(hasTestTag("talk-alpha-conf-2099:1"))
        onNodeWithTag("search-field").performTextReplacement("kubernetes")
        // Keywords find 4 (the shorter title) then 3; meaning (e1) puts 3 first, so 3 is first in the
        // fused list. Talk 1 joins as a neighbour by meaning.
        waitFor(hasText(Strings.Search.count(3, browse = false, includeEvents = false)))
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("rank-toggle-alpha-conf-2099:3"))
        onNodeWithTag("rank-toggle-alpha-conf-2099:3").performClick()
        val inPanel = hasAnyAncestor(hasTestTag("rank-panel-alpha-conf-2099:3"))
        waitFor(hasText(Strings.Rank.PLACE) and inPanel, unmerged = true)
        waitFor(hasText(Strings.Rank.keyword(2, 50)) and inPanel, unmerged = true)
        waitFor(hasText(Strings.Rank.meaning(1, 50)) and inPanel, unmerged = true)
        waitFor(hasText(Strings.Rank.conferenceOnly("Alpha Conference")) and inPanel, unmerged = true)
        waitFor(hasText(Strings.Rank.NOTE_NATIVE) and inPanel, unmerged = true)
        onNode(hasTestTag("search-degraded")).assertDoesNotExist()
    }

    @Test
    fun withoutTheModelSearchSaysItMatchesKeywordsOnly() = runComposeUiTest {
        app(Tab.Search, failing = true)
        waitFor(hasTestTag("talk-alpha-conf-2099:1"))
        onNodeWithTag("search-field").performTextReplacement("kubernetes")
        waitFor(hasTestTag("search-degraded"))
        waitFor(hasText(Strings.Search.count(2, browse = false, includeEvents = false)))
        onNodeWithTag("search-results").performScrollToNode(hasTestTag("rank-toggle-alpha-conf-2099:3"))
        onNodeWithTag("rank-toggle-alpha-conf-2099:3").performClick()
        val inPanel = hasAnyAncestor(hasTestTag("rank-panel-alpha-conf-2099:3"))
        waitFor(hasText(Strings.Rank.NOTE_KEYWORDS_ONLY) and inPanel, unmerged = true)
        onNode(hasText(Strings.Rank.MEANING) and inPanel, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun aRelatedTalkOpensInTheSheetOrOnTheOfficialSite() = runComposeUiTest {
        app(Tab.Search, TalkLaunch(talk = "alpha-conf-2099:3"))
        waitFor(hasTestTag("talk-sheet"))
        waitFor(hasTestTag("related-talks"))
        waitFor(hasTestTag("related-official-alpha-conf-2099:4")).performScrollTo().performClick()
        waitUntil(timeoutMillis = 20_000) { opened.isNotEmpty() }
        assertEquals(listOf("https://caddie.test/alpha-conf-2099/session/4"), opened)
    }
}
