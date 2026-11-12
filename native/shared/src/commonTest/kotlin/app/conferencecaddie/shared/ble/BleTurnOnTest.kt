package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.BleProblem
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.DeviceCredential
import app.conferencecaddie.shared.people.FakeApiHttp
import app.conferencecaddie.shared.people.PEOPLE_ON
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleHarness
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PresenceMode
import app.conferencecaddie.shared.people.StubPeopleServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

// Turning Bluetooth proximity on and off (web ble.ts startBle and stopBle, on derived tokens).
class BleTurnOnTest {
    @Test
    fun turnOnRunsItsStepsInOrderAndRepeatsPresenceInFull() = runTest {
        val b = BleRig(this)
        b.h.start(BLE_ON)
        b.h.visible()
        assertNull(b.controller.turnOnPresence("Hallway", "Green jacket", PresenceMode.Day))
        b.h.location.accessNow = LocationAccess.Precise
        b.controller.sharePosition(true)
        runCurrent()
        b.h.location.flow.emit(GeoFix(40.767891, -111.890123, 14.6, 0))
        runCurrent()
        b.h.http.sent.clear()
        b.log.clear()
        b.radio.log = b.log
        b.keys.log = b.log
        b.h.notifier.log = b.log
        b.radio.accessNow = BleAccess.NotAsked
        var startingDuringPrompt = false
        b.radio.duringRequest = { startingDuringPrompt = b.view.starting }
        assertTrue(b.view.available)
        assertFalse(b.view.noticeSeen)

        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertTrue(startingDuringPrompt, "the switch shows starting while the prompt is up")
        assertEquals(listOf("access", "requestAccess", "state", "notifications", "PUT presence ble=true", "keys.put", "start"), b.log)
        assertEquals(
            """{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","location":{"lat":40.767891,"lon":-111.890123,"accuracy":15},"until":"day","ble":true}""",
            b.presencePuts().single().body,
            "the write repeats zone, spot, position and duration, because a presence write replaces every field",
        )
        // The key is in the store under the conference's alias, and it is the server's key.
        assertEquals(setOf(b.alias), b.keys.aliases)
        assertEquals(b.h.server.bleKeyId(), BleProtocol.keyIdOf(b.keys.hmac(b.alias, BleProtocol.keyIdMessage())!!))
        val until = Instant.parse(b.h.state.presence.until!!).toEpochMilliseconds()
        assertEquals(listOf(BleRadioConfig(nearRssi = -75, untilEpochMillis = until)), b.radio.starts)
        assertTrue(b.radio.running)
        val v = b.view
        assertTrue(v.on)
        assertTrue(v.noticeSeen)
        assertFalse(v.starting)
        assertNull(v.problem)
        assertTrue(v.notificationsAllowed)
        // The key's text is kept nowhere: not in the records, not in the presence state.
        val keyText = DeviceCredential.base64Url(b.h.server.bleKeys.single())
        assertTrue(b.h.kv.map.values.none { keyText in it })
        assertFalse(keyText in b.h.state.toString())
        // Turning it on again changes nothing.
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertEquals(1, b.presencePuts().size)
    }

    @Test
    fun notificationsRefusedStillTurnItOn() = runTest {
        val b = BleRig(this)
        b.ready()
        b.h.notifier.allowed = false
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertTrue(b.view.on)
        assertFalse(b.view.notificationsAllowed)
        assertEquals(1, b.h.notifier.permissionRequests)
    }

    @Test
    fun turnOffStopsTheRadioRemovesTheKeyAndTellsTheServer() = runTest {
        val b = BleRig(this)
        b.on()
        b.h.http.sent.clear()
        b.controller.turnOffBluetooth()
        runCurrent()
        assertFalse(b.radio.running)
        assertTrue(b.keys.aliases.isEmpty())
        assertFalse(b.view.on)
        assertTrue(b.view.noticeSeen, "the explanation stays seen")
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}""", b.presencePuts().single().body)
        assertTrue(b.h.state.presence.on, "presence stays")
        assertNull(b.radio.source!!.payloadNow(), "nothing is served once stopped")
    }

    @Test
    fun noRadioOrNoDerivedTokensMeansUnsupported() = runTest {
        val plain = PeopleHarness(this)
        plain.start(BLE_ON)
        plain.visible()
        plain.controller.turnOnPresence("Hallway", "")
        assertFalse(plain.state.ble.available, "no radio on this device")
        assertEquals(BleProblem.Unsupported, (plain.controller.turnOnBluetooth() as BleOutcome.Problem).problem)

        val b = BleRig(this)
        b.ready(PEOPLE_ON.copy(ble = Capabilities.Ble(mode = Capabilities.BleMode.ServerRotate)))
        assertFalse(b.view.available, "server-rotate is not this app's mode")
        assertEquals(BleProblem.Unsupported, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)

        val c = BleRig(this)
        c.radio.supported = false
        c.ready()
        assertFalse(c.view.available)
        val p = c.controller.turnOnBluetooth() as BleOutcome.Problem
        assertEquals(BleProblem.Unsupported, p.problem)
        assertEquals(PeopleText.BLE_UNSUPPORTED, p.message)
        assertTrue(c.presencePuts().isEmpty())
    }

    @Test
    fun presenceOffAsksForPresenceFirstAndSendsNothing() = runTest {
        val b = BleRig(this)
        b.h.start(BLE_ON)
        b.h.visible()
        b.radio.log = b.log
        val p = b.controller.turnOnBluetooth() as BleOutcome.Problem
        assertEquals(BleProblem.NeedsPresence, p.problem)
        assertEquals(PeopleText.BLE_NEEDS_PRESENCE, p.message)
        assertTrue(b.log.isEmpty(), "nothing is asked of the radio")
        assertTrue(b.h.http.sent.isEmpty())
        assertEquals(BleProblem.NeedsPresence, b.view.problem)
        assertEquals(PeopleText.BLE_NEEDS_PRESENCE, b.view.message)

        // The next turn-on clears the problem.
        b.controller.turnOnPresence("Hallway", "")
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertNull(b.view.problem)
        assertNull(b.view.message)
    }

    @Test
    fun aRefusedPermissionIsDeniedOrBlocked() = runTest {
        val b = BleRig(this)
        b.ready()
        b.radio.accessNow = BleAccess.NotAsked
        b.radio.afterRequest = BleAccess.Denied
        assertEquals(BleOutcome.Problem(BleProblem.PermissionDenied, PeopleText.BLE_PERMISSION), b.controller.turnOnBluetooth())
        assertEquals(1, b.radio.requests)
        // Denied (the rationale case) asks again; refused for good is blocked.
        b.radio.afterRequest = BleAccess.Blocked
        assertEquals(BleProblem.PermissionBlocked, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        assertEquals(2, b.radio.requests)
        // Blocked before asking: no prompt at all.
        assertEquals(BleProblem.PermissionBlocked, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        assertEquals(2, b.radio.requests, "no prompt for a permission refused for good")
        assertTrue(b.presencePuts().isEmpty())
        assertTrue(b.keys.aliases.isEmpty())
        assertEquals(BleProblem.PermissionBlocked, b.view.problem)

        // iOS names its own permission.
        b.radio.permissionKind = BlePermissionKind.Bluetooth
        assertEquals("Caddie needs the Bluetooth permission for this. You can allow it in Settings.", (b.controller.turnOnBluetooth() as BleOutcome.Problem).message)
        assertEquals(BlePermissionKind.Bluetooth, b.view.permission)
    }

    @Test
    fun deniedOnceAsksAgainAndCanBeGranted() = runTest {
        val b = BleRig(this)
        b.ready()
        b.radio.accessNow = BleAccess.Denied
        b.radio.afterRequest = BleAccess.Granted
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertEquals(1, b.radio.requests, "the prompt shows again after a refusal that is not for good")
        assertTrue(b.view.on)
        assertNull(b.view.problem)
    }

    @Test
    fun aLateAnswerReachesTheBackendSelectedAgainAfterAnotherOneTookTheRadio() = runTest {
        // The prompt timed out on this backend; another backend's runtime then took the radio's one
        // listener, and coming back to this backend must take it back.
        val b = BleRig(this)
        b.ready()
        b.radio.permissionKind = BlePermissionKind.Bluetooth
        b.radio.accessNow = BleAccess.NotAsked
        b.radio.afterRequest = BleAccess.Denied
        assertEquals(BleProblem.PermissionDenied, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        val other = app.conferencecaddie.shared.BackendUrl.normalise("https://other.example") as app.conferencecaddie.shared.BackendUrl.Valid
        b.h.controller.updateContext(b.h.context(BLE_ON).copy(backend = other))
        runCurrent()
        val othersListener = b.radio.accessListener
        assertNotNull(othersListener, "the other backend's runtime listens now")
        b.h.controller.updateContext(b.h.context(BLE_ON))
        runCurrent()
        assertTrue(b.radio.accessListener !== othersListener, "coming back takes the listener back")
        b.radio.answerLate(BleAccess.Granted)
        runCurrent()
        assertNull(b.view.problem, "the refusal under this backend's switch is gone")
    }

    @Test
    fun aLateAnswerToThePromptReplacesTheRefusalUnderTheSwitch() = runTest {
        // iOS: the prompt went unanswered for a minute, so the turn-on counted it as refused.
        val b = BleRig(this)
        b.ready()
        b.radio.permissionKind = BlePermissionKind.Bluetooth
        b.radio.accessNow = BleAccess.NotAsked
        b.radio.afterRequest = BleAccess.Denied
        assertEquals(BleProblem.PermissionDenied, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        assertEquals(BleProblem.PermissionDenied, b.view.problem)
        assertNotNull(b.radio.accessListener, "the runtime listens for the answer")

        // Allowed later: the refusal goes, and nothing starts by itself.
        b.radio.answerLate(BleAccess.Granted)
        runCurrent()
        assertNull(b.view.problem)
        assertNull(b.view.message)
        assertFalse(b.view.on)
        assertTrue(b.presencePuts().isEmpty())
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth(), "the switch turns it on at once")

        // Refused later: the refusal is one for good, with the way to Settings.
        val c = BleRig(this)
        c.ready()
        c.radio.permissionKind = BlePermissionKind.Bluetooth
        c.radio.accessNow = BleAccess.NotAsked
        c.radio.afterRequest = BleAccess.Denied
        c.controller.turnOnBluetooth()
        c.radio.answerLate(BleAccess.Blocked)
        runCurrent()
        assertEquals(BleProblem.PermissionBlocked, c.view.problem)
        assertEquals("Caddie needs the Bluetooth permission for this. You can allow it in Settings.", c.view.message)

        // Any other problem is left as it is.
        val d = BleRig(this)
        d.ready()
        d.radio.stateNow = BleRadioState.PoweredOff
        d.controller.turnOnBluetooth()
        d.radio.answerLate(BleAccess.Granted)
        runCurrent()
        assertEquals(BleProblem.BluetoothOff, d.view.problem)
    }

    @Test
    fun theRadiosStateDecidesBeforeAnyWrite() = runTest {
        val b = BleRig(this)
        b.ready()
        b.radio.stateNow = BleRadioState.PoweredOff
        assertEquals(BleOutcome.Problem(BleProblem.BluetoothOff, PeopleText.BLE_BLUETOOTH_OFF), b.controller.turnOnBluetooth())
        b.radio.stateNow = BleRadioState.Unauthorized
        assertEquals(BleProblem.PermissionBlocked, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        b.radio.stateNow = BleRadioState.Unsupported
        assertEquals(BleProblem.Unsupported, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        assertTrue(b.presencePuts().isEmpty())
        assertEquals(0, b.h.notifier.permissionRequests, "notifications are asked for only once the radio can run")
        // Unknown (iOS before its first state report) goes ahead.
        b.radio.stateNow = BleRadioState.Unknown
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
    }

    @Test
    fun locationOffRefusesWithItsOwnWordsBeforeAnyWrite() = runTest {
        val b = BleRig(this)
        b.ready()
        // Android 8 to 11 with the Location switch off: a scan would hear nothing.
        b.radio.stateNow = BleRadioState.LocationOff
        assertEquals(BleOutcome.Problem(BleProblem.LocationOff, PeopleText.BLE_LOCATION_OFF), b.controller.turnOnBluetooth())
        assertEquals(BleProblem.LocationOff, b.view.problem)
        assertEquals("Turn on Location first. This phone needs it to find people over Bluetooth.", b.view.message)
        assertEquals(PeopleText.BLE_LOCATION_OFF, PeopleText.bleProblemMessage(BleProblem.LocationOff))
        assertFalse(b.view.on)
        assertTrue(b.presencePuts().isEmpty())
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
        // Location switched on: the next attempt starts and the words go.
        b.radio.stateNow = BleRadioState.Ready
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertNull(b.view.problem)
    }

    @Test
    fun anAnswerWithoutAKeyOrWithTheWrongKeyIdFails() = runTest {
        val b = BleRig(this)
        b.ready()
        // A server-rotate (or older) backend answers ble: true with a legacy token and no key.
        b.h.server.presencePut = { r ->
            val base = b.h.server.presenceOk(r, issueKey = false).text().removeSuffix("}")
            FakeApiHttp.json(200, """$base,"ble":{"token":"AAAAAAAAAAAAAAAAAAAAAA","rotate_at":"2099-01-01T00:00:00Z"}}""")
        }
        assertEquals(BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED), b.controller.turnOnBluetooth())
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
        assertFalse(b.view.on)
        assertEquals(BleProblem.Failed, b.view.problem)
        assertEquals(PeopleText.BLE_START_FAILED, b.view.message)

        // A key whose id is not the one the answer names: the key goes again.
        b.h.server.presencePut = { r ->
            val key = ByteArray(32) { 5 }
            val base = b.h.server.presenceOk(r, issueKey = false).text().removeSuffix("}")
            FakeApiHttp.json(200, """$base,"ble_key":"${DeviceCredential.base64Url(key)}","ble_key_id":"${StubPeopleServer.keyIdOf(ByteArray(32) { 6 })}"}""")
        }
        assertEquals(BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED), b.controller.turnOnBluetooth())
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
        assertFalse(b.view.on)
    }

    @Test
    fun aFailingKeyStoreFailsTheStartAndNeverThrowsIntoTheRadio() = runTest {
        val b = BleRig(this)
        b.ready()
        b.keys.failPut = true
        assertEquals(BleOutcome.Problem(BleProblem.Failed, PeopleText.BLE_START_FAILED), b.controller.turnOnBluetooth())
        assertTrue(b.keys.lastPutArgument!!.all { it == 0.toByte() }, "the key bytes are zeroed")
        assertTrue(b.radio.starts.isEmpty())
        b.keys.failPut = false
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        assertTrue(b.keys.lastPutArgument!!.all { it == 0.toByte() }, "after a successful store too")
        b.keys.failHmac = true
        assertNull(b.radio.source!!.payloadNow(), "a store that fails serves nothing, and throws nothing")
    }

    @Test
    fun aRefusedPresenceWriteSaysWhy() = runTest {
        val b = BleRig(this)
        b.ready()
        b.h.server.presencePut = { FakeApiHttp.json(403, """{"error":"presence_required"}""") }
        assertEquals(BleProblem.NeedsPresence, (b.controller.turnOnBluetooth() as BleOutcome.Problem).problem)
        b.h.server.presencePut = { FakeApiHttp.json(409, """{"error":"The profile changed at the same time; try again"}""") }
        assertEquals(BleOutcome.Problem(BleProblem.Failed, "That did not go through. Try again."), b.controller.turnOnBluetooth())
        b.h.server.presencePut = { FakeApiHttp.json(403, """{"error":"profile_required"}""") }
        assertEquals(BleOutcome.Problem(BleProblem.Failed, "Make your profile visible first."), b.controller.turnOnBluetooth())
        assertTrue(b.keys.aliases.isEmpty())
        assertTrue(b.radio.starts.isEmpty())
    }

    @Test
    fun aDeleteCoveringTheConferenceRefusesWithTheDeleteWording() = runTest {
        val b = BleRig(this)
        b.ready()
        // Turning visibility off deletes the server copy; that delete fails, so it stays unfinished.
        b.h.server.profileDelete = { FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""") }
        b.controller.setOpenToMeet(false)
        runCurrent()
        assertTrue(b.h.state.deletes.coversConference)
        b.h.http.sent.clear()
        assertEquals(BleOutcome.Problem(BleProblem.Failed, PeopleError.DELETE_UNFINISHED_MESSAGE), b.controller.turnOnBluetooth())
        assertTrue(b.presencePuts().isEmpty())
    }

    @Test
    fun turningItOnAtAnotherConferenceStopsTheFirstAndTellsItsServer() = runTest {
        val b = BleRig(this)
        b.on()
        val first = b.alias
        b.h.http.sent.clear()
        val other = b.h.context(BLE_ON).copy(conference = ConferenceInfo("other-conf-2099", "Other"), bundle = null, interested = emptyList())
        b.controller.updateContext(other)
        runCurrent()
        assertTrue(b.radio.running, "switching the selected conference does not stop it")
        assertFalse(b.view.on, "it is not on at the conference now selected")
        assertNull(b.controller.setOpenToMeet(true))
        assertNull(b.controller.turnOnPresence("Hallway", ""))
        b.h.http.sent.clear()
        assertEquals(BleOutcome.On, b.controller.turnOnBluetooth())
        val puts = b.presencePuts()
        assertEquals(2, puts.size)
        assertEquals("""{"event":"${b.slug}","zone":"Hallway","spot":"Green jacket","ble":false}""", puts[0].body)
        assertEquals("""{"event":"other-conf-2099","zone":"Hallway","spot":"","ble":true}""", puts[1].body)
        val second = BleProtocol.keyAlias(BACKEND_BASE, "other-conf-2099")
        assertEquals(setOf(second), b.keys.aliases)
        assertTrue(first != second)
        assertEquals(2, b.radio.starts.size)
        assertTrue(b.view.on)
    }

    private companion object {
        val BACKEND_BASE = app.conferencecaddie.shared.people.BACKEND.base
    }
}
