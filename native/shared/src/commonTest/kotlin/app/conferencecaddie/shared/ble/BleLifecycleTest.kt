package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.PEOPLE_ON
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleText
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

// Bluetooth following presence, deletes, backend switches, the radio stopping by itself, and the
// restore after a restart.
class BleLifecycleTest {
    private fun BleRig.assertStoppedLocally() {
        assertFalse(radio.running)
        assertTrue(keys.aliases.isEmpty(), "the key is gone")
        assertFalse(view.on)
        assertTrue(h.sent("PUT", "/api/presence").none { it.body!!.contains("\"ble\"") }, "no ble write: the server's session ended with presence")
    }

    @Test
    fun presenceTurnedOffStopsItOnTheDeviceOnly() = runTest {
        val b = BleRig(this)
        b.on()
        b.controller.turnOffPresence()
        runCurrent()
        b.assertStoppedLocally()
        assertEquals(1, b.h.sent("DELETE", "/api/presence").size)
        assertTrue(b.presencePuts().isEmpty())
    }

    @Test
    fun presenceRunningOutStopsIt() = runTest {
        val b = BleRig(this)
        b.on()
        advanceTimeBy(3_600_000)
        runCurrent()
        assertFalse(b.h.state.presence.on)
        b.assertStoppedLocally()
    }

    @Test
    fun visibilityOffEndsPresenceOnTheServerAndStopsIt() = runTest {
        val b = BleRig(this)
        b.on()
        assertNull(b.controller.setOpenToMeet(false))
        runCurrent()
        b.assertStoppedLocally()
        assertTrue(b.presencePuts().isEmpty())
    }

    @Test
    fun extendingOrMovingKeepsTheKeyAndRestartsTheRadioWithTheNewUntil() = runTest {
        val b = BleRig(this)
        b.on()
        val keyId = b.keys.hmac(b.alias, BleProtocol.keyIdMessage())!!
        advanceTimeBy(10 * 60_000L)
        assertNull(b.controller.extendPresence())
        val extended = Instant.parse(b.h.state.presence.until!!).toEpochMilliseconds()
        assertEquals(2, b.radio.starts.size)
        assertEquals(extended, b.radio.starts.last().untilEpochMillis)
        advanceTimeBy(60_000L)
        assertNull(b.controller.turnOnPresence("Expo hall", "Green jacket"))
        assertEquals(3, b.radio.starts.size)
        assertEquals(Instant.parse(b.h.state.presence.until!!).toEpochMilliseconds(), b.radio.starts.last().untilEpochMillis)
        assertEquals(listOf(
            """{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket"}""",
            """{"event":"${b.slug}","zone":"Expo hall","spot":"Green jacket"}""",
        ), b.presencePuts().map { it.body }, "writes without ble leave Bluetooth as it is")
        assertContentEquals(keyId, b.keys.hmac(b.alias, BleProtocol.keyIdMessage()))
        assertTrue(b.view.on)
        // The extended hour holds past the first one.
        advanceTimeBy(52 * 60_000L)
        runCurrent()
        assertTrue(b.radio.running)
    }

    @Test
    fun inTheBackgroundHourModePresenceStaysWhileBluetoothRunsAndEndsAfterItStops() = runTest {
        val b = BleRig(this)
        b.on()
        b.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(10 * 60_000L)
        runCurrent()
        assertTrue(b.h.state.presence.on, "the phone is meant to be in a pocket")
        assertTrue(b.radio.running)
        b.controller.setForeground(true)
        runCurrent()
        assertTrue(b.h.state.presence.on, "coming back after ten minutes away does not end it either")

        b.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(60_000L)
        // Stop in the ongoing notification, with the app in the background.
        b.radio.stopBySelf(BleStopReason.User)
        runCurrent()
        assertFalse(b.view.on)
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}""", b.presencePuts().single().body)
        advanceTimeBy(5 * 60_000L - 1_000)
        runCurrent()
        assertTrue(b.h.state.presence.on)
        advanceTimeBy(2_000)
        runCurrent()
        assertFalse(b.h.state.presence.on, "five minutes after Bluetooth stopped, the hour mode ends as usual")
    }

    @Test
    fun inTheBackgroundPresenceStillEndsAtItsUntil() = runTest {
        val b = BleRig(this)
        b.on()
        b.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(3_600_000)
        runCurrent()
        assertFalse(b.h.state.presence.on)
        b.assertStoppedLocally()
    }

    @Test
    fun deleteMyProfileStopsItAndRemovesTheKeysOfEveryConference() = runTest {
        val b = BleRig(this)
        b.on()
        // A key left behind at another conference with a record on this device.
        val other = b.h.context(BLE_ON).copy(conference = ConferenceInfo("other-conf-2099", "Other"), bundle = null)
        b.controller.updateContext(other)
        assertNull(b.controller.setOpenToMeet(true))
        b.controller.updateContext(b.h.context(BLE_ON))
        val otherAlias = BleProtocol.keyAlias(app.conferencecaddie.shared.people.BACKEND.base, "other-conf-2099")
        b.keys.inner.put(otherAlias, ByteArray(32) { 9 })
        b.h.http.sent.clear()
        assertTrue(b.controller.deleteMyProfile().done)
        runCurrent()
        b.assertStoppedLocally()
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(b.view.noticeSeen, "the device's people data went")
    }

    @Test
    fun aBackendSwitchStopsItWithoutARequest() = runTest {
        val b = BleRig(this)
        b.on()
        val elsewhere = BackendUrl.normalise("https://other.example") as BackendUrl.Valid
        b.controller.updateContext(b.h.context(BLE_ON).copy(backend = elsewhere))
        runCurrent()
        assertFalse(b.radio.running)
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.h.http.sent.none { it.url.startsWith("https://caddie.example/api/presence") })
        // Back on the first backend, the record says off.
        b.controller.updateContext(b.h.context(BLE_ON))
        runCurrent()
        assertFalse(b.view.on)
        assertEquals(1, b.radio.starts.size)
    }

    @Test
    fun capabilitiesThatNoLongerOfferBluetoothTurnItOffAndTellTheServer() = runTest {
        val withdrawn = listOf(
            PEOPLE_ON.copy(ble = Capabilities.Ble(mode = Capabilities.BleMode.ServerRotate)),
            BLE_ON.copy(people = BLE_ON.people.copy(presence = false)),
        )
        for (caps in withdrawn) {
            val b = BleRig(this)
            b.on()
            b.controller.updateContext(b.h.context(caps))
            runCurrent()
            assertFalse(b.radio.running, "the switch is gone, so the radio stops here")
            assertTrue(b.keys.aliases.isEmpty())
            assertFalse(b.view.available)
            assertFalse(b.view.on)
            assertEquals(listOf("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}"""), b.presencePuts().map { it.body })
            // Offered again: it is off, and turns on as before.
            b.controller.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertTrue(b.view.available)
            assertFalse(b.view.on)
            assertEquals(1, b.radio.starts.size)
        }
        // Capabilities that still offer it change nothing.
        val b = BleRig(this)
        b.on()
        b.controller.updateContext(b.h.context(bleCaps(20)))
        runCurrent()
        assertTrue(b.radio.running)
        assertTrue(b.view.on)
        assertTrue(b.presencePuts().isEmpty())
    }

    @Test
    fun theRadioStoppingByItselfTurnsItOffAndSaysWhy() = runTest {
        suspend fun TestScope.stopped(reason: BleStopReason): BleRig {
            val b = BleRig(this)
            b.on()
            b.radio.stopBySelf(reason)
            runCurrent()
            assertFalse(b.view.on)
            assertTrue(b.keys.aliases.isEmpty())
            return b
        }
        stopped(BleStopReason.BluetoothOff).let { b ->
            assertEquals(BleProblem.BluetoothOff, b.view.problem)
            assertEquals(PeopleText.BLE_STOPPED_BLUETOOTH_OFF, b.h.state.notice?.message)
            assertEquals("Bluetooth turned off, so finding people near you stopped.", b.h.state.notice?.message)
            assertTrue(b.presencePuts().isEmpty())
        }
        stopped(BleStopReason.LocationOff).let { b ->
            assertEquals(BleProblem.LocationOff, b.view.problem)
            assertEquals(PeopleText.BLE_LOCATION_OFF, b.view.message)
            assertEquals(PeopleText.BLE_LOCATION_OFF, b.h.state.notice?.message)
            assertTrue(b.presencePuts().isEmpty(), "the device's own stop: the session ends with presence")
        }
        stopped(BleStopReason.PermissionLost).let { b ->
            assertEquals(BleProblem.PermissionBlocked, b.view.problem)
            assertNull(b.h.state.notice?.message)
        }
        stopped(BleStopReason.AdvertiseFailed).let { b ->
            assertEquals(BleProblem.Unsupported, b.view.problem)
            assertEquals("This phone's Bluetooth couldn't send the code.", b.h.state.notice?.message)
            assertEquals("This phone's Bluetooth couldn't send the code.", b.view.message)
        }
        stopped(BleStopReason.Unsupported).let { b -> assertEquals(BleProblem.Unsupported, b.view.problem) }
        stopped(BleStopReason.System).let { b ->
            assertNull(b.view.problem)
            assertNull(b.h.state.notice?.message)
            assertTrue(b.presencePuts().isEmpty())
        }
        stopped(BleStopReason.User).let { b ->
            assertNull(b.view.problem)
            assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}""", b.presencePuts().single().body)
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Restore

    /** A new process: a new controller and radio over the same records, secure store and key store. */
    private fun TestScope.restart(b: BleRig, radio: FakeBleRadio = FakeBleRadio()): Pair<PeopleController, FakeBleRadio> {
        b.controller.close()
        val c = PeopleController(
            b.h.kv,
            b.h.http,
            PeopleServices(b.h.secure, b.h.location, b.h.notifier, ble = BlePlatform(radio, b.keys)),
            backgroundScope,
            allowLocalHttp = false,
            clock = b.h.clock,
            timeZone = TimeZone.UTC,
        )
        return c to radio
    }

    @Test
    fun aRestartResumesWhereTheRecordKeyAndPresenceAgree() = runTest {
        val b = BleRig(this)
        b.on()
        val until = b.radio.starts.single().untilEpochMillis
        advanceTimeBy(60_000)
        val (c, radio) = restart(b)
        c.updateContext(b.h.context(BLE_ON))
        runCurrent()
        assertEquals(listOf(BleRadioConfig(nearRssi = -75, untilEpochMillis = until)), radio.starts)
        assertEquals(0, radio.stops)
        assertTrue(c.state.value.ble.on)
        assertTrue(b.h.http.sent.none { it.path.startsWith("/api/presence") }, "no request to resume")
        assertContentEquals(b.radio.source!!.payloadNow(), radio.source!!.payloadNow(), "the same key, the same payload")
        // It works as before: a sighting is reported.
        radio.hear(otherPayload(1), -60, b.now())
        runCurrent()
        assertEquals(1, b.sightings().size)
        // Turning it off from here tells the server.
        c.turnOffBluetooth()
        assertEquals(1, b.presencePuts().size)
    }

    @Test
    fun aRestartWithoutTheKeyPresenceOrPermissionRecordsItAsOff() = runTest {
        // The key store lost the key.
        BleRig(this).let { b ->
            b.on()
            b.keys.inner.remove(b.alias)
            val (c, radio) = restart(b)
            c.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertTrue(radio.starts.isEmpty())
            assertFalse(c.state.value.ble.on)
            assertTrue(c.state.value.ble.noticeSeen)
            assertTrue(b.h.http.sent.none { it.path.startsWith("/api/presence") })
        }
        // Presence ran out while the app was not running.
        BleRig(this).let { b ->
            b.on()
            b.controller.close()
            advanceTimeBy(3_700_000)
            val (c, radio) = restart(b)
            c.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertTrue(radio.starts.isEmpty())
            assertTrue(b.keys.aliases.isEmpty(), "the key goes")
            assertFalse(c.state.value.ble.on)
            assertTrue(b.h.http.sent.none { it.path.startsWith("/api/presence") })
        }
        // The permission was taken away (for now or for good), Bluetooth is off or not allowed, or
        // the phone turned out not to support it.
        val setUps = listOf<(FakeBleRadio) -> Unit>(
            { it.accessNow = BleAccess.Denied },
            { it.accessNow = BleAccess.Blocked },
            { it.stateNow = BleRadioState.PoweredOff },
            { it.stateNow = BleRadioState.LocationOff },
            { it.stateNow = BleRadioState.Unauthorized },
            { it.stateNow = BleRadioState.Unsupported },
            { it.supported = false },
        )
        for (setUp in setUps) {
            val b = BleRig(this)
            b.on()
            val (c, radio) = restart(b, FakeBleRadio().also(setUp))
            c.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertTrue(radio.starts.isEmpty())
            assertTrue(b.keys.aliases.isEmpty())
            assertFalse(c.state.value.ble.on)
            assertFalse(radio.running)
            assertTrue(b.h.http.sent.none { it.path.startsWith("/api/presence") }, "no request")
        }
    }

    @Test
    fun aRestartThatResumesNothingStopsARadioTheSystemRestarted() = runTest {
        // Off before the process ended, yet the system restarted the radio (a sticky service).
        BleRig(this).let { b ->
            b.on()
            b.controller.turnOffBluetooth()
            val (c, radio) = restart(b, FakeBleRadio().apply { running = true })
            c.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertFalse(radio.running)
            assertEquals(1, radio.stops)
            assertTrue(radio.starts.isEmpty())
        }
        // On, but the key did not survive: it cannot resume, so the restored radio stops too.
        BleRig(this).let { b ->
            b.on()
            b.keys.lose(b.alias)
            val (c, radio) = restart(b, FakeBleRadio().apply { running = true })
            c.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertFalse(radio.running)
            assertTrue(radio.starts.isEmpty())
            assertFalse(c.state.value.ble.on)
        }
    }

    @Test
    fun aRestartAfterThePersonStoppedTheAppTurnsItOffAndTellsTheServer() = runTest {
        val b = BleRig(this)
        b.on()
        // Everything would let it resume: presence, the key, the permission, the radio.
        val (c, radio) = restart(b, FakeBleRadio().apply { running = true; userStoppedApp = true })
        c.updateContext(b.h.context(BLE_ON))
        runCurrent()
        assertTrue(radio.starts.isEmpty(), "nothing resumes")
        assertFalse(radio.running)
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(c.state.value.ble.on)
        assertNull(c.state.value.ble.problem, "the person's own off: nothing to explain")
        assertEquals(listOf("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}"""), b.presencePuts().map { it.body })
        assertTrue(c.state.value.presence.on, "presence stays on")
        assertEquals(1, radio.userStoppedAsked)
        assertFalse(radio.userStoppedApp, "asking cleared it")

        // Turned on again by hand, it runs: the answer was used up.
        assertEquals(BleOutcome.On, c.turnOnBluetooth())
        runCurrent()
        assertTrue(radio.running)
        assertTrue(c.state.value.ble.on)
    }

    @Test
    fun aRestartAfterThePersonStoppedTheAppWithPresenceGoneSendsNothing() = runTest {
        val b = BleRig(this)
        b.on()
        b.controller.close()
        advanceTimeBy(3_700_000)
        val (c, radio) = restart(b, FakeBleRadio().apply { userStoppedApp = true })
        c.updateContext(b.h.context(BLE_ON))
        runCurrent()
        assertTrue(radio.starts.isEmpty())
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(c.state.value.ble.on)
        assertTrue(b.h.http.sent.none { it.path.startsWith("/api/presence") }, "presence ended, and the server's session with it")
    }

    @Test
    fun aStopWhileTheKeyIsBeingStoredAbandonsTheStartAndLeavesNoKey() = runTest {
        suspend fun TestScope.during(stopIt: suspend (BleRig) -> Unit): Pair<BleRig, BleOutcome> {
            val b = BleRig(this)
            b.ready()
            val gate = CompletableDeferred<Unit>()
            b.keys.putGate = gate
            val outcome = async { b.controller.turnOnBluetooth() }
            runCurrent()
            assertEquals(1, b.keys.putsWaiting, "the key is on its way into the store")
            stopIt(b)
            runCurrent()
            gate.complete(Unit)
            runCurrent()
            val o = outcome.await()
            assertTrue(b.keys.aliases.isEmpty(), "the key that landed after the stop went again")
            assertTrue(b.radio.starts.isEmpty())
            assertFalse(b.radio.running)
            assertFalse(b.view.on)
            assertFalse(b.view.starting)
            return b to o
        }
        during { it.controller.turnOffBluetooth() }.let { (b, o) ->
            assertTrue(o is BleOutcome.Problem)
            assertNull(b.view.problem, "the person turned it off: nothing to explain")
            assertEquals(listOf(true, false), b.presencePuts().map { it.body!!.contains("\"ble\":true") })
        }
        during { it.controller.turnOffPresence() }.let { (b, o) ->
            assertEquals(BleProblem.NeedsPresence, (o as BleOutcome.Problem).problem)
            assertEquals(BleProblem.NeedsPresence, b.view.problem)
        }
        during { check(it.controller.deleteMyProfile().done) }.let { (_, o) ->
            assertEquals(BleProblem.NeedsPresence, (o as BleOutcome.Problem).problem)
        }
        // A backend switch: the start's words wait under the switch for the way back.
        val elsewhere = BackendUrl.normalise("https://other.example") as BackendUrl.Valid
        during { it.controller.updateContext(it.h.context(BLE_ON).copy(backend = elsewhere)) }.let { (b, o) ->
            assertEquals(BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED), o)
            b.controller.updateContext(b.h.context(BLE_ON))
            runCurrent()
            assertFalse(b.view.on)
            assertEquals(BleProblem.Failed, b.view.problem)
            assertEquals(PeopleText.BLE_START_FAILED, b.view.message)
        }
    }

    @Test
    fun aStartThatPresenceOutlivesIsAbandoned() = runTest {
        val b = BleRig(this)
        b.ready()
        // Presence goes while the permission prompt is up.
        b.radio.accessNow = BleAccess.NotAsked
        b.radio.promptMs = 1_000
        backgroundScope.launch {
            delay(500)
            b.controller.turnOffPresence()
        }
        val outcome = b.controller.turnOnBluetooth()
        assertEquals(BleProblem.NeedsPresence, (outcome as BleOutcome.Problem).problem)
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
        assertTrue(b.presencePuts().isEmpty())
        assertFalse(b.view.starting)
    }

    @Test
    fun turningItOffDuringTheStartLeavesItOff() = runTest {
        val b = BleRig(this)
        b.ready()
        b.radio.accessNow = BleAccess.NotAsked
        b.radio.promptMs = 1_000
        backgroundScope.launch {
            delay(500)
            b.controller.turnOffBluetooth()
        }
        val outcome = b.controller.turnOnBluetooth()
        runCurrent()
        assertTrue(outcome is BleOutcome.Problem)
        assertFalse(b.view.on)
        assertNull(b.view.problem, "the person turned it off: nothing to explain")
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
        assertTrue(b.presencePuts().none { it.body!!.contains("\"ble\":true") }, "given up before the write")
    }
}
