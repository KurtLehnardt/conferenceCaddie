package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import platform.CoreBluetooth.CBManagerAuthorizationAllowedAlways
import platform.CoreBluetooth.CBManagerAuthorizationDenied
import platform.CoreBluetooth.CBManagerAuthorizationNotDetermined

/**
 * The iOS radio's guards, apart from Core Bluetooth: one payload per central for its reads
 * ([CentralReadWindows]), the gate that holds reads after a relaunch ([RestoreGate]) and the time
 * limit on the Bluetooth prompt ([awaitAccessDecision]).
 */
class IosBleGuardsTest {
    /** Timers on a clock the test moves. */
    private class Timers {
        var now = 0L
        private val due = mutableListOf<Pair<Long, () -> Unit>>()

        fun schedule(millis: Long, block: () -> Unit) {
            due += (now + millis) to block
        }

        /** Runs every timer due by [t], in order. */
        fun advanceTo(t: Long) {
            while (true) {
                val next = due.filter { it.first <= t }.minByOrNull { it.first } ?: break
                due.remove(next)
                now = next.first
                next.second()
            }
            now = t
        }
    }

    // ---------------------------------------------------------------------------------------------
    // One payload per central

    private fun payload(seed: Int) = ByteArray(17) { i -> (seed * 31 + i).toByte() }

    @Test
    fun aCentralIsServedThePayloadOfItsFirstReadOnly() {
        val windows = CentralReadWindows()
        val w = 2_990_520L
        assertTrue(windows.allow("central-a", w, payload(1)))
        assertTrue(windows.allow("central-a", w, payload(1)), "again in the same window (a long read, a retry)")
        // A connection held open across the change: refused for the rest of the next window.
        assertFalse(windows.allow("central-a", w + 1, payload(2)))
        assertFalse(windows.allow("central-a", w + 1, payload(2)), "still refused")
        assertFalse(windows.allow("central-a", w - 1, payload(0)), "an earlier window too (a clock set back)")
    }

    @Test
    fun aReKeyWithinTheWindowIsNotServedToACentralThatReadTheOldKey() {
        val windows = CentralReadWindows()
        val w = 2_990_520L
        assertTrue(windows.allow("central-a", w, payload(1)), "the token of key version 1")
        assertFalse(windows.allow("central-a", w, payload(9)), "the token of key version 2, same window: refused")
        assertTrue(windows.allow("central-b", w, payload(9)), "a central that never read is served the new one")
    }

    @Test
    fun onlyTheCurrentAndThePreviousWindowAreRemembered() {
        val windows = CentralReadWindows()
        val w = 2_990_520L
        windows.allow("central-a", w, payload(1))
        windows.allow("central-b", w + 1, payload(2))
        assertEquals(2, windows.size)
        // Two windows after its first read, a central is a stranger again: no session-long record,
        // and no refusal that tells it this phone was met before.
        assertTrue(windows.allow("central-a", w + 2, payload(3)))
        assertFalse(windows.allow("central-b", w + 2, payload(3)), "first served in the window before: still refused")
        windows.allow("central-c", w + 4, payload(5))
        assertEquals(1, windows.size, "the entries older than the window before are gone")
    }

    @Test
    fun anotherCentralIsServedInItsOwnWindow() {
        val windows = CentralReadWindows()
        val w = 2_990_520L
        assertTrue(windows.allow("central-a", w, payload(1)))
        assertTrue(windows.allow("central-b", w + 1, payload(2)), "a phone under a new address is a new central")
        assertFalse(windows.allow("central-a", w + 1, payload(2)))
        assertEquals(2, windows.size)
    }

    @Test
    fun atMostTheBoundIsRememberedTheLeastRecentlySeenFirstToGo() {
        assertEquals(1024, MAX_CENTRALS_REMEMBERED)
        val windows = CentralReadWindows(cap = 3)
        val w = 2_990_520L
        windows.allow("a", w, payload(1))
        windows.allow("b", w, payload(1))
        windows.allow("c", w, payload(1))
        // "a" seen again, so "b" is now the least recently seen.
        windows.allow("a", w, payload(1))
        windows.allow("d", w, payload(1))
        assertEquals(3, windows.size)
        assertFalse(windows.allow("a", w + 1, payload(2)), "still remembered")
        assertTrue(windows.allow("b", w + 1, payload(2)), "forgotten to make room")

        val full = CentralReadWindows()
        for (i in 0 until 1_100) full.allow("central-$i", w, payload(1))
        assertEquals(MAX_CENTRALS_REMEMBERED, full.size)
    }

    @Test
    fun aStopForgetsEveryCentral() {
        val windows = CentralReadWindows()
        val w = 2_990_520L
        windows.allow("central-a", w, payload(1))
        windows.clear()
        assertEquals(0, windows.size)
        assertTrue(windows.allow("central-a", w + 1, payload(2)), "a new session serves it again")
    }

    // ---------------------------------------------------------------------------------------------
    // The relaunch gate

    @Test
    fun withoutARelaunchAReadIsRefusedAtOnce() {
        val timers = Timers()
        val gate = RestoreGate<String>(timers::schedule)
        assertFalse(gate.restoring)
        assertFalse(gate.hold("read-1") { error("nothing is held") })
        assertEquals(0, gate.heldCount)
    }

    @Test
    fun aHeldReadIsAnsweredWhenTheRadioStarts() {
        val timers = Timers()
        val gate = RestoreGate<String>(timers::schedule)
        var halted = 0
        val refused = mutableListOf<String>()
        gate.relaunched { halted++ }
        assertTrue(gate.restoring)
        assertTrue(gate.hold("read-1") { refused += it })
        timers.advanceTo(1_000L)
        assertEquals(listOf("read-1"), gate.started(), "answered with the payload")
        assertFalse(gate.restoring)
        // The hold's and the grace's timers come to nothing.
        timers.advanceTo(60_000L)
        assertTrue(refused.isEmpty())
        assertEquals(0, halted)
        assertFalse(gate.hold("read-2") { refused += it }, "running: a read is served, not held")
    }

    @Test
    fun heldReadsAreRefusedAfterThreeSeconds() {
        assertEquals(3_000L, IosBleRadio.READ_HOLD_MS)
        val timers = Timers()
        val gate = RestoreGate<String>(timers::schedule)
        val refused = mutableListOf<List<String>>()
        gate.relaunched { }
        gate.hold("read-1") { refused += it }
        timers.advanceTo(2_000L)
        gate.hold("read-2") { refused += it }
        timers.advanceTo(2_999L)
        assertTrue(refused.isEmpty())
        timers.advanceTo(3_000L)
        assertEquals(listOf(listOf("read-1", "read-2")), refused, "both, three seconds after the first")
        // The relaunch still waits for the runtime: a later read is held again, for its own three seconds.
        assertTrue(gate.restoring)
        timers.advanceTo(4_000L)
        assertTrue(gate.hold("read-3") { refused += it })
        timers.advanceTo(6_999L)
        assertEquals(1, refused.size)
        timers.advanceTo(7_000L)
        assertEquals(listOf("read-3"), refused.last())
    }

    @Test
    fun theRelaunchIsHaltedAfterThirtySecondsWithoutTheRuntime() {
        assertEquals(30_000L, IosBleRadio.RESTORE_GRACE_MS)
        val timers = Timers()
        val gate = RestoreGate<String>(timers::schedule)
        var halted = 0
        var refusedAtHalt: List<String>? = null
        // As the radio does: the halt stops the gate and refuses what it held.
        gate.relaunched {
            halted++
            refusedAtHalt = gate.stopped()
        }
        timers.advanceTo(29_000L)
        gate.hold("read-1") { }
        timers.advanceTo(29_999L)
        assertEquals(0, halted)
        timers.advanceTo(30_000L)
        assertEquals(1, halted)
        assertEquals(listOf("read-1"), refusedAtHalt)
        assertFalse(gate.restoring)
        timers.advanceTo(40_000L)
        assertEquals(1, halted, "once")
    }

    @Test
    fun aStopBeforeTheGraceEndsItToo() {
        val timers = Timers()
        val gate = RestoreGate<String>(timers::schedule)
        var halted = 0
        gate.relaunched { halted++ }
        gate.hold("read-1") { error("the stop answered it") }
        assertEquals(listOf("read-1"), gate.stopped())
        timers.advanceTo(60_000L)
        assertEquals(0, halted)
    }

    // ---------------------------------------------------------------------------------------------
    // The prompt's time limit

    @Test
    fun aPromptUnansweredForAMinuteCountsAsRefusedAndLetsGo() = runTest {
        assertEquals(60_000L, IosBleRadio.ACCESS_TIMEOUT_MS)
        var released = false
        val access = awaitAccessDecision(IosBleRadio.ACCESS_TIMEOUT_MS, {
            try {
                awaitCancellation()
            } finally {
                released = true
            }
        }, { BleAccess.NotAsked })
        assertEquals(BleAccess.Denied, access)
        assertTrue(released, "the waiter was cancelled, so the radio forgets it")
        assertEquals(60_000L, currentTime)
    }

    @Test
    fun anAnswerInTimeIsTheAccessAfterIt() = runTest {
        assertEquals(BleAccess.Granted, awaitAccessDecision(60_000L, { delay(5_000L) }, { BleAccess.Granted }))
        assertEquals(5_000L, currentTime)
        assertEquals(BleAccess.Blocked, awaitAccessDecision(60_000L, { }, { BleAccess.Blocked }))
        // Allowed, but the radio never reported its state within the minute: allowed all the same.
        assertEquals(BleAccess.Granted, awaitAccessDecision(60_000L, { awaitCancellation() }, { BleAccess.Granted }))
    }
}
