package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.PushToken
import app.conferencecaddie.shared.core.CapabilitiesState
import app.conferencecaddie.shared.core.CoreState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean

// The controller itself on virtual time: a store that fails ends neither the app nor the binding,
// a write runs to its end when its caller goes, one session per backend, circle counts in batches,
// and the push, People I met and notice rules.
class PeopleControllerTest {
    /** A key-value store that can fail to read or to write, as a database with a disk error does. */
    private class FlakyKeyValue : PeopleKeyValue {
        val inner = MapKeyValue()
        var failReads = false
        var failWrites = false

        override suspend fun get(key: String): String? = if (failReads) error("disk I/O error") else inner.get(key)

        override suspend fun set(key: String, value: String?) = if (failWrites) error("disk I/O error") else inner.set(key, value)
    }

    private fun TestScope.controllerOver(kv: PeopleKeyValue, h: PeopleHarness) =
        PeopleController(kv, h.http, PeopleServices(h.secure, h.location, h.notifier), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)

    private val other: BackendUrl.Valid = BackendUrl.normalise("https://other.example") as BackendUrl.Valid

    private fun talk(n: Int) = "$FIXTURE_SLUG:$n"

    // ---------------------------------------------------------------------------------------------
    // A store that fails

    @Test
    fun recordsThatCannotBeReadEndNeitherTheAppNorTheBinding() = runTest {
        val h = PeopleHarness(this)
        val kv = FlakyKeyValue().apply { failReads = true }
        val c = controllerOver(kv, h)
        val ready = CapabilitiesState.Ready(PEOPLE_ON, CapabilitiesDiscovery.Source.Api, cached = false, updateApp = false)
        val core = MutableStateFlow(CoreState(BACKEND, isDefaultBackend = false, capabilities = ready))
        c.bind(core)
        runCurrent()
        assertEquals(PeopleAvailability.Loading, c.state.value.availability, "no session while its records cannot be read")
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertEquals(ProfileSync.GENERIC_MESSAGE, c.setOpenToMeet(true), "an action fails without throwing")

        // The binding still follows the core.
        core.value = core.value.copy(capabilities = CapabilitiesState.Unreachable)
        runCurrent()
        assertEquals(PeopleAvailability.Off, c.state.value.availability)

        // The next context opens the session once the records can be read.
        kv.failReads = false
        core.value = core.value.copy(capabilities = ready)
        runCurrent()
        assertEquals(PeopleAvailability.NoConference, c.state.value.availability)
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertEquals("Caddie Native Test A", c.state.value.profile.displayName)
        assertTrue(kv.inner.map.keys.any { it.endsWith("#profile") }, "the profile is stored")
        c.close()
    }

    @Test
    fun aSessionWhoseRecordsCouldNotBeReadIsTriedAgainLater() = runTest {
        val h = PeopleHarness(this)
        val kv = FlakyKeyValue().apply { failReads = true }
        val c = controllerOver(kv, h)
        c.updateContext(h.context())
        runCurrent()
        assertEquals(PeopleAvailability.Loading, c.state.value.availability)
        kv.failReads = false
        advanceTimeBy(PeopleController.SESSION_RETRY_MS + 1)
        runCurrent()
        assertEquals(PeopleAvailability.Ready, c.state.value.availability, "a later attempt opens it without a new context")
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertNull(c.setOpenToMeet(true))
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        c.close()
    }

    @Test
    fun aSessionIsOpenedOnceWhileItsRecordsAreStillBeingRead() = runTest {
        val h = PeopleHarness(this)
        val gate = CompletableDeferred<Unit>()
        var profileReads = 0
        val kv = object : PeopleKeyValue {
            val inner = MapKeyValue()

            override suspend fun get(key: String): String? {
                if (key.endsWith("#profile")) {
                    profileReads++
                    gate.await()
                }
                return inner.get(key)
            }

            override suspend fun set(key: String, value: String?) = inner.set(key, value)
        }
        val c = controllerOver(kv, h)
        val applying = launch { c.updateContext(h.context()) }
        runCurrent()
        // An action arrives while the records are being read: it waits for that session.
        val action = async { c.setOpenToMeet(true) }
        runCurrent()
        gate.complete(Unit)
        applying.join()
        assertEquals("Add your name to your profile first.", action.await())
        assertEquals(1, profileReads, "one session, its records read once")
        assertEquals(PeopleAvailability.Ready, c.state.value.availability)
        c.close()
    }

    @Test
    fun recordsThatCannotBeWrittenFailTheActionNotTheApp() = runTest {
        val h = PeopleHarness(this)
        val kv = FlakyKeyValue()
        val c = controllerOver(kv, h)
        c.updateContext(h.context())
        runCurrent()
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertNull(c.setOpenToMeet(true))
        assertNull(c.turnOnPresence("Hallway", ""))

        kv.failWrites = true
        assertEquals(ProfileSync.GENERIC_MESSAGE, c.shareForTalk(talk(1001), true), "the generic line, not an exception")
        c.saveMet("Ana", null)
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        assertEquals(ProfileSync.GENERIC_MESSAGE, c.block("9b1c7e5d3a2f4c60", "Ana"))
        // A read whose answer is written down fails like a call that got no usable answer.
        h.server.matches = { FakeApiHttp.json(403, """{"error":"visibility_required"}""") }
        val search = c.searchPeople(null, around = false).errorOrNull
        assertEquals(PeopleError.Kind.Unavailable, search?.kind)
        assertEquals(PeopleError.UNAVAILABLE_MESSAGE, search?.message)
        // The hour runs out while nothing can be written: the timer's failure ends quietly.
        advanceTimeBy(3_600_000 + 1)
        runCurrent()
        // The controller still follows its context.
        c.updateContext(h.context(PEOPLE_ON.copy(people = PEOPLE_ON.people.copy(circles = false))))
        runCurrent()
        assertFalse(c.state.value.features.circles)

        kv.failWrites = false
        c.updateContext(h.context())
        runCurrent()
        assertNull(c.shareForTalk(talk(1002), true))
        assertTrue(talk(1002) in c.state.value.visibility.sharedTalkIds)
        c.close()
    }

    // ---------------------------------------------------------------------------------------------
    // Writes whose caller goes away

    @Test
    fun aWriteWhoseCallerIsCancelledStillRecordsTheServersAnswer() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.named()

        // Conference-wide visibility.
        val profileGate = CompletableDeferred<Unit>()
        var storedOpen: Boolean? = null
        h.server.profilePut = { r ->
            storedOpen = (r.jsonObject["open_to_meet"] as JsonPrimitive).boolean
            profileGate.await()
            h.server.echoProfile(r)
        }
        val visible = launch { h.controller.setOpenToMeet(true) }
        runCurrent()
        visible.cancel()
        runCurrent()
        profileGate.complete(Unit)
        runCurrent()
        assertEquals(true, storedOpen)
        assertTrue(h.state.visibility.openToMeet && h.state.visibility.onServer, "the phone shows what the server stored")
        assertTrue(h.state.hasDevice)

        // A share for a talk.
        val shareGate = CompletableDeferred<Unit>()
        var storedShares: List<String>? = null
        h.server.profilePut = { r ->
            storedShares = (r.jsonObject["shared_talk_ids"] as JsonArray).map { (it as JsonPrimitive).content }
            shareGate.await()
            h.server.echoProfile(r)
        }
        val share = launch { h.controller.shareForTalk(talk(1001), true) }
        runCurrent()
        share.cancel()
        runCurrent()
        shareGate.complete(Unit)
        runCurrent()
        assertEquals(listOf(talk(1001)), storedShares)
        assertEquals(storedShares, h.state.visibility.sharedTalkIds)

        // Presence.
        val presenceGate = CompletableDeferred<Unit>()
        var storedZone: String? = null
        h.server.presencePut = { r ->
            storedZone = (r.jsonObject["zone"] as JsonPrimitive).content
            presenceGate.await()
            h.server.presenceOk(r)
        }
        val on = launch { h.controller.turnOnPresence("Hallway", "") }
        runCurrent()
        on.cancel()
        runCurrent()
        presenceGate.complete(Unit)
        runCurrent()
        assertEquals("Hallway", storedZone)
        assertTrue(h.state.presence.on, "the switch shows on, so turning it off sends the delete")
        assertEquals("Hallway", h.state.presence.zone)
        h.controller.turnOffPresence()
        assertEquals(1, h.sent("DELETE", "/api/presence").size)
    }

    // ---------------------------------------------------------------------------------------------
    // One session per backend

    @Test
    fun leavingABackendAndComingBackDuringItsDeleteKeepsOneSession() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        val gate = CompletableDeferred<Unit>()
        h.server.profileDelete = {
            gate.await()
            h.server.ok()
        }
        val delete = async { h.controller.deleteMyProfile() }
        runCurrent()
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size)

        h.controller.updateContext(h.context().copy(backend = other))
        runCurrent()
        h.controller.updateContext(h.context())
        runCurrent()
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size, "coming back sends no second delete while the first is under way")

        gate.complete(Unit)
        assertTrue(delete.await().done)
        runCurrent()
        assertEquals(Profile.EMPTY, h.state.profile, "the session on screen is the one the delete cleared")
        assertFalse(h.state.deletes.unfinished)
        assertFalse(h.state.hasDevice)
        advanceTimeBy(3_600_000)
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size, "no retry timer was left behind")
    }

    @Test
    fun aPresenceWriteUnderWayWhenTheBackendIsLeftIsKept() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        val gate = CompletableDeferred<Unit>()
        h.server.presencePut = { r ->
            gate.await()
            h.server.presenceOk(r)
        }
        val on = async { h.controller.turnOnPresence("Hallway", "") }
        runCurrent()
        h.controller.updateContext(h.context().copy(backend = other))
        runCurrent()
        gate.complete(Unit)
        assertNull(on.await())
        h.controller.updateContext(h.context())
        runCurrent()
        assertTrue(h.state.presence.on, "the server's answer is recorded although another backend was selected")
        // One expiry timer: the hour ends with one delete.
        advanceTimeBy(3_600_000 + 1)
        runCurrent()
        assertFalse(h.state.presence.on)
        assertEquals(1, h.sent("DELETE", "/api/presence").size)
    }

    @Test
    fun comingBackToABackendKeepsOneInboxPoll() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.setInboxVisible(true)
        runCurrent()
        repeat(2) {
            h.controller.updateContext(h.context().copy(backend = other))
            runCurrent()
            h.controller.updateContext(h.context())
            runCurrent()
        }
        h.http.sent.clear()
        advanceTimeBy(10 * ConnectRuntime.INBOX_POLL_MS + 1)
        assertEquals(10, h.sent("GET", "/api/meet/inbox").count { it.url.startsWith(BACKEND.base) })
    }

    // ---------------------------------------------------------------------------------------------
    // Circle counts

    private fun countsServer(h: PeopleHarness, answer: (SentRequest) -> app.conferencecaddie.shared.net.HttpResponse = { r -> counted(r) }) {
        h.server.other = { r -> if (r.path == "/api/circles/counts") answer(r) else FakeApiHttp.json(404, """{"error":"Not found"}""") }
    }

    private fun idsOf(r: SentRequest) = (r.jsonObject["talk_ids"] as JsonArray).map { (it as JsonPrimitive).content }

    private fun countOf(id: String) = id.substringAfterLast(':').toInt() % 7

    private fun counted(r: SentRequest) =
        FakeApiHttp.json(200, """{"counts":{${idsOf(r).joinToString(",") { "\"$it\":${countOf(it)}" }}}}""")

    private fun countRequests(h: PeopleHarness) = h.sent("POST", "/api/circles/counts")

    @Test
    fun perCardCountCallsShareOneRequest() = runTest {
        val h = PeopleHarness(this)
        countsServer(h)
        h.start()
        val ids = (1001..1012).map { talk(it) }
        val results = ids.map { id -> async { h.controller.circleCounts(listOf(id)) } }.awaitAll()
        assertEquals(1, countRequests(h).size, "one request for every card")
        assertEquals(ids, idsOf(countRequests(h).single()))
        results.forEachIndexed { i, m -> assertEquals(mapOf(ids[i] to countOf(ids[i])), m, "each card gets its own talk") }

        // A hundred talks at most per request.
        val many = (2001..2150).map { talk(it) }
        val counts = h.controller.circleCounts(many)
        assertEquals(listOf(100, 50), countRequests(h).drop(1).map { idsOf(it).size })
        assertEquals(many.associateWith { countOf(it) }, counts)
    }

    @Test
    fun aFailedCountIsNotAskedForAgainWithinTheTtl() = runTest {
        val h = PeopleHarness(this)
        countsServer(h)
        h.start()
        assertEquals(mapOf(talk(1004) to countOf(talk(1004))), h.controller.circleCounts(listOf(talk(1004))))
        countsServer(h) { FakeApiHttp.json(502, """{"error":"People are temporarily unavailable"}""") }
        assertTrue(h.controller.circleCounts(listOf(talk(1005))).isEmpty())
        assertEquals(2, countRequests(h).size)
        repeat(5) { assertTrue(h.controller.circleCounts(listOf(talk(1005))).isEmpty()) }
        assertEquals(2, countRequests(h).size, "the failure is kept like an answer")

        // Out of date: asked again; a count read before keeps showing when that fails.
        advanceTimeBy(PeopleController.COUNT_TTL_MS + 1)
        assertEquals(mapOf(talk(1004) to countOf(talk(1004))), h.controller.circleCounts(listOf(talk(1004), talk(1005))))
        assertEquals(3, countRequests(h).size)
        assertEquals(listOf(talk(1004), talk(1005)), idsOf(countRequests(h).last()))
        h.controller.circleCounts(listOf(talk(1004), talk(1005)))
        assertEquals(3, countRequests(h).size)
    }

    @Test
    fun aRetryAfterHoldsEveryCountRequestBack() = runTest {
        val h = PeopleHarness(this)
        countsServer(h) { FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "300")) }
        h.start()
        assertTrue(h.controller.circleCounts(listOf(talk(1001))).isEmpty())
        assertEquals(1, countRequests(h).size)
        countsServer(h)
        advanceTimeBy(PeopleController.COUNT_TTL_MS + 1)
        assertTrue(h.controller.circleCounts(listOf(talk(1001), talk(1002))).isEmpty(), "past the TTL, still inside Retry-After")
        advanceTimeBy(200_000)
        assertTrue(h.controller.circleCounts(listOf(talk(1003))).isEmpty(), "a talk never asked about waits too")
        assertEquals(1, countRequests(h).size)
        advanceTimeBy(40_000)
        assertEquals(mapOf(talk(1001) to countOf(talk(1001)), talk(1003) to countOf(talk(1003))), h.controller.circleCounts(listOf(talk(1001), talk(1003))))
        assertEquals(2, countRequests(h).size)
    }

    @Test
    fun aCountCallerThatStopsWaitingLeavesTheOthersTheirCounts() = runTest {
        val h = PeopleHarness(this)
        val gate = CompletableDeferred<Unit>()
        countsServer(h)
        h.start()
        h.server.other = { r ->
            gate.await()
            counted(r)
        }
        val a = async { h.controller.circleCounts(listOf(talk(1001))) }
        val b = async { h.controller.circleCounts(listOf(talk(1002))) }
        advanceTimeBy(PeopleController.COUNT_BATCH_MS + 1)
        runCurrent()
        assertEquals(1, countRequests(h).size, "the request is under way")
        a.cancel()
        runCurrent()
        gate.complete(Unit)
        assertEquals(mapOf(talk(1002) to countOf(talk(1002))), b.await())
        assertEquals(mapOf(talk(1001) to countOf(talk(1001))), h.controller.circleCounts(listOf(talk(1001))), "the cancelled caller's talk was counted too")
        assertEquals(1, countRequests(h).size)
    }

    // ---------------------------------------------------------------------------------------------
    // Push, People I met, notices

    @Test
    fun pushAsksForAVisibleProfileBeforeTheSystemPrompt() = runTest {
        val push = FakePush("apns", PushToken("apns", "ab".repeat(32), environment = "sandbox"))
        val h = PeopleHarness(this, push = push)
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        h.start(PEOPLE_ON.copy(push = Capabilities.Push(apns = true)))
        h.named()
        assertEquals(PushOutcome.ProfileNeeded, h.controller.enablePush())
        assertEquals(0, push.registered, "no notification prompt without a visible profile")
        assertTrue(h.sent("PUT", "/api/push/native").isEmpty())

        assertNull(h.controller.shareForTalk(talk(1001), true))
        assertEquals(PushOutcome.On, h.controller.enablePush(), "a shared talk is a visible profile too")
        assertEquals(1, push.registered)
    }

    @Test
    fun removingSomeoneIMetTwiceRemovesThemOnce() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.controller.saveMet("Ana", "SRE")
        h.controller.saveMet("Ben", null)
        val ana = h.state.met.first()
        h.controller.removeMet(ana)
        h.controller.removeMet(ana)
        assertEquals(listOf("Ben"), h.state.met.map { it.displayName }, "a double tap does not remove the next person")
    }

    @Test
    fun aNoticeSaysWhetherItOpensTheProfile() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertNull(h.controller.followInterested())

        // A failed automatic share: nothing to fix on the profile.
        h.server.profilePut = { FakeApiHttp.json(502, """{"error":"People are temporarily unavailable"}""") }
        h.controller.updateContext(h.context(interested = listOf(talk(1001))))
        runCurrent()
        assertEquals(PeopleNotice(PeopleError.UNAVAILABLE_MESSAGE, opensProfile = false), h.state.notice)
        h.controller.clearNotice()
        assertNull(h.state.notice)

        // A profile without a name: the fix is on the profile.
        h.server.profilePut = { h.server.echoProfile(it) }
        h.controller.updateProfile { it.copy(displayName = "") }
        h.controller.updateContext(h.context(interested = listOf(talk(1001), talk(1002))))
        runCurrent()
        assertEquals(PeopleNotice("Add your name to your profile first.", opensProfile = true), h.state.notice)

        // A malformed LinkedIn link says nothing of the profile, but is fixed there too.
        h.controller.updateProfile { it.copy(displayName = "Caddie Native Test A", linkedinUrl = "https://example.com/ana") }
        h.controller.updateContext(h.context(interested = listOf(talk(1001), talk(1002), talk(1003))))
        runCurrent()
        val notice = h.state.notice!!
        assertTrue(notice.opensProfile, notice.message)
        assertFalse(notice.message.contains("profile"))
    }
}
