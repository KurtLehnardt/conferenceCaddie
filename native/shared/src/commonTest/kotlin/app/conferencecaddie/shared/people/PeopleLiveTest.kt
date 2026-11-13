package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.PushToken
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// presence.ts, connect.ts and nudges.ts on virtual time, and the capability gates.
class PeopleLiveTest {
    private val f = PeopleJson.responses

    @Test
    fun presenceSendsTheWebsBodyAndEndsByItselfAfterTheHour() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertEquals(listOf("Hall A | Room 1", "Hall A | Room 2", "Hall B") + PeopleZones.FIXED, h.state.zones)
        assertNull(h.controller.turnOnPresence("Hallway", "  Green jacket  "))
        assertEquals("""{"event":"$FIXTURE_SLUG","zone":"Hallway","spot":"Green jacket"}""", h.sent("PUT", "/api/presence").single().body)
        assertTrue(h.state.presence.on)
        assertEquals("Hallway", h.state.presence.zone)
        assertEquals(listOf("Hallway"), h.state.presence.recentZones)
        assertTrue(h.state.presence.noticeSeen)

        advanceTimeBy(3_599_000)
        assertTrue(h.state.presence.on)
        advanceTimeBy(2_000)
        runCurrent()
        assertFalse(h.state.presence.on, "off by itself at its hour")
        assertEquals(1, h.sent("DELETE", "/api/presence").size)
        assertEquals("event=$FIXTURE_SLUG", h.sent("DELETE", "/api/presence").single().query)
    }

    @Test
    fun extendStartsAFreshHourAndTheDayModeSendsUntilDay() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.turnOnPresence("Hallway", "")
        advanceTimeBy(50 * 60_000L)
        assertNull(h.controller.extendPresence())
        assertEquals(2, h.sent("PUT", "/api/presence").size)
        advanceTimeBy(30 * 60_000L)
        runCurrent()
        assertTrue(h.state.presence.on, "the extended hour runs from the extension")
        assertEquals(10, PeopleText.minutesLeft(kotlin.time.Instant.parse(h.state.presence.until!!).toEpochMilliseconds(), h.clock.now().toEpochMilliseconds()) - 20)

        h.controller.turnOnPresence("Expo hall", "", PresenceMode.Day)
        val day = h.sent("PUT", "/api/presence").last()
        assertEquals("""{"event":"$FIXTURE_SLUG","zone":"Expo hall","spot":"","until":"day"}""", day.body)
        assertEquals(PresenceMode.Day, h.state.presence.mode)
        assertEquals(listOf("Expo hall", "Hallway"), h.state.presence.recentZones)
    }

    @Test
    fun fiveMinutesInTheBackgroundEndTheHourModeButNotTheDayMode() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.turnOnPresence("Hallway", "")
        h.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(5 * 60_000L + 1_000)
        runCurrent()
        assertFalse(h.state.presence.on)

        h.controller.setForeground(true)
        runCurrent()
        h.controller.turnOnPresence("Hallway", "", PresenceMode.Day)
        h.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(20 * 60_000L)
        runCurrent()
        assertTrue(h.state.presence.on, "the day mode stays in the pocket")
        assertFalse(h.state.presence.confirmPending)
        h.controller.setForeground(true)
        runCurrent()
        assertTrue(h.state.presence.confirmPending, "back after more than ten minutes: Still in Hallway?")
        assertEquals(4, h.state.likelyZones.size)
        assertFalse("Hallway" in h.state.likelyZones)

        h.controller.dismissZoneCheck()
        assertFalse(h.state.presence.confirmPending)
        h.controller.setForeground(false)
        runCurrent()
        advanceTimeBy(11 * 60_000L)
        h.controller.setForeground(true)
        runCurrent()
        assertTrue(h.state.presence.confirmPending)
        assertNull(h.controller.confirmZone("Hall B"))
        assertEquals("Hall B", h.state.presence.zone)
        assertFalse(h.state.presence.confirmPending)
    }

    @Test
    fun thePositionGoesWithPresenceAtMostEveryThirtySecondsStretchedByThePace() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.turnOnPresence("Hallway", "")
        assertEquals(PositionOutcome.On, h.controller.sharePosition(true))
        assertEquals(1, h.location.requests, "access asked once")
        runCurrent()
        h.location.flow.emit(GeoFix(40.767891, -111.890123, 14.6, 0))
        runCurrent()
        val first = h.sent("PUT", "/api/presence").last()
        val loc = first.jsonObject["location"] as JsonObject
        assertEquals("15", (loc["accuracy"] as JsonPrimitive).content, "accuracy rounded to whole metres")
        assertEquals("40.767891", (loc["lat"] as JsonPrimitive).content)
        val writes = h.sent("PUT", "/api/presence").size

        h.location.flow.emit(GeoFix(40.7679, -111.8902, 10.0, 0))
        runCurrent()
        assertEquals(writes, h.sent("PUT", "/api/presence").size, "waits for the 30 seconds")
        // The answer to the next write asks for half the pace: 60 seconds from then on.
        h.server.pace = "2"
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(writes + 1, h.sent("PUT", "/api/presence").size)

        h.location.flow.emit(GeoFix(40.768, -111.8903, 10.0, 0))
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(writes + 1, h.sent("PUT", "/api/presence").size)
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(writes + 2, h.sent("PUT", "/api/presence").size)

        // Off: the next write carries no position.
        assertEquals(PositionOutcome.Off, h.controller.sharePosition(false))
        runCurrent()
        assertNull(h.sent("PUT", "/api/presence").last().jsonObject["location"])
        h.location.flow.emit(GeoFix(1.0, 1.0, 5.0, 0))
        advanceTimeBy(120_000)
        assertEquals(writes + 3, h.sent("PUT", "/api/presence").size)
    }

    @Test
    fun noPositionWithoutPreciseAccessOrGpsBands() = runTest {
        val h = PeopleHarness(this)
        h.location.afterRequest = LocationAccess.Approximate
        h.start()
        h.visible()
        h.controller.turnOnPresence("Hallway", "")
        assertEquals(PositionOutcome.Approximate, h.controller.sharePosition(true))
        assertFalse(h.state.presence.position)
        h.location.flow.emit(GeoFix(40.0, -111.0, 5.0, 0))
        advanceTimeBy(60_000)
        assertEquals(1, h.sent("PUT", "/api/presence").size)

        val g = PeopleHarness(this)
        g.location.accessNow = LocationAccess.Precise
        g.start(PEOPLE_ON.copy(people = PEOPLE_ON.people.copy(gpsBands = false)))
        g.visible()
        assertEquals(PositionOutcome.Unavailable, g.controller.sharePosition(true))
        assertEquals(LocationAccess.Unavailable, g.state.locationAccess)
    }

    @Test
    fun theInboxIsPolledWhilePresenceIsOnAndStretchedByThePaceAndRetryAfter() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        val atStart = h.sent("GET", "/api/meet/inbox").size
        advanceTimeBy(100_000)
        assertEquals(atStart, h.sent("GET", "/api/meet/inbox").size, "no poll while nothing waits")
        h.controller.turnOnPresence("Hallway", "")
        runCurrent()
        advanceTimeBy(45_001)
        runCurrent()
        assertEquals(atStart + 1, h.sent("GET", "/api/meet/inbox").size)
        advanceTimeBy(45_000)
        runCurrent()
        assertEquals(atStart + 2, h.sent("GET", "/api/meet/inbox").size)

        // The pace an answer reports stretches the wait set after the next tick, as on the web.
        h.server.pace = "3"
        advanceTimeBy(45_000)
        runCurrent()
        advanceTimeBy(45_000)
        runCurrent()
        val n = h.sent("GET", "/api/meet/inbox").size
        advanceTimeBy(134_000)
        runCurrent()
        assertEquals(n, h.sent("GET", "/api/meet/inbox").size, "135 seconds at pace 3")
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(n + 1, h.sent("GET", "/api/meet/inbox").size)

        h.server.pace = null
        h.server.inbox = { FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "300")) }
        advanceTimeBy(135_100)
        runCurrent()
        val limited = h.sent("GET", "/api/meet/inbox").size
        advanceTimeBy(299_000)
        runCurrent()
        assertEquals(limited, h.sent("GET", "/api/meet/inbox").size, "Retry-After holds the poll back")
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(limited + 1, h.sent("GET", "/api/meet/inbox").size)

        h.controller.setForeground(false)
        runCurrent()
        val background = h.sent("GET", "/api/meet/inbox").size
        advanceTimeBy(600_000)
        assertEquals(background, h.sent("GET", "/api/meet/inbox").size, "nothing polls in the background")
    }

    @Test
    fun aStrongMatchInMyZoneNudgesOncePerPersonPerDay() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.matches = { page(person("3f2a9c0d1e4b5a68", zone = "Hallway", evidence = "Built <mark>eBPF</mark> probes."), person("9b1c7e5d3a2f4c60", zone = "Hallway", broad = true)) }
        h.controller.turnOnPresence("Hallway", "")
        runCurrent()
        advanceTimeBy(45_001)
        runCurrent()
        val nudge = assertNotNull(h.state.nudge)
        assertEquals("Someone who's worked on Built eBPF probes is in Hallway right now", nudge.text)
        assertFalse(nudge.watched)
        assertTrue(h.notifier.shown.isEmpty(), "in the foreground the banner is enough")
        val around = h.sent("POST", "/api/people/matches").last()
        assertEquals("""{"event":"$FIXTURE_SLUG","interested_talk_ids":[],"when":"around_now","size":20}""", around.body)

        h.controller.dismissNudge()
        advanceTimeBy(3 * 45_000L + 1_000)
        runCurrent()
        assertNull(h.state.nudge, "not again today")

        // The next day (UTC here) the same person may nudge again, now as a local notification
        // because the app is in the background.
        advanceTimeBy(24 * 3_600_000L)
        h.controller.turnOnPresence("Hallway", "", PresenceMode.Day)
        h.controller.setForeground(false)
        runCurrent()
        h.controller.backgroundCheck()
        val shown = h.notifier.shown.single()
        assertEquals("Conference Caddie", shown.title)
        assertEquals("Someone who's worked on Built eBPF probes is in Hallway right now", shown.body)
        assertEquals("caddie://people?around=1", shown.deepLink)
        assertFalse(shown.body.contains("Sample Person"))
    }

    @Test
    fun aNotificationAboutADemoConferenceSaysSo() = runTest {
        val h = PeopleHarness(this)
        h.conference = FIXTURE_CONFERENCE.copy(demo = true)
        h.start()
        h.visible()
        h.server.matches = { page(person("3f2a9c0d1e4b5a68", zone = "Hallway", evidence = "Built <mark>eBPF</mark> probes.")) }
        h.controller.turnOnPresence("Hallway", "")
        h.controller.setForeground(false)
        runCurrent()
        h.controller.backgroundCheck()
        val shown = h.notifier.shown.single()
        assertEquals("Conference Caddie (Demo)", shown.title)
        assertEquals("Demo: someone who's worked on Built eBPF probes is in Hallway right now", shown.body, "the banner's words after Demo: ")
        assertEquals("Someone who's worked on Built eBPF probes is in Hallway right now", h.state.nudge?.text, "the banner itself keeps its words")
    }

    @Test
    fun theDemoMarkIsKeptWithPresenceOnceItIsOn() = runTest {
        val h = PeopleHarness(this)
        h.conference = FIXTURE_CONFERENCE.copy(demo = true)
        h.start()
        h.visible()
        val key = h.kv.map.keys.single { it.endsWith("#conference:$FIXTURE_SLUG") }
        assertFalse(h.kv.map.getValue(key).contains("\"demo\":true"), "nothing is kept before presence turns on")
        assertNull(h.controller.turnOnPresence("Hallway", ""))
        runCurrent()
        assertTrue(h.kv.map.getValue(key).contains("\"demo\":true"), "kept in the record that holds presence")
    }

    @Test
    fun aFailedTurnOnKeepsNoDemoMark() = runTest {
        val h = PeopleHarness(this)
        h.conference = FIXTURE_CONFERENCE.copy(demo = true)
        h.start()
        h.visible()
        h.server.presencePut = { FakeApiHttp.json(503, """{"error":"People are temporarily unavailable"}""") }
        assertNotNull(h.controller.turnOnPresence("Hallway", ""))
        runCurrent()
        assertFalse(h.kv.map.values.any { it.contains("\"demo\":true") })
    }

    @Test
    fun someoneOnTheWatchListNudgesInTheBannerOnly() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertTrue(h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"))
        h.server.matches = { page(person("9b1c7e5d3a2f4c60", name = "Ana", zone = "Hall B")) }
        h.controller.turnOnPresence("Hallway", "")
        h.controller.backgroundCheck()
        assertEquals("Ana is around in Hall B now", h.state.nudge?.text)
        assertTrue(h.state.nudge!!.watched)
        assertTrue(h.notifier.shown.isEmpty(), "a notification never names anyone")
        h.controller.seeWho()
        assertEquals("9b1c7e5d3a2f4c60", h.state.reveal)
        assertNull(h.state.nudge)
        h.controller.consumeReveal()
        assertNull(h.state.reveal)
        assertFalse(h.controller.toggleWatch("9b1c7e5d3a2f4c60", "Ana"))
        assertTrue(h.state.watch.isEmpty())
    }

    @Test
    fun noNudgeWhileMyPresenceIsOffOrTheSettingIsOff() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.matches = { page(person("3f2a9c0d1e4b5a68", zone = "Hallway", evidence = "x")) }
        h.controller.backgroundCheck()
        assertNull(h.state.nudge)
        h.controller.setNudgesEnabled(false)
        h.controller.turnOnPresence("Hallway", "")
        h.controller.backgroundCheck()
        assertNull(h.state.nudge)
        assertTrue(h.sent("POST", "/api/people/matches").isEmpty())
    }

    @Test
    fun asksWavesAndTheInbox() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        val p = f.decodeFromString(Person.serializer(), person("3f2a9c0d1e4b5a68", zone = "Hallway"))
        assertEquals(PeopleError.Kind.PresenceRequired, h.controller.wave(p).errorOrNull?.kind, "a wave needs my zone")
        h.controller.turnOnPresence("Hallway", "")
        h.server.other = { r ->
            if (r.path == "/api/meet") FakeApiHttp.json(409, """{"error":"meet_open","meet_id":"QEFCQ0RFRkdISUpLTE1OTw"}""") else FakeApiHttp.json(404, "{}")
        }
        val r = h.controller.wave(p)
        assertEquals(PeopleError.Kind.MeetOpen, r.errorOrNull?.kind)
        assertEquals(
            """{"event":"$FIXTURE_SLUG","ref":"3f2a9c0d1e4b5a68","topic_id":null,"note":"I'm in Hallway too — want to talk shop?"}""",
            h.sent("POST", "/api/meet").single().body,
        )
        assertEquals(MeetState.Requested, h.state.inbox.askStates["3f2a9c0d1e4b5a68"], "the card says No reply yet")

        val incoming = """{"meet_id":"UFFSU1RVVldYWVpbXF1eXw","state":"requested","requested_by_me":false,"same_zone":true,"mine":{"around":true},"other":{"display_name":"Ana","around":true,"zone":"Hallway"},"from":{"ref":"9b1c7e5d3a2f4c60","display_name":"Ana","about":"SRE"}}"""
        h.server.inbox = { FakeApiHttp.json(200, """{"incoming":[$incoming],"outgoing":[]}""") }
        h.controller.refreshInbox()
        assertEquals(1, h.state.inbox.count)
        assertEquals("Hallway", PeoplePrivacy.zone(h.state.inbox.incoming.single()))

        h.server.other = { req ->
            if (req.path.endsWith("/accept")) FakeApiHttp.json(410, """{"error":"over","state":"expired"}""") else FakeApiHttp.json(404, "{}")
        }
        assertEquals(PeopleError.Kind.Over, h.controller.acceptMeet("UFFSU1RVVldYWVpbXF1eXw").errorOrNull?.kind)
        assertEquals(0, h.state.inbox.count, "an ask that ran out leaves the inbox")
        assertEquals("{}", h.sent("POST", "/api/meet/UFFSU1RVVldYWVpbXF1eXw/accept").single().body)
        assertEquals("SRE", h.controller.personForMeet("UFFSU1RVVldYWVpbXF1eXw")?.about)

        // A blocked person's ask is hidden at once.
        h.controller.refreshInbox()
        assertEquals(1, h.state.inbox.count)
        h.server.other = { FakeApiHttp.json(500, "{}") }
        assertEquals(PeopleError.UNAVAILABLE_MESSAGE, h.controller.block("9b1c7e5d3a2f4c60", "Ana"))
        assertEquals(1, h.state.inbox.count, "the block came back off when the server refused it")
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        assertNull(h.controller.block("9b1c7e5d3a2f4c60", "Ana"))
        assertEquals(0, h.state.inbox.count)
        assertEquals(listOf(BlockedPerson("9b1c7e5d3a2f4c60", "Ana")), h.state.blocks)
    }

    @Test
    fun peopleOffSendsNothingAndOffersNothing() = runTest {
        val h = PeopleHarness(this)
        h.start(Capabilities.None)
        assertEquals(PeopleAvailability.Off, h.state.availability)
        assertEquals(PeopleError.NOT_OFFERED_MESSAGE, h.controller.setOpenToMeet(true))
        assertEquals(PeopleError.NOT_OFFERED_MESSAGE, h.controller.turnOnPresence("Hallway", ""))
        assertEquals(PeopleError.Kind.NotOffered, h.controller.searchPeople(null, around = false).errorOrNull?.kind)
        assertTrue(h.controller.circleCounts(listOf("$FIXTURE_SLUG:1001")).isEmpty())
        advanceTimeBy(600_000)
        assertTrue(h.http.sent.isEmpty())
        // No reports means no people features at all (the contract's dependency rule).
        assertFalse(Capabilities.effective(kotlinx.serialization.json.Json.parseToJsonElement("""{"api_version":1,"people":{"enabled":true,"reports":false}}""")).people.enabled)
    }

    @Test
    fun presenceMeetsAndCirclesOffAreEachOffered() = runTest {
        val noPresence = PeopleHarness(this)
        noPresence.start(PEOPLE_ON.copy(people = PEOPLE_ON.people.copy(presence = false, gpsBands = false, meets = false)))
        noPresence.visible()
        assertEquals(PeopleError.NOT_OFFERED_MESSAGE, noPresence.controller.turnOnPresence("Hallway", ""))
        assertEquals(PeopleError.Kind.NotOffered, noPresence.controller.searchPeople(null, around = true).errorOrNull?.kind)
        val p = f.decodeFromString(Person.serializer(), person("3f2a9c0d1e4b5a68"))
        assertEquals(PeopleError.Kind.NotOffered, noPresence.controller.ask(p, "hi").errorOrNull?.kind)
        noPresence.controller.setInboxVisible(true)
        advanceTimeBy(100_000)
        assertTrue(noPresence.sent("GET", "/api/meet/inbox").isEmpty(), "no inbox without meets")
        assertNull(noPresence.state.nudge)

        val noCircles = PeopleHarness(this)
        noCircles.start(PEOPLE_ON.copy(people = PEOPLE_ON.people.copy(circles = false)))
        assertTrue(noCircles.controller.circleCounts(listOf("$FIXTURE_SLUG:1001")).isEmpty())
        assertEquals(PeopleError.Kind.NotOffered, noCircles.controller.circleMembers("$FIXTURE_SLUG:1001").errorOrNull?.kind)
        assertTrue(noCircles.http.sent.isEmpty())

        val circles = PeopleHarness(this)
        circles.server.other = { FakeApiHttp.json(200, """{"counts":{"$FIXTURE_SLUG:1001":4}}""") }
        circles.start()
        assertEquals(mapOf("$FIXTURE_SLUG:1001" to 4, "$FIXTURE_SLUG:1002" to 0), circles.controller.circleCounts(listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002")))
        circles.controller.circleCounts(listOf("$FIXTURE_SLUG:1001"))
        assertEquals(1, circles.sent("POST", "/api/circles/counts").size, "kept for a minute")
        assertNull(circles.sent("POST", "/api/circles/counts").single().headers[PeopleApi.DEVICE_HEADER])
    }

    @Test
    fun pushRegistersOnlyWhenTheBackendAdvertisesThisBuildsChannel() = runTest {
        val apnsToken = PushToken("apns", "ab".repeat(32), environment = "sandbox")
        val none = PeopleHarness(this, push = FakePush("apns", apnsToken))
        none.start(PEOPLE_ON.copy(push = Capabilities.Push(fcm = true)))
        none.visible()
        assertFalse(none.state.push.available)
        assertEquals(PushOutcome.Unavailable, none.controller.enablePush())
        assertTrue(none.http.sent.isEmpty())

        val apns = PeopleHarness(this, push = FakePush("apns", apnsToken))
        apns.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        apns.start(PEOPLE_ON.copy(push = Capabilities.Push(apns = true)))
        apns.visible()
        assertTrue(apns.state.push.available)
        assertEquals(PushOutcome.On, apns.controller.enablePush())
        assertEquals(
            """{"event":"$FIXTURE_SLUG","platform":"apns","token":"${"ab".repeat(32)}","environment":"sandbox"}""",
            apns.sent("PUT", "/api/push/native").single().body,
        )
        assertTrue(apns.state.push.on)
        apns.controller.disablePush()
        assertEquals("""{"event":"$FIXTURE_SLUG","platform":"apns","token":"${"ab".repeat(32)}"}""", apns.sent("DELETE", "/api/push/native").single().body)
        assertFalse(apns.state.push.on)

        // FCM never sends an environment, and a 404 means no native push on this backend.
        val fcmToken = PushToken("fcm", "f".repeat(40), environment = "production")
        val fcm = PeopleHarness(this, push = FakePush("fcm", fcmToken))
        fcm.server.other = { FakeApiHttp.json(404, """{"error":"push_unavailable"}""") }
        fcm.start(PEOPLE_ON.copy(push = Capabilities.Push(fcm = true)))
        fcm.visible()
        assertEquals(PushOutcome.Unavailable, fcm.controller.enablePush())
        assertEquals("""{"event":"$FIXTURE_SLUG","platform":"fcm","token":"${"f".repeat(40)}"}""", fcm.sent("PUT", "/api/push/native").single().body)
        assertFalse(fcm.state.push.available, "until the capabilities change")
    }

    @Test
    fun searchSendsTheWebsBodiesAndLeavesBlockedPeopleOut() = runTest {
        val h = PeopleHarness(this)
        h.start(interested = listOf("$FIXTURE_SLUG:1001"))
        h.visible()
        h.server.other = { FakeApiHttp.json(200, """{"ok":true}""") }
        assertNull(h.controller.block("9b1c7e5d3a2f4c60", "Blocked"))
        h.server.matches = { page(person("3f2a9c0d1e4b5a68"), person("9b1c7e5d3a2f4c60")) }
        val plain = h.controller.searchPeople(null, around = false).valueOrNull!!
        assertEquals(listOf("3f2a9c0d1e4b5a68"), plain.results.map { it.ref })
        h.controller.searchPeople("  ebpf load balancing  ", around = false, from = 20)
        h.controller.searchPeople(null, around = true)
        val bodies = h.sent("POST", "/api/people/matches").map { it.body }
        assertEquals("""{"event":"$FIXTURE_SLUG","interested_talk_ids":["$FIXTURE_SLUG:1001"],"size":20}""", bodies[0])
        assertEquals("""{"event":"$FIXTURE_SLUG","interested_talk_ids":["$FIXTURE_SLUG:1001"],"query":"ebpf load balancing","when":"anyone","from":20,"size":20}""", bodies[1])
        assertEquals("""{"event":"$FIXTURE_SLUG","interested_talk_ids":["$FIXTURE_SLUG:1001"],"when":"around_now","size":20}""", bodies[2])

        // The server copy has gone: the device follows.
        h.server.matches = { FakeApiHttp.json(403, """{"error":"visibility_required"}""") }
        h.controller.searchPeople(null, around = false)
        assertFalse(h.state.visibility.openToMeet)
    }

    @Test
    fun requestsThatOpenBeforePeopleFeaturesAreReadyAreReadOnceTheyAre() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        // Requests opens while the backend's capabilities offer no people features (still loading,
        // or cached from before): nothing can be read yet.
        h.start(Capabilities.None)
        h.controller.setInboxVisible(true)
        runCurrent()
        assertTrue(h.sent("GET", "/api/meet/inbox").isEmpty())

        // The same conference once people features are on: the wish was kept, so the inbox is read.
        h.start()
        assertEquals(1, h.sent("GET", "/api/meet/inbox").size)
        assertTrue(h.state.inbox.loaded)

        // And it is polled while Requests shows, with my presence off.
        advanceTimeBy(ConnectRuntime.INBOX_POLL_MS + 1_000)
        runCurrent()
        assertTrue(h.sent("GET", "/api/meet/inbox").size >= 2, "polled while Requests shows")
        h.controller.setInboxVisible(false)
        runCurrent()
        val polled = h.sent("GET", "/api/meet/inbox").size
        advanceTimeBy(5 * ConnectRuntime.INBOX_POLL_MS)
        runCurrent()
        assertEquals(polled, h.sent("GET", "/api/meet/inbox").size, "no poll once Requests has closed")
    }

    @Test
    fun theAroundPageSaysWhetherTheServerHasMore() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.turnOnPresence("Hallway", "")
        h.server.matches = {
            FakeApiHttp.json(200, """{"results":[${person("3f2a9c0d1e4b5a68")}],"from":0,"size":20,"has_more":true}""")
        }
        h.controller.setAroundVisible(true)
        runCurrent()
        assertTrue(h.state.around.loaded)
        assertTrue(h.state.around.hasMore, "a short page can still have more after it")
        h.server.matches = { page(person("3f2a9c0d1e4b5a68")) }
        h.controller.refreshAround()
        assertFalse(h.state.around.hasMore)
        h.controller.setAroundVisible(false)
    }

    @Test
    fun aCircleThatNeedsAShareDropsTheTalkFromTheDevicesSharedList() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.named()
        assertNull(h.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertNull(h.controller.shareForTalk("$FIXTURE_SLUG:1002", true))
        runCurrent()
        assertEquals(listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002"), h.state.visibility.sharedTalkIds)

        h.server.other = { r ->
            if (r.path == "/api/circles/members") FakeApiHttp.json(403, """{"error":"share_required"}""") else FakeApiHttp.json(404, "{}")
        }
        assertEquals(PeopleError.Kind.ShareRequired, h.controller.circleMembers("$FIXTURE_SLUG:1001").errorOrNull?.kind)
        assertEquals(listOf("$FIXTURE_SLUG:1002"), h.state.visibility.sharedTalkIds, "the server no longer holds that share")

        // Another refusal leaves the shared list alone.
        h.server.other = { FakeApiHttp.json(403, """{"error":"no_device"}""") }
        h.controller.circleMembers("$FIXTURE_SLUG:1002")
        assertEquals(listOf("$FIXTURE_SLUG:1002"), h.state.visibility.sharedTalkIds)
    }
}
