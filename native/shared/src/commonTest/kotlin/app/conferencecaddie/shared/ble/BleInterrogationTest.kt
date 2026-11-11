package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.ble.BleInterrogation.Kind
import app.conferencecaddie.shared.ble.BleInterrogation.Outcome
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Which scanned devices a radio connects to, and when (BleInterrogation). */
class BleInterrogationTest {
    // 2026-11-10T12:00:00Z, the start of window 2990520, plus a little.
    private val t0 = 1_794_312_000_000L + 1_000L
    private val near = -75

    private fun policy(perMinute: Int = BleInterrogation.MAX_CONNECTIONS_PER_MINUTE) = BleInterrogation(near, perMinute)

    @Test
    fun kindsOfAdvertisements() {
        val overflow = byteArrayOf(0x01, 0x00, 0x00, 0x40)
        val nearbyInfo = byteArrayOf(0x10, 0x05, 0x01)
        assertEquals(Kind.Service, BleInterrogation.kindOf(true, null, null, connectable = true))
        assertEquals(Kind.Service, BleInterrogation.kindOf(true, null, overflow, connectable = true))
        assertEquals(Kind.AppleOverflow, BleInterrogation.kindOf(false, null, overflow, connectable = true))
        assertEquals(Kind.Apple, BleInterrogation.kindOf(false, null, nearbyInfo, connectable = true))
        assertEquals(Kind.Apple, BleInterrogation.kindOf(false, null, ByteArray(0), connectable = true))
        // The payload is in the advertisement: nothing to read.
        assertNull(BleInterrogation.kindOf(true, ByteArray(17), null, connectable = true))
        assertNull(BleInterrogation.kindOf(true, ByteArray(3), overflow, connectable = true))
        // A connection would only time out.
        assertNull(BleInterrogation.kindOf(true, null, overflow, connectable = false))
        // Neither the service nor Apple.
        assertNull(BleInterrogation.kindOf(false, null, null, connectable = true))
    }

    @Test
    fun nothingWaitingMeansNoCandidate() {
        val p = policy()
        assertNull(p.next(t0))
        assertNull(p.nextAttemptAt(t0))
        assertFalse(p.busy)
    }

    @Test
    fun weakerThanNearRssiIsIgnored() {
        val p = policy()
        assertFalse(p.offer("A", -76, Kind.Service, t0))
        assertNull(p.next(t0))
        assertTrue(p.offer("A", -75, Kind.Service, t0))
        assertEquals("A", p.next(t0)?.address)
    }

    @Test
    fun theServiceComesFirstThenTheOverflowAreaThenOtherAppleData() {
        val p = policy()
        p.offer("apple", -40, Kind.Apple, t0)
        p.offer("overflow", -70, Kind.AppleOverflow, t0)
        p.offer("service", -74, Kind.Service, t0)
        val order = mutableListOf<String>()
        repeat(3) {
            val c = p.next(t0 + it)!!
            order += c.address
            p.finished(c.address, Outcome.NotCaddie, t0 + it)
        }
        assertEquals(listOf("service", "overflow", "apple"), order)
    }

    @Test
    fun withinAKindTheStrongerSignalComesFirst() {
        val p = policy()
        p.offer("far", -72, Kind.AppleOverflow, t0)
        p.offer("close", -50, Kind.AppleOverflow, t0)
        p.offer("middle", -60, Kind.AppleOverflow, t0)
        val order = mutableListOf<String>()
        repeat(3) {
            val c = p.next(t0)!!
            order += c.address
            p.finished(c.address, Outcome.NotCaddie, t0)
        }
        assertEquals(listOf("close", "middle", "far"), order)
    }

    @Test
    fun anAddressKeepsItsBestKindAndStrongestRecentSignal() {
        val p = policy()
        p.offer("phone", -70, Kind.Apple, t0)
        p.offer("phone", -60, Kind.AppleOverflow, t0 + 1_000)
        p.offer("phone", -74, Kind.Apple, t0 + 2_000)
        p.offer("other", -65, Kind.AppleOverflow, t0 + 2_000)
        val c = p.next(t0 + 2_000)!!
        assertEquals("phone", c.address)
        assertEquals(Kind.AppleOverflow, c.kind)
        assertEquals(-60, c.rssi)
    }

    @Test
    fun oneConnectionAtATime() {
        val p = policy()
        p.offer("A", -50, Kind.Service, t0)
        p.offer("B", -50, Kind.Service, t0)
        val first = p.next(t0)!!
        assertTrue(p.busy)
        assertNull(p.next(t0 + 100))
        assertNull(p.nextAttemptAt(t0 + 100))
        // The device in flight is not queued again by its own advertisements.
        assertFalse(p.offer(first.address, -50, Kind.Service, t0 + 200))
        p.finished(first.address, Outcome.Read, t0 + 1_000)
        assertFalse(p.busy)
        assertEquals("B", p.next(t0 + 1_000)?.address)
    }

    @Test
    fun aReadOrANegativeIsCachedForTheRestOfTheWindow() {
        val p = policy()
        p.offer("iphone", -50, Kind.AppleOverflow, t0)
        p.offer("airpods", -50, Kind.Apple, t0)
        p.finished(p.next(t0)!!.address, Outcome.Read, t0 + 1_000)
        p.finished(p.next(t0 + 1_000)!!.address, Outcome.NotCaddie, t0 + 2_000)
        // Heard again later in the same window: neither is read again.
        val late = BleProtocol.windowStartMillis(2990521L) - 1
        assertFalse(p.offer("iphone", -40, Kind.AppleOverflow, late))
        assertFalse(p.offer("airpods", -40, Kind.Apple, late))
        assertNull(p.next(late))
        // The next window: every token has changed, so both are worth a read again.
        val next = BleProtocol.windowStartMillis(2990521L)
        assertTrue(p.offer("iphone", -40, Kind.AppleOverflow, next))
        assertTrue(p.offer("airpods", -40, Kind.Apple, next))
        assertEquals("iphone", p.next(next)?.address)
    }

    @Test
    fun aFailureIsRetriedOnceAfterAMinuteThenLeftForTheWindow() {
        val p = policy()
        p.offer("A", -50, Kind.Service, t0)
        p.finished(p.next(t0)!!.address, Outcome.Failed, t0 + 5_000)
        // Still advertising, but not before the retry time.
        assertTrue(p.offer("A", -50, Kind.Service, t0 + 10_000))
        assertNull(p.next(t0 + 10_000))
        assertNull(p.nextAttemptAt(t0 + 10_000), "the offer expires before the retry time")
        assertTrue(p.offer("A", -50, Kind.Service, t0 + 60_000))
        assertEquals(t0 + 65_000, p.nextAttemptAt(t0 + 60_000))
        assertNull(p.next(t0 + 64_999))
        val retry = p.next(t0 + 65_000)!!
        assertEquals("A", retry.address)
        p.finished("A", Outcome.Failed, t0 + 70_000)
        // Two failures: nothing more in this window.
        assertFalse(p.offer("A", -50, Kind.Service, t0 + 200_000))
        assertNull(p.next(t0 + 200_000))
    }

    @Test
    fun connectionsAreCappedPerMinute() {
        val p = policy(perMinute = 3)
        for (i in 0 until 5) p.offer("D$i", -50 - i, Kind.Apple, t0)
        for (i in 0 until 3) {
            val c = p.next(t0 + i * 1_000L)!!
            assertEquals("D$i", c.address)
            p.finished(c.address, Outcome.NotCaddie, t0 + i * 1_000L + 500)
        }
        // Three started within the minute: the fourth waits until the first is a minute old.
        for (i in 3 until 5) p.offer("D$i", -50 - i, Kind.Apple, t0 + 50_000)
        assertNull(p.next(t0 + 50_000))
        assertEquals(t0 + 60_000, p.nextAttemptAt(t0 + 50_000))
        assertNull(p.next(t0 + 59_999))
        assertEquals("D3", p.next(t0 + 60_000)?.address)
    }

    @Test
    fun theDefaultCapIsSixAMinute() {
        val p = policy()
        for (i in 0 until 10) p.offer("D$i", -50, Kind.Apple, t0)
        var started = 0
        while (true) {
            val c = p.next(t0 + started) ?: break
            p.finished(c.address, Outcome.NotCaddie, t0 + started)
            started++
        }
        assertEquals(6, started)
    }

    @Test
    fun aCandidateNotHeardForFifteenSecondsIsDropped() {
        val p = policy()
        p.offer("gone", -50, Kind.Service, t0)
        p.offer("here", -70, Kind.Apple, t0)
        p.offer("here", -70, Kind.Apple, t0 + 14_000)
        assertEquals("here", p.next(t0 + 16_000)?.address)
        p.finished("here", Outcome.NotCaddie, t0 + 16_500)
        assertNull(p.next(t0 + 17_000))
    }

    @Test
    fun aConnectionNeverReportedBackIsLetGo() {
        val p = policy()
        p.offer("stuck", -50, Kind.Service, t0)
        p.offer("next", -50, Kind.Apple, t0)
        assertEquals("stuck", p.next(t0)?.address)
        p.offer("next", -50, Kind.Apple, t0 + 10_000)
        assertNull(p.next(t0 + 10_000))
        p.offer("next", -50, Kind.Apple, t0 + 15_000)
        assertEquals("next", p.next(t0 + 15_000)?.address)
    }

    @Test
    fun resetForgetsEverything() {
        val p = policy(perMinute = 1)
        p.offer("A", -50, Kind.Service, t0)
        p.finished(p.next(t0)!!.address, Outcome.Read, t0)
        p.offer("B", -50, Kind.Service, t0)
        assertNull(p.next(t0), "capped")
        p.reset()
        assertTrue(p.offer("A", -50, Kind.Service, t0 + 1))
        assertEquals("A", p.next(t0 + 1)?.address)
    }

    @Test
    fun theNumberOfWaitingAddressesIsBounded() {
        val p = policy()
        for (i in 0 until BleInterrogation.MAX_PENDING) assertTrue(p.offer("D$i", -50, Kind.Apple, t0))
        assertFalse(p.offer("one-too-many", -50, Kind.Apple, t0 + 1_000))
        // Once the earlier ones expire there is room again.
        assertTrue(p.offer("later", -50, Kind.Apple, t0 + 16_000))
        assertEquals("later", p.next(t0 + 16_000)?.address)
    }
}
