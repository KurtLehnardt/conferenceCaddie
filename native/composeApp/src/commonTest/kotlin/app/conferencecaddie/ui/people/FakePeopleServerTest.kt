package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.shared.ble.BlePayloadSource
import app.conferencecaddie.shared.ble.BlePermissionKind
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.BleProtocol
import app.conferencecaddie.shared.ble.BleRadio
import app.conferencecaddie.shared.ble.BleRadioConfig
import app.conferencecaddie.shared.ble.BleRadioEvents
import app.conferencecaddie.shared.ble.BleRadioState
import app.conferencecaddie.shared.ble.HmacSha256
import app.conferencecaddie.shared.ble.InMemoryBleKeyStore
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.core.BundleState
import app.conferencecaddie.shared.core.CaddieCore
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.BleOutcome
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.MatchesResponse
import app.conferencecaddie.shared.people.MeetState
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleContext
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeoplePrivacy
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.shared.people.Proximity
import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.shared.people.ReportReason
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray

// FakePeopleServer driven by the real PeopleController: the whole flow from profile to delete, the
// failure modes, and the privacy rules, plus the raw shapes of a few answers. Plain tests, no UI.
class FakePeopleServerTest {
    private val slug = "alpha-conf-2099"
    private val talk1 = "alpha-conf-2099:1"
    private val talk3 = "alpha-conf-2099:3"

    private val peopleOn = Capabilities(
        people = Capabilities.People(
            enabled = true,
            semantic = Capabilities.Semantic.Server,
            presence = true,
            gpsBands = true,
            meets = true,
            circles = true,
            reports = true,
        ),
    )

    /** A test clock on the scheduler's virtual time, so delays move the fake server's time too. */
    private fun TestScope.virtualClock(): Clock = object : Clock {
        override fun now(): Instant = Instant.fromEpochMilliseconds(TestClock.START_MS + testScheduler.currentTime)
    }

    private class Rig(val test: TestScope, val clock: Clock, services: PeopleServices = PeopleServices(InMemorySecureStore())) {
        val server = FakePeopleServer({ clock.now().toEpochMilliseconds() }, FakeConference.alpha())
        val controller: PeopleController = testPeopleController(server, test.backgroundScope, clock, services = services)
        val state get() = controller.state.value
        val me: FakePerson get() = server.me("alpha-conf-2099") ?: error("No profile on the server")
        val keyValue = InMemoryPeopleKeyValue()
    }

    private suspend fun TestScope.rig(caps: Capabilities = peopleOn, services: PeopleServices = PeopleServices(InMemorySecureStore())): Rig = Rig(this, virtualClock(), services).also {
        it.controller.updateContext(
            PeopleContext(
                backend = testBackendUrl(),
                capabilities = caps.forThisApp(),
                conference = ConferenceInfo(slug, "Alpha Conference", "UTC"),
                bundle = null,
            ),
        )
        runCurrent()
    }

    /** A named profile that is visible conference-wide, wanting to learn eBPF. */
    private suspend fun TestScope.makeVisible(r: Rig) {
        r.controller.updateProfile { it.copy(displayName = "Me Myself", about = "Tester.", interests = "tracing") }
        r.controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = emptyList())
        assertNull(r.controller.setOpenToMeet(true))
        runCurrent()
    }

    private fun MatchesResponse.names() = results.map { it.displayName }

    private fun <T> ApiResult<T>.ok(): T = (this as? ApiResult.Ok)?.value ?: error("Failed: ${(this as ApiResult.Failed).error}")

    /** Sends [method] [path] as the device under test, with the credential the controller sent last. */
    private suspend fun Rig.raw(method: String, path: String, body: JsonObject? = null, device: String? = null): Pair<Int, JsonObject> {
        val header = device ?: server.requests.last { it.header("X-Caddie-Device") != null }.header("X-Caddie-Device")!!
        val before = server.requests.size
        val r: HttpResponse = server.send(method, "https://caddie.test$path", mapOf("X-Caddie-Device" to header), body?.toString()?.encodeToByteArray(), 1000, 1_000_000)
        while (server.requests.size > before) server.requests.removeAt(server.requests.size - 1)
        return r.status to (Json.parseToJsonElement(r.text()) as JsonObject)
    }

    @Test
    fun theWholeFlowFromProfileToDelete() = runTest {
        val r = rig()
        val ada = r.server.seedPerson(
            slug, "Ada Seed", about = "Platform engineer.", expertise = "Ran eBPF tracing for 200 clusters. Also Kubernetes upgrades.",
            speakTopics = listOf("ebpf"), around = "Hallway", located = true,
        )
        assertEquals(PeopleAvailability.Ready, r.state.availability)

        // Create a visible profile: the server holds it, the device has a credential, no Origin went out.
        makeVisible(r)
        assertTrue(r.state.hasDevice)
        assertTrue(r.state.visibility.onServer)
        val put = r.server.requests("PUT", "/api/people/profile").single()
        assertNotNull(put.header("X-Caddie-Device"))
        assertFalse(r.server.anyOrigin())
        assertEquals(slug, put.body!!.getValue("event").let { (it as JsonPrimitive).content })
        assertNotNull(r.server.me(slug))

        // Search finds the seeded person with evidence, and no zone while I am not around.
        val found = r.controller.searchPeople("ebpf", around = false).ok().results.single()
        assertEquals("Ada Seed", found.displayName)
        assertEquals("Ran <mark>eBPF</mark> tracing for 200 clusters.", found.evidence)
        assertEquals("They've worked on Ran <mark>eBPF</mark> tracing for 200 clusters.", found.opener)
        assertTrue(found.around)
        assertNull(found.zone)
        assertNull(found.proximity)
        assertEquals(ada.ref, found.ref)
        assertEquals(listOf(TopicRef("ebpf", "eBPF")), found.speakTopics)

        // Without a query the reasons name the shared topic; the people to meet list holds her too.
        val toMeet = r.controller.searchPeople(null, around = false).ok().results.single()
        assertEquals("They can speak to eBPF, which you want to learn about.", toMeet.opener)

        // Presence on: the around view now has her zone and a band.
        assertNull(r.controller.turnOnPresence("Hallway", "by the coffee"))
        runCurrent()
        assertTrue(r.state.presence.on)
        val around = r.controller.searchPeople(null, around = true).ok().results.single()
        assertEquals("Hallway", PeoplePrivacy.zone(around, true))
        assertEquals(Proximity.SameZone, PeoplePrivacy.proximity(around, true))
        assertEquals("They're in Hallway right now.", around.reasons.last())

        // Ask: requested, same zone, her zone shown while both are around; a second ask names the open meet.
        val asked = r.controller.ask(around, "Want to talk eBPF?", topicId = "ebpf").ok()
        assertEquals(MeetState.Requested, asked.state)
        assertTrue(asked.requestedByMe)
        assertEquals("eBPF", asked.topicLabel)
        assertEquals("Hallway", PeoplePrivacy.zone(asked))
        val second = r.controller.ask(around, "Again?").errorOrNull
        assertEquals(PeopleError.Kind.MeetOpen, second?.kind)
        assertEquals(asked.meetId, second?.meetId)

        // She accepts: active at once. No distance until both have a position.
        assertEquals("active", ada.accept(asked.meetId))
        val active = r.controller.readMeet(asked.meetId).ok()
        assertEquals(MeetState.Active, active.meet.state)
        assertNull(PeoplePrivacy.distance(active))
        r.me.locate(40.77689, -111.89012)
        val located = r.controller.readMeet(asked.meetId).ok()
        val d = assertNotNull(PeoplePrivacy.distance(located))
        assertTrue(d.meters in 990..1010, "distance ${d.meters}")
        assertTrue(d.bearingDegrees in 178..182, "bearing ${d.bearingDegrees}")
        // The action answers never carry it.
        assertNull(r.controller.setSpotMe(asked.meetId, "Red scarf").ok().other.distanceM)

        // Found: the meet is over, so a read is 410.
        assertEquals(MeetState.Found, r.controller.foundMeet(asked.meetId).ok().state)
        assertEquals(410, r.controller.readMeet(asked.meetId).errorOrNull?.status)

        // Block her: she leaves the results, appears in the list, and cannot ask me.
        assertNull(r.controller.block(ada.ref, "Ada Seed"))
        assertTrue(r.controller.searchPeople(null, around = false).ok().results.isEmpty())
        r.controller.refreshBlocks()
        assertEquals(listOf(ada.ref), r.state.blocks.map { it.ref })
        assertEquals("Ada Seed", r.state.blocks.single().displayName)
        assertEquals(403, assertFailsWith<FakeCallFailed> { ada.ask(r.me.ref) }.status)
        val (status, matches) = r.raw("POST", "/api/people/matches", buildJsonObject { put("event", slug) })
        assertEquals(200, status)
        assertTrue((matches["results"] as JsonArray).isEmpty())

        // Report her too: the server accepts it (one report does not hide).
        val report = r.controller.report(ada.ref, ReportKind.Profile, ada.ref, ReportReason.Spam).ok()
        assertFalse(report.hidden)

        // Delete my profile: the server copy goes, the device forgets its credential and visibility.
        val result = r.controller.deleteMyProfile()
        assertTrue(result.done, result.message)
        assertNull(r.server.me(slug))
        assertFalse(r.state.hasDevice)
        assertFalse(r.state.visibility.openToMeet)
        assertFalse(r.state.deletes.unfinished)
        assertEquals(1, r.server.requests("DELETE", "/api/people/profile").size)
        assertFalse(r.server.anyOrigin())
    }

    @Test
    fun aDeleteThatFailsIsUnfinishedAndAVirtualHourLaterItSucceeds() = runTest {
        val r = rig()
        makeVisible(r)
        r.server.failNextDeletes(2)

        val first = r.controller.deleteMyProfile()
        assertFalse(first.done)
        assertTrue(r.state.deletes.unfinished)
        assertTrue(r.state.deletes.deleteAll)
        assertNotNull(r.server.me(slug))

        // "Try again" is refused once more by the fake, then the server recovers and the retry finishes.
        assertFalse(r.controller.finishPendingDeletes())
        assertTrue(r.state.deletes.unfinished)
        assertTrue(r.controller.finishPendingDeletes())
        assertFalse(r.state.deletes.unfinished)
        assertNull(r.server.me(slug))
        assertFalse(r.state.hasDevice)
        assertEquals(3, r.server.requests("DELETE", "/api/people/profile").size)
    }

    @Test
    fun anUnfinishedDeleteRetriesByItselfOnVirtualTime() = runTest {
        val r = rig()
        makeVisible(r)
        r.server.failNextDeletes(1, status = 503)
        assertFalse(r.controller.deleteMyProfile().done)
        assertTrue(r.state.deletes.unfinished)

        delay(2 * 60 * 60_000L)
        runCurrent()
        assertFalse(r.state.deletes.unfinished, "the automatic retry did not run")
        assertNull(r.server.me(slug))
    }

    @Test
    fun offlineAndRateLimitedAnswersMapToTheControllersErrors() = runTest {
        val r = rig()
        makeVisible(r)

        r.server.failure = FakeFailure.Offline
        assertEquals(PeopleError.Kind.Offline, r.controller.searchPeople("ebpf", around = false).errorOrNull?.kind)

        r.server.failure = FakeFailure.RateLimited(retryAfterSeconds = 45)
        val limited = r.controller.searchPeople("ebpf", around = false).errorOrNull
        assertEquals(429, limited?.status)
        assertEquals(45L, limited?.retryAfterSeconds)

        r.server.failure = FakeFailure.ServerError(503)
        assertEquals(503, r.controller.searchPeople("ebpf", around = false).errorOrNull?.status)

        r.server.failure = FakeFailure.None
        assertTrue(r.controller.searchPeople("ebpf", around = false) is ApiResult.Ok)
    }

    @Test
    fun aDeclineIsSilentAndAnAskRunsOutAfterFifteenMinutes() = runTest {
        val r = rig()
        makeVisible(r)
        val bob = r.server.seedPerson(slug, "Bob Seed", expertise = "Security reviews.", around = "Hallway")
        val cy = r.server.seedPerson(slug, "Cy Seed", expertise = "Security audits.", around = "Hallway")
        assertNull(r.controller.turnOnPresence("Hallway", ""))
        runCurrent()
        val people = r.controller.searchPeople(null, around = true).ok().results.associateBy { it.displayName }

        val toBob = r.controller.ask(people.getValue("Bob Seed"), "Hi").ok()
        assertEquals("declined", bob.decline(toBob.meetId))
        r.controller.refreshInbox()
        runCurrent()
        assertEquals(listOf(MeetState.Requested), r.state.inbox.outgoing.map { it.state })
        assertEquals(MeetState.Requested, r.state.inbox.askStates[bob.ref])

        val toCy = r.controller.ask(people.getValue("Cy Seed"), "Hi").ok()
        delay(16 * 60_000L)
        assertEquals("expired", r.server.meetState(toCy.meetId))
        assertEquals(410, r.controller.readMeet(toCy.meetId).errorOrNull?.status)
        assertEquals(410, assertFailsWith<FakeCallFailed> { cy.accept(toCy.meetId) }.status)
    }

    @Test
    fun anAskNeedsBothToBeAroundAndNotBlocked() = runTest {
        val r = rig()
        makeVisible(r)
        val eve = r.server.seedPerson(slug, "Eve Seed", expertise = "Networking.", around = "Hallway")
        val zed = r.server.seedPerson(slug, "Zed Seed", expertise = "Networking too.")
        val results = r.controller.searchPeople(null, around = false).ok().results.associateBy { it.displayName }

        // I am not around.
        assertEquals(PeopleError.Kind.PresenceRequired, r.controller.ask(results.getValue("Eve Seed"), "Hi").errorOrNull?.kind)
        assertNull(r.controller.turnOnPresence("Hallway", ""))
        runCurrent()
        // Zed is not around.
        assertEquals(PeopleError.Kind.NotAround, r.controller.ask(results.getValue("Zed Seed"), "Hi").errorOrNull?.kind)
        // Eve blocks me, in either direction the same answer.
        eve.block(r.me.ref)
        assertEquals(PeopleError.Kind.Blocked, r.controller.ask(results.getValue("Eve Seed"), "Hi").errorOrNull?.kind)
        assertTrue(zed.ref.length == 16)
    }

    @Test
    fun twoReportsHideAProfileFromEveryoneButItsOwner() = runTest {
        val r = rig()
        makeVisible(r)
        val bob = r.server.seedPerson(slug, "Bob Seed", expertise = "Security reviews.")
        val cy = r.server.seedPerson(slug, "Cy Seed", expertise = "Security audits.")
        val dee = r.server.seedPerson(slug, "Dee Seed", expertise = "Security work.")

        assertEquals(setOf("Bob Seed", "Cy Seed", "Dee Seed"), r.controller.searchPeople(null, around = false).ok().names().toSet())
        assertFalse(r.controller.report(bob.ref, ReportKind.Profile, bob.ref, ReportReason.Harassment).ok().hidden)
        assertTrue(cy.report(bob.ref))
        assertTrue(bob.hidden)
        assertEquals(setOf("Cy Seed", "Dee Seed"), r.controller.searchPeople(null, around = false).ok().names().toSet())

        // Two reports of me hide me from the others, and my own save says so.
        assertFalse(bob.report(r.me.ref))
        assertTrue(dee.report(r.me.ref))
        r.controller.updateProfile { it.copy(about = "Still here.") }
        delay(10_000)
        runCurrent()
        assertTrue(r.state.visibility.hiddenForOwner)
        // A hidden person cannot be asked, but can still be blocked.
        assertNull(r.controller.block(bob.ref, "Bob Seed"))
    }

    @Test
    fun circlesShowCountsToAllAndMembersOnlyToASharer() = runTest {
        val r = rig()
        r.server.seedPerson(slug, "Ada Seed", expertise = "eBPF.", sharedTalkIds = listOf(talk1), openToMeet = false)
        r.server.seedPerson(slug, "Bob Seed", expertise = "Kubernetes.", sharedTalkIds = listOf(talk1, talk3))
        r.controller.updateProfile { it.copy(displayName = "Me Myself") }

        assertEquals(mapOf(talk1 to 2, talk3 to 1), r.controller.circleCounts(listOf(talk1, talk3)))

        // I share for talk 3 only: talk 1 is 403 share_required with its count.
        assertNull(r.controller.shareForTalk(talk3, true))
        runCurrent()
        val refused = r.controller.circleMembers(talk1).errorOrNull
        assertEquals(PeopleError.Kind.ShareRequired, refused?.kind)
        assertEquals(2, refused?.count)
        val members = r.controller.circleMembers(talk3).ok()
        assertEquals(2, members.count)
        assertEquals(listOf("Bob Seed"), members.members.map { it.displayName })
        assertEquals("Kubernetes scheduling deep dive", members.talk.title)
        assertTrue("You are both interested in Kubernetes scheduling deep dive." in members.members.single().reasons)
        // Sharing for a talk does not make me visible conference-wide.
        assertEquals(PeopleError.Kind.VisibilityRequired, r.controller.searchPeople(null, around = false).errorOrNull?.kind)
    }

    @Test
    fun matchesPageAndRankByWords() = runTest {
        val r = rig()
        makeVisible(r)
        for (i in 1..25) r.server.seedPerson(slug, "Person ${i.toString().padStart(2, '0')}", expertise = "Worked on <tracing> & more $i.")
        r.server.seedPerson(slug, "Other", expertise = "Cooking.")

        val first = r.controller.searchPeople("tracing", around = false).ok()
        assertEquals(20, first.results.size)
        assertTrue(first.hasMore)
        assertEquals("Worked on &lt;<mark>tracing</mark>&gt; &amp; more 1.", first.results.first().evidence)
        val second = r.controller.searchPeople("tracing", around = false, from = 20).ok()
        assertEquals(5, second.results.size)
        assertFalse(second.hasMore)
        assertFalse("Other" in first.names() + second.names())
    }

    @Test
    fun theSharedShapesAndErrorsOfTheContractHold() = runTest {
        val r = rig()
        makeVisible(r)
        val ada = r.server.seedPerson(slug, "Ada Seed", expertise = "eBPF tracing.", around = "Hallway", located = true)

        // Closed request shapes: an unknown key is 400; an unknown conference is 400.
        val (unknownStatus, unknown) = r.raw("POST", "/api/people/block", buildJsonObject { put("event", slug); put("ref", ada.ref); put("extra", 1) })
        assertEquals(400, unknownStatus)
        assertEquals("Unknown key: extra", (unknown["error"] as JsonPrimitive).content)
        assertEquals(400, r.raw("POST", "/api/people/matches", buildJsonObject { put("event", "nope") }).first)

        // A wrong secret for a known profile is 403 forbidden; so is a malformed credential.
        val real = r.server.requests.last { it.header("X-Caddie-Device") != null }.header("X-Caddie-Device")!!
        val wrong = real.substringBefore('.') + "." + "A".repeat(43)
        val (forbidden, body) = r.raw("POST", "/api/people/matches", buildJsonObject { put("event", slug) }, device = wrong)
        assertEquals(403, forbidden)
        assertEquals("forbidden", (body["error"] as JsonPrimitive).content)
        assertEquals(403, r.raw("POST", "/api/people/matches", buildJsonObject { put("event", slug) }, device = "short.cred").first)

        // Blocks list: newest first, display_name null once the blocked profile is gone.
        val bob = r.server.seedPerson(slug, "Bob Seed")
        assertEquals(200, r.raw("POST", "/api/people/block", buildJsonObject { put("event", slug); put("ref", ada.ref) }).first)
        delay(1000)
        assertEquals(200, r.raw("POST", "/api/people/block", buildJsonObject { put("event", slug); put("ref", bob.ref) }).first)
        r.server.me(slug)
        val listed = r.raw("GET", "/api/people/blocks?event=$slug").second
        assertEquals(listOf(bob.ref, ada.ref), (listed["refs"] as JsonArray).map { (it as JsonPrimitive).content })
        val entries = listed["blocks"] as JsonArray
        assertEquals("Bob Seed", ((entries[0] as JsonObject)["display_name"] as JsonPrimitive).content)
        assertTrue(((entries[1] as JsonObject)["created_at"] as JsonPrimitive).content.endsWith(".000Z"))
        // Unblocking works whether or not the profile exists; an unknown ref to block is 404.
        assertEquals(404, r.raw("POST", "/api/people/block", buildJsonObject { put("event", slug); put("ref", "0123456789abcdef") }).first)
        assertEquals(200, r.raw("DELETE", "/api/people/block", buildJsonObject { put("event", slug); put("ref", "0123456789abcdef") }).first)

        // Presence: an unknown zone is 400, a line held by the filter is 400 filtered.
        assertEquals(400, r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Moon") }).first)
        val (filteredStatus, filtered) = r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("spot", "badword here") })
        assertEquals(400, filteredStatus)
        assertEquals("filtered", (filtered["error"] as JsonPrimitive).content)
        val on = r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("location", JsonNull); put("until", "day") }).second
        assertEquals(setOf("ok", "zone", "spot", "spot_hidden", "until", "presence_since", "presence_until", "located"), on.keys)
        assertEquals("day", (on["until"] as JsonPrimitive).content)

        // Native push: 404 push_unavailable until the server is configured, then 200 and stored.
        val token = "ab".repeat(32)
        val push = buildJsonObject { put("event", slug); put("platform", "apns"); put("token", token) }
        val (pushStatus, pushBody) = r.raw("PUT", "/api/push/native", push)
        assertEquals(404, pushStatus)
        assertEquals("push_unavailable", (pushBody["error"] as JsonPrimitive).content)
        r.server.pushPlatforms = setOf("apns")
        assertEquals(200, r.raw("PUT", "/api/push/native", push).first)
        assertEquals(setOf("apns:$token"), r.server.pushRegistrations(r.me))
        assertEquals(200, r.raw("DELETE", "/api/push/native", push).first)
        assertEquals(emptySet(), r.server.pushRegistrations(r.me))
        assertEquals(405, r.raw("GET", "/api/people/profile").first)
        assertEquals(404, r.raw("GET", "/api/nothing").first)
    }

    @Test
    fun theControllerFollowsARealCoreOnTestBackendWithRoomsAndTopics() = runTest {
        val backend = TestBackend(people = true)
        val root = Path(SystemTemporaryDirectory, "caddie-people-${Random.nextLong().toULong()}")
        val files = BundleFiles(Path(root, "bundles")).also { SystemFileSystem.createDirectories(Path(root, "bundles")) }
        val database = CaddieDatabase.open(":memory:")
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            withContext(Dispatchers.Default) {
                val core = CaddieCore(database, files, backend, scope, allowLocalHttp = false)
                core.setBackend(testBackendUrl(backend.base))
                // The core has fetched the capabilities and the list and installed the bundle.
                core.awaitIdle()
                assertTrue(core.state.value.bundle is BundleState.Ready)
                val clock = TestClock()
                val server = FakePeopleServer({ clock.ms }, FakeConference.alpha())
                val controller = testPeopleController(server, scope, clock)
                controller.bind(core.state)
                withTimeout(20_000) {
                    controller.state.first { it.availability == PeopleAvailability.Ready && it.zones.contains("Hall A") }
                }
                val state = controller.state.value
                assertEquals(listOf("Hall A", "Hall B"), state.zones.take(2))
                assertTrue(state.features.meets)

                controller.updateProfile { it.copy(displayName = "Me Myself") }
                controller.setTopics(learn = listOf(TopicRef("ebpf", "eBPF")), speak = listOf(TopicRef("kubernetes", "Kubernetes")))
                assertNull(controller.setOpenToMeet(true))
                assertNull(controller.turnOnPresence("Hall A", "Row 3"))
                assertEquals("Hall A", controller.state.value.presence.zone)
                assertNotNull(server.me(slug))
                controller.close()
            }
        } finally {
            // Every job must have stopped before the database closes.
            scope.coroutineContext.job.cancelAndJoin()
            files.clear()
            SystemFileSystem.delete(Path(root, "bundles"), mustExist = false)
            SystemFileSystem.delete(root, mustExist = false)
            database.closeWhenIdle()
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Bluetooth (derived-v1)

    private fun sightingsBody(vararg sightings: Pair<String, Int>) = buildJsonObject {
        put("event", slug)
        putJsonArray("sightings") {
            for ((token, rssi) in sightings) addJsonObject {
                put("token", token)
                put("rssi", rssi)
            }
        }
    }

    private fun JsonObject.str(key: String): String = (getValue(key) as JsonPrimitive).content

    @Test
    fun bluetoothKeysAreIssuedOnceAndSightingsResolveDerivedTokens() = runTest {
        val r = rig()
        makeVisible(r)
        assertNull(r.controller.turnOnPresence("Hallway", ""))
        val ada = r.server.seedPerson(slug, "Ada Seed", expertise = "Ran eBPF tracing for 200 clusters. Also upgrades.", speakTopics = listOf("ebpf"), around = "Hallway")
        ada.bluetooth()
        val far = r.server.seedPerson(slug, "Far Seed", expertise = "Elsewhere.", around = "Expo hall")
        far.bluetooth()
        val now = r.clock.now().toEpochMilliseconds()
        fun token(p: FakePerson, at: Long = now) = BleProtocol.decodePayload(r.server.blePayload(p, at))!!.text

        // No session of my own yet: 403 ble_required.
        val (noSession, refused) = r.raw("POST", "/api/presence/sightings", sightingsBody(token(ada) to -50))
        assertEquals(403, noSession)
        assertEquals("ble_required", refused.str("error"))

        // ble: true issues a key and its id, once; each such write starts a new session.
        val first = r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("spot", ""); put("ble", true) }).second
        val key = BleProtocol.decodeKey(first.str("ble_key"))!!
        assertEquals(BleProtocol.keyIdOf(HmacSha256.mac(key, BleProtocol.keyIdMessage())), first.str("ble_key_id"))
        assertEquals(r.server.bleKeyId(r.me), first.str("ble_key_id"))
        val second = r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("spot", ""); put("ble", true) }).second
        assertTrue(first.str("ble_key") != second.str("ble_key"))
        val keyId = second.str("ble_key_id")
        // A write without ble keeps the session and answers no key.
        val plain = r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("spot", "") }).second
        assertFalse("ble_key" in plain)
        assertEquals(keyId, r.server.bleKeyId(r.me))

        // Ada is in my zone; Far is not; an unknown token is nobody.
        val (status, res) = r.raw("POST", "/api/presence/sightings", sightingsBody(token(ada) to -50, token(far) to -50, "A".repeat(22) to -40))
        assertEquals(200, status)
        assertEquals(setOf("nearby", "ble_key_id"), res.keys)
        assertEquals(keyId, res.str("ble_key_id"))
        val near = (res.getValue("nearby") as JsonArray).single() as JsonObject
        assertEquals(setOf("ref", "display_name", "evidence", "speak_topics", "zone"), near.keys)
        assertEquals(ada.ref, near.str("ref"))
        assertEquals("Ran eBPF tracing for 200 clusters.", near.str("evidence"))
        assertEquals("Hallway", near.str("zone"))
        suspend fun resolved(vararg sightings: Pair<String, Int>) =
            (r.raw("POST", "/api/presence/sightings", sightingsBody(*sightings)).second.getValue("nearby") as JsonArray).size
        assertEquals(1, resolved(token(ada, now - 600_000) to -50), "the previous window")
        assertEquals(1, resolved(token(ada, now + 600_000) to -50), "the next window")
        assertEquals(0, resolved(token(ada, now + 1_200_000) to -50), "two windows away")
        assertEquals(0, resolved(token(ada) to -76), "weaker than near_rssi")
        assertEquals(400, r.raw("POST", "/api/presence/sightings", sightingsBody("short" to -50)).first)

        // Ada stops: her tokens resolve to nobody. Mine ends with ble: false.
        val adaToken = token(ada)
        ada.bluetooth(on = false)
        assertNull(r.server.blePayload(ada))
        assertEquals(0, resolved(adaToken to -50))
        r.raw("PUT", "/api/presence", buildJsonObject { put("event", slug); put("zone", "Hallway"); put("spot", ""); put("ble", false) })
        assertEquals(403, r.raw("POST", "/api/presence/sightings", sightingsBody("A".repeat(22) to -50)).first)
    }

    private class TestRadio : BleRadio {
        override val supported = true
        override val permissionKind = BlePermissionKind.NearbyDevices
        override var running = false
        var source: BlePayloadSource? = null
        var events: BleRadioEvents? = null

        override fun access() = BleAccess.Granted
        override suspend fun requestAccess() = BleAccess.Granted
        override fun state() = BleRadioState.Ready
        override fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents) {
            running = true
            this.source = source
            this.events = events
        }
        override fun refresh() = Unit
        override fun stop() {
            running = false
        }
    }

    private class TestNotifier : Notifier {
        val shown = ArrayList<Pair<String, String?>>()
        override suspend fun requestPermission() = true
        override fun show(id: String, title: String, body: String, deepLink: String?) {
            shown += body to deepLink
        }
        override fun cancel(id: String) = Unit
    }

    @Test
    fun theControllerFindsSomeoneRightNearThroughTheFake() = runTest {
        val radio = TestRadio()
        val notifier = TestNotifier()
        val r = rig(
            caps = peopleOn.copy(ble = Capabilities.Ble(mode = Capabilities.BleMode.DerivedV1)),
            services = PeopleServices(InMemorySecureStore(), notifier = notifier, ble = BlePlatform(radio, InMemoryBleKeyStore())),
        )
        makeVisible(r)
        assertNull(r.controller.turnOnPresence("Hallway", ""))
        assertEquals(BleOutcome.On, r.controller.turnOnBluetooth())
        assertTrue(r.state.ble.on)
        // The phone serves the payload of the key the fake issued.
        assertTrue(radio.source!!.payloadNow()!!.contentEquals(r.server.blePayload(r.me)!!))

        val ada = r.server.seedPerson(slug, "Ada Seed", expertise = "Ran eBPF tracing for 200 clusters.", speakTopics = listOf("ebpf"), around = "Hallway")
        ada.bluetooth()
        radio.events!!.onHeard(r.server.blePayload(ada)!!, -50, r.clock.now().toEpochMilliseconds())
        runCurrent()
        assertEquals<List<Pair<String, String?>>>(listOf("Someone who's worked on Ran eBPF tracing for 200 clusters is right near you" to "caddie://people?around=1"), notifier.shown)
        assertEquals(ada.ref, r.state.reveal)

        r.controller.turnOffBluetooth()
        assertFalse(radio.running)
        assertNull(r.server.bleKeyId(r.me), "ble: false ended the session")
    }
}
