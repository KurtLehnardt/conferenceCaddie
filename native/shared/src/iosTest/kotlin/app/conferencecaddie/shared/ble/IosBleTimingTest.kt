package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The iOS radio's timing and holding rules, apart from Core Bluetooth: how long the app is held
 * awake ([wakeHoldEnd]), which discoveries a relaunch keeps for the runtime ([HeldDiscoveries]), and
 * when the radio ticks next ([tickDelayMillis]).
 */
class IosBleTimingTest {
    private val grace = UiBackgroundGrace.GRACE_MS

    @Test
    fun aHoldLastsTheGraceFromNowAndIsNeverShortened() {
        val now = 1_000_000L
        assertEquals(now + grace, wakeHoldEnd(now, currentEnd = 0L, graceMillis = grace))
        // A later event moves the end on.
        assertEquals(now + 5_000L + grace, wakeHoldEnd(now + 5_000L, currentEnd = now + grace, graceMillis = grace))
        // An end further away (a hold until the next report) is kept.
        assertEquals(now + 60_000L, wakeHoldEnd(now, currentEnd = now + 60_000L, graceMillis = grace))
    }

    @Test
    fun aHoldUntilAReportLastsALittleAfterIt() {
        val now = 1_000_000L
        // The report is due after the grace: held until 5 seconds after it.
        val report = now + 45_000L
        assertEquals(report + HOLD_UNTIL_MARGIN_MS, wakeHoldEnd(now, currentEnd = 0L, graceMillis = grace, requested = report))
        assertEquals(5_000L, HOLD_UNTIL_MARGIN_MS)
        // Due sooner than the grace ends: the grace still applies.
        assertEquals(now + grace, wakeHoldEnd(now, currentEnd = 0L, graceMillis = grace, requested = now + 1_000L))
        // Already past: the grace from now.
        assertEquals(now + grace, wakeHoldEnd(now, currentEnd = 0L, graceMillis = grace, requested = now - 30_000L))
        // Never shortens a longer hold.
        assertEquals(now + 90_000L, wakeHoldEnd(now, currentEnd = now + 90_000L, graceMillis = grace, requested = report))
    }

    @Test
    fun discoveriesHeldAfterARelaunchAreCappedAndReplayedInOrder() {
        val held = HeldDiscoveries<String>()
        assertEquals(16, MAX_HELD_DISCOVERIES)
        for (i in 0 until 20) held.add("phone-$i", "heard-$i")
        // The 16 latest phones, oldest first; the first four made room.
        assertEquals(MAX_HELD_DISCOVERIES, held.size)
        assertEquals((4 until 20).map { "heard-$it" }, held.drain())
        assertEquals(0, held.size)
        assertEquals(emptyList<String>(), held.drain())
    }

    @Test
    fun aPhoneHeardAgainIsHeldOnceWithItsLatestDiscovery() {
        val held = HeldDiscoveries<String>(cap = 3)
        held.add("a", "a-1")
        held.add("b", "b-1")
        held.add("a", "a-2")
        held.add("c", "c-1")
        // "a" heard again counts as its latest discovery, so "b" is now the oldest and makes room.
        held.add("d", "d-1")
        assertEquals(listOf("a-2", "c-1", "d-1"), held.drain())
    }

    @Test
    fun clearingDropsEverythingHeld() {
        val held = HeldDiscoveries<Int>()
        held.add("a", 1)
        held.add("b", 2)
        held.clear()
        assertEquals(0, held.size)
        assertTrue(held.drain().isEmpty())
    }

    @Test
    fun theTickComesAtTheScanRestartTheWindowOrTheEnd() {
        val window = BleProtocol.windowStartMillis(2990520L)
        val windowLength = BleProtocol.windowStartMillis(2990521L) - window
        val scan = IosBleRadio.SCAN_RESTART_MS
        val margin = IosBleRadio.WINDOW_MARGIN_MS
        val min = IosBleRadio.MIN_TICK_MS
        fun delay(now: Long, until: Long = now + 3_600_000L) = tickDelayMillis(now, until, scan, margin, min)

        // Early in a window: the scan restart comes first.
        assertEquals(scan, delay(window + 1_000L))
        // Late in a window: just after the next one starts.
        val late = window + windowLength - 10_000L
        assertEquals(10_000L + margin, delay(late))
        // The session ends first.
        assertEquals(7_000L, delay(window + 1_000L, until = window + 8_000L))
        // Due already, or nearly: never sooner than the minimum.
        assertEquals(min, delay(window + 1_000L, until = window + 1_000L))
        assertEquals(min, delay(window + 1_000L, until = window - 60_000L))
        // Exactly at a window start: the scan restart, since the next window is a whole window away.
        assertEquals(minOf(scan, windowLength + margin), delay(window))
    }

    @Test
    fun keepingAwakeIsSafeWhereThereIsNoRadio() {
        // The simulator's radio is not supported: nothing is held and nothing touches UIApplication.
        val radio = IosBleRadio()
        radio.keepAwakeUntil(epochMillis() + 60_000L)
        radio.stop()
    }
}
