package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.runComposeUiTest
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.people.ConferenceWindow
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.ui.talks.ForYouModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

// The parity screenshots run at a fixed instant (ParitySample.pinnedNowMs), not on the wall clock,
// so the states that depend on the time look the same on any day. These checks run with the other
// UI tests, so a change to the sample talks or to the pin that would leave For you empty, or would
// end the talks the states show, fails here rather than in a screenshot run nobody looks at. The
// first checks the core's clock; the second the app's (ParityRig.App), through the ended-talk banner.

@OptIn(ExperimentalTestApi::class)
class ParityClockTest {
    @Test
    fun forYouListsTheParityTalksAtThePinnedInstant() = runTest {
        val rig = ParityRig()
        try {
            withContext(Dispatchers.Default) {
                rig.core.awaitIdle()
                val bundle = assertIs<BundleState.Ready>(rig.core.state.value.bundle, "the sample summit's bundle is installed").bundle
                val now = rig.clock.ms
                assertEquals(ParitySample.pinnedNowMs(bundle.conference), now, "the rig runs at the pinned instant of the bundle it serves")

                // The talks the states rely on: the first day's have ended (the ended-talk banner, and
                // what For you leaves out), the rest have not, and the summit still takes people writes.
                val ends = bundle.talks.associate { it.talkId to it.endEpochMs }
                for (n in listOf(1, 2)) assertTrue(ends.getValue(ParitySample.talk(n).id) <= now, "talk $n has ended at the pinned instant")
                for (n in 3..12) assertTrue(ends.getValue(ParitySample.talk(n).id) > now, "talk $n has not ended at the pinned instant")
                val until = ConferenceWindow.visibleUntilMs(bundle.conference.endDate, bundle.conference.timeZone)
                assertTrue(until != null && now < until, "the summit takes people writes at the pinned instant")

                rig.core.setLearnTopics(JORDAN_LEARNS)
                withTimeout(20_000) { rig.core.state.first { it.learn.topics == JORDAN_LEARNS } }
                // The For you tab (fix-foryou-people) and the People home's row (fix-people-foryou).
                for (size in listOf(ForYouModel.SIZE, ForYouModel.ROW_SIZE)) {
                    val result = assertIs<ForYou.Result.Ready>(rig.core.forYou(size), "For you of size $size has something to suggest from")
                    val ids = result.items.map { it.talk.talkId }
                    assertTrue(ids.size >= MIN_FOR_YOU_TALKS, "For you of size $size lists at least $MIN_FOR_YOU_TALKS talks at the pinned instant, not $ids")
                    assertTrue(ParitySample.talk(FOR_YOU_SHARED_TALK).id in ids, "For you of size $size lists talk $FOR_YOU_SHARED_TALK, which fix-foryou-people shares: $ids")
                    assertTrue(result.items.all { it.talk.endEpochMs > now }, "For you lists no ended talk: $ids")
                    if (size == ForYouModel.SIZE) {
                        assertEquals(FOR_YOU_TOP.map { ParitySample.talk(it).id }, ids.take(3), "For you's first three at the pinned instant")
                    }
                }
                // The Android shots' status bar shows the same instant on the summit's wall clock.
                assertEquals("0900", ParitySample.pinnedHhmm())
            }
        } finally {
            withContext(Dispatchers.Default) { rig.core.awaitIdle() }
            rig.close()
        }
    }

    @Test
    fun theAppShowsTalksAgainstThePinnedInstant() = runComposeUiTest {
        val rig = ParityRig()
        try {
            ParityRun(this, rig, ParityCamera { }, "unused", bothThemes = false).run {
                // As ended-talk-banner starts: talks 1 and 3 marked, shared for talk 1. The banner names
                // the most recent marked talk that has ended by the app's clock (CaddieApp's nowMs).
                start(interested = listOf(1, 3), shared = listOf(1))
                val banner = hasTestTag("ended-talk-banner")
                waitUntil(timeoutMillis = 20_000) {
                    onAllNodes(banner).fetchSemanticsNodes().isNotEmpty() ||
                        runCatching { onNodeWithTag("people-screen").performScrollToNode(banner) }.isSuccess
                }
                waitFor(banner)
                fun inBanner(n: Int) = onAllNodes(hasText(ParitySample.talk(n).title, substring = true) and hasAnyAncestor(banner), useUnmergedTree = true)
                    .fetchSemanticsNodes().isNotEmpty()
                // At the pinned instant talk 1 (day 1) has ended and talk 3 (day 3) has not. On the wall
                // clock after 2026-11-11 10:30 UTC both have ended and the banner would name talk 3.
                assertTrue(inBanner(1), "the ended-talk banner names talk 1, which has ended at the pinned instant")
                assertFalse(inBanner(3), "the ended-talk banner does not name talk 3, which has not ended at the pinned instant")
            }
        } finally {
            rig.close()
        }
    }

    private companion object {
        /** Talks 9, 7 and 12: the summit's eBPF and Security talks after its first day. */
        const val MIN_FOR_YOU_TALKS = 3

        /** For you's order at the pinned instant: one wanted topic each, so by start time. */
        val FOR_YOU_TOP = listOf(9, 7, 12)
    }
}
