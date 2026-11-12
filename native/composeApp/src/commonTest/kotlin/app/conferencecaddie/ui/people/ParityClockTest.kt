package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.people.ConferenceWindow
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.ui.talks.ForYouModel
import kotlin.test.Test
import kotlin.test.assertEquals
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
// end the talks the states show, fails here rather than in a screenshot run nobody looks at.

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
                }
            }
        } finally {
            withContext(Dispatchers.Default) { rig.core.awaitIdle() }
            rig.close()
        }
    }

    private companion object {
        /** Talks 9, 7 and 12: the summit's eBPF and Security talks after its first day. */
        const val MIN_FOR_YOU_TALKS = 3
    }
}
