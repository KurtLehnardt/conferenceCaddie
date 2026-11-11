package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.db.CaddieDatabase
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

// The privacy helpers, the zones, the words of nudges and asks, and the device-side records.
class PeopleRulesTest {
    private fun person(around: Boolean, zone: String?, proximity: Proximity? = null, evidence: String? = null, broad: Boolean = false) =
        Person(ref = "3f2a9c0d1e4b5a68", displayName = "Sample Person", around = around, zone = zone, proximity = proximity, evidence = evidence, broad = broad)

    private fun meet(state: MeetState, sameZone: Boolean = false, otherAround: Boolean = true, mineAround: Boolean = true, distance: Int? = null, bearing: Int? = null) =
        MeetView(
            meetId = "QEFCQ0RFRkdISUpLTE1OTw",
            state = state,
            sameZone = sameZone,
            mine = MeetMine(spotMe = "Red scarf", around = mineAround),
            other = MeetOther(ref = "3f2a9c0d1e4b5a68", displayName = "Sample", around = otherAround, zone = "Hallway", spot = "Green jacket", spotMe = "Cilium sticker", distanceM = distance, bearingDeg = bearing),
        )

    @Test
    fun aPersonsZoneAndBandOnlyWhileBothAreAround() {
        val p = person(around = true, zone = "Hallway", proximity = Proximity.SameZone)
        assertEquals("Hallway", PeoplePrivacy.zone(p, myPresenceOn = true))
        assertNull(PeoplePrivacy.zone(p, myPresenceOn = false), "my presence is off")
        assertNull(PeoplePrivacy.zone(person(around = false, zone = "Hallway"), true), "they are not around")
        assertEquals(Proximity.SameZone, PeoplePrivacy.proximity(p, true))
        assertNull(PeoplePrivacy.proximity(p, false))
        assertNull(PeoplePrivacy.proximity(person(true, null, Proximity.Venue), true), "the venue as a whole says nothing")
        val mine = Presence(on = true, zone = "Hallway")
        assertTrue(PeoplePrivacy.inMyZone(p, mine))
        assertFalse(PeoplePrivacy.inMyZone(p, mine.copy(on = false)))
        assertFalse(PeoplePrivacy.inMyZone(person(true, "Hall B"), mine))
    }

    @Test
    fun aMeetsZoneOnlyWhileActiveOrWhileASameZoneAskWaitsWithBothAround() {
        assertEquals("Hallway", PeoplePrivacy.zone(meet(MeetState.Active)))
        assertEquals("Hallway", PeoplePrivacy.zone(meet(MeetState.Requested, sameZone = true)))
        assertNull(PeoplePrivacy.zone(meet(MeetState.Requested, sameZone = false)))
        assertNull(PeoplePrivacy.zone(meet(MeetState.Requested, sameZone = true, otherAround = false)))
        assertNull(PeoplePrivacy.zone(meet(MeetState.Requested, sameZone = true, mineAround = false)))
        for (s in listOf(MeetState.Found, MeetState.Cancelled, MeetState.Declined, MeetState.Expired, MeetState.Unknown)) assertNull(PeoplePrivacy.zone(meet(s, sameZone = true)), "$s")
    }

    @Test
    fun spotLinesOnlyInsideAnActiveMeet() {
        assertEquals("Green jacket", PeoplePrivacy.spot(meet(MeetState.Active)))
        assertEquals("Cilium sticker", PeoplePrivacy.spotMe(meet(MeetState.Active)))
        for (s in MeetState.entries.filter { it != MeetState.Active }) {
            assertNull(PeoplePrivacy.spot(meet(s, sameZone = true)), "$s")
            assertNull(PeoplePrivacy.spotMe(meet(s, sameZone = true)), "$s")
        }
    }

    @Test
    fun distanceOnlyFromAMeetReadOfAnActiveMeet() {
        assertEquals(PeoplePrivacy.Distance(40, 275), PeoplePrivacy.distance(MeetRead(meet(MeetState.Active, distance = 40, bearing = 275))))
        assertNull(PeoplePrivacy.distance(MeetRead(meet(MeetState.Found, distance = 40, bearing = 275))))
        assertNull(PeoplePrivacy.distance(MeetRead(meet(MeetState.Active, distance = 40))), "both or neither")
        assertNull(PeoplePrivacy.distance(MeetRead(meet(MeetState.Active, distance = 40, bearing = 400))))
        // Every other answer drops them as it is read.
        assertNull(meet(MeetState.Active, distance = 40, bearing = 275).withoutDistance().other.distanceM)
    }

    @Test
    fun aNearbyPersonsZoneOnlyInMyOwnZone() {
        val n = NearbyPerson(ref = "3f2a9c0d1e4b5a68", displayName = "X", zone = "Hallway")
        assertEquals("Hallway", PeoplePrivacy.zone(n, Presence(on = true, zone = "Hallway")))
        assertNull(PeoplePrivacy.zone(n, Presence(on = true, zone = "Expo hall")))
        assertNull(PeoplePrivacy.zone(n, Presence(on = false, zone = "Hallway")))
    }

    @Test
    fun zonesAreTheRoomsThenTheFixedZones() {
        val zones = PeopleZones.forRooms(listOf("Hall B", " hall b ", null, "", "Ballroom A", "Hallway", "expo HALL", "Room 2"))
        assertEquals(listOf("Ballroom A", "Hall B", "Room 2", "Expo hall", "Registration", "Food and coffee", "Hallway", "Outside"), zones)
        assertEquals(PeopleZones.FIXED, PeopleZones.forBundle(null))
        assertEquals("Food and coffee", PeopleZones.match(zones, "food-and-coffee"))
        assertEquals("Hall B", PeopleZones.match(zones, "hall%20b"))
        assertNull(PeopleZones.match(zones, "Nowhere"))
        assertNull(PeopleZones.match(zones, "%E0%A4%A"))
    }

    @Test
    fun nudgeWordsNameNobody() {
        val p = person(true, "Hallway", evidence = "Built <mark>eBPF</mark> load balancing for 40 clusters.")
        assertEquals("Built eBPF load balancing for 40 clusters", PeopleText.evidenceFor(p))
        assertEquals("Someone who's worked on Built eBPF load balancing for 40 clusters is in Hallway right now", PeopleText.nudgeText(PeopleText.evidenceFor(p)!!, "Hallway"))
        val long = person(true, "Hallway", evidence = "word ".repeat(40) + "end")
        val cut = PeopleText.evidenceFor(long)!!
        assertTrue(cut.endsWith("…") && cut.length <= PeopleText.EVIDENCE_MAX + 1, cut)
        assertEquals("eBPF", PeopleText.evidenceFor(person(true, "Hallway").copy(speakTopics = listOf(TopicRef("ebpf", "eBPF")))))
        assertEquals("Tom &amp; <x>", PeopleText.plainText("Tom &amp;amp; &lt;x&gt;"))
        assertEquals("Ana is around in Hall B now", PeopleText.watchText("Ana", "Hall B"))
    }

    @Test
    fun askNotesAreTheWebsAndFitIn140() {
        assertEquals("I'm in Hallway too — want to talk shop?", PeopleText.waveNote("Hallway"))
        assertEquals(140, PeopleText.waveNote("x".repeat(200)).length)
        val (note, topic) = PeopleText.askPrefill(person(true, null, evidence = "Built <mark>eBPF</mark> things"))
        assertEquals("I'd like to compare notes on Built eBPF things", note)
        assertNull(topic)
        val long = PeopleText.askPrefill(person(true, null, evidence = "word ".repeat(60))).first
        assertTrue(long.length <= 140 && long.endsWith("…"), long)
        val byTopic = PeopleText.askPrefill(person(true, null).copy(speakTopics = listOf(TopicRef("cilium", "Cilium"))))
        assertEquals("I'd like to compare notes on Cilium" to "cilium", byTopic)
        assertEquals("I'd like to compare notes on what you're working on", PeopleText.askPrefill(person(true, null)).first)
    }

    @Test
    fun recordsRoundTripThroughTheSettingsTableScopedByBackend() = runTest {
        val db = CaddieDatabase.open(":memory:")
        try {
            val kv = PeopleKeyValue.forDatabase(db)
            val store = PeopleStore(kv, BACKEND.base)
            store.load()
            store.setProfile(Profile(displayName = "Ana", topics = mapOf(SLUG to ConferenceTopics(learn = listOf(TopicRef("ebpf", "eBPF"))))))
            store.setVisibility(SLUG) { it.copy(openToMeet = true, onServer = true, sharedTalkIds = listOf("$SLUG:1")) }
            store.setPresence(SLUG) { it.copy(on = true, zone = "Hallway", until = "2099-01-01T00:00:00Z", mode = PresenceMode.Day, positionChoice = PositionChoice.Yes) }
            store.update(SLUG) { it.copy(blocks = listOf(BlockedPerson("ref1", null)), watch = listOf(Watch("ref2", "Bo", "2026-11-10T17:00:00Z")), met = listOf(MetPerson("Cy")), nudged = mapOf("ref3" to "2026-11-10")) }
            store.setDeletePending("other-conf", DeleteRetry(attempts = 2, nextAt = 99, since = 1, last = DeleteFailure.Offline))
            store.setDeleteAll(DeleteRetry(since = 5))

            val again = PeopleStore(kv, BACKEND.base)
            again.load()
            assertEquals("Ana", again.profile?.displayName)
            assertEquals("eBPF", again.profile?.topicsFor(SLUG)?.learn?.single()?.label)
            assertEquals(store.record(SLUG), again.record(SLUG))
            assertEquals(DeleteFailure.Offline, again.deletePending("other-conf")?.last)
            assertEquals(setOf(SLUG, "other-conf"), again.slugs)
            assertNotNull(again.deleteAll)
            assertTrue(again.deleteCovers("anything"), "Delete my profile covers every conference")

            // Another backend, even on the same origin, sees none of it.
            val sibling = BackendUrl.normalise("https://caddie.example/tier1") as BackendUrl.Valid
            val other = PeopleStore(kv, sibling.base)
            other.load()
            assertNull(other.profile)
            assertTrue(other.slugs.isEmpty())

            // Clearing keeps People I met only.
            again.clearAllPeopleData()
            val cleared = PeopleStore(kv, BACKEND.base)
            cleared.load()
            assertNull(cleared.profile)
            assertNull(cleared.deleteAll)
            assertEquals(listOf(MetPerson("Cy")), cleared.record(SLUG).met)
            assertEquals(ConferenceRecord(met = listOf(MetPerson("Cy"))), cleared.record(SLUG))
            assertEquals(setOf(SLUG), cleared.slugs)
        } finally {
            db.closeWhenIdle()
        }
    }

    @Test
    fun unreadableRecordsReadAsNone() = runTest {
        val kv = MapKeyValue()
        kv.set("people:v1:${BACKEND.base}#profile", "{not json")
        kv.set("people:v1:${BACKEND.base}#slugs", """["$SLUG"]""")
        kv.set("people:v1:${BACKEND.base}#conference:$SLUG", """{"visibility":{"open_to_meet":"yes","shared_talk_ids":[]},"future":1}""")
        val store = PeopleStore(kv, BACKEND.base)
        store.load()
        assertNull(store.profile)
        assertFalse(store.visibility(SLUG).openToMeet)
    }

    @Test
    fun theContextFollowsTheCore() {
        val core = app.conferencecaddie.shared.core.CoreState(BACKEND, isDefaultBackend = false)
        assertNull(PeopleContext.fromCore(core), "capabilities still loading")
        val off = PeopleContext.fromCore(core.copy(capabilities = app.conferencecaddie.shared.core.CapabilitiesState.Unreachable))
        assertFalse(off!!.capabilities.people.enabled)
        val ready = app.conferencecaddie.shared.core.CapabilitiesState.Ready(app.conferencecaddie.shared.Capabilities.Legacy, app.conferencecaddie.shared.CapabilitiesDiscovery.Source.Legacy, cached = false, updateApp = false)
        val ctx = PeopleContext.fromCore(
            core.copy(
                capabilities = ready,
                selectedSlug = FIXTURE_SLUG,
                bundle = app.conferencecaddie.shared.core.BundleState.Ready(FIXTURE_BUNDLE, app.conferencecaddie.shared.search.TalkSearch(FIXTURE_BUNDLE, "k", CaddieDatabase.open(":memory:")) { kotlin.time.Clock.System.now() }),
                interested = listOf("$FIXTURE_SLUG:1001"),
            ),
        )!!
        assertEquals(FIXTURE_SLUG, ctx.conference?.slug)
        assertEquals(FIXTURE_BUNDLE, ctx.bundle)
        assertEquals(listOf("$FIXTURE_SLUG:1001"), ctx.interested)
        assertEquals(app.conferencecaddie.shared.Capabilities.BleMode.None, ctx.capabilities.ble.mode, "forThisApp drops server-rotate")
        assertFalse(ctx.storageInMemory)
        // A launch whose stored data could not be opened says so to the people features.
        assertTrue(PeopleContext.fromCore(core.copy(capabilities = ready, storageInMemory = true))!!.storageInMemory)
    }

    @Test
    fun expiredPresenceReadsAsOff() {
        val on = Presence(on = true, zone = "Hallway", until = "2026-11-10T18:00:00Z", position = true, confirmedAt = "2026-11-10T17:00:00Z", recentZones = listOf("Hallway"))
        assertTrue(PresenceRuntime.live(on, START_MS).on)
        val off = PresenceRuntime.live(on, START_MS + 3_600_001)
        assertFalse(off.on)
        assertNull(off.zone)
        assertFalse(off.position)
        assertEquals(listOf("Hallway"), off.recentZones, "the recent zones stay")
    }
}
