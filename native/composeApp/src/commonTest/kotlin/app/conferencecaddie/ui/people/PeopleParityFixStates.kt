package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import kotlinx.coroutines.delay

// The parity states of the fixes pass (parity-3/scenarios.mjs, the fix- runs): the For you row of the
// People home, and the people controls on the Search results and on the For you cards. File names
// start with fix-; the heights are the web screenshots' at 390 and 320 wide.

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

@OptIn(ExperimentalTestApi::class)
internal val PARITY_FIX_STATES: List<ParityState> = listOf(
    ParityState("fix-people-foryou", 1037, 1101) {
        start(visible = false, prepare = { learnLikeJordan() })
        waitFor(hasTestTag("people-visibility-prompt"))
        waitFor(hasTestTag("for-you-row-cards"))
        settle(600)
        peopleTop()
        shoot()
    },
    ParityState("fix-people-foryou-pick", 961, 1004) {
        start(profile = false)
        waitFor(hasTestTag("people-create-profile"))
        waitFor(hasTestTag("for-you-prompt") and hasAnyAncestor(hasTestTag("for-you-row")))
        settle(400)
        peopleTop()
        shoot()
    },
    ParityState("fix-search-people", 1500, 1500) {
        start(interested = listOf(1, 2), shared = listOf(1), tab = "tab-Search")
        val talk1 = ParitySample.talk(1).id
        waitInCard(hasTestTag("talk-people-$talk1"))
        waitInCard(hasTestTag("share-switch-${ParitySample.talk(2).id}"))
        waitInCard(hasText("people want to talk about this", substring = true) and hasAnyAncestor(hasTestTag("talk-people-$talk1")))
        settle(800)
        shoot()
    },
    ParityState("fix-foryou-people", 1035, 1098) {
        start(shared = listOf(7), tab = "tab-For you", prepare = { learnLikeJordan() })
        val talk7 = ParitySample.talk(7).id
        waitFor(hasTestTag("for-you-$talk7"))
        waitInCard(hasTestTag("share-switch-$talk7"))
        settle(800)
        shoot()
    },
)
