package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.PeopleNotice
import app.conferencecaddie.shared.people.PositionOutcome
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
// Bluetooth ones included, unless the backend offers `people.presence_keep_until` and the write says
// `until: "keep"`. The device follows the until the server names, so the switch, the expiry and
// the radio never end before the server's presence does: a person must not stay visible, or their
// tokens resolvable, after the phone says presence ended. A toast says so when the end moved.
//
// With `people.presence_keep_until` every write of presence that is already on (Bluetooth on or
// off, a re-key, a position, the position off) says `keep`; only the person turning presence on,
// extending it or answering "Still in {zone}?" asks for the hour or the day. A `keep` refused with
// 400 presence_not_active means presence is not live on the server: it ends on the device too.
class BlePresenceUntilTest {
    private val minute = 60_000L

    /** BLE_ON on a backend that keeps presence_until on `until: "keep"`. */
    private val keepCaps = BLE_ON.copy(people = BLE_ON.people.copy(presenceKeepUntil = true))

    private val notActive =
        """{"error":"presence_not_active","message":"until: 'keep' needs presence that is on; turn it on with 'hour' or 'day'."}"""

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
        // Turning presence on (again) still asks for its mode: the person chooses the end there.
        b.h.http.sent.clear()
        b.controller.turnOnPresence("Hallway", "Green jacket", PresenceMode.Day)
        runCurrent()
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","until":"day"}""", b.presencePuts().single().body)
    }

    @Test
    fun withoutKeepUntilABluetoothWriteAsksForTheModeAsBefore() = runTest {
        val b = BleRig(this)
        b.ready(BLE_ON)
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

    /** Answers every `until: "keep"` write as a server whose presence has ended: 400 presence_not_active. */
    private fun BleRig.serverEndedPresence() {
        val put = h.server.presencePut
        h.server.presencePut = { r ->
            if ((r.jsonObject["until"] as? JsonPrimitive)?.content == "keep") FakeApiHttp.json(400, notActive) else put(r)
        }
    }

    private fun BleRig.body(rest: String) = """{"event":"$slug","zone":"Hallway","spot":"Green jacket"$rest}"""

    // A re-key, as a sightings answer naming another key id asks for one.
    private fun BleRig.reKey() {
        h.server.sightings = { answer(keyId = "AAAAAAAAAAAAAAAAAAAAAA") }
        radio.hear(otherPayload(1), -60, now())
    }

    private val fix = GeoFix(40.767891, -111.890123, 14.6, 0)
    private val located = ""","location":{"lat":40.767891,"lon":-111.890123,"accuracy":15}"""

    @Test
    fun onABackendThatKeepsTheUntilAReKeyAPositionAndThePositionOffSayKeep() = runTest {
        val b = BleRig(this)
        b.serverKeeps()
        b.on(keepCaps)
        val until = b.presenceUntil()!!
        advanceTimeBy(20 * minute)

        b.reKey()
        runCurrent()
        assertEquals(b.body(""","until":"keep","ble":true"""), b.presencePuts().single().body)
        assertEquals(2, b.h.server.bleKeys.size, "the re-key took a new key")
        b.h.server.sightings = { b.answer() }

        b.h.http.sent.clear()
        b.h.location.accessNow = LocationAccess.Precise
        assertEquals(PositionOutcome.On, b.controller.sharePosition(true))
        runCurrent()
        b.h.location.flow.emit(fix)
        runCurrent()
        assertEquals(b.body("""$located,"until":"keep""""), b.presencePuts().single().body)

        b.h.http.sent.clear()
        assertEquals(PositionOutcome.Off, b.controller.sharePosition(false))
        runCurrent()
        assertEquals(b.body(""","until":"keep""""), b.presencePuts().single().body)

        // The end never moved: not on the device, not for the radio, and nothing to say.
        assertEquals(until, b.presenceUntil())
        assertEquals(until, b.radio.starts.last().untilEpochMillis)
        assertTrue(b.radio.running)
        assertNull(b.h.state.notice)
    }

    @Test
    fun onABackendThatKeepsTheUntilTurningOnExtendingAndConfirmingTheZoneAskForTheMode() = runTest {
        val b = BleRig(this)
        b.h.start(keepCaps)
        b.h.visible()
        assertNull(b.controller.turnOnPresence("Hallway", "Green jacket"))
        assertNull(b.controller.confirmZone("Hall B"))
        assertNull(b.controller.extendPresence())
        assertNull(b.controller.turnOnPresence("Hall B", "Green jacket", PresenceMode.Day))
        assertNull(b.controller.confirmZone("Hallway"))
        assertNull(b.controller.extendPresence())
        runCurrent()
        val hallB = """{"event":"${b.slug}","zone":"Hall B","spot":"Green jacket""""
        assertEquals(
            listOf(b.body(""), "$hallB}", "$hallB}", """$hallB,"until":"day"}""", b.body(""","until":"day""""), b.body(""","until":"day"""")),
            b.presencePuts().map { it.body },
        )
        // `keep` is for the wire only: the person picks an hour or the day.
        assertEquals(listOf(PresenceMode.Hour, PresenceMode.Day), PresenceMode.entries)
    }

    @Test
    fun withoutKeepUntilAReKeyAPositionAndThePositionOffAskForTheModeAsBefore() = runTest {
        for (mode in PresenceMode.entries) {
            val b = BleRig(this)
            b.on(BLE_ON, mode = mode)
            val until = if (mode == PresenceMode.Day) ",\"until\":\"day\"" else ""
            advanceTimeBy(20 * minute)

            b.reKey()
            runCurrent()
            assertEquals(b.body("$until,\"ble\":true"), b.presencePuts().single().body, "$mode")
            b.h.server.sightings = { b.answer() }

            b.h.http.sent.clear()
            b.h.location.accessNow = LocationAccess.Precise
            assertEquals(PositionOutcome.On, b.controller.sharePosition(true))
            runCurrent()
            b.h.location.flow.emit(fix)
            runCurrent()
            assertEquals(b.body("$located$until"), b.presencePuts().single().body, "$mode")

            b.h.http.sent.clear()
            assertEquals(PositionOutcome.Off, b.controller.sharePosition(false))
            runCurrent()
            assertEquals(b.body(until), b.presencePuts().single().body, "$mode")
        }
    }

    @Test
    fun aReKeyRefusedAsPresenceNotActiveEndsPresenceAndStopsTheRadioWithNoRequest() = runTest {
        val b = BleRig(this)
        b.serverKeeps()
        b.on(keepCaps)
        advanceTimeBy(20 * minute)
        b.serverEndedPresence()

        b.reKey()
        runCurrent()
        assertEquals(b.body(""","until":"keep","ble":true"""), b.presencePuts().single().body)
        assertFalse(b.h.state.presence.on, "off on the device, as on the server")
        assertNull(b.presenceUntil())
        assertFalse(b.radio.running, "the radio stopped")
        assertFalse(b.view.on)
        assertTrue(b.keys.aliases.isEmpty(), "and its key is gone")
        assertNull(b.h.state.notice, "no toast, as when presence ends at its until")

        // Nothing is live on the server, so no delete follows, and no other write: the expiry went
        // with presence.
        advanceTimeBy(60 * minute)
        runCurrent()
        assertEquals(1, b.presencePuts().size)
        assertTrue(b.h.sent("DELETE", "/api/presence").isEmpty())

        // Turning presence on again is a fresh start with the hour.
        assertNull(b.controller.turnOnPresence("Hallway", "Green jacket"))
        runCurrent()
        assertEquals(b.body(""), b.presencePuts().last().body)
        assertTrue(b.h.state.presence.on)
    }

    @Test
    fun aPositionRefusedAsPresenceNotActiveEndsPresenceAndStopsTheWatchAndTheRadio() = runTest {
        val b = BleRig(this)
        b.serverKeeps()
        b.on(keepCaps)
        b.h.location.accessNow = LocationAccess.Precise
        assertEquals(PositionOutcome.On, b.controller.sharePosition(true))
        runCurrent()
        b.serverEndedPresence()

        b.h.location.flow.emit(fix)
        runCurrent()
        assertEquals(b.body("""$located,"until":"keep""""), b.presencePuts().single().body)
        assertFalse(b.h.state.presence.on)
        assertFalse(b.h.state.presence.position)
        assertFalse(b.radio.running)
        assertFalse(b.view.on)
        assertNull(b.h.state.notice)

        // The watch stopped with presence: a later fix sends nothing, and nothing else is sent.
        b.h.location.flow.emit(GeoFix(40.7679, -111.8902, 10.0, 0))
        advanceTimeBy(2 * minute)
        runCurrent()
        assertEquals(1, b.presencePuts().size)
        assertTrue(b.h.sent("DELETE", "/api/presence").isEmpty())
    }

    @Test
    fun bluetoothTurnedOnOrOffAgainstPresenceNotActiveEndsPresence() = runTest {
        val b = BleRig(this)
        b.ready(keepCaps)
        b.serverEndedPresence()
        val outcome = b.controller.turnOnBluetooth()
        runCurrent()
        assertEquals(BleProblem.NeedsPresence, (outcome as BleOutcome.Problem).problem, "the switch says presence is needed")
        assertEquals(b.body(""","until":"keep","ble":true"""), b.presencePuts().single().body)
        assertFalse(b.h.state.presence.on)
        assertTrue(b.radio.starts.isEmpty())
        assertTrue(b.keys.aliases.isEmpty())
        assertNull(b.h.state.notice)
        assertTrue(b.h.sent("DELETE", "/api/presence").isEmpty())

        // Off: the radio stops at once, then the `ble: false` write finds presence gone.
        val c = BleRig(this)
        c.serverKeeps()
        c.on(keepCaps)
        c.serverEndedPresence()
        c.controller.turnOffBluetooth()
        runCurrent()
        assertEquals(c.body(""","until":"keep","ble":false"""), c.presencePuts().single().body)
        assertFalse(c.h.state.presence.on)
        assertFalse(c.radio.running)
        assertNull(c.h.state.notice)
        assertTrue(c.h.sent("DELETE", "/api/presence").isEmpty())
    }

    @Test
    fun aTurnOnQueuedBehindARefusedKeepWriteStillTurnsPresenceOn() = runTest {
        // The person moved zones while a `keep` write that the server will refuse was under way:
        // the turn-on comes after it on the server and starts presence again, so the device must
        // record it rather than stay off while the server shows the person.
        val b = BleRig(this)
        b.serverKeeps()
        b.on(keepCaps)
        val gate = CompletableDeferred<Unit>()
        val put = b.h.server.presencePut
        b.h.server.presencePut = { r ->
            if ((r.jsonObject["until"] as? JsonPrimitive)?.content == "keep") {
                gate.await()
                FakeApiHttp.json(400, notActive)
            } else {
                put(r)
            }
        }
        val off = async { b.controller.turnOffBluetooth() }
        runCurrent()
        assertEquals(1, b.presencePuts().size, "the keep write is under way")
        val on = async { b.controller.turnOnPresence("Hall B", "Green jacket") }
        runCurrent()
        gate.complete(Unit)
        runCurrent()
        off.await()
        assertNull(on.await())
        assertEquals(
            listOf(b.body(""","until":"keep","ble":false"""), """{"event":"${b.slug}","zone":"Hall B","spot":"Green jacket"}"""),
            b.presencePuts().map { it.body },
        )
        assertTrue(b.h.state.presence.on, "the turn-on asked for after the refused write has the last word")
        assertEquals("Hall B", b.h.state.presence.zone)
        assertTrue(b.h.sent("DELETE", "/api/presence").isEmpty())
    }
}
