package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.people.BleOutcome
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

// Every presence write restarts presence's hour on the server (server/connect.mjs putPresence), the
// Bluetooth ones included, and none can ask it to keep the old presence_until. The device follows
// the until the server names, so the switch, the expiry and the radio never end before the
// server's presence does: a person must not stay visible, or their tokens resolvable, after the
// phone says presence ended.
class BlePresenceUntilTest {
    private val minute = 60_000L

    @Test
    fun turningItOnLateInTheHourTakesTheUntilTheServerNowHolds() = runTest {
        val b = BleRig(this)
        val server = b.serverUntils()
        b.ready()
        val t0 = b.now()
        assertEquals(t0 + 60 * minute, b.presenceUntil())

        advanceTimeBy(50 * minute)
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        runCurrent()
        assertEquals(t0 + 110 * minute, server.last(), "the ble: true write restarted the hour on the server")
        assertEquals(server.last(), b.presenceUntil(), "the phone's until is the server's")
        assertEquals(server.last(), b.radio.starts.last().untilEpochMillis, "and so is the radio's deadline")

        // Past the first hour presence and Bluetooth still run, as they do on the server.
        advanceTimeBy(15 * minute)
        runCurrent()
        assertTrue(b.h.state.presence.on)
        assertTrue(b.radio.running)
        // At the server's until both end, and the device deletes presence itself.
        advanceTimeBy(45 * minute)
        runCurrent()
        assertFalse(b.h.state.presence.on)
        assertFalse(b.radio.running)
        assertEquals(1, b.h.sent("DELETE", "/api/presence").size)
    }

    @Test
    fun turningItOffLateInTheHourTakesTheUntilTheServerNowHolds() = runTest {
        val b = BleRig(this)
        val server = b.serverUntils()
        b.on()
        val t0 = b.now()
        assertEquals(t0 + 60 * minute, b.presenceUntil())

        advanceTimeBy(50 * minute)
        b.controller.turnOffBluetooth()
        runCurrent()
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}""", b.presencePuts().single().body)
        assertEquals(t0 + 110 * minute, server.last(), "the ble: false write restarted the hour on the server too")
        assertEquals(server.last(), b.presenceUntil(), "the phone's until is the server's")
        assertFalse(b.radio.running)

        advanceTimeBy(15 * minute)
        runCurrent()
        assertTrue(b.h.state.presence.on, "presence runs on, as on the server")
        advanceTimeBy(45 * minute)
        runCurrent()
        assertFalse(b.h.state.presence.on)
        assertEquals(1, b.h.sent("DELETE", "/api/presence").size)
    }

    @Test
    fun aReKeyMovesTheRadiosDeadlineWithTheServersUntil() = runTest {
        val b = BleRig(this)
        val server = b.serverUntils()
        b.on()
        advanceTimeBy(20 * minute)
        // A sightings answer with another key id: the phone re-keys with a ble: true write.
        b.h.server.sightings = { b.answer(keyId = "AAAAAAAAAAAAAAAAAAAAAA") }
        b.radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertTrue(b.presencePuts().single().body!!.contains("\"ble\":true"))
        assertEquals(server.last(), b.presenceUntil())
        assertEquals(server.last(), b.radio.starts.last().untilEpochMillis)
        assertTrue(b.radio.running)
    }

    @Test
    fun aBluetoothWriteAnsweredAfterPresenceWentOffLeavesItOff() = runTest {
        val b = BleRig(this)
        b.ready()
        val gate = CompletableDeferred<Unit>()
        val put = b.h.server.presencePut
        b.h.server.presencePut = { r ->
            gate.await()
            put(r)
        }
        val outcome = async { b.controller.turnOnBluetooth() }
        runCurrent()
        assertEquals(1, b.presencePuts().size, "the ble: true write is under way")
        // The delete waits in the presence write queue behind the write under way.
        val off = async { b.controller.turnOffPresence() }
        runCurrent()
        assertFalse(b.h.state.presence.on, "off on the device at once")
        gate.complete(Unit)
        runCurrent()
        off.await()
        assertTrue(outcome.await() is BleOutcome.Problem)
        assertFalse(b.h.state.presence.on, "the answer does not bring presence back")
        assertNull(b.presenceUntil())
        assertFalse(b.radio.running)
        assertEquals(1, b.h.sent("DELETE", "/api/presence").size)
    }
}
