package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.ble.BleProtocol
import app.conferencecaddie.shared.ble.HmacSha256
import app.conferencecaddie.shared.bundle.Sha256
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.people.DeviceCredential
import app.conferencecaddie.shared.people.PeopleZones
import app.conferencecaddie.shared.secureRandomBytes
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.time.Instant
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** The fake server is switched to "offline": every request throws this, as a dropped connection does. */
class FakeNetworkDown : Exception("The fake People server is offline.")

/** An action taken as a seeded person was refused; [status] and [code] are the answer the server gave. */
class FakeCallFailed(val status: Int, val code: String?) : Exception("The fake People server answered $status ${code ?: ""}".trim())

/** A talk of a [FakeConference]: what circles and shared talks need. [kind] is "talk" for a real session. */
class FakeTalk(
    val id: String,
    val title: String,
    val kind: String = "talk",
    val start: String? = null,
    val end: String? = null,
    val url: String? = null,
    val speakers: List<String> = emptyList(),
)

/**
 * One conference of the fake. The zones are its [rooms] (sorted) and then the five fixed zones, as
 * [PeopleZones] builds them for the app, so a zone the controller sends always matches.
 */
class FakeConference(
    val slug: String,
    rooms: List<String>,
    /** topic_id to label. */
    val topics: Map<String, String>,
    val talks: List<FakeTalk> = emptyList(),
) {
    val zones: List<String> = PeopleZones.forRooms(rooms)

    companion object {
        /** The talks and rooms of [app.conferencecaddie.ui.talks.TestBackend]'s Alpha conference, and its three topics. */
        fun alpha() = FakeConference(
            slug = "alpha-conf-2099",
            rooms = listOf("Hall A", "Hall B"),
            topics = mapOf("ebpf" to "eBPF", "kubernetes" to "Kubernetes", "security" to "Security"),
            talks = listOf(
                FakeTalk("alpha-conf-2099:1", "Intro to eBPF tracing", start = "2099-03-03T10:00:00Z", end = "2099-03-03T10:30:00Z", url = "https://caddie.test/alpha-conf-2099/session/1", speakers = listOf("Ada Lovelace")),
                FakeTalk("alpha-conf-2099:2", "Lunch", kind = "break"),
                FakeTalk("alpha-conf-2099:3", "Kubernetes scheduling deep dive", start = "2099-03-03T13:30:00Z", end = "2099-03-03T14:00:00Z", speakers = listOf("Grace Hopper")),
                FakeTalk("alpha-conf-2099:4", "Kubernetes networking basics", start = "2099-03-03T15:00:00Z", end = "2099-03-03T15:30:00Z"),
            ),
        )
    }
}

/** What the fake does to every request while it is set. */
sealed interface FakeFailure {
    data object None : FakeFailure

    /** Throws [FakeNetworkDown]. */
    data object Offline : FakeFailure

    /** Answers [status] (a 5xx) with the store-failed body. */
    data class ServerError(val status: Int = 503) : FakeFailure

    /** Answers 429 `Too many requests` with `Retry-After: [retryAfterSeconds]`. */
    data class RateLimited(val retryAfterSeconds: Int = 30) : FakeFailure
}

/** One request the code under test sent, as the fake received it. */
class RecordedRequest(val method: String, val url: String, val headers: Map<String, String>, val bodyText: String?) {
    /** The path from `/api/`, without the query. */
    val path: String get() = url.substring(maxOf(0, url.indexOf("/api/"))).substringBefore('?')
    val query: String? get() = url.substringAfter('?', "").ifEmpty { null }
    val body: JsonObject? get() = bodyText?.let { Json.parseToJsonElement(it) as? JsonObject }

    /** The header [name], any case, or null. */
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

/**
 * An in-memory People API v1 server (docs/contracts/people-api.md) for the UI tests of the native
 * apps, beside [app.conferencecaddie.ui.talks.TestBackend]. It answers every route of the contract
 * with the contract's status codes, stable error bodies and closed response shapes, keeping per
 * conference the profiles (keyed by the device credential), visibility, presence, blocks, meets and
 * reports. A request goes in as [ApiHttp] sends it, so the real [app.conferencecaddie.shared.people.PeopleController]
 * can run against it. [clock] gives epoch milliseconds, so a test that moves the clock expires
 * presence and asks.
 *
 * It never returns a profile_id, a secret or a coordinate. Ranking is a deterministic count of
 * shared topics, shared talks and words, which is enough to drive flows, not to judge relevance.
 * Presence "day" mode ends at the end of the UTC day. The conference has no end date here. No
 * rate limit is simulated except through [failure]. Words in [filterWords] are held by the line
 * filter (400 `filtered`).
 *
 * Bluetooth is derived-v1 (docs/contracts/ble-tokens.md): a presence write with `ble: true` mints a
 * random 32-byte key for a new session and answers it once with its id; `ble: false`, the end of
 * presence and the profile's deletion end the session. Sightings resolve the tokens of windows
 * w - 1, w and w + 1 of every live session at the conference, at or above [nearRssi], to the people
 * who are around in the requester's zone and visible (the co-location rule, zones only), ranked like
 * matches, and answer `{ nearby, ble_key_id }`.
 */
class FakePeopleServer(private val clock: () -> Long, conferences: List<FakeConference>) : ApiHttp {
    constructor(clock: () -> Long, vararg conferences: FakeConference) : this(clock, conferences.toList())

    private val conferences = conferences.associateBy { it.slug }
    private val docs = ArrayList<Doc>()
    private val meets = ArrayList<Meet>()
    private val reports = ArrayList<Report>()
    private var counter = 0

    /** Every request the code under test sent, oldest first (calls a [FakePerson] makes are not recorded). */
    val requests = ArrayList<RecordedRequest>()

    /** The mode every request meets; set it back to [FakeFailure.None] to recover. */
    var failure: FakeFailure = FakeFailure.None

    /** Sent as `X-Caddie-Pace` on every answer when set. */
    var pace: String? = null

    /** `ble.near_rssi`: weaker sightings resolve to nobody. */
    var nearRssi: Int = -75

    /** The native push platforms this server pushes to ("apns", "fcm"); empty answers 404 `push_unavailable`. */
    var pushPlatforms: Set<String> = emptySet()

    /** Lines containing one of these words (any case) are refused with 400 `filtered`. */
    var filterWords: Set<String> = setOf("badword")

    private var deleteFailures = 0
    private var deleteFailureStatus = 502

    /** The next [count] profile deletes answer [status] and delete nothing. */
    fun failNextDeletes(count: Int, status: Int = 502) {
        deleteFailures = count
        deleteFailureStatus = status
    }

    /**
     * One request held on its way in: the server has recorded it but answers, and applies it, only
     * once [release] is called. Cancelling the caller while it is held drops the request unapplied.
     */
    class Hold internal constructor(internal val method: String, internal val path: String) {
        private val arrived = CompletableDeferred<Unit>()
        private val gate = CompletableDeferred<Unit>()

        /** True once a matching request has reached the server and is waiting. */
        val hasArrived: Boolean get() = arrived.isCompleted

        internal suspend fun wait() {
            arrived.complete(Unit)
            gate.await()
        }

        /** Lets the held request be applied and answered. */
        fun release() {
            gate.complete(Unit)
        }
    }

    @kotlin.concurrent.Volatile
    private var holds: List<Hold> = emptyList()

    /**
     * Holds the next request with [method] to [path], and only that one, until [Hold.release]. For
     * tests of what happens when the screen that asked has gone by the time the answer comes.
     */
    fun hold(method: String, path: String): Hold = Hold(method, path).also { holds = holds + it }

    /** The recorded requests with [method] to [path]. */
    fun requests(method: String, path: String): List<RecordedRequest> = requests.filter { it.method == method && it.path == path }

    /** True when any recorded request carried an `Origin` header. */
    fun anyOrigin(): Boolean = requests.any { it.header("Origin") != null }

    // ---------------------------------------------------------------------------------------------
    // Test control

    /**
     * Adds a person to conference [slug], visible conference-wide ([openToMeet]) and optionally
     * sharing [sharedTalkIds], and around in zone [around] for an hour when it is not null; [located]
     * gives them a stored position near the venue origin. Returns their ref and a handle to act as them.
     */
    fun seedPerson(
        slug: String,
        displayName: String,
        about: String = "",
        expertise: String = "",
        speakTopics: List<String> = emptyList(),
        around: String? = null,
        located: Boolean = false,
        learnTopics: List<String> = emptyList(),
        interests: String = "",
        sharedTalkIds: List<String> = emptyList(),
        openToMeet: Boolean = true,
        linkedinUrl: String? = null,
        contactNote: String? = null,
    ): FakePerson {
        val conf = conferences.getValue(slug)
        val d = newDoc(slug, seeded = true)
        d.displayName = displayName
        d.about = about
        d.expertise = expertise
        d.interests = interests
        d.speak = speakTopics.filter { it in conf.topics }
        d.learn = learnTopics.filter { it in conf.topics }
        d.shared = sharedTalkIds
        d.openToMeet = openToMeet
        d.linkedin = linkedinUrl
        d.contactNote = contactNote
        docs += d
        val person = FakePerson(this, d)
        if (around != null) person.goAround(around, located = located)
        return person
    }

    /** This phone's Bluetooth payload for [person] at the clock's window, as their radio would serve it; null without a live session. */
    fun blePayload(person: FakePerson, atMs: Long = clock()): ByteArray? =
        person.doc.bleKey?.let { BleProtocol.encodePayload(BleProtocol.tokenOf(HmacSha256.mac(it, BleProtocol.tokenMessage(BleProtocol.windowAtMillis(atMs))))) }

    /** The `ble_key_id` of [person]'s live Bluetooth session, or null. */
    fun bleKeyId(person: FakePerson): String? = person.doc.bleKey?.let { keyIdOf(it) }

    /** The profile most recently created through the API at [slug] (the device under test), or null when there is none. */
    fun me(slug: String): FakePerson? = docs.lastOrNull { it.slug == slug && !it.seeded }?.let { FakePerson(this, it) }

    /** The person with [ref] at [slug], or null. */
    fun person(slug: String, ref: String): FakePerson? = docs.firstOrNull { it.slug == slug && it.ref == ref }?.let { FakePerson(this, it) }

    /** The stored state of a meet, or null when there is no such meet (after the time and presence transitions). */
    fun meetState(meetId: String): String? = meets.firstOrNull { it.id == meetId }?.also { refresh(it) }?.state

    /** Every ref at [slug] that [person] has blocked, oldest first. */
    fun blockedBy(person: FakePerson): List<String> = person.doc.blocks.map { it.first }

    private fun newDoc(slug: String, seeded: Boolean, credential: Pair<String, String>? = null): Doc {
        counter++
        val (id, secret) = credential ?: (DeviceCredential.base64Url(bytes(16, counter)) to DeviceCredential.base64Url(bytes(32, counter + 1000)))
        return Doc(slug, id, secret, refFor(slug, id), seeded)
    }

    // ---------------------------------------------------------------------------------------------
    // ApiHttp

    override suspend fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long, maxBytes: Long): HttpResponse {
        requests += RecordedRequest(method, url, headers, body?.decodeToString())
        val request = RecordedRequest(method, url, headers, null)
        holds.firstOrNull { it.method == method && it.path == request.path }?.let { held ->
            holds = holds - held
            held.wait()
        }
        return answer(method, url, headers, body?.decodeToString())
    }

    private fun answer(method: String, url: String, headers: Map<String, String>, body: String?): HttpResponse {
        val reply = try {
            when (val f = failure) {
                FakeFailure.Offline -> throw FakeNetworkDown()
                is FakeFailure.ServerError -> throw Reply(f.status, err("People are temporarily unavailable"))
                is FakeFailure.RateLimited -> throw Reply(429, err("Too many requests"), mapOf("retry-after" to f.retryAfterSeconds.toString()))
                FakeFailure.None -> Unit
            }
            Reply(200, route(method, url, headers, body))
        } catch (r: Reply) {
            r
        }
        val h = if (pace != null) reply.headers + ("x-caddie-pace" to pace!!) else reply.headers
        return HttpResponse(reply.status, reply.body.toString().encodeToByteArray(), headers = h + ("cache-control" to "no-store"))
    }

    /** Runs a request as [doc] without recording it; used by [FakePerson]. */
    internal fun actAs(doc: Doc, method: String, path: String, body: JsonObject?): JsonObject {
        val h = mapOf("X-Caddie-Device" to "${doc.profileId}.${doc.secret}")
        val r = answer(method, "https://fake.test$path", h, body?.toString())
        val parsed = Json.parseToJsonElement(r.text()) as JsonObject
        if (r.status !in 200..299) throw FakeCallFailed(r.status, parsed.str("error"))
        return parsed
    }

    // ---------------------------------------------------------------------------------------------
    // Routing

    private class Reply(val status: Int, val body: JsonObject, val headers: Map<String, String> = emptyMap()) : Exception()

    private fun err(code: String, build: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        put("error", code)
        build()
    }

    private fun fail(status: Int, code: String, headers: Map<String, String> = emptyMap(), build: JsonObjectBuilder.() -> Unit = {}): Nothing =
        throw Reply(status, err(code, build), headers)

    private fun bad(message: String): Nothing = fail(400, message)

    private class Cred(val profileId: String, val secret: String)

    private val meetPath = Regex("^/api/meet/([A-Za-z0-9_-]+)(?:/(accept|decline|found|cancel|details))?$")

    private fun route(method: String, url: String, headers: Map<String, String>, bodyText: String?): JsonObject {
        val at = url.indexOf("/api/")
        if (at < 0) fail(404, "Not found")
        val full = url.substring(at)
        val path = full.substringBefore('?')
        val query = full.substringAfter('?', "").split('&').filter { it.contains('=') }.associate { it.substringBefore('=') to percentDecode(it.substringAfter('=')) }
        val origin = headers.entries.firstOrNull { it.key.equals("Origin", true) }?.value
        if (origin != null && origin.substringAfter("://") != url.substringAfter("://").substringBefore('/')) fail(403, "cross-origin request")
        val body: JsonObject? = if (bodyText == null) null else {
            if (bodyText.encodeToByteArray().size > 8192) fail(413, "Request body is too large")
            (try { Json.parseToJsonElement(bodyText) } catch (e: Exception) { null } as? JsonObject) ?: bad("The body must be a JSON object")
        }
        val device = headers.entries.firstOrNull { it.key.equals("X-Caddie-Device", true) }?.value
        val ctx = Ctx(method, device, body, query)
        val meet = meetPath.matchEntire(path)
        return when {
            path == "/api/people/profile" -> ctx.only("PUT", "DELETE") { if (method == "PUT") putProfile(ctx) else deleteProfile(ctx) }
            path == "/api/people/matches" -> ctx.only("POST") { matches(ctx) }
            path == "/api/circles/counts" -> ctx.only("POST") { circleCounts(ctx) }
            path == "/api/circles/members" -> ctx.only("POST") { circleMembers(ctx) }
            path == "/api/people/block" -> ctx.only("POST", "DELETE") { block(ctx, method == "POST") }
            path == "/api/people/blocks" -> ctx.only("GET") { blocks(ctx) }
            path == "/api/presence" -> ctx.only("PUT", "DELETE") { if (method == "PUT") putPresence(ctx) else deletePresence(ctx) }
            path == "/api/presence/ble/rotate" -> ctx.only("POST") { rotateBle(ctx) }
            path == "/api/presence/sightings" -> ctx.only("POST") { sightings(ctx) }
            path == "/api/meet" -> ctx.only("POST") { requestMeet(ctx) }
            path == "/api/meet/inbox" -> ctx.only("GET") { inbox(ctx) }
            meet != null -> meetRoute(ctx, meet.groupValues[1], meet.groupValues[2].ifEmpty { null })
            path == "/api/people/report" -> ctx.only("POST") { report(ctx) }
            path == "/api/push/vapid" -> ctx.only("GET") { buildJsonObject { put("publicKey", JsonNull) } }
            path == "/api/push/subscription" -> ctx.only("PUT", "DELETE") { pushSubscription(ctx) }
            path == "/api/push/native" -> ctx.only("PUT", "DELETE") { pushNative(ctx) }
            else -> fail(404, "Not found")
        }
    }

    private inner class Ctx(val method: String, val device: String?, val body: JsonObject?, val query: Map<String, String>) {
        fun only(vararg methods: String, block: () -> JsonObject): JsonObject {
            if (method !in methods) fail(405, "Method not allowed", mapOf("allow" to methods.joinToString(", ")))
            return block()
        }

        /** The credential of the header, or 403 `forbidden`. */
        fun cred(): Cred {
            val parts = device?.split('.') ?: fail(403, "forbidden")
            if (parts.size != 2 || !ID_RE.matches(parts[0]) || !SECRET_RE.matches(parts[1])) fail(403, "forbidden")
            return Cred(parts[0], parts[1])
        }

        fun obj(allowed: Set<String>, required: Set<String> = emptySet()): JsonObject {
            val b = body ?: bad("The body must be a JSON object")
            for (k in b.keys) if (k !in allowed) bad("Unknown key: ${k.take(40)}")
            for (k in required) if (k !in b) bad("$k is required")
            return b
        }

        /** The conference named by `event` (in the body or the query), or 400. */
        fun conf(event: String?): FakeConference = event?.let { conferences[it] } ?: bad("conference is not available")

        /** The requester's credential checked against their document at [slug]; the document, or null when none. */
        fun doc(slug: String): Doc? {
            val c = cred()
            val d = docs.firstOrNull { it.slug == slug && it.profileId == c.profileId }
            if (d != null && d.secret != c.secret) fail(403, "forbidden")
            return d
        }

        fun live(slug: String): Doc = doc(slug) ?: fail(403, "profile_required")
    }

    // ---------------------------------------------------------------------------------------------
    // Profile

    private fun putProfile(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "profile", "open_to_meet", "shared_talk_ids"), setOf("event", "profile", "open_to_meet"))
        val conf = c.conf(b.str("event"))
        val cred = c.cred()
        val existing = c.doc(conf.slug)
        val p = b["profile"] as? JsonObject ?: bad("profile must be an object")
        for (k in p.keys) if (k !in PROFILE_KEYS) bad("Unknown key: profile.${k.take(40)}")
        val open = (b["open_to_meet"] as? JsonPrimitive)?.booleanOrNull ?: bad("open_to_meet must be a boolean")
        val shared = idList(b["shared_talk_ids"], "shared_talk_ids", 50)
        val name = text(p["display_name"], "display_name", 60, required = true)
        val about = text(p["about"], "about", 280)
        val interests = text(p["interests"], "interests", 500)
        val expertise = text(p["expertise"], "expertise", 500)
        val contactNote = text(p["contact_note"], "contact_note", 120).ifEmpty { null }
        val linkedin = text(p["linkedin_url"], "linkedin_url", 200).ifEmpty { null }
        if (linkedin != null && !LINKEDIN_RE.matches(linkedin)) bad("linkedin_url must be a https://www.linkedin.com/in/... address or null")
        val learn = topicList(conf, p["learn_topics"], "learn_topics", existing?.learn ?: emptyList())
        val speak = topicList(conf, p["speak_topics"], "speak_topics", existing?.speak ?: emptyList())
        val talkIds = conf.talks.filter { it.kind == "talk" }.map { it.id }
        if (!shared.all { it in talkIds }) bad("shared_talk_ids contains an unknown talk")
        if (!open && shared.isEmpty()) {
            if (existing != null) deleteDoc(existing)
            return buildJsonObject {
                put("ok", true)
                put("open_to_meet", false)
                putJsonArray("shared_talk_ids") {}
            }
        }
        val d = existing ?: newDoc(conf.slug, seeded = false, credential = cred.profileId to cred.secret).also { docs += it }
        d.displayName = name
        d.about = about
        d.interests = interests
        d.expertise = expertise
        d.learn = learn
        d.speak = speak
        d.linkedin = linkedin
        d.contactNote = contactNote
        d.openToMeet = open
        d.shared = shared
        // Conference-wide visibility off ends the Bluetooth session with it.
        if (!open) d.bleKey = null
        if (reportCount(conf.slug, "profile", d.ref) >= 2) d.hidden = true
        return buildJsonObject {
            put("ok", true)
            put("open_to_meet", open)
            put("shared_talk_ids", JsonArray(shared.map { JsonPrimitive(it) }))
            put("hidden_for_owner", d.hidden)
        }
    }

    private fun deleteProfile(c: Ctx): JsonObject {
        val slug = c.query["event"]?.takeIf { SLUG_RE.matches(it) } ?: bad("event must be a conference slug")
        if (deleteFailures > 0) {
            deleteFailures--
            fail(deleteFailureStatus, "People are temporarily unavailable")
        }
        c.doc(slug)?.let { deleteDoc(it) }
        return OK
    }

    private fun deleteDoc(d: Doc) {
        docs.remove(d)
        meets.removeAll { it.requester == d.profileId || it.target == d.profileId }
    }

    // ---------------------------------------------------------------------------------------------
    // Matches and circles

    private fun matches(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "interested_talk_ids", "query", "when", "from", "size"), setOf("event"))
        val conf = c.conf(b.str("event"))
        val me = c.doc(conf.slug)
        if (me == null || !me.openToMeet) fail(403, "visibility_required")
        val q = text(b["query"], "query", 300).ifEmpty { null }
        val whenNow = when (val w = b.str("when")) {
            null, "anyone" -> false
            "around_now" -> true
            else -> bad("when must be anyone or around_now: $w")
        }
        val from = b.int("from", 0, 0, 1000)
        val size = b.int("size", 20, 1, 20)
        val words = tokens(q ?: "")
        val ranked = docs.filter { it.slug == conf.slug && it !== me && it.openToMeet && !it.hidden && !blockedEither(me, it) }
            .filter { !whenNow || around(it) }
            .map { it to score(me, it, words) }
            .filter { words.isEmpty() || wordHits(it.first, words) > 0 }
            .sortedWith(compareByDescending<Pair<Doc, Int>> { it.second }.thenBy { it.first.displayName }.thenBy { it.first.ref })
            .map { it.first }
        val page = ranked.drop(from).take(size)
        return buildJsonObject {
            put("results", JsonArray(page.map { personJson(conf, me, it, words, null) }))
            put("from", from)
            put("size", size)
            put("has_more", from + size < ranked.size)
        }
    }

    private fun circleCounts(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "talk_ids"), setOf("event"))
        val conf = c.conf(b.str("event"))
        val ids = idList(b["talk_ids"], "talk_ids", 100)
        return buildJsonObject {
            putJsonObject("counts") {
                for (id in ids) put(id, docs.count { it.slug == conf.slug && !it.hidden && id in it.shared })
            }
        }
    }

    private fun circleMembers(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "talk_id"), setOf("event", "talk_id"))
        val conf = c.conf(b.str("event"))
        val talkId = b.str("talk_id") ?: bad("talk_id must be a string")
        val me = c.doc(conf.slug)
        val talk = conf.talks.firstOrNull { it.id == talkId && it.kind == "talk" } ?: fail(404, "talk not found")
        val sharers = docs.filter { it.slug == conf.slug && !it.hidden && talkId in it.shared }
        if (me == null || talkId !in me.shared) fail(403, "share_required") { put("count", sharers.size) }
        val members = sharers.filter { it !== me && !blockedEither(me, it) }
            .map { it to score(me, it, emptyList()) }
            .sortedWith(compareByDescending<Pair<Doc, Int>> { it.second }.thenBy { it.first.displayName })
        return buildJsonObject {
            putJsonObject("talk") {
                put("title", talk.title)
                put("start", talk.start)
                put("end", talk.end)
                put("url", talk.url)
            }
            put("speakers", JsonArray(talk.speakers.map { n -> buildJsonObject { put("name", n); put("tagline", JsonNull); put("links", JsonArray(emptyList())) } }))
            put("count", sharers.size)
            put("members", JsonArray(members.map { personJson(conf, me, it.first, emptyList(), talk) }))
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Blocks and reports

    private fun block(c: Ctx, add: Boolean): JsonObject {
        val b = c.obj(setOf("event", "ref"), setOf("event", "ref"))
        val conf = c.conf(b.str("event"))
        val me = c.live(conf.slug)
        val ref = refOf(b)
        if (!add) {
            me.blocks.removeAll { it.first == ref }
            return OK
        }
        val other = docs.firstOrNull { it.slug == conf.slug && it.ref == ref && it !== me } ?: fail(404, "not_found")
        if (me.blocks.none { it.first == ref }) me.blocks += ref to clock()
        for (m in meets) {
            refresh(m)
            if (m.slug == conf.slug && m.state in OPEN && setOf(m.requester, m.target) == setOf(me.profileId, other.profileId)) {
                m.state = if (m.target == me.profileId) "declined" else "cancelled"
            }
        }
        return OK
    }

    private fun blocks(c: Ctx): JsonObject {
        val conf = c.conf(c.query["event"])
        val me = c.live(conf.slug)
        val newestFirst = me.blocks.reversed()
        return buildJsonObject {
            put("refs", JsonArray(newestFirst.map { JsonPrimitive(it.first) }))
            put("blocks", JsonArray(newestFirst.map { (ref, at) ->
                buildJsonObject {
                    put("ref", ref)
                    put("display_name", docs.firstOrNull { it.slug == conf.slug && it.ref == ref }?.displayName)
                    put("created_at", iso(at))
                }
            }))
        }
    }

    private fun report(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "ref", "context", "reason"), setOf("event", "ref", "context", "reason"))
        val conf = c.conf(b.str("event"))
        val me = c.live(conf.slug)
        val ref = refOf(b)
        val ctxObj = b["context"] as? JsonObject ?: bad("context must be an object")
        for (k in ctxObj.keys) if (k !in setOf("kind", "id")) bad("Unknown key: context.${k.take(40)}")
        val kind = ctxObj.str("kind")?.takeIf { it in setOf("profile", "meet", "spot") } ?: bad("context.kind is not valid")
        val id = ctxObj.str("id") ?: bad("context.id must be a string")
        if (b.str("reason") !in setOf("harassment", "hate", "sexual", "spam", "other")) bad("reason is not valid")
        val targetKey: String
        if (kind == "meet") {
            val m = meets.firstOrNull { it.id == id && it.slug == conf.slug && me.profileId in setOf(it.requester, it.target) } ?: fail(404, "not_found")
            val otherId = if (m.requester == me.profileId) m.target else m.requester
            if (docOf(m.slug, otherId)?.ref != ref) bad("ref must name the other participant")
            targetKey = id
        } else {
            if (id != ref) bad("context.id must equal ref")
            docs.firstOrNull { it.slug == conf.slug && it.ref == ref && it !== me } ?: fail(404, "not_found")
            targetKey = ref
        }
        if (reports.none { it.slug == conf.slug && it.kind == kind && it.target == targetKey && it.reporter == me.profileId }) {
            reports += Report(conf.slug, kind, targetKey, me.profileId)
        }
        val hidden = reportCount(conf.slug, kind, targetKey) >= 2
        if (hidden) {
            when (kind) {
                "profile" -> docs.firstOrNull { it.slug == conf.slug && it.ref == ref }?.hidden = true
                "spot" -> docs.firstOrNull { it.slug == conf.slug && it.ref == ref }?.let { it.spot = null; it.spotHidden = true }
                else -> meets.firstOrNull { it.id == id }?.let { m -> m.hiddenOwner = docs.firstOrNull { it.slug == conf.slug && it.ref == ref }?.profileId }
            }
        }
        return buildJsonObject {
            put("ok", true)
            put("hidden", hidden)
        }
    }

    private fun reportCount(slug: String, kind: String, target: String) =
        reports.filter { it.slug == slug && it.kind == kind && it.target == target }.map { it.reporter }.toSet().size

    // ---------------------------------------------------------------------------------------------
    // Presence and Bluetooth

    private fun putPresence(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "zone", "spot", "location", "until", "ble"), setOf("event", "zone"))
        val conf = c.conf(b.str("event"))
        val me = c.live(conf.slug)
        if (!me.openToMeet) fail(403, "profile_required")
        val zone = b.str("zone")?.takeIf { it in conf.zones } ?: bad("zone is not one of this conference's zones")
        val spot = text(b["spot"], "spot", 60)
        held(spot)
        val mode = when (val u = b.str("until")) {
            null -> if (b["until"] == null) me.mode else bad("until must be hour or day")
            "hour", "day" -> u
            else -> bad("until must be hour or day")
        }
        var located: Pair<Double, Double>? = null
        val loc = b["location"]
        if (loc != null && loc !is JsonNull) {
            val l = loc as? JsonObject ?: bad("location must be an object or null")
            for (k in l.keys) if (k !in setOf("lat", "lon", "accuracy")) bad("Unknown key: location.${k.take(40)}")
            val lat = (l["lat"] as? JsonPrimitive)?.doubleOrNull ?: bad("location.lat must be a number")
            val lon = (l["lon"] as? JsonPrimitive)?.doubleOrNull ?: bad("location.lon must be a number")
            val acc = (l["accuracy"] as? JsonPrimitive)?.doubleOrNull ?: bad("location.accuracy must be a number")
            if (acc <= 200.0) located = lat to lon
        }
        val now = clock()
        if (!around(me)) me.since = now
        me.zone = zone
        me.spot = if (me.spotHidden) null else spot.ifEmpty { null }
        me.mode = mode
        me.until = if (mode == "day") endOfDay(now) else now + HOUR_MS
        me.loc = located
        val bleOn = (b["ble"] as? JsonPrimitive)?.booleanOrNull
        // Every write with ble: true starts a new session (a new nonce, so a new key); false ends it.
        when (bleOn) {
            true -> me.bleKey = secureRandomBytes(BleProtocol.KEY_BYTES)
            false -> me.bleKey = null
            null -> Unit
        }
        return buildJsonObject {
            put("ok", true)
            put("zone", zone)
            put("spot", me.spot)
            put("spot_hidden", me.spotHidden)
            put("until", mode)
            put("presence_since", iso(me.since))
            put("presence_until", iso(me.until))
            put("located", located != null)
            me.bleKey?.takeIf { bleOn == true }?.let { key ->
                put("ble_key", DeviceCredential.base64Url(key))
                put("ble_key_id", keyIdOf(key))
            }
        }
    }

    private fun deletePresence(c: Ctx): JsonObject {
        val conf = c.conf(c.query["event"])
        val me = c.live(conf.slug)
        endPresence(me)
        return OK
    }

    private fun endPresence(d: Doc) {
        d.zone = null
        d.spot = null
        d.until = 0
        d.loc = null
        d.bleKey = null
        for (m in meets) if (m.state == "active" && d.profileId in setOf(m.requester, m.target)) m.state = "expired"
    }

    private fun rotateBle(c: Ctx): JsonObject {
        val b = c.obj(setOf("event"), setOf("event"))
        val me = c.live(c.conf(b.str("event")).slug)
        if (!around(me) || me.bleKey == null) fail(403, "ble_required")
        return buildJsonObject {
            put("ok", true)
            putJsonObject("ble") {
                put("token", DeviceCredential.base64Url(bytes(16, ++counter)))
                put("rotate_at", iso(clock() + 5 * 60_000L))
            }
        }
    }

    private fun sightings(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "sightings"), setOf("event", "sightings"))
        val conf = c.conf(b.str("event"))
        val me = c.live(conf.slug)
        val list = b["sightings"] as? JsonArray ?: bad("sightings must be an array")
        if (list.size > 50) bad("sightings must have at most 50 entries")
        // The strongest RSSI per token.
        val heard = LinkedHashMap<String, Int>()
        for (e in list) {
            val o = e as? JsonObject ?: bad("sightings must be objects")
            for (k in o.keys) if (k !in setOf("token", "rssi")) bad("Unknown key: sightings.${k.take(40)}")
            val token = o.str("token")?.takeIf { TOKEN_RE.matches(it) } ?: bad("token must be 22 base64url characters")
            val rssi = (o["rssi"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull()?.takeIf { it in -127..20 }
                ?: bad("rssi must be an integer from -127 to 20")
            heard[token] = maxOf(heard[token] ?: rssi, rssi)
        }
        val myKey = me.bleKey
        if (!around(me) || myKey == null) fail(403, "ble_required")
        // The token table of this window: w - 1, w and w + 1 of every live session at the conference.
        val w = BleProtocol.windowAtMillis(clock())
        val table = HashMap<String, Doc>()
        for (d in docs) {
            val key = d.bleKey ?: continue
            if (d.slug != conf.slug || !around(d)) continue
            for (x in w - 1..w + 1) table[BleProtocol.encodeToken(BleProtocol.tokenOf(HmacSha256.mac(key, BleProtocol.tokenMessage(x))))] = d
        }
        val found = heard.filter { it.value >= nearRssi }.keys.mapNotNull { table[it] }.distinct()
            .filter { it !== me && it.zone == me.zone && it.openToMeet && !it.hidden && !blockedEither(me, it) }
            .sortedWith(compareByDescending<Doc> { score(me, it, emptyList()) }.thenBy { it.displayName }.thenBy { it.ref })
        return buildJsonObject {
            put("nearby", JsonArray(found.map { nearbyJson(conf, it) }))
            put("ble_key_id", keyIdOf(myKey))
        }
    }

    // A nearby entry in the contract's closed shape; the zone is set because co-location here is the same zone.
    private fun nearbyJson(conf: FakeConference, d: Doc): JsonObject = buildJsonObject {
        val passage = firstSentence(d.expertise.ifEmpty { d.about })
        put("ref", d.ref)
        put("display_name", d.displayName)
        put("evidence", if (passage.isNotEmpty()) escapeHtml(passage.take(160)) else null)
        put("speak_topics", topicRefs(conf, d.speak))
        put("zone", d.zone)
    }

    private fun keyIdOf(key: ByteArray): String = BleProtocol.keyIdOf(HmacSha256.mac(key, BleProtocol.keyIdMessage()))

    // ---------------------------------------------------------------------------------------------
    // Meets

    private fun requestMeet(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "ref", "topic_id", "note"), setOf("event", "ref"))
        val conf = c.conf(b.str("event"))
        val me = c.live(conf.slug)
        val ref = refOf(b)
        val topic = b.str("topic_id")?.also { if (it !in conf.topics) bad("topic_id is not a topic of this conference") }
        val note = text(b["note"], "note", 140)
        held(note)
        val them = docs.firstOrNull { it.slug == conf.slug && it.ref == ref && it !== me && !it.hidden && (it.openToMeet || it.shared.any { t -> t in me.shared }) } ?: fail(404, "not_found")
        if (blockedEither(me, them)) fail(403, "blocked")
        if (!around(me)) fail(403, "presence_required") { put("message", PRESENCE_MESSAGE) }
        if (!around(them)) fail(409, "not_around") { put("message", "They're not around right now.") }
        val open = meets.firstOrNull { m -> refresh(m); m.slug == conf.slug && m.state in OPEN && setOf(m.requester, m.target) == setOf(me.profileId, them.profileId) }
        if (open != null) fail(409, "meet_open") { put("meet_id", open.id) }
        val now = clock()
        val dayStart = now - now % DAY_MS
        if (meets.count { it.slug == conf.slug && it.requester == me.profileId && it.state == "declined" && it.createdAt >= dayStart } >= 3) {
            val retryAt = dayStart + DAY_MS
            fail(429, "paused", mapOf("retry-after" to ((retryAt - now) / 1000).toString())) {
                put("message", "Three people said not now today. Try again tomorrow.")
                put("retry_at", iso(retryAt))
            }
        }
        counter++
        val m = Meet(DeviceCredential.base64Url(bytes(16, counter + 5000)), conf.slug, me.profileId, them.profileId, topic, note, now, now + 15 * 60_000L)
        m.sameZone = me.zone == them.zone
        meets += m
        return withOk(meetJson(conf, m, me, distance = false))
    }

    private fun inbox(c: Ctx): JsonObject {
        val conf = c.conf(c.query["event"])
        val me = c.live(conf.slug)
        fun visible(m: Meet): Boolean {
            refresh(m)
            if (m.slug != conf.slug || me.profileId !in setOf(m.requester, m.target) || (m.hiddenOwner != null && m.hiddenOwner != me.profileId)) return false
            val openNow = m.state in OPEN || (m.state == "declined" && m.requester == me.profileId && clock() <= m.expiresAt)
            val other = docOf(conf.slug, if (m.requester == me.profileId) m.target else m.requester)
            return openNow && other != null && !blockedEither(me, other)
        }
        val mine = meets.filter { visible(it) }.sortedByDescending { it.createdAt }.take(100)
        return buildJsonObject {
            put("incoming", JsonArray(mine.filter { it.target == me.profileId }.map { m ->
                val from = docOf(conf.slug, m.requester)!!
                JsonObject(meetJson(conf, m, me, false) + ("from" to buildJsonObject {
                    put("ref", from.ref)
                    put("display_name", from.displayName)
                    put("about", from.about)
                }))
            }))
            put("outgoing", JsonArray(mine.filter { it.requester == me.profileId }.map { m ->
                val to = docOf(conf.slug, m.target)!!
                JsonObject(meetJson(conf, m, me, false) + ("to" to buildJsonObject {
                    put("ref", to.ref)
                    put("display_name", to.displayName)
                }))
            }))
        }
    }

    private fun meetRoute(c: Ctx, id: String, action: String?): JsonObject {
        val want = when (action) {
            null -> "GET"
            "details" -> "PUT"
            else -> "POST"
        }
        return c.only(want) {
            c.cred()
            val m = meets.firstOrNull { it.id == id } ?: fail(404, "not_found")
            val conf = conferences.getValue(m.slug)
            val me = c.doc(m.slug)
            if (me == null || me.profileId !in setOf(m.requester, m.target)) fail(403, "forbidden")
            if (m.hiddenOwner != null && m.hiddenOwner != me.profileId) fail(404, "not_found")
            refresh(m)
            if (m.state !in OPEN) fail(410, "over") { put("state", m.state) }
            when (action) {
                null -> meetJson(conf, m, me, distance = true)
                "accept", "decline" -> {
                    if (m.requester == me.profileId) fail(403, "forbidden")
                    if (m.state != "requested") fail(409, "state") { put("state", m.state) }
                    if (action == "decline") {
                        m.state = "declined"
                    } else {
                        if (!around(me)) fail(403, "presence_required") { put("message", PRESENCE_MESSAGE) }
                        val requester = docOf(m.slug, m.requester)
                        if (requester == null || !around(requester)) {
                            m.state = "expired"
                            fail(410, "over") { put("state", "expired") }
                        }
                        val now = clock()
                        m.state = "active"
                        m.activeSince = now
                        m.expiresAt = now + 20 * 60_000L
                        m.sameZone = requester.zone == me.zone
                        if (m.sameZone && m.rendezvous == null) m.rendezvous = me.zone
                    }
                    withOk(meetJson(conf, m, me, false))
                }
                "found" -> {
                    if (m.state != "active") fail(409, "state") { put("state", m.state) }
                    m.state = "found"
                    withOk(meetJson(conf, m, me, false))
                }
                "cancel" -> {
                    m.state = "cancelled"
                    withOk(meetJson(conf, m, me, false))
                }
                else -> {
                    val b = c.obj(setOf("spot_me", "rendezvous"))
                    if ("spot_me" in b) {
                        val line = text(b["spot_me"], "spot_me", 60)
                        held(line)
                        if (line.isEmpty()) m.spotMe.remove(me.profileId) else m.spotMe[me.profileId] = line
                    }
                    if ("rendezvous" in b) m.rendezvous = b.str("rendezvous")?.also { if (it !in conf.zones) bad("rendezvous is not one of this conference's zones") }
                    withOk(meetJson(conf, m, me, false))
                }
            }
        }
    }

    /** Applies the time and presence transitions of one meet. */
    private fun refresh(m: Meet) {
        if (m.state !in OPEN) return
        val a = docOf(m.slug, m.requester)
        val b = docOf(m.slug, m.target)
        if (clock() > m.expiresAt || (m.state == "active" && (a == null || b == null || !around(a) || !around(b)))) m.state = "expired"
    }

    private fun meetJson(conf: FakeConference, m: Meet, viewer: Doc, distance: Boolean): JsonObject {
        val other = docOf(m.slug, if (m.requester == viewer.profileId) m.target else m.requester)!!
        val active = m.state == "active"
        val bothAround = around(viewer) && around(other)
        val showZone = active || (m.state == "requested" && m.sameZone && bothAround)
        val byMe = m.requester == viewer.profileId
        return buildJsonObject {
            put("meet_id", m.id)
            put("state", if (m.state == "declined" && byMe) "requested" else m.state)
            put("requested_by_me", byMe)
            put("same_zone", m.sameZone)
            if (m.topic != null) putJsonObject("topic") { put("topic_id", m.topic); put("label", conf.topics[m.topic] ?: m.topic) } else put("topic", JsonNull)
            put("topic_label", m.topic?.let { conf.topics[it] ?: it })
            put("note", m.note.ifEmpty { null })
            put("created_at", iso(m.createdAt))
            put("active_since", m.activeSince?.let { iso(it) })
            put("active_until", if (active) iso(m.expiresAt) else null)
            put("expires_at", iso(m.expiresAt))
            put("rendezvous", m.rendezvous)
            putJsonObject("mine") {
                put("spot_me", m.spotMe[viewer.profileId])
                put("around", around(viewer))
            }
            putJsonObject("other") {
                put("ref", other.ref)
                put("display_name", other.displayName)
                put("about", other.about)
                put("around", around(other))
                put("zone", if (showZone && around(other)) other.zone else null)
                put("spot", if (active) other.spot else null)
                put("spot_me", if (active) m.spotMe[other.profileId] else null)
                val a = viewer.loc
                val b = other.loc
                if (distance && active && bothAround && a != null && b != null) {
                    put("distance_m", (haversine(a, b) / 10).roundToInt() * 10)
                    put("bearing_deg", bearing(a, b).roundToInt() % 360)
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Push

    private fun pushSubscription(c: Ctx): JsonObject {
        val b = c.obj(setOf("event", "subscription", "endpoint"), setOf("event"))
        val me = c.live(c.conf(b.str("event")).slug)
        if (c.method == "PUT") {
            val s = b["subscription"] as? JsonObject ?: bad("subscription must be an object")
            if (s.str("endpoint")?.startsWith("https://") != true) bad("endpoint must be an https URL")
            me.push += "web:" + s.str("endpoint")
        } else {
            me.push -= "web:" + b.str("endpoint")
        }
        return OK
    }

    private fun pushNative(c: Ctx): JsonObject {
        val put = c.method == "PUT"
        val b = c.obj(if (put) setOf("event", "platform", "token", "environment") else setOf("event", "platform", "token"), setOf("event", "platform", "token"))
        val conf = c.conf(b.str("event"))
        val platform = b.str("platform")?.takeIf { it == "apns" || it == "fcm" } ?: bad("platform must be apns or fcm")
        val token = b.str("token") ?: bad("token must be a string")
        val env = b.str("environment")
        if (put) {
            if (env != null && platform != "apns") bad("environment is only for apns")
            if (env != null && env != "production" && env != "sandbox") bad("environment must be production or sandbox")
            if (platform == "apns" && !APNS_RE.matches(token) || platform == "fcm" && !FCM_RE.matches(token)) bad("token is not valid for $platform")
        }
        val me = c.doc(conf.slug)
        if (!put) {
            me?.push?.remove("$platform:$token")
            return OK
        }
        if (me == null) fail(403, "profile_required")
        if (platform !in pushPlatforms) fail(404, "push_unavailable")
        me.push += "$platform:${if (platform == "apns") token.lowercase() else token}"
        return OK
    }

    /** The native push registrations of [person], as "platform:token". */
    fun pushRegistrations(person: FakePerson): Set<String> = person.doc.push.filter { !it.startsWith("web:") }.toSet()

    // ---------------------------------------------------------------------------------------------
    // Shaping people

    private fun personJson(conf: FakeConference, me: Doc, d: Doc, words: List<String>, circle: FakeTalk?): JsonObject {
        val search = words.isNotEmpty()
        val bothAround = around(me) && around(d)
        val zone = if (bothAround) d.zone else null
        val passage = firstSentence(d.expertise.ifEmpty { d.about })
        val matchText = if (search) listOf(d.expertise, d.about).firstOrNull { f -> tokens(f).any { it in words } } else null
        val evidence: String? = when {
            matchText != null -> markHtml(sentenceWith(matchText, words), words)
            !search && passage.isNotEmpty() -> escapeHtml(passage.take(160))
            else -> null
        }
        fun labels(ids: List<String>) = ids.mapNotNull { conf.topics[it] }
        val canSpeak = labels(me.learn.filter { it in d.speak })
        val wantLearn = labels(me.speak.filter { it in d.learn })
        val titles = conf.talks.filter { it.id in me.shared && it.id in d.shared && it.id != circle?.id }.map { it.title }
        val reasons = ArrayList<String>()
        if (search && evidence != null) reasons += "They've worked on ${evidence.trimEnd('.')}."
        if (canSpeak.isNotEmpty()) reasons += "They can speak to ${list(canSpeak.take(4))}, which you want to learn about."
        if (wantLearn.isNotEmpty()) reasons += "They want to learn about ${list(wantLearn.take(4))}, which you can speak to."
        if (titles.isNotEmpty()) reasons += "You are both interested in ${list(titles.take(2))}."
        if (!search && passage.isNotEmpty()) reasons += "Ask them about ${escapeHtml(passage.take(160).trimEnd('.'))}."
        if (circle != null) reasons += "You are both interested in ${circle.title}."
        if (zone != null) reasons += "They're in $zone right now."
        return buildJsonObject {
            put("ref", d.ref)
            put("display_name", d.displayName)
            put("about", d.about)
            put("sample", false)
            put("learn_topics", topicRefs(conf, d.learn))
            put("speak_topics", topicRefs(conf, d.speak))
            put("reasons", JsonArray(reasons.map { JsonPrimitive(it) }))
            put("opener", reasons.firstOrNull())
            putJsonObject("contact") {
                put("linkedin_url", d.linkedin)
                put("contact_note", d.contactNote)
            }
            put("evidence", evidence)
            put("around", around(d))
            put("zone", zone)
            put("proximity", if (!bothAround) null else if (me.zone == d.zone) "same_zone" else "venue")
            put("broad", false)
        }
    }

    private fun topicRefs(conf: FakeConference, ids: List<String>): JsonArray =
        JsonArray(ids.filter { it in conf.topics }.map { buildJsonObject { put("topic_id", it); put("label", conf.topics.getValue(it)) } })

    private fun score(me: Doc, d: Doc, words: List<String>): Int =
        2 * (me.learn.count { it in d.speak } + me.speak.count { it in d.learn }) + me.shared.count { it in d.shared } + wordHits(d, words)

    private fun wordHits(d: Doc, words: List<String>): Int = (tokens(d.expertise) + tokens(d.about)).count { it in words }

    // ---------------------------------------------------------------------------------------------
    // Helpers

    private fun around(d: Doc) = d.zone != null && d.until > clock()

    private fun blockedEither(a: Doc, b: Doc) = a.blocks.any { it.first == b.ref } || b.blocks.any { it.first == a.ref }

    private fun docOf(slug: String, profileId: String) = docs.firstOrNull { it.slug == slug && it.profileId == profileId }

    private fun refOf(b: JsonObject): String = b.str("ref")?.takeIf { REF_RE.matches(it) } ?: bad("ref must be 16 hexadecimal digits")

    private fun held(line: String) {
        val words = tokens(line)
        if (words.any { it in filterWords }) fail(400, "filtered") { put("message", "That was held back by the filter. Edit it and try again.") }
    }

    private fun withOk(o: JsonObject) = JsonObject(mapOf("ok" to JsonPrimitive(true)) + o)

    private fun text(v: JsonElement?, name: String, max: Int, required: Boolean = false): String {
        if (v == null || v is JsonNull) return if (required) bad("$name is required") else ""
        val s = (v as? JsonPrimitive)?.takeIf { it.isString }?.content ?: bad("$name must be a string")
        val t = s.replace("\r\n", "\n").trim()
        if (t.length > max) bad("$name must be at most $max characters")
        if (required && t.isEmpty()) bad("$name is required")
        return t
    }

    private fun idList(v: JsonElement?, name: String, max: Int): List<String> {
        if (v == null || v is JsonNull) return emptyList()
        val a = v as? JsonArray ?: bad("$name must be an array of at most $max ids")
        if (a.size > max || a.any { !(it is JsonPrimitive && it.isString) }) bad("$name must be an array of at most $max ids")
        return a.map { (it as JsonPrimitive).content }.distinct()
    }

    /** Unknown topics are refused, except one the stored profile already holds, which is dropped (a retired topic). */
    private fun topicList(conf: FakeConference, v: JsonElement?, name: String, stored: List<String>): List<String> {
        val ids = idList(v, name, 30)
        if (ids.any { it !in conf.topics && it !in stored }) bad("$name contains an unknown topic")
        return ids.filter { it in conf.topics }
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.int(key: String, default: Int, lo: Int, hi: Int): Int {
        val v = this[key]
        if (v == null || v is JsonNull) return default
        val n = (v as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toIntOrNull() ?: bad("$key must be an integer")
        if (n !in lo..hi) bad("$key must be between $lo and $hi")
        return n
    }

    private fun refFor(slug: String, profileId: String): String =
        Sha256.hex("$slug:$profileId:fake-ref-salt".encodeToByteArray()).take(16)

    private fun bytes(n: Int, seed: Int) = ByteArray(n) { i -> if (i < 4) (seed shr (8 * i)).toByte() else (i * 31 + 7).toByte() }

    private fun iso(ms: Long): String {
        val s = Instant.fromEpochMilliseconds(ms).toString()
        return if ('.' in s) s else s.removeSuffix("Z") + ".000Z"
    }

    private fun endOfDay(now: Long) = now - now % DAY_MS + DAY_MS - 1000

    private fun percentDecode(s: String): String {
        val out = ArrayList<Byte>()
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            if (ch == '%' && i + 2 < s.length && s.substring(i + 1, i + 3).toIntOrNull(16) != null) {
                out += s.substring(i + 1, i + 3).toInt(16).toByte()
                i += 3
            } else {
                (if (ch == '+') " " else ch.toString()).encodeToByteArray().forEach { out += it }
                i++
            }
        }
        return out.toByteArray().decodeToString()
    }

    private fun haversine(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
        val dLat = rad(b.first - a.first)
        val dLon = rad(b.second - a.second)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(rad(a.first)) * cos(rad(b.first)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * 6_371_000.0 * asin(min(1.0, sqrt(h)))
    }

    private fun bearing(a: Pair<Double, Double>, b: Pair<Double, Double>): Double {
        val dLon = rad(b.second - a.second)
        val y = sin(dLon) * cos(rad(b.first))
        val x = cos(rad(a.first)) * sin(rad(b.first)) - sin(rad(a.first)) * cos(rad(b.first)) * cos(dLon)
        return (atan2(y, x) * 180 / PI + 360) % 360
    }

    private fun rad(deg: Double) = deg * PI / 180

    // Documents

    internal class Doc(val slug: String, val profileId: String, val secret: String, val ref: String, val seeded: Boolean) {
        var displayName = ""
        var about = ""
        var interests = ""
        var expertise = ""
        var learn: List<String> = emptyList()
        var speak: List<String> = emptyList()
        var linkedin: String? = null
        var contactNote: String? = null
        var openToMeet = false
        var shared: List<String> = emptyList()
        var hidden = false
        var spotHidden = false
        var zone: String? = null
        var spot: String? = null
        var mode = "hour"
        var since = 0L
        var until = 0L
        var loc: Pair<Double, Double>? = null

        /** The key of the live Bluetooth session, or null; only ever handed out once, in the presence answer. */
        var bleKey: ByteArray? = null
        val blocks = ArrayList<Pair<String, Long>>()
        val push = LinkedHashSet<String>()
    }

    private class Meet(val id: String, val slug: String, val requester: String, val target: String, val topic: String?, val note: String, val createdAt: Long, var expiresAt: Long) {
        var state = "requested"
        var sameZone = false
        var activeSince: Long? = null
        var rendezvous: String? = null
        var hiddenOwner: String? = null
        val spotMe = HashMap<String, String>()
    }

    private class Report(val slug: String, val kind: String, val target: String, val reporter: String)

    private companion object {
        val OK = buildJsonObject { put("ok", true) }
        val OPEN = setOf("requested", "active")
        val ID_RE = Regex("^[A-Za-z0-9_-]{22}$")
        val SECRET_RE = Regex("^[A-Za-z0-9_-]{43}$")
        val REF_RE = Regex("^[0-9a-f]{16}$")
        val TOKEN_RE = Regex("^[A-Za-z0-9_-]{22}$")
        val SLUG_RE = Regex("^[a-z0-9][a-z0-9-]{0,99}$")
        val LINKEDIN_RE = Regex("^https://(www\\.)?linkedin\\.com/in/[A-Za-z0-9_-]{3,100}/?$")
        val APNS_RE = Regex("^(?:[0-9A-Fa-f]{2}){32,100}$")
        val FCM_RE = Regex("^[A-Za-z0-9_:-]{32,4096}$")
        val PROFILE_KEYS = setOf("display_name", "about", "interests", "expertise", "learn_topics", "speak_topics", "linkedin_url", "contact_note")
        const val HOUR_MS = 3_600_000L
        const val DAY_MS = 86_400_000L
        const val PRESENCE_MESSAGE = "Turn on 'Around and up for a conversation' first."
    }
}

/**
 * A person at the fake, seeded or the device under test, to act as: the calls go through the same
 * routes the app uses, so every rule of the contract applies to them, and they are not recorded in
 * [FakePeopleServer.requests]. A refused call throws [FakeCallFailed].
 */
class FakePerson internal constructor(private val server: FakePeopleServer, internal val doc: FakePeopleServer.Doc) {
    val ref: String get() = doc.ref
    val displayName: String get() = doc.displayName
    val slug: String get() = doc.slug

    /** True while this person is visible conference-wide, as the server stores it. */
    val openToMeet: Boolean get() = doc.openToMeet

    /** The talk ids this person shares for, as the server stores them. */
    val sharedTalkIds: List<String> get() = doc.shared

    /** The zone this person's presence is on in, or null while presence is off, as the server stores it. */
    val zone: String? get() = doc.zone

    /** True while the profile is hidden after reports. */
    val hidden: Boolean get() = doc.hidden

    private fun call(method: String, path: String, build: JsonObjectBuilder.() -> Unit = {}): JsonObject =
        server.actAs(doc, method, path, buildJsonObject { put("event", doc.slug); build() })

    private fun query(method: String, path: String): JsonObject = server.actAs(doc, method, "$path?event=${doc.slug}", null)

    /** Asks [targetRef] to talk shop now; returns the meet id. */
    fun ask(targetRef: String, note: String = "", topicId: String? = null): String =
        call("POST", "/api/meet") {
            put("ref", targetRef)
            if (topicId != null) put("topic_id", topicId)
            put("note", note)
        }.getValue("meet_id").let { (it as JsonPrimitive).content }

    fun accept(meetId: String) = call("POST", "/api/meet/$meetId/accept") {}.state()

    fun decline(meetId: String) = call("POST", "/api/meet/$meetId/decline") {}.state()

    fun found(meetId: String) = call("POST", "/api/meet/$meetId/found") {}.state()

    fun cancel(meetId: String) = call("POST", "/api/meet/$meetId/cancel") {}.state()

    /** Reports [targetRef] as a profile; true when that hid it. */
    fun report(targetRef: String, reason: String = "spam"): Boolean =
        call("POST", "/api/people/report") {
            put("ref", targetRef)
            putJsonObject("context") { put("kind", "profile"); put("id", targetRef) }
            put("reason", reason)
        }.getValue("hidden").let { (it as JsonPrimitive).booleanOrNull == true }

    fun block(targetRef: String) {
        call("POST", "/api/people/block") { put("ref", targetRef) }
    }

    fun unblock(targetRef: String) {
        call("DELETE", "/api/people/block") { put("ref", targetRef) }
    }

    /** Turns presence on in [zone] for an hour; [located] stores a position near [lat], [lon]. */
    fun goAround(zone: String, spot: String = "", located: Boolean = false, lat: Double = 40.76789, lon: Double = -111.89012) {
        call("PUT", "/api/presence") {
            put("zone", zone)
            put("spot", spot)
            if (located) putJsonObject("location") { put("lat", lat); put("lon", lon); put("accuracy", 15) } else put("location", JsonNull)
            put("until", "hour")
        }
    }

    /** Turns Bluetooth proximity on (a new session and key) or off, repeating the zone and spot (presence must be on). */
    fun bluetooth(on: Boolean = true) {
        call("PUT", "/api/presence") {
            put("zone", doc.zone ?: error("Not around"))
            put("spot", doc.spot ?: "")
            put("until", doc.mode)
            put("ble", on)
        }
    }

    /** Moves the stored position, keeping the zone and the hour (presence must be on). */
    fun locate(lat: Double, lon: Double) {
        goAround(doc.zone ?: error("Not around"), doc.spot ?: "", located = true, lat = lat, lon = lon)
    }

    fun leave() {
        query("DELETE", "/api/presence")
    }

    /** The meet's state as the server stores it, or null. */
    fun meetState(meetId: String): String? = server.meetState(meetId)

    /** The open meet ids waiting for this person (incoming asks), newest first. */
    fun incoming(): List<String> = (query("GET", "/api/meet/inbox").getValue("incoming") as JsonArray).map { ((it as JsonObject).getValue("meet_id") as JsonPrimitive).content }

    private fun JsonObject.state(): String = (getValue("state") as JsonPrimitive).content
}
