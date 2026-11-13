package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.PushToken
import app.conferencecaddie.shared.ble.BleRig
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

// The people actions whose records the phone could not write: each returns the web's message
// instead of claiming success, and what the screens show and the next launch reads is what it was
// before. A later write that goes through never carries the change that failed.
class NoSilentFailuresTest {
    private val failed = ProfileSync.GENERIC_MESSAGE

    /** The records as the next launch reads them. */
    private suspend fun nextLaunch(h: PeopleHarness): ConferenceRecord = PeopleStore(h.kv, BACKEND.base).apply { load() }.record(FIXTURE_SLUG)

    // A write that goes through, of a record the failed change belongs to.
    private suspend fun writeSomethingElse(h: PeopleHarness) {
        assertNull(h.controller.setNudgesEnabled(!h.state.nudgesOn))
        assertNull(h.controller.setNudgesEnabled(!h.state.nudgesOn))
    }

    @Test
    fun saveThisPersonThatCannotBeStoredSaysSoAndKeepsNobody() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.kv.failWrites = true
        assertEquals(failed, h.controller.saveMet("Ana", "SRE"))
        assertTrue(h.state.met.isEmpty(), "nobody shows under People I met")

        h.kv.failWrites = false
        writeSomethingElse(h)
        assertTrue(nextLaunch(h).met.isEmpty(), "nor is anyone stored with a later write")
        assertNull(h.controller.saveMet("Ben", null))
        assertEquals(listOf("Ben"), h.state.met.map { it.displayName })
        assertEquals(listOf("Ben"), nextLaunch(h).met.map { it.displayName })
    }

    @Test
    fun removingSomeoneMetThatCannotBeStoredKeepsThem() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertNull(h.controller.saveMet("Ana", "SRE"))
        val ana = h.state.met.single()
        h.kv.failWrites = true
        assertEquals(failed, h.controller.removeMet(ana))
        assertEquals(listOf(ana), h.state.met)

        h.kv.failWrites = false
        writeSomethingElse(h)
        assertEquals(listOf(ana), nextLaunch(h).met)
    }

    @Test
    fun aWatchThatCannotBeStoredStaysAsItWas() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.kv.failWrites = true
        assertEquals(WatchOutcome.Failed(failed), h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"), "not \"stopped watching\"")
        assertTrue(h.state.watch.isEmpty())
        h.kv.failWrites = false
        writeSomethingElse(h)
        assertTrue(nextLaunch(h).watch.isEmpty())

        assertEquals(WatchOutcome.Done(on = true), h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"))
        h.kv.failWrites = true
        assertEquals(WatchOutcome.Failed(failed), h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"))
        assertEquals(listOf("Ana"), h.state.watch.map { it.displayName }, "still watched")
        assertEquals(failed, h.controller.removeWatch("9b1c7e5d3a2f4c60"))
        assertEquals(listOf("Ana"), h.state.watch.map { it.displayName })
        h.kv.failWrites = false
        writeSomethingElse(h)
        assertEquals(listOf("Ana"), nextLaunch(h).watch.map { it.displayName })
    }

    @Test
    fun theNudgeSettingThatCannotBeStoredStaysAsItWas() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertTrue(h.state.nudgesOn)
        h.kv.failWrites = true
        assertEquals(failed, h.controller.setNudgesEnabled(false))
        assertTrue(h.state.nudgesOn)
        h.kv.failWrites = false
        assertNull(h.controller.saveMet("Ben", null))
        assertTrue(nextLaunch(h).nudgesOn)
    }

    @Test
    fun sharingChoicesThatCannotBeStoredStayAsTheyWere() = runTest {
        val h = PeopleHarness(this)
        h.start(interested = listOf("$FIXTURE_SLUG:1001"))
        h.visible()
        h.kv.failWrites = true
        assertEquals(failed, h.controller.markShareNoticeSeen())
        assertFalse(h.state.visibility.shareNoticeSeen)
        assertEquals(failed, h.controller.markBannerSeen("$FIXTURE_SLUG:1001"))
        assertTrue(h.state.visibility.bannerSeen.isEmpty(), "the ended-talk banner comes back")
        h.kv.failWrites = false
        assertNull(h.controller.followInterested())
        assertTrue(h.state.visibility.shareNew)
        assertTrue(nextLaunch(h).visibility.bannerSeen.isEmpty(), "a later write does not carry the mark")

        h.kv.failWrites = true
        assertEquals(failed, h.controller.stopFollowingInterested())
        assertTrue(h.state.visibility.shareNew, "the switch stays on")
        h.kv.failWrites = false
        writeSomethingElse(h)
        assertTrue(nextLaunch(h).visibility.shareNew)
        assertNull(h.controller.stopFollowingInterested())
        assertFalse(h.state.visibility.shareNew)
    }

    @Test
    fun closingStillInThatCannotBeStoredLeavesTheQuestion() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertNull(h.controller.turnOnPresence("Hallway", "", PresenceMode.Day))
        h.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(20 * 60_000L)
        h.controller.setForeground(true)
        runCurrent()
        assertTrue(h.state.presence.confirmPending)
        val confirmedAt = h.state.presence.confirmedAt

        h.kv.failWrites = true
        assertEquals(failed, h.controller.dismissZoneCheck())
        assertTrue(h.state.presence.confirmPending, "Still in Hallway? is still asked")
        assertEquals(confirmedAt, h.state.presence.confirmedAt)
        h.kv.failWrites = false
        assertNull(h.controller.dismissZoneCheck())
        assertFalse(h.state.presence.confirmPending)
    }

    @Test
    fun turningPresenceOffThatCannotBeStoredLeavesItOnHereAndOnTheServer() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertNull(h.controller.turnOnPresence("Hallway", "by the stairs"))
        val before = h.state.presence
        h.http.sent.clear()

        h.kv.failWrites = true
        assertEquals(failed, h.controller.turnOffPresence())
        runCurrent()
        assertEquals(before, h.state.presence, "presence is on as before")
        assertTrue(h.sent("DELETE", "/api/presence").isEmpty(), "and still on at the server: nothing was sent")

        h.kv.failWrites = false
        assertNull(h.controller.turnOffPresence())
        runCurrent()
        assertFalse(h.state.presence.on)
        assertEquals(1, h.sent("DELETE", "/api/presence").size)
        assertFalse(nextLaunch(h).presence.on)
    }

    /** Records whose writes wait for [gate] when it is set; a write that started while [failWrites] fails once it is let through. */
    private class GatedKeyValue(val inner: MapKeyValue) : PeopleKeyValue {
        var gate: CompletableDeferred<Unit>? = null
        var failWrites = false
        var waiting = 0

        override suspend fun get(key: String): String? = inner.get(key)

        override suspend fun set(key: String, value: String?) {
            val fail = failWrites
            gate?.let { g ->
                waiting++
                g.await()
                waiting--
            }
            if (fail) error("disk I/O error")
            inner.set(key, value)
        }
    }

    private fun TestScope.gatedHarness(kv: GatedKeyValue): Pair<PeopleHarness, PeopleController> {
        val h = PeopleHarness(this)
        val c = PeopleController(kv, h.http, PeopleServices(h.secure, h.location, h.notifier), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        return h to c
    }

    @Test
    fun aMoveAnsweredWhileAFailedTurnOffWasBeingWrittenIsStillRecorded() = runTest {
        val kv = GatedKeyValue(MapKeyValue())
        val (h, c) = gatedHarness(kv)
        c.updateContext(h.context())
        runCurrent()
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertNull(c.setOpenToMeet(true))
        assertNull(c.turnOnPresence("Hallway", ""))
        runCurrent()

        // A move to Hall B waits for its answer.
        val answer = CompletableDeferred<Unit>()
        val put = h.server.presencePut
        h.server.presencePut = { r ->
            answer.await()
            put(r)
        }
        val move = async { c.turnOnPresence("Hall B", "") }
        runCurrent()
        // The person turns presence off; its record is being written (and will fail) when the
        // move's answer arrives.
        kv.gate = CompletableDeferred()
        kv.failWrites = true
        val off = async { c.turnOffPresence() }
        runCurrent()
        assertEquals(1, kv.waiting)
        kv.failWrites = false
        answer.complete(Unit)
        runCurrent()
        kv.gate!!.complete(Unit)
        kv.gate = null
        runCurrent()

        assertEquals(failed, off.await())
        assertNull(move.await())
        assertTrue(c.state.value.presence.on, "the off changed nothing, so the move the server took is recorded")
        assertEquals("Hall B", c.state.value.presence.zone)
        assertTrue(h.sent("DELETE", "/api/presence").isEmpty())
        c.close()
    }

    @Test
    fun aMoveAnsweredWhileATurnOffWasBeingWrittenIsNotRecorded() = runTest {
        val kv = GatedKeyValue(MapKeyValue())
        val (h, c) = gatedHarness(kv)
        c.updateContext(h.context())
        runCurrent()
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertNull(c.setOpenToMeet(true))
        assertNull(c.turnOnPresence("Hallway", ""))
        runCurrent()

        val answer = CompletableDeferred<Unit>()
        val put = h.server.presencePut
        h.server.presencePut = { r ->
            answer.await()
            put(r)
        }
        val move = async { c.turnOnPresence("Hall B", "") }
        runCurrent()
        kv.gate = CompletableDeferred()
        val off = async { c.turnOffPresence() }
        runCurrent()
        assertEquals(1, kv.waiting)
        answer.complete(Unit)
        runCurrent()
        kv.gate!!.complete(Unit)
        kv.gate = null
        runCurrent()

        assertNull(off.await())
        assertNull(move.await())
        assertFalse(c.state.value.presence.on, "the off has the last word, here and on the server")
        assertEquals(1, h.sent("DELETE", "/api/presence").size)
        c.close()
    }

    @Test
    fun turningBluetoothOffThatCannotBeStoredLeavesItRunning() = runTest {
        val b = BleRig(this)
        b.on()
        val alias = b.alias
        b.h.kv.failWrites = true
        assertEquals(failed, b.controller.turnOffBluetooth())
        runCurrent()
        assertTrue(b.view.on, "the switch stays on")
        assertTrue(b.radio.running, "the radio runs on")
        assertTrue(b.keys.hmac(alias, ByteArray(1)) != null, "with its key")
        assertTrue(b.presencePuts().isEmpty(), "and nothing told the server")

        b.h.kv.failWrites = false
        assertNull(b.controller.turnOffBluetooth())
        runCurrent()
        assertFalse(b.view.on)
        assertFalse(b.radio.running)
        assertEquals(1, b.presencePuts().size)
    }

    @Test
    fun turningPushOffThatCannotBeStoredLeavesItOnHereAndOnTheServer() = runTest {
        val push = FakePush("apns", PushToken("apns", "ab".repeat(32), environment = "sandbox"))
        val h = PeopleHarness(this, push = push)
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        h.start(PEOPLE_ON.copy(push = Capabilities.Push(apns = true)))
        h.visible()
        h.kv.failWrites = true
        assertEquals(failed, h.controller.markPushNoticeSeen())
        assertFalse(h.state.push.noticeSeen, "the notice shows again")
        h.kv.failWrites = false
        assertEquals(PushOutcome.On, h.controller.enablePush())

        h.kv.failWrites = true
        assertEquals(failed, h.controller.disablePush())
        assertTrue(h.state.push.on)
        assertTrue(h.sent("DELETE", "/api/push/native").isEmpty())
        assertEquals(0, push.unregistered)
        h.kv.failWrites = false
        writeSomethingElse(h)
        assertTrue(nextLaunch(h).push.on)
        assertNull(h.controller.disablePush())
        assertFalse(h.state.push.on)
        assertEquals(1, h.sent("DELETE", "/api/push/native").size)
    }

    @Test
    fun aPositionChoiceThatCannotBeStoredStaysAsItWas() = runTest {
        val h = PeopleHarness(this)
        h.location.accessNow = LocationAccess.Precise
        h.start()
        h.visible()
        assertNull(h.controller.turnOnPresence("Hallway", ""))
        h.http.sent.clear()

        h.kv.failWrites = true
        assertEquals(PositionOutcome.NotSaved, h.controller.sharePosition(true), "not Unavailable, which the screen does not show")
        assertNull(h.state.presence.positionChoice)
        assertFalse(h.state.presence.position)
        h.kv.failWrites = false
        assertEquals(PositionOutcome.On, h.controller.sharePosition(true))
        assertTrue(h.state.presence.position)

        h.kv.failWrites = true
        assertEquals(PositionOutcome.NotSaved, h.controller.sharePosition(false))
        runCurrent()
        assertTrue(h.state.presence.position, "still on")
        assertTrue(h.sent("PUT", "/api/presence").isEmpty(), "and the server was not told otherwise")
    }

    @Test
    fun aBlockThatCannotBeStoredIsNotSentAndAnUnblockThatCannotBeStoredKeepsTheRow() = runTest {
        val h = PeopleHarness(this)
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        h.start()
        h.visible()
        h.kv.failWrites = true
        assertEquals(failed, h.controller.block("9b1c7e5d3a2f4c60", "Ana"))
        assertTrue(h.state.blocks.isEmpty())
        assertTrue(h.sent("POST", "/api/people/block").isEmpty(), "nothing was blocked on the server either")

        h.kv.failWrites = false
        assertNull(h.controller.block("9b1c7e5d3a2f4c60", "Ana"))
        h.kv.failWrites = true
        assertEquals(failed, h.controller.unblock("9b1c7e5d3a2f4c60"))
        assertEquals(listOf("Ana"), h.state.blocks.map { it.displayName }, "the row stays, as the next launch has it")
        h.kv.failWrites = false
        writeSomethingElse(h)
        assertEquals(listOf("Ana"), nextLaunch(h).blocks.map { it.displayName })

        // Trying again finishes it.
        assertNull(h.controller.unblock("9b1c7e5d3a2f4c60"))
        assertTrue(h.state.blocks.isEmpty())
    }

    @Test
    fun twoChangesThatBothFailLeaveWhatIsStored() = runTest {
        val kv = GatedKeyValue(MapKeyValue())
        val (h, c) = gatedHarness(kv)
        c.updateContext(h.context())
        runCurrent()
        assertTrue(c.toggleWatch("aaaa000000000001", "Ana") is WatchOutcome.Done)

        // Two watches whose writes are both under way when both fail: the second built on the first.
        kv.gate = CompletableDeferred()
        kv.failWrites = true
        val ben = async { c.toggleWatch("aaaa000000000002", "Ben") }
        val cy = async { c.toggleWatch("aaaa000000000003", "Cy") }
        runCurrent()
        assertEquals(2, kv.waiting)
        kv.gate!!.complete(Unit)
        kv.gate = null
        kv.failWrites = false
        runCurrent()
        assertEquals(WatchOutcome.Failed(failed), ben.await())
        assertEquals(WatchOutcome.Failed(failed), cy.await())
        assertEquals(listOf("Ana"), c.state.value.watch.map { it.displayName }, "what is stored, not Ben")
        c.close()
    }

    @Test
    fun aRecordWhoseListCannotBeWrittenIsNotKeptOrLeftBehind() = runTest {
        // A new conference record is written before the list that names it: when the list fails,
        // the record is taken back too, so nothing that names someone stays unlisted.
        var failSlugs = false
        val inner = MapKeyValue()
        val kv = object : PeopleKeyValue {
            override suspend fun get(key: String): String? = inner.get(key)

            override suspend fun set(key: String, value: String?) {
                if (failSlugs && key.endsWith("#slugs")) error("disk I/O error")
                inner.set(key, value)
            }
        }
        val store = PeopleStore(kv, BACKEND.base).apply { load() }
        failSlugs = true
        val res = runCatching { store.update(FIXTURE_SLUG, undoOnFailure = true) { it.copy(met = listOf(MetPerson("Ana"))) } }
        assertTrue(res.isFailure)
        assertTrue(store.record(FIXTURE_SLUG).met.isEmpty())
        assertTrue(inner.map.isEmpty(), "no record is left behind")

        // A record emptied is gone once its own key is: a list that still names it reads it as empty.
        failSlugs = false
        store.update(FIXTURE_SLUG, undoOnFailure = true) { it.copy(met = listOf(MetPerson("Ana"))) }
        failSlugs = true
        store.update(FIXTURE_SLUG, undoOnFailure = true) { it.copy(met = emptyList()) }
        assertTrue(store.record(FIXTURE_SLUG).met.isEmpty())
        assertTrue(PeopleStore(inner, BACKEND.base).apply { load() }.record(FIXTURE_SLUG).met.isEmpty(), "as the next launch reads it")
    }

    @Test
    fun actionsReturnTheMessageWhenTheRecordsAreNotOpenOrPeopleAreOff() = runTest {
        val h = PeopleHarness(this)
        h.start(PEOPLE_ON.copy(people = PEOPLE_ON.people.copy(enabled = false)))
        val off = PeopleError.NOT_OFFERED_MESSAGE
        assertEquals(off, h.controller.saveMet("Ana", null))
        assertEquals(WatchOutcome.Failed(off), h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"))
        assertEquals(off, h.controller.setNudgesEnabled(false))
        assertEquals(off, h.controller.turnOffPresence())
        assertEquals(off, h.controller.markBannerSeen("x"))
    }
}
