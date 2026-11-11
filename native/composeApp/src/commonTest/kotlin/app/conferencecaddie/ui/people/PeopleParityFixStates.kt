package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import kotlinx.coroutines.delay

// The parity states of the fixes pass (parity-3/scenarios.mjs, the fix- runs): the For you row of the
// People home, and the people controls on the Search results and on the For you cards. File names
// start with fix-; the heights are the web screenshots' at 390 and 320 wide, and each state is also
// shot at twice the font size, in landscape and in the wide layout (extras), like the brief's screens.

/** What Jordan Rivera's profile wants to learn, as For you's topics on this device (For you runs here, not from the profile). */
private suspend fun ParityRun.learnLikeJordan() {
    rig.core.setLearnTopics(listOf("ebpf", "security"))
    while (rig.core.state.value.learn.topics != listOf("ebpf", "security")) delay(20)
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.settle(ms: Long) {
    runCatching { waitUntil(timeoutMillis = ms) { false } }
}

/** Waits for a node inside a talk card: a card is one button for screen readers, so its parts are only in the unmerged tree. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.waitInCard(matcher: SemanticsMatcher) {
    waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
}

/**
 * Waits for [matcher] in the lazy list tagged [list], scrolling the list to it first when it is
 * below what the window composes (the landscape window is 390 dp tall), and scrolls back to the
 * top, so the shot shows the list from its start as the web screenshot does.
 */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.waitInList(list: String, matcher: SemanticsMatcher, unmerged: Boolean = false) {
    waitUntil(timeoutMillis = 20_000) {
        onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty() ||
            runCatching { onNodeWithTag(list, useUnmergedTree = unmerged).performScrollToNode(matcher) }.isSuccess
    }
    waitUntil(timeoutMillis = 20_000) { onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty() }
    onNodeWithTag(list, useUnmergedTree = unmerged).performScrollToIndex(0)
    waitForIdle()
}

@OptIn(ExperimentalTestApi::class)
internal val PARITY_FIX_STATES: List<ParityState> = listOf(
    ParityState("fix-people-foryou", 1037, 1101, extras = extras(2400)) {
        start(visible = false, prepare = { learnLikeJordan() })
        waitFor(hasTestTag("people-visibility-prompt"))
        waitInList("people-screen", hasTestTag("for-you-row-cards"))
        settle(600)
        peopleTop()
        shoot()
    },
    ParityState("fix-people-foryou-pick", 961, 1004, extras = extras(2000)) {
        start(profile = false)
        waitFor(hasTestTag("people-create-profile"))
        waitInList("people-screen", hasTestTag("for-you-prompt") and hasAnyAncestor(hasTestTag("for-you-row")))
        settle(400)
        peopleTop()
        shoot()
    },
    ParityState("fix-search-people", 1500, 1500, extras = extras(3000)) {
        start(interested = listOf(1, 2), shared = listOf(1), tab = "tab-Search")
        val talk1 = ParitySample.talk(1).id
        waitInCard(hasTestTag("talk-people-$talk1"))
        waitInList("search-results", hasTestTag("share-switch-${ParitySample.talk(2).id}"), unmerged = true)
        waitInCard(hasText("people want to talk about this", substring = true) and hasAnyAncestor(hasTestTag("talk-people-$talk1")))
        settle(800)
        shoot()
    },
    ParityState("fix-foryou-people", 1035, 1098, extras = extras(2400)) {
        // Talk 12 is the sample's last talk, so it stays in For you (which lists upcoming talks) for
        // the whole conference; the earlier ones leave it as the real clock passes them.
        start(shared = listOf(12), tab = "tab-For you", prepare = { learnLikeJordan() })
        val talk12 = ParitySample.talk(12).id
        waitInList("for-you-screen", hasTestTag("for-you-$talk12"))
        waitInList("for-you-screen", hasTestTag("share-switch-$talk12"), unmerged = true)
        settle(800)
        shoot()
    },
)
