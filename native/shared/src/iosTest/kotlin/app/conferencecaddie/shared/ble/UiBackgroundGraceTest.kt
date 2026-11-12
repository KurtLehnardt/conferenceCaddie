package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * [UiBackgroundGrace] without UIApplication: every background task it begins is ended exactly once,
 * by the end of the hold, by [WakeHold.release] or by iOS's expiration, and nothing is begun in the
 * foreground.
 */
class UiBackgroundGraceTest {
    private class FakeTasks : BackgroundTasks {
        var now = 0L
        var background = true
        var mainCalls = 0
        val begun = mutableListOf<ULong>()
        val ended = mutableListOf<ULong>()
        var expire: (() -> Unit)? = null
        private val timers = mutableListOf<Pair<Long, () -> Unit>>()

        override fun onMain(block: () -> Unit) {
            mainCalls++
            block()
        }

        override fun onMainAfter(millis: Long, block: () -> Unit) {
            timers += (now + millis) to block
        }

        override fun inBackground(): Boolean = background

        override fun begin(onExpired: () -> Unit): ULong? {
            val id = (begun.size + 1).toULong()
            begun += id
            expire = onExpired
            return id
        }

        override fun end(task: ULong) {
            ended += task
        }

        fun advanceTo(t: Long) {
            while (true) {
                val next = timers.filter { it.first <= t }.minByOrNull { it.first } ?: break
                timers.remove(next)
                now = next.first
                next.second()
            }
            now = t
        }
    }

    private val grace = UiBackgroundGrace.GRACE_MS

    private fun graceOf(tasks: FakeTasks) = UiBackgroundGrace(graceMillis = grace, clock = { tasks.now }, tasks = tasks)

    @Test
    fun inTheForegroundNothingIsBegun() {
        val tasks = FakeTasks().apply { background = false }
        val hold = graceOf(tasks)
        hold.hold()
        hold.holdUntil(60_000L)
        hold.release()
        tasks.advanceTo(120_000L)
        assertTrue(tasks.begun.isEmpty())
        assertTrue(tasks.ended.isEmpty())
    }

    @Test
    fun oneTaskPerHoldEndedOnceWhenTheLastGraceRunsOut() {
        val tasks = FakeTasks()
        val hold = graceOf(tasks)
        hold.hold()
        assertEquals(listOf(1uL), tasks.begun)
        tasks.advanceTo(5_000L)
        hold.hold()
        assertEquals(listOf(1uL), tasks.begun, "a second event extends the same task")
        // The first hold's timer has been replaced.
        tasks.advanceTo(grace)
        assertTrue(tasks.ended.isEmpty())
        tasks.advanceTo(5_000L + grace)
        assertEquals(listOf(1uL), tasks.ended)

        // The next event begins a new task, ended in turn.
        tasks.advanceTo(30_000L)
        hold.hold()
        tasks.advanceTo(30_000L + grace)
        assertEquals(listOf(1uL, 2uL), tasks.begun)
        assertEquals(tasks.begun, tasks.ended)
    }

    @Test
    fun aHoldUntilTheNextReportLastsALittleAfterIt() {
        val tasks = FakeTasks()
        val hold = graceOf(tasks)
        hold.hold()
        hold.holdUntil(45_000L)
        tasks.advanceTo(45_000L + HOLD_UNTIL_MARGIN_MS - 1)
        assertTrue(tasks.ended.isEmpty())
        tasks.advanceTo(45_000L + HOLD_UNTIL_MARGIN_MS)
        assertEquals(listOf(1uL), tasks.ended)
        assertEquals(1, tasks.begun.size)
    }

    @Test
    fun releaseEndsTheTaskOnceAndItsTimerThenDoesNothing() {
        val tasks = FakeTasks()
        val hold = graceOf(tasks)
        hold.hold()
        hold.release()
        assertEquals(listOf(1uL), tasks.ended)
        hold.release()
        tasks.advanceTo(120_000L)
        assertEquals(listOf(1uL), tasks.ended, "ended once")
    }

    @Test
    fun iosExpiringTheTaskEndsItOnce() {
        val tasks = FakeTasks()
        val hold = graceOf(tasks)
        hold.holdUntil(100_000L)
        tasks.advanceTo(25_000L)
        tasks.expire!!()
        assertEquals(listOf(1uL), tasks.ended)
        tasks.advanceTo(200_000L)
        hold.release()
        assertEquals(listOf(1uL), tasks.ended, "neither the timer nor the release ends it again")
    }

    @Test
    fun aReleaseBeforeAnyHoldTouchesNothing() {
        val tasks = FakeTasks()
        graceOf(tasks).release()
        assertEquals(0, tasks.mainCalls, "a radio in a test process can stop without a UIApplication")
    }
}
