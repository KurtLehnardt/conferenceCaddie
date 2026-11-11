package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.NoPush
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.PushRegistrar
import app.conferencecaddie.shared.SecureStore
import app.conferencecaddie.shared.ble.BlePlatform
import app.conferencecaddie.shared.ble.BleProtocol
import app.conferencecaddie.shared.ble.HmacSha256
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.net.HttpResponse
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean

/** Every people feature on, as tier 3 serves them (Bluetooth aside). */
val PEOPLE_ON = Capabilities(
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

/** The fixture bundle (contracts/fixtures/bundle): rooms "Hall A | Room 1", "Hall A | Room 2" and "Hall B", topics kubernetes, mcp and security. */
val FIXTURE_BUNDLE: TalkBundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
val FIXTURE_SLUG: String = FIXTURE_BUNDLE.conference.slug

/** The fixture conference as the people context names it; no end date, so it counts as running. */
val FIXTURE_CONFERENCE = ConferenceInfo(FIXTURE_SLUG, "Fixture Conference", "America/Denver")

/**
 * A People API that behaves like the server for the routes the controller uses: profile writes
 * echo their choices, presence writes answer with an hour or the day (and a fresh derived-v1 key
 * when they carry `ble: true`), and the rest answer empty. Each route can be replaced by a test.
 */
class StubPeopleServer(private val clock: Clock) {
    var profilePut: suspend (SentRequest) -> HttpResponse = { echoProfile(it) }
    var profileDelete: suspend (SentRequest) -> HttpResponse = { ok() }
    var presencePut: suspend (SentRequest) -> HttpResponse = { presenceOk(it) }
    var presenceDelete: suspend (SentRequest) -> HttpResponse = { ok() }
    var matches: suspend (SentRequest) -> HttpResponse = { FakeApiHttp.json(200, """{"results":[],"from":0,"size":20,"has_more":false}""") }
    var inbox: suspend (SentRequest) -> HttpResponse = { FakeApiHttp.json(200, """{"incoming":[],"outgoing":[]}""") }
    var sightings: suspend (SentRequest) -> HttpResponse = { FakeApiHttp.json(200, """{"nearby":[],"ble_key_id":"${bleKeyId()}"}""") }

    /** The Bluetooth keys handed out by presence writes with `ble: true`, oldest first. */
    val bleKeys = ArrayList<ByteArray>()

    /** The next key to hand out: a different fake pattern for every write by default. */
    var nextBleKey: () -> ByteArray = { ByteArray(32) { i -> (i * 13 + bleKeys.size * 71 + 1).toByte() } }

    /** The `ble_key_id` of the key handed out last, as the server names it in sightings answers; null before any. */
    fun bleKeyId(): String? = bleKeys.lastOrNull()?.let { keyIdOf(it) }
    var other: suspend (SentRequest) -> HttpResponse = { FakeApiHttp.json(404, """{"error":"Not found"}""") }

    /** Sent as X-Caddie-Pace on every answer when set. */
    var pace: String? = null

    suspend fun handle(r: SentRequest): HttpResponse {
        val answer = when {
            r.path == "/api/people/profile" && r.method == "PUT" -> profilePut(r)
            r.path == "/api/people/profile" && r.method == "DELETE" -> profileDelete(r)
            r.path == "/api/presence" && r.method == "PUT" -> presencePut(r)
            r.path == "/api/presence" && r.method == "DELETE" -> presenceDelete(r)
            r.path == "/api/people/matches" -> matches(r)
            r.path == "/api/meet/inbox" -> inbox(r)
            r.path == "/api/presence/sightings" && r.method == "POST" -> sightings(r)
            else -> other(r)
        }
        val p = pace ?: return answer
        return HttpResponse(answer.status, answer.body, headers = answer.headers + ("x-caddie-pace" to p))
    }

    fun ok() = FakeApiHttp.json(200, """{"ok":true}""")

    fun echoProfile(r: SentRequest): HttpResponse {
        val o = r.jsonObject
        val open = (o["open_to_meet"] as JsonPrimitive).boolean
        val shared = (o["shared_talk_ids"] as? JsonArray) ?: JsonArray(emptyList())
        val hidden = if (open || shared.isNotEmpty()) ""","hidden_for_owner":false""" else ""
        return FakeApiHttp.json(200, """{"ok":true,"open_to_meet":$open,"shared_talk_ids":$shared$hidden}""")
    }

    /** The answer to a presence write; with [issueKey] false a `ble: true` write gets no key (a server-rotate or older backend). */
    fun presenceOk(r: SentRequest, issueKey: Boolean = true): HttpResponse {
        val o = r.jsonObject
        val zone = (o["zone"] as JsonPrimitive).content
        val day = (o["until"] as? JsonPrimitive)?.content == "day"
        val now = clock.now().toEpochMilliseconds()
        val until = Instant.fromEpochMilliseconds(if (day) now + 8 * 3_600_000L else now + 3_600_000L)
        val located = o["location"] is JsonObject
        val key = if (issueKey && (o["ble"] as? JsonPrimitive)?.content == "true") nextBleKey().also { bleKeys += it } else null
        val keyFields = if (key != null) ""","ble_key":"${DeviceCredential.base64Url(key)}","ble_key_id":"${keyIdOf(key)}"""" else ""
        return FakeApiHttp.json(
            200,
            """{"ok":true,"zone":"$zone","spot":null,"spot_hidden":false,"until":"${if (day) "day" else "hour"}",""" +
                """"presence_since":"${Instant.fromEpochMilliseconds(now)}","presence_until":"$until","located":$located$keyFields}""",
        )
    }

    companion object {
        /** The `ble_key_id` of [key], as the server derives it. */
        fun keyIdOf(key: ByteArray): String = BleProtocol.keyIdOf(HmacSha256.mac(key, BleProtocol.keyIdMessage()))
    }
}

/** A controller over [StubPeopleServer] on the test's virtual time. */
class PeopleHarness(
    private val test: TestScope,
    var push: PushRegistrar = NoPush,
    val secure: SecureStore = InMemorySecureStore(),
    /** Bluetooth proximity's radio and key store, or null for a device without them. */
    val ble: BlePlatform? = null,
    /** Epoch milliseconds of the virtual clock's start. */
    startMs: Long = START_MS,
) {
    val clock: Clock = test.virtualClock(startMs)
    val server = StubPeopleServer(clock)
    val http = FakeApiHttp { server.handle(it) }
    val kv = MapKeyValue()
    val location = FakeLocation()
    val notifier = FakeNotifier()

    val controller: PeopleController by lazy {
        PeopleController(kv, http, PeopleServices(secure, location, notifier, push, ble = ble), test.backgroundScope, allowLocalHttp = false, clock = clock, timeZone = TimeZone.UTC)
    }

    val state: PeopleUiState get() = controller.state.value

    /** The fixture conference, selected and in the backend's list, as [PeopleContext.fromCore] gives it. */
    fun context(caps: Capabilities = PEOPLE_ON, interested: List<String> = emptyList(), bundle: TalkBundle? = FIXTURE_BUNDLE) = PeopleContext(
        backend = BACKEND,
        capabilities = caps.forThisApp(),
        conference = FIXTURE_CONFERENCE,
        bundle = bundle,
        interested = interested,
        listed = listOf(FIXTURE_CONFERENCE),
    )

    suspend fun start(caps: Capabilities = PEOPLE_ON, interested: List<String> = emptyList()) {
        controller.updateContext(context(caps, interested))
        test.runCurrent()
    }

    /** A profile with a name, ready to be made visible. */
    suspend fun named(name: String = "Caddie Native Test A") {
        controller.updateProfile { it.copy(displayName = name) }
        test.runCurrent()
    }

    /** Makes the profile visible at the fixture conference and forgets the requests that took. */
    suspend fun visible() {
        named()
        check(controller.setOpenToMeet(true) == null)
        test.runCurrent()
        http.sent.clear()
    }

    fun sent(method: String, path: String) = http.sentTo(method, path)
}

fun person(ref: String, name: String = "Sample Person", around: Boolean = true, zone: String? = null, evidence: String? = null, broad: Boolean = false) =
    """{"ref":"$ref","display_name":"$name","about":"","sample":false,"learn_topics":[],"speak_topics":[{"topic_id":"ebpf","label":"eBPF"}],""" +
        """"reasons":[],"opener":null,"contact":null,"evidence":${evidence?.let { "\"$it\"" } ?: "null"},"around":$around,""" +
        """"zone":${zone?.let { "\"$it\"" } ?: "null"},"proximity":${if (zone != null) "\"same_zone\"" else "null"},"broad":$broad}"""

fun page(vararg people: String) = FakeApiHttp.json(200, """{"results":[${people.joinToString(",")}],"from":0,"size":20,"has_more":false}""")
