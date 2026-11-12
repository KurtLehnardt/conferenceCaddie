package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Clock
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int

// Every example of contracts/fixtures/people-api through the client: the request each route sends
// (method, path, query, device header and the exact body), and how each answer reads: a 2xx decodes,
// and an error maps to the kind the contract's client rule gives it.
class PeopleContractTest {
    private val strict = Json

    // The capabilities whose optional examples this client sends (a fixture example's "requires").
    // until: "keep" (people.presence_keep_until) is not one yet: PresenceMode has no keep, so those
    // requests cannot even be built. Add the flag here when the client sends it.
    private val capabilitiesSent = emptySet<String>()

    private class Route(val method: String, val path: String, val auth: Boolean = true)

    private val routes = mapOf(
        "profile.put" to Route("PUT", "/api/people/profile"),
        "profile.delete" to Route("DELETE", "/api/people/profile"),
        "matches" to Route("POST", "/api/people/matches"),
        "circles.counts" to Route("POST", "/api/circles/counts", auth = false),
        "circles.members" to Route("POST", "/api/circles/members"),
        "block.post" to Route("POST", "/api/people/block"),
        "block.delete" to Route("DELETE", "/api/people/block"),
        "blocks.get" to Route("GET", "/api/people/blocks"),
        "presence.put" to Route("PUT", "/api/presence"),
        "presence.delete" to Route("DELETE", "/api/presence"),
        "ble.rotate" to Route("POST", "/api/presence/ble/rotate"),
        "sightings" to Route("POST", "/api/presence/sightings"),
        "meet.post" to Route("POST", "/api/meet"),
        "meet.inbox" to Route("GET", "/api/meet/inbox"),
        "meet.get" to Route("GET", "/api/meet/{meet_id}"),
        "meet.accept" to Route("POST", "/api/meet/{meet_id}/accept"),
        "meet.decline" to Route("POST", "/api/meet/{meet_id}/decline"),
        "meet.found" to Route("POST", "/api/meet/{meet_id}/found"),
        "meet.cancel" to Route("POST", "/api/meet/{meet_id}/cancel"),
        "meet.details" to Route("PUT", "/api/meet/{meet_id}/details"),
        "report" to Route("POST", "/api/people/report"),
        "push.vapid" to Route("GET", "/api/push/vapid", auth = false),
        "push.subscription.put" to Route("PUT", "/api/push/subscription"),
        "push.subscription.delete" to Route("DELETE", "/api/push/subscription"),
        "push.native.put" to Route("PUT", "/api/push/native"),
        "push.native.delete" to Route("DELETE", "/api/push/native"),
    )

    private fun <T> decodeRequest(serializer: DeserializationStrategy<T>, body: JsonElement?): T = strict.decodeFromJsonElement(serializer, body!!)

    private suspend fun call(api: PeopleApi, route: String, body: JsonElement?, event: String?, meetId: String?): ApiResult<*> = when (route) {
        "profile.put" -> api.putProfile(decodeRequest(ProfilePutRequest.serializer(), body))
        "profile.delete" -> api.deleteProfile(event!!)
        "matches" -> api.matches(decodeRequest(MatchesRequest.serializer(), body))
        "circles.counts" -> api.circleCounts(decodeRequest(CircleCountsRequest.serializer(), body))
        "circles.members" -> api.circleMembers(decodeRequest(CircleMembersRequest.serializer(), body))
        "block.post" -> api.block(decodeRequest(BlockRequest.serializer(), body))
        "block.delete" -> api.unblock(decodeRequest(BlockRequest.serializer(), body))
        "blocks.get" -> api.blocks(event!!)
        "presence.put" -> api.putPresence(decodeRequest(PresencePutRequest.serializer(), body))
        "presence.delete" -> api.deletePresence(event!!)
        "ble.rotate" -> api.rotateBle(decodeRequest(BleRotateRequest.serializer(), body))
        "sightings" -> api.sightings(decodeRequest(SightingsRequest.serializer(), body))
        "meet.post" -> api.requestMeet(decodeRequest(MeetRequest.serializer(), body))
        "meet.inbox" -> api.inbox(event!!)
        "meet.get" -> api.readMeet(meetId!!)
        "meet.accept" -> api.acceptMeet(meetId!!)
        "meet.decline" -> api.declineMeet(meetId!!)
        "meet.found" -> api.foundMeet(meetId!!)
        "meet.cancel" -> api.cancelMeet(meetId!!)
        "meet.details" -> api.putMeetDetails(meetId!!, decodeRequest(MeetDetailsRequest.serializer(), body))
        "report" -> api.report(decodeRequest(ReportRequest.serializer(), body))
        "push.vapid" -> api.vapidKey()
        "push.subscription.put" -> api.putPushSubscription(decodeRequest(PushSubscriptionPutRequest.serializer(), body))
        "push.subscription.delete" -> api.deletePushSubscription(decodeRequest(PushSubscriptionDeleteRequest.serializer(), body))
        "push.native.put" -> api.putNativePush(decodeRequest(NativePushPutRequest.serializer(), body))
        "push.native.delete" -> api.deleteNativePush(decodeRequest(NativePushDeleteRequest.serializer(), body))
        else -> error("no route $route")
    }

    private fun fixtureFiles(): List<String> = Fixtures.names.filter { it.startsWith("people-api/") }.sorted()

    @Test
    fun everyRouteHasExamplesAndEveryExampleIsCovered() {
        val covered = fixtureFiles().map { (Fixtures.json(it) as JsonObject)["route"].let { r -> (r as JsonPrimitive).content } }.toSet()
        assertEquals(routes.keys, covered, "the fixtures and the client cover the same 26 routes")
        assertEquals(26, routes.size)
    }

    @Test
    fun everyExampleGoesThroughTheClient() = runTest {
        var examples = 0
        for (file in fixtureFiles()) {
            val doc = Fixtures.json(file) as JsonObject
            val route = (doc["route"] as JsonPrimitive).content
            val spec = routes.getValue(route)
            for (example in (doc["examples"] as JsonArray).map { it as JsonObject }) {
                val name = (example["name"] as JsonPrimitive).content
                val request = example["request"] as JsonObject
                val response = example["response"] as JsonObject
                val status = (response["status"] as JsonPrimitive).int
                val body = request["body"]
                val event = (request["query"] as? JsonObject)?.get("event")?.let { (it as JsonPrimitive).content }
                val meetId = (request["path_params"] as? JsonObject)?.get("meet_id")?.let { (it as JsonPrimitive).content }
                val header = ((request["headers"] as? JsonObject)?.get("X-Caddie-Device") as? JsonPrimitive)?.content

                val requires = (example["requires"] as? JsonPrimitive)?.content
                if (requires != null && requires !in capabilitiesSent) {
                    assertEquals("presence.put", route, "$name: only presence.put has examples that need a capability")
                    assertFailsWith<Exception>("$route ($name): a request this client cannot build yet") { decodeRequest(PresencePutRequest.serializer(), body) }
                    // ... and only because of until: "keep": the same body with "hour" builds.
                    val asHour = JsonObject((body as JsonObject) + ("until" to JsonPrimitive("hour")))
                    assertEquals(Opt.Of(PresenceMode.Hour), decodeRequest(PresencePutRequest.serializer(), asHour).until, "$route ($name)")
                    continue
                }
                if (name == "an unknown key is refused") {
                    // A key the schema does not name cannot even be put into a request: the server's 400 cannot happen.
                    assertFailsWith<Exception> { decodeRequest(ProfilePutRequest.serializer(), body) }
                    continue
                }
                val http = FakeApiHttp { FakeApiHttp.json(status, response["body"].toString()) }
                val credential = header?.let { DeviceCredential.parse(BACKEND, it) }
                if (header != null) assertNotNull(credential, "$route: the fixture's device header parses")
                val api = PeopleApi(http, BACKEND, { credential }, Pace(Clock.System))
                val result = call(api, route, body, event, meetId)
                examples++

                val sent = http.sent.single()
                val path = spec.path.replace("{meet_id}", meetId ?: "")
                assertEquals(spec.method, sent.method, "$route: method")
                assertEquals(path, sent.path, "$route: path")
                assertEquals(event?.let { "event=$it" }, sent.query, "$route ($name): query")
                assertNull(sent.headers.keys.firstOrNull { it.equals("Origin", ignoreCase = true) }, "$route: no Origin")
                assertNull(sent.headers.keys.firstOrNull { it.equals("Cookie", ignoreCase = true) }, "$route: no Cookie")
                if (spec.auth) assertEquals(header, sent.headers[PeopleApi.DEVICE_HEADER], "$route: device header") else assertNull(sent.headers[PeopleApi.DEVICE_HEADER])
                when {
                    body != null -> assertEquals(body, sent.json, "$route ($name): the exact body")
                    route.startsWith("meet.") && sent.method == "POST" -> assertEquals("{}", sent.body, "$route: an empty object")
                    else -> assertNull(sent.body, "$route ($name): no body")
                }

                if (status in 200..299) {
                    assertIs<ApiResult.Ok<*>>(result, "$route ($name) decodes")
                } else {
                    val error = assertIs<ApiResult.Failed>(result, "$route ($name) fails").error
                    val code = ((response["body"] as JsonObject)["error"] as JsonPrimitive).content
                    assertEquals(status, error.status)
                    assertEquals(code, error.code)
                    assertEquals(PeopleError.kindOf(status, code), error.kind)
                    assertTrue(error.kind !in setOf(PeopleError.Kind.Refused, PeopleError.Kind.NotPossible) || code.contains(' '), "$route ($name): a stable code maps to its own kind")
                }
            }
        }
        assertTrue(examples >= 40, "$examples examples")
    }

    @Test
    fun responsesDecodeWithTheirFields() {
        fun body(file: String, index: Int = 0): String =
            (((Fixtures.json("people-api/$file") as JsonObject)["examples"] as JsonArray)[index] as JsonObject)["response"]!!.let { (it as JsonObject)["body"].toString() }
        val json = PeopleJson.responses

        val matches = json.decodeFromString(MatchesResponse.serializer(), body("matches.json", 1))
        assertEquals(2, matches.results.size)
        assertEquals(Proximity.SameZone, matches.results[0].proximity)
        assertEquals("Hallway", matches.results[0].zone)
        assertEquals(Proximity.Near, matches.results[1].proximity)
        assertTrue(matches.results[1].broad)
        assertNull(matches.results[1].evidence)

        val degraded = json.decodeFromString(MatchesResponse.serializer(), body("matches.json", 2))
        assertEquals(true, degraded.degraded?.semantic)

        val meet = json.decodeFromString(MeetView.serializer(), body("meet.get.json"))
        assertEquals(MeetState.Active, meet.state)
        assertEquals(40, meet.other.distanceM)
        assertEquals(275, meet.other.bearingDeg)

        val inbox = json.decodeFromString(InboxResponse.serializer(), body("meet.inbox.json"))
        assertEquals("9b1c7e5d3a2f4c60", inbox.incoming.single().from?.ref)
        assertEquals("3f2a9c0d1e4b5a68", inbox.outgoing.single().to?.ref)

        val presence = json.decodeFromString(PresencePutResponse.serializer(), body("presence.put.json", 1))
        assertEquals(PresenceMode.Day, presence.until)
        assertEquals("0mzTMJg1DCU", presence.bleKeyId)
        assertTrue(presence.toString().contains("<redacted>") && !presence.toString().contains(presence.bleKey!!), "the key never reaches toString")

        val held = json.decodeFromString(PresencePutResponse.serializer(), body("presence.put.json", 3))
        assertEquals(listOf("spot"), held.held?.fields)

        val blocks = json.decodeFromString(BlocksResponse.serializer(), body("blocks.get.json"))
        assertNull(blocks.blocks!![1].displayName)

        val members = json.decodeFromString(CircleMembersResponse.serializer(), body("circles.members.json"))
        assertEquals(4, members.count)
        assertEquals("Find me at the Cilium booth.", members.members.single().contact?.contactNote)

        val profile = json.decodeFromString(ProfilePutResponse.serializer(), body("profile.put.json", 2))
        assertNull(profile.hiddenForOwner, "absent when the write deleted the profile")
    }

    @Test
    fun unknownFieldsAndValuesAreIgnored() {
        val json = PeopleJson.responses
        val meet = json.decodeFromString(
            MeetView.serializer(),
            """{"meet_id":"QEFCQ0RFRkdISUpLTE1OTw","state":"teleported","new_field":1,"other":{"display_name":"X","proximity":"close"}}""",
        )
        assertEquals(MeetState.Unknown, meet.state)
        val person = json.decodeFromString(Person.serializer(), """{"ref":"3f2a9c0d1e4b5a68","display_name":"X","proximity":"adjacent","zone":null}""")
        assertNull(person.proximity)
    }

    @Test
    fun requestsSendOnlyTheKeysTheyAreGiven() {
        val r = PeopleJson.requests
        assertEquals(
            """{"event":"e","zone":"Hallway","spot":"Green jacket"}""",
            r.encodeToString(PresencePutRequest.serializer(), PresencePutRequest("e", "Hallway", spot = Opt.Of("Green jacket"))),
        )
        assertEquals(
            """{"event":"e","zone":"Hallway","location":null,"until":"day","ble":false}""",
            r.encodeToString(PresencePutRequest.serializer(), PresencePutRequest("e", "Hallway", location = Opt.Null, until = Opt.Of(PresenceMode.Day), ble = false)),
        )
        assertEquals("""{"event":"e","ref":"r","topic_id":null,"note":"hi"}""", r.encodeToString(MeetRequest.serializer(), MeetRequest("e", "r", Opt.Null, Opt.Of("hi"))))
        assertEquals("{}", r.encodeToString(EmptyRequest.serializer(), EmptyRequest()))
        assertEquals("""{"rendezvous":null}""", r.encodeToString(MeetDetailsRequest.serializer(), MeetDetailsRequest(rendezvous = Opt.Null)))
        assertEquals(
            """{"event":"e","platform":"apns","token":"t","environment":"sandbox"}""",
            r.encodeToString(NativePushPutRequest.serializer(), NativePushPutRequest("e", "apns", "t", "sandbox")),
        )
        assertEquals("""{"event":"e","platform":"fcm","token":"t"}""", r.encodeToString(NativePushPutRequest.serializer(), NativePushPutRequest("e", "fcm", "t")))
        assertTrue(!NativePushPutRequest("e", "fcm", "secret-token").toString().contains("secret-token"))
    }
}
