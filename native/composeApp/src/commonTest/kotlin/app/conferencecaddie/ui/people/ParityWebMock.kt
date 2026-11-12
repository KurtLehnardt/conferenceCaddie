package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.ui.talks.TestBackend
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.time.Instant
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.atTime
import kotlinx.datetime.plus
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

// The web app's mock data (web/src/mock/fixtures.ts) and the parts of its mock server
// (web/src/mock/handler.ts) that shape people, for the parity screenshots: the Sample Cloud Summit
// with its twelve talks and eight topics, its sample people, and the matches and talk circles as
// the web's mock answers them. Everything else (profiles, presence, blocks, reports, meets) is
// FakePeopleServer's, which the sample people are seeded into.

/** The Sample Cloud Summit of the web's mock, as the test backends serve it. */
internal object ParitySample {
    const val SLUG = "sample-cloud-summit-2026"
    const val NAME = "Sample Cloud Summit"

    val TOPICS: List<Pair<String, String>> = listOf(
        "kubernetes" to "Kubernetes",
        "security" to "Security",
        "ebpf" to "eBPF",
        "observability" to "Observability",
        "platform-engineering" to "Platform Engineering",
        "ai" to "AI",
        "service-mesh" to "Service Mesh",
        "wasm" to "WebAssembly",
    )
    private val LABELS = TOPICS.toMap()

    fun label(topicId: String): String = LABELS[topicId] ?: topicId

    /** One talk of the summit; times are the conference's local times, served as UTC. */
    class SampleTalk(
        val n: Int,
        val title: String,
        val day: String,
        val start: String,
        val end: String,
        val topics: List<String>,
        val room: String? = "Sample Room 1",
        val track: String = "Sample Track 1",
        val speakers: List<String> = listOf("Sample Speaker One"),
        val slides: Boolean = false,
    ) {
        val id: String get() = "$SLUG:${1000 + n}"
        val startIso: String get() = "${day}T$start:00Z"
        val endIso: String get() = "${day}T$end:00Z"
        val url: String get() = "https://example.invalid/mock-session/${1000 + n}"
    }

    val TALKS: List<SampleTalk> = listOf(
        SampleTalk(1, "Sample talk 1 on Kubernetes security", "2026-11-09", "09:00", "09:30", listOf("kubernetes", "security"), speakers = listOf("Sample Speaker One", "Sample Speaker Two")),
        SampleTalk(2, "Sample talk 2 on eBPF observability", "2026-11-09", "09:15", "09:45", listOf("ebpf", "observability"), room = "Sample Room 2", track = "Sample Track 2"),
        // On Nov 11, not Nov 10 as in fixtures.ts: the web screenshots' Interested list has it then
        // (parity-3/scenarios.mjs TALK3), so it has not ended and talk 1 gets the ended-talk banner.
        SampleTalk(3, "Sample talk 3 with a deliberately long placeholder title that should clamp to two lines on a phone", "2026-11-11", "10:00", "10:30", listOf("service-mesh"), track = "Sample Track 3", slides = true),
        SampleTalk(4, "Sample talk 4", "2026-11-10", "11:00", "11:30", listOf("platform-engineering"), room = null),
        SampleTalk(5, "Sample talk 5", "2026-11-10", "11:00", "11:45", listOf("ai"), track = "Sample Track 2"),
        SampleTalk(6, "Sample talk 6", "2026-11-10", "13:30", "14:00", listOf("kubernetes"), room = "Sample Room 3"),
        SampleTalk(7, "Sample talk 7", "2026-11-11", "14:15", "14:45", listOf("security", "ai"), track = "Sample Track 3", speakers = listOf("Sample Speaker Three")),
        SampleTalk(8, "Sample talk 8", "2026-11-11", "09:00", "09:30", listOf("wasm"), track = "Sample Track 2"),
        SampleTalk(9, "Sample talk 9", "2026-11-11", "09:00", "09:45", listOf("kubernetes", "ebpf"), room = "Sample Room 2"),
        SampleTalk(10, "Sample talk 10", "2026-11-12", "10:30", "11:00", listOf("observability"), track = "Sample Track 3"),
        SampleTalk(11, "Sample talk 11", "2026-11-12", "14:00", "14:30", listOf("platform-engineering"), track = "Sample Track 2"),
        SampleTalk(12, "Sample talk 12", "2026-11-12", "15:00", "15:30", listOf("security"), room = "Sample Room 3", speakers = emptyList()),
    )

    fun talk(n: Int): SampleTalk = TALKS.first { it.n == n }

    /**
     * The instant the parity screenshots run at, from the summit's bundle as the app reads it: 09:00
     * on its second day in its own zone, as TalkSmokeTest pins its checks. Talks 1 and 2 (the first
     * day) have ended and every other talk is still to come, so For you, the ended-talk banners and
     * the people features (which close after the last day) look the same whatever day the
     * screenshots are taken. [ParityClockTest] holds the states to that.
     */
    fun pinnedNowMs(conference: Conference): Long {
        val start = LocalDate.parse(conference.startDate ?: error("${conference.slug} has no start date"))
        val zone = TimeZone.of(conference.timeZone ?: error("${conference.slug} has no time zone"))
        return start.plus(1, DateTimeUnit.DAY).atTime(9, 0).toInstant(zone).toEpochMilliseconds()
    }

    /** The summit's bundle as [TestBackend] serves it, for the cameras, which have no rig. */
    private val served: Conference by lazy {
        TestBackend().also { it.publish(listOf(testConference())) }.bundleOf(testConference()).conference
    }

    /** The wall clock at [pinnedNowMs] in the summit's zone as `HHMM` ("0900"): what the Android shots' status bar shows. */
    fun pinnedHhmm(): String {
        val zone = TimeZone.of(served.timeZone ?: error("${served.slug} has no time zone"))
        val wall = Instant.fromEpochMilliseconds(pinnedNowMs(served)).toLocalDateTime(zone)
        return wall.hour.toString().padStart(2, '0') + wall.minute.toString().padStart(2, '0')
    }

    private fun minutes(hhmm: String) = hhmm.substringBefore(':').toInt() * 60 + hhmm.substringAfter(':').toInt()

    /** The summit as [TestBackend] publishes it (the talk bundle and conferences.json). */
    fun testConference(): TestBackend.TestConference = TestBackend.TestConference(
        SLUG,
        NAME,
        "2026-11-09",
        // A bundle lists its talks by start, then talk_id.
        TALKS.sortedWith(compareBy<SampleTalk> { it.startIso }.thenBy { it.id }).map { t ->
            TestBackend.TestTalk(
                id = "${1000 + t.n}",
                kind = "talk",
                title = t.title,
                abstract = "Placeholder abstract for sample talk ${t.n}. It mentions kubernetes, security & observability so mock searches find something.",
                speakers = t.speakers.map { it to "Sample tagline" },
                day = t.day,
                start = minutes(t.start),
                end = minutes(t.end),
                track = t.track,
                room = t.room,
                hasSlides = t.slides,
                topics = t.topics,
            )
        },
        endDay = "2026-11-12",
    )

    /** The summit as FakePeopleServer knows it: zones from its rooms, its topics and talks. */
    fun fakeConference(): FakeConference = FakeConference(
        slug = SLUG,
        rooms = TALKS.mapNotNull { it.room },
        topics = LABELS,
        talks = TALKS.map { FakeTalk(it.id, it.title, start = it.startIso, end = it.endIso, url = it.url, speakers = it.speakers) },
    )

    /** One sample person of fixtures.ts, at the summit. */
    class MockPerson(
        val n: Int,
        val name: String,
        val learn: List<String>,
        val speak: List<String>,
        val shared: List<Int>,
        val openToMeet: Boolean,
        val expertise: String,
        val interests: String,
        /** Their fixed zone; null for those who are never around or who turn up later (moved by the test). */
        val zone: String?,
        val spot: String?,
        val broad: Boolean = false,
    ) {
        val displayName: String get() = "Sample · $name"
        val about: String get() = "Placeholder profile $n for local development."
    }

    private val FILLER_EXPERTISE = listOf(
        "Ran Postgres operators on bare metal for 3 years and lived through two storage migrations.",
        "Moved a 40-team platform to GitOps with Argo CD; wrote the rollback runbooks.",
        "Built an internal developer portal on Backstage and then replaced half of it.",
        "Tuned eBPF probes in production until the overhead fell under one percent.",
        "Operated a multi-cluster service mesh across three clouds with mTLS everywhere.",
        "Wrote admission policies in Rego and then migrated them to Kyverno.",
        "Scaled a Kafka platform past a million messages a second on Kubernetes.",
        "Shipped WebAssembly plugins for an API gateway and measured cold starts.",
        "Set up GPU scheduling for an ML platform; fought the node autoscaler and won.",
        "Debugged DNS in Kubernetes more times than anyone should.",
        "Migrated CI from Jenkins to Tekton for a 200-developer org.",
        "Built cost dashboards from OpenCost and cut the cloud bill by a third.",
        "Ran an on-call rotation for a managed Kubernetes product with 400 clusters.",
    )
    private val FILLER_NAMES = listOf(
        "Harper", "Indigo", "Jules", "Kai", "Lennon", "Marlowe", "Noor", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum",
        "Uma", "Vesper", "Wren", "Xen", "Yael", "Zephyr", "Arden", "Bellamy", "Cleo", "Dakota", "Ellis", "Frankie", "Greer",
    )
    private val FILLER_TOPICS = listOf("kubernetes", "ebpf", "service-mesh", "security", "observability", "ai", "platform-engineering", "wasm")
    private val FIXED_ZONE_SAMPLES = listOf("Hallway", "Food and coffee", "Sample Room 2", "Registration", "Outside", "Expo hall")

    /** The summit's people in fixtures.ts order (Finley and Gray belong to the other conference). */
    val PEOPLE: List<MockPerson> = listOf(
        MockPerson(1, "Avery", listOf("ebpf"), listOf("kubernetes", "security"), listOf(1), true,
            "Ran Postgres operators on bare metal for 3 years; broke and fixed Kubernetes upgrades across 60 clusters.",
            "Getting Postgres failover under a minute without a managed service.", "Sample Room 1", "back row, left"),
        MockPerson(2, "Blake", listOf("security"), listOf("ebpf", "observability"), listOf(1, 3), true,
            "Tuned eBPF probes in production until the overhead fell under one percent; built the tracing pipeline around them.",
            "Supply-chain security for a platform team that ships 300 images a day.", "Expo hall", "by the coffee cart"),
        MockPerson(3, "Casey", listOf("ai"), listOf("service-mesh"), listOf(3), true,
            "Operated a multi-cluster service mesh across three clouds; wrote the mTLS rotation tooling.",
            "Running inference workloads next to the mesh without doubling latency.", null, null),
        MockPerson(4, "Devon", listOf("kubernetes"), listOf("platform-engineering"), emptyList(), true,
            "Moved a 40-team platform to GitOps with Argo CD; wrote the rollback runbooks.",
            "Kubernetes multi-tenancy for teams that refuse to share a cluster.", null, null),
        MockPerson(8, "Hollis", listOf("wasm"), listOf("kubernetes"), emptyList(), true,
            "Scaled a Kafka platform past a million messages a second on Kubernetes; wrote the partition rebalancing runbook.",
            "Running stateful workloads without a storage team.", "Expo hall", "tall, by the espresso machine"),
        MockPerson(5, "Emery", listOf("observability"), listOf("wasm"), listOf(1), false,
            "Shipped WebAssembly plugins for an API gateway and measured cold starts.",
            "Placeholder interest 5: comparing notes on sample platforms.", null, null),
        MockPerson(11, "Rowan", listOf("observability"), listOf("kubernetes", "platform-engineering"), emptyList(), true,
            "Rebuilt a 3,000-node cluster's etcd from a snapshot during a live event. Wrote the runbook afterwards.",
            "Making control-plane recovery boring.", null, null),
        MockPerson(9, "Sawyer", listOf("security"), listOf("kubernetes"), emptyList(), true,
            "Keeps a few clusters running for a small team.",
            "Whatever everyone else is talking about this year.", null, null, broad = true),
        MockPerson(10, "Tenzin", listOf("wasm"), listOf("observability"), emptyList(), true,
            "Ran the tracing backend for a payments company; cut cardinality by 90% without losing an alert.",
            "Profiling in production without a sidecar per pod.", null, null),
    ) + FILLER_NAMES.mapIndexed { i, name ->
        MockPerson(
            100 + i, name,
            listOf(FILLER_TOPICS[(i + 3) % FILLER_TOPICS.size]),
            listOf(FILLER_TOPICS[i % FILLER_TOPICS.size]),
            emptyList(), true,
            FILLER_EXPERTISE[i % FILLER_EXPERTISE.size],
            "Placeholder interest ${100 + i}: comparing notes on sample platforms.",
            if (i % 5 == 0) FIXED_ZONE_SAMPLES[(i / 5) % FIXED_ZONE_SAMPLES.size] else null,
            null,
        )
    }

    fun person(name: String): MockPerson = PEOPLE.first { it.name == name }
}

/**
 * FakePeopleServer with the web mock's answers to `POST /api/people/matches` and
 * `POST /api/circles/members` (handler.ts personResult, its ranking and its made-up positions); every
 * other request, and those two whenever the device is not allowed them, goes to [server]. [seeded] maps
 * each sample person to the handle they were seeded under. Call [send] under the test's lock.
 */
internal class ParityWebMock(
    private val server: FakePeopleServer,
    private val clock: () -> Long,
    val seeded: Map<String, FakePerson>,
) : ApiHttp {
    private val slug = ParitySample.SLUG

    override suspend fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long, maxBytes: Long): HttpResponse {
        val path = url.substring(maxOf(0, url.indexOf("/api/"))).substringBefore('?')
        if (method == "POST" && (path == "/api/people/matches" || path == "/api/circles/members")) {
            val request = body?.decodeToString()?.let { Json.parseToJsonElement(it) as? JsonObject }
            val me = server.me(slug)?.doc
            val answer = when {
                request == null || me == null -> null
                path == "/api/people/matches" -> if (me.openToMeet) matches(request, me) else null
                else -> request.str("talk_id")?.takeIf { it in me.shared }?.let { circle(it, me) }
            }
            if (answer != null) {
                server.record(RecordedRequest(method, url, headers, body?.decodeToString()))
                return HttpResponse(200, answer.toString().encodeToByteArray(), headers = mapOf("content-type" to "application/json"))
            }
        }
        return server.send(method, url, headers, body, timeoutMs, maxBytes)
    }

    private fun live(person: FakePerson): FakePeopleServer.Doc = person.doc

    private fun zoneOf(d: FakePeopleServer.Doc): String? = d.zone?.takeIf { d.until > clock() }

    private fun blockedEither(me: FakePeopleServer.Doc, d: FakePeopleServer.Doc) =
        me.blocks.any { it.first == d.ref } || d.blocks.any { it.first == me.ref }

    private fun matches(b: JsonObject, me: FakePeopleServer.Doc): JsonObject {
        val interested = (b["interested_talk_ids"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
        val query = b.str("query").orEmpty().take(300)
        val aroundNow = b.str("when") == "around_now"
        val terms = query.lowercase().split(Regex("[^a-z0-9]+")).filter { it.length > 2 }
        val from = max(0, (b["from"] as? JsonPrimitive)?.intOrNull ?: 0)
        val size = min(max(1, (b["size"] as? JsonPrimitive)?.intOrNull ?: 20), 20)
        val myZone = zoneOf(me)
        val mine = me.loc?.takeIf { myZone != null }?.let { LatLon(round5(it.first), round5(it.second)) }
        val pool = ParitySample.PEOPLE.filter { p ->
            val d = live(seeded.getValue(p.name))
            p.openToMeet && !blockedEither(me, d) && !d.hidden && (!aroundNow || zoneOf(d) != null) &&
                (terms.isEmpty() || terms.any { w -> "${p.expertise} ${p.about}".lowercase().contains(w) })
        }
        fun near(p: ParitySample.MockPerson): Double {
            val theirs = mine?.let { samplePosition(p, it, zoneOf(live(seeded.getValue(p.name)))) } ?: return 0.0
            return max(0.0, 1 - distanceM(cellFor(mine), cellFor(theirs)) / 1000)
        }
        fun score(p: ParitySample.MockPerson): Double =
            terms.count { p.expertise.lowercase().contains(it) } * 10.0 + (if (zoneOf(live(seeded.getValue(p.name))) != null) 1 else 0) + near(p)
        val specific = pool.filter { !it.broad }.sortedByDescending { score(it) }
        val broad = if (aroundNow && myZone != null && terms.isEmpty()) {
            pool.filter { it.broad && zoneOf(live(seeded.getValue(it.name))) == myZone }
        } else {
            emptyList()
        }
        val ranked = specific + broad
        val page = ranked.drop(from).take(size)
        return buildJsonObject {
            put("results", JsonArray(page.map { personResult(it, me, interested, terms, myZone, mine) }))
            put("from", from)
            put("size", size)
            put("has_more", from + size < ranked.size)
        }
    }

    private fun circle(talkId: String, me: FakePeopleServer.Doc): JsonObject {
        val talk = ParitySample.TALKS.first { it.id == talkId }
        val members = ParitySample.PEOPLE.filter { p -> talkId in p.shared.map { ParitySample.talk(it).id } && !live(seeded.getValue(p.name)).hidden }
        return buildJsonObject {
            putJsonObject("talk") {
                put("title", talk.title)
                put("start", talk.startIso)
                put("end", talk.endIso)
                put("url", talk.url)
            }
            putJsonArray("speakers") {
                add(buildJsonObject {
                    put("name", "Sample Speaker One")
                    put("tagline", "Sample tagline")
                    putJsonArray("links") { add(buildJsonObject { put("title", "Website"); put("url", "https://example.invalid/speaker") }) }
                })
            }
            put("count", members.size + 1)
            put("members", JsonArray(members.map { personResult(it, me, listOf(talkId), emptyList(), null, null, circle = true) }))
        }
    }

    private fun personResult(
        p: ParitySample.MockPerson,
        me: FakePeopleServer.Doc,
        interested: List<String>,
        terms: List<String>,
        myZone: String?,
        mine: LatLon?,
        circle: Boolean = false,
    ): JsonObject {
        val d = live(seeded.getValue(p.name))
        val canTeach = p.speak.filter { it in me.learn }
        val wantsMine = p.learn.filter { it in me.speak }
        fun label(ids: List<String>) = ids.joinToString(", ") { ParitySample.label(it) }
        val hit = if (terms.isNotEmpty()) highlight(p.expertise, terms) ?: highlight(p.about, terms) else null
        val presenceZone = zoneOf(d)
        val around = presenceZone != null
        val meAround = !circle && myZone != null
        val zone = if (around && meAround) presenceZone else null
        val proximity = if (around && meAround) band(myZone!!, mine, p, presenceZone) else null
        val evidence = if (p.broad) null else hit ?: firstSentence(p.expertise)
        val reasons = ArrayList<String>()
        if (p.broad) {
            val shared = (canTeach + wantsMine).distinct()
            reasons += "Also interested in ${label(shared.ifEmpty { p.speak.take(1) })}."
        } else {
            if (hit != null) reasons += "They've worked on $hit"
            if (canTeach.isNotEmpty()) reasons += "They can speak to ${label(canTeach)}, which you want to learn about."
            if (wantsMine.isNotEmpty()) reasons += "They want to learn about ${label(wantsMine)}, which you can speak to."
            p.shared.map { ParitySample.talk(it) }.firstOrNull { it.id in interested }?.let { reasons += "You are both interested in ${it.title}." }
        }
        if (zone != null) reasons += "They're in $zone right now."
        if (reasons.isEmpty()) reasons += "Ask them about ${label(p.speak)}."
        return buildJsonObject {
            put("ref", d.ref)
            put("display_name", p.displayName)
            put("about", p.about)
            put("sample", true)
            put("learn_topics", topicRefs(p.learn))
            put("speak_topics", topicRefs(p.speak))
            put("reasons", JsonArray(reasons.map { JsonPrimitive(it) }))
            put("opener", reasons.first())
            putJsonObject("contact") {
                put("linkedin_url", JsonNull)
                put("contact_note", "Sample profile, not a real person")
            }
            put("evidence", evidence)
            put("around", around)
            if (zone != null) put("zone", zone)
            put("proximity", proximity)
            if (p.broad) put("broad", true)
        }
    }

    private fun topicRefs(ids: List<String>) = buildJsonArray {
        for (id in ids) add(buildJsonObject { put("topic_id", id); put("label", ParitySample.label(id)) })
    }

    // --- handler.ts: highlight, the first sentence, and the made-up positions and bands ---

    private fun highlight(text: String, terms: List<String>): String? {
        var hit = false
        var out = text
        for (term in terms) {
            val re = Regex("(${Regex.escape(term)})", RegexOption.IGNORE_CASE)
            if (re.containsMatchIn(out)) {
                hit = true
                out = re.replace(out, "<mark>$1</mark>")
            }
        }
        return if (hit) out else null
    }

    /** `text.split(/(?<=\.)\s/)[0]`. */
    private fun firstSentence(text: String): String {
        for (i in 1 until text.length) if (text[i].isWhitespace() && text[i - 1] == '.') return text.substring(0, i)
        return text
    }

    private class LatLon(val lat: Double, val lon: Double)

    private fun rad(d: Double) = d * PI / 180

    /** JavaScript's Math.round. */
    private fun jsRound(x: Double) = floor(x + 0.5)

    private fun round5(x: Double) = jsRound(x * 1e5) / 1e5

    private fun round6(x: Double) = jsRound(x * 1e6) / 1e6

    private fun distanceM(a: LatLon, b: LatLon): Double {
        val dLat = rad(b.lat - a.lat)
        val dLon = rad(b.lon - a.lon)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(rad(a.lat)) * cos(rad(b.lat)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * EARTH_M * asin(min(1.0, sqrt(h)))
    }

    private fun cellFor(p: LatLon): LatLon {
        val lat = max(-90.0, min(90.0, jsRound(p.lat / CELL_DEG) * CELL_DEG))
        val step = CELL_DEG / max(cos(rad(lat)), CELL_DEG)
        return LatLon(round6(lat), round6(jsRound(p.lon / step) * step))
    }

    private fun offset(from: LatLon, metres: Double, bearing: Double): LatLon {
        val dLat = metres * cos(rad(bearing)) / EARTH_M
        val dLon = metres * sin(rad(bearing)) / (EARTH_M * cos(rad(from.lat)))
        return LatLon(from.lat + dLat * 180 / PI, from.lon + dLon * 180 / PI)
    }

    private fun samplePosition(p: ParitySample.MockPerson, mine: LatLon, theirZone: String?): LatLon? {
        if (theirZone == null) return null
        val metres = listOf(40.0, 120.0, 260.0, 500.0, 900.0)[p.n % 5]
        return offset(mine, metres, ((p.n * 73) % 360).toDouble())
    }

    private fun band(myZone: String, mine: LatLon?, p: ParitySample.MockPerson, theirZone: String?): String {
        if (theirZone == myZone) return "same_zone"
        val theirs = mine?.let { samplePosition(p, it, theirZone) }
        if (mine == null || theirs == null) return "venue"
        val a = cellFor(mine)
        val b = cellFor(theirs)
        if (a.lat == b.lat && a.lon == b.lon) return "near"
        return if (distanceM(a, b) < 300) "around" else "venue"
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private companion object {
        const val EARTH_M = 6_371_000.0
        const val CELL_DEG = 0.001
    }
}
