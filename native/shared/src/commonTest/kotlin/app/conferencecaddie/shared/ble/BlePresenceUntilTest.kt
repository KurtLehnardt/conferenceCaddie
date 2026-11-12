package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.PeopleNotice
import app.conferencecaddie.shared.people.PresenceMode
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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Every presence write restarts presence's hour on the server (server/connect.mjs putPresence), the
// Bluetooth ones included, unless the backend offers `presence.keep_until` and the write says
// `until: "keep"`. The device follows the until the server names, so the switch, the expiry and
// the radio never end before the server's presence does: a person must not stay visible, or their
// tokens resolvable, after the phone says presence ended. A toast says so when the end moved.
class BlePresenceUntilTest {
    private val minute = 60_000L

    /** BLE_ON on a backend that keeps presence_until on `until: "keep"`. */
    private val keepCaps = BLE_ON.copy(presence = Capabilities.Presence(keepUntil = true))

    /** Answers `until: "keep"` as the server would: presence_until stays the one it holds. */
    private fun BleRig.serverKeeps() {
        var held: String? = null
        val put = h.server.presencePut
        h.server.presencePut = { r ->
            val res = put(r)
            val keep = (r.jsonObject["until"] as? JsonPrimitive)?.content == "keep"
            val answer = Json.parseToJsonElement(res.text()).jsonObject
            val until = answer["presence_until"]!!.jsonPrimitive.content
            if (keep && held != null) {
                // The answer names the until it kept, and echoes `keep`, which reads as no mode.
                FakeApiHttp.json(200, res.text().replace(until, held!!).replace("\"until\":\"hour\"", "\"until\":\"keep\""))
            } else {
                held = until
                res
            }
        }
    }

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
        // The person is told that being around now runs longer (17:00 + 110 minutes, in UTC here).
        assertEquals(PeopleNotice("Being around now runs until 6:50 PM.", opensProfile = false), b.h.state.notice)

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
        assertEquals("Being around now runs until 6:50 PM.", b.h.state.notice?.message)

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

    @Test
    fun aBluetoothWriteThatLeavesTheEndWhereItWasSaysNothing() = runTest {
        // Turned on in the same minute as presence: the end does not move to another minute.
        val b = BleRig(this)
        b.ready()
        advanceTimeBy(20_000)
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        runCurrent()
        assertNull(b.h.state.notice)
    }

    @Test
    fun onABackendThatKeepsTheUntilABluetoothWriteSaysKeep() = runTest {
        val b = BleRig(this)
        b.serverKeeps()
        b.ready(keepCaps)
        val t0 = b.now()
        advanceTimeBy(50 * minute)
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        runCurrent()
        assertEquals(
            """{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","until":"keep","ble":true}""",
            b.presencePuts().single().body,
        )
        assertEquals(t0 + 60 * minute, b.presenceUntil(), "the end stays where the person put it")
        assertEquals(t0 + 60 * minute, b.radio.starts.last().untilEpochMillis)
        assertNull(b.h.state.notice, "nothing moved, nothing to say")

        // Off again: kept as well.
        advanceTimeBy(5 * minute)
        b.h.http.sent.clear()
        b.controller.turnOffBluetooth()
        runCurrent()
        assertEquals(
            """{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","until":"keep","ble":false}""",
            b.presencePuts().single().body,
        )
        assertEquals(t0 + 60 * minute, b.presenceUntil())
        // A presence write of its own still asks for its mode: only Bluetooth writes keep the end.
        b.h.http.sent.clear()
        b.controller.turnOnPresence("Hallway", "Green jacket", PresenceMode.Day)
        runCurrent()
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","until":"day"}""", b.presencePuts().single().body)
    }

    @Test
    fun withoutKeepUntilABluetoothWriteAsksForTheModeAsBefore() = runTest {
        val b = BleRig(this)
        b.ready(BLE_ON.copy(presence = Capabilities.Presence(keepUntil = false)))
        b.controller.turnOnBluetooth()
        runCurrent()
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":true}""", b.presencePuts().single().body)
        // Day mode sends its mode, as any presence write.
        val d = BleRig(this)
        d.ready(mode = PresenceMode.Day)
        d.controller.turnOnBluetooth()
        runCurrent()
        assertEquals("""{"event":"${d.slug}","zone":"Hallway","spot":"Green jacket","until":"day","ble":true}""", d.presencePuts().single().body)
    }
}
