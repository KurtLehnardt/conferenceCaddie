package app.conferencecaddie.shared.ble

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Which phones the iOS radio connects to and when: once per window, one at a time, a cap per minute. */
class GattReadsTest {
    // Ten seconds into window 2990520 (2026-11-10T12:00:10Z).
    private val t0 = BleProtocol.windowStartMillis(2990520) + 10_000L

    private fun candidate(id: String, at: Long = t0, rssi: Int = -60) = GattReads.Candidate(id, "peripheral $id", rssi, at)

    private fun GattReads<String>.started(now: Long): String = assertIs<GattReads.Next.Start<String>>(next(now)).candidate.id

    @Test
    fun aPhoneIsReadOncePerWindow() {
        val reads = GattReads<String>()
        assertTrue(reads.offer(candidate("a")))
        assertEquals("a", reads.started(t0))
        reads.finish()
        assertFalse(reads.offer(candidate("a", at = t0 + 1_000)))
        assertSame(GattReads.Next.Idle, reads.next(t0 + 1_000))
        assertTrue(reads.wasRead("a"))
        // The next window's token is another one, so the phone is read again.
        val nextWindow = BleProtocol.windowStartMillis(2990521) + 1_000
        assertTrue(reads.offer(candidate("a", at = nextWindow)))
        assertEquals("a", reads.started(nextWindow))
    }

    @Test
    fun refreshForgetsTheWindowsReads() {
        val reads = GattReads<String>()
        reads.offer(candidate("a"))
        reads.started(t0)
        reads.finish()
        reads.resetWindow()
        assertTrue(reads.offer(candidate("a", at = t0 + 1_000)))
    }

    @Test
    fun aPhoneBeingReadOrReadInTheWindowIsNotServedThisPhonesToken() {
        val reads = GattReads<String>()
        assertTrue(reads.mayServe("a", t0), "a stranger is served")
        reads.offer(candidate("a"))
        assertTrue(reads.mayServe("a", t0), "only waiting: no connection yet")
        assertEquals("a", reads.started(t0))
        // Connected to it: it could read this phone's Bluetooth name over that connection.
        assertFalse(reads.mayServe("a", t0 + 1_000), "while it is read")
        reads.finish()
        assertFalse(reads.mayServe("a", t0 + 2_000), "after the read, in the same window")
        reads.resetWindow()
        assertFalse(reads.mayServe("a", t0 + 3_000), "a refresh (a re-key) does not make it a stranger")
        reads.clear()
        assertFalse(reads.mayServe("a", t0 + 4_000), "nor does stopping the radio")
        assertTrue(reads.mayServe("b", t0 + 4_000), "another phone is served")
        // The next window: a phone not connected to in it is served again.
        val nextWindow = BleProtocol.windowStartMillis(2990521) + 1_000
        assertTrue(reads.mayServe("a", nextWindow))
    }

    @Test
    fun oneReadAtATime() {
        val reads = GattReads<String>()
        reads.offer(candidate("a"))
        reads.offer(candidate("b"))
        assertEquals("a", reads.started(t0))
        assertSame(GattReads.Next.Idle, reads.next(t0 + 100))
        // The phone being read is not queued again.
        assertFalse(reads.offer(candidate("a", at = t0 + 200)))
        assertEquals("a", reads.finish()?.id)
        assertEquals("b", reads.started(t0 + 300))
    }

    @Test
    fun connectionsPerMinuteAreCapped() {
        val reads = GattReads<String>(maxPerMinute = 3)
        for (i in 0 until 5) reads.offer(candidate("p$i", at = t0 + i))
        for (i in 0 until 3) {
            assertEquals("p$i", reads.started(t0 + 10L * i))
            reads.finish()
        }
        val wait = assertIs<GattReads.Next.WaitUntil>(reads.next(t0 + 100))
        assertEquals(t0 + 60_000L, wait.epochMillis)
        // A minute after the first connection started, one more may start.
        val later = t0 + 60_000L
        reads.offer(candidate("p3", at = later))
        reads.offer(candidate("p4", at = later))
        assertEquals("p3", reads.started(later))
    }

    @Test
    fun theQueueIsShortAndKeepsTheNewest() {
        val reads = GattReads<String>(maxPending = 2)
        reads.offer(candidate("a"))
        reads.offer(candidate("b"))
        reads.offer(candidate("c"))
        assertEquals(listOf("b", "c"), reads.pendingIds)
        // Heard again while waiting: updated in place, not queued twice.
        assertFalse(reads.offer(candidate("b", at = t0 + 5, rssi = -40)))
        assertEquals(listOf("b", "c"), reads.pendingIds)
        assertEquals(-40, assertIs<GattReads.Next.Start<String>>(reads.next(t0 + 6)).candidate.rssi)
    }

    @Test
    fun aPhoneThatWaitedTooLongIsDropped() {
        val reads = GattReads<String>()
        reads.offer(candidate("a"))
        assertSame(GattReads.Next.Idle, reads.next(t0 + GattReads.PENDING_MAX_AGE_MS + 1))
        assertFalse(reads.wasRead("a"))
    }

    @Test
    fun clearDropsTheQueueButKeepsTheWindowAndTheCap() {
        val reads = GattReads<String>(maxPerMinute = 1)
        reads.offer(candidate("a"))
        reads.offer(candidate("b"))
        reads.started(t0)
        assertEquals(listOf("peripheral a", "peripheral b"), reads.peripherals())
        assertEquals("a", reads.clear()?.id)
        assertNull(reads.current)
        assertEquals(emptyList(), reads.pendingIds)
        assertFalse(reads.offer(candidate("a", at = t0 + 10)))
        reads.offer(candidate("c", at = t0 + 10))
        assertIs<GattReads.Next.WaitUntil>(reads.next(t0 + 20))
    }
}
