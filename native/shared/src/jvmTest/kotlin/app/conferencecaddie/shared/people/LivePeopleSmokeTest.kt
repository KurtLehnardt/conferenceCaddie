package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.net.KtorHttp
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.max
import kotlin.math.min
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The people checks of scripts/smoke.mjs (p0 to p12, q1 to q10, ble1 and the leak scans), run
 * through [PeopleApi] against a live backend. It runs only when a backend is named:
 *
 * ```
 * ./gradlew :shared:jvmTest --tests '*LivePeopleSmokeTest*' -Pcaddie.liveBase=https://conference-caddie-265846417372.us-west1.run.app
 * ```
 *
 * It prints one PASS, FAIL or SKIP line per check with the smoke's name, and fails when a check
 * fails. Raw HTTP is used only for routes outside the People API (talk search, recommendations and
 * the capabilities document). Checks that need an admin token or an Elasticsearch key are skipped,
 * as the smoke skips them without one; so are the CORS checks, which need a browser origin, and the
 * Bluetooth resolution check, which the smoke never runs against a deployed API.
 *
 * The live rules: every test profile's name starts with "Caddie Native Test" and carries this run's
 * tag; their words are the smoke's synthetic, run-tagged words, so no nudge can pair one with a real
 * attendee; no real attendee's profile is ever written; every profile made here is deleted at the
 * end, whatever happened, and checked to be gone. Device secrets, ids and headers are never printed.
 */
class LivePeopleSmokeTest {
    @Test
    fun peopleChecksAgainstALiveBackend() {
        val base = System.getProperty("caddie.liveBase")?.trim().orEmpty()
        if (base.isEmpty()) {
            println("SKIP live people checks (no -Pcaddie.liveBase)")
            return
        }
        val backend = BackendUrl.normalise(base) as? BackendUrl.Valid ?: error("caddie.liveBase is not a backend URL")
        val failures = runBlocking { LiveRun(backend).run() }
        assertEquals(0, failures, "failed live checks; see the FAIL lines")
    }
}

private class LiveRun(private val backend: BackendUrl.Valid) {
    private val root: File = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .first { File(it, "contracts").isDirectory && File(it, "config/moderation-words.json").isFile }
    private val random = SecureRandom()
    private val runTag = ByteArray(4).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val ktor = KtorHttp()
    private val recorder = Recorder(ktor)
    private val json = Json { ignoreUnknownKeys = true }

    private val primary = "kubecon-cloudnativecon-north-america-2026"
    private val extra = "mcp-dev-summit-nairobi-2026"
    private val circleTalkTitle = "From Bytes to Traces: A Deep Dive into OpenTelemetry eBPF Instrumentation Internals"
    private val subject = "zqvsmoke$runTag vexmorlith quabbit flarnishing"
    private val expertise = "tuned $subject rigs for three yonders"
    private val findWord = "zqvfind$runTag"
    private val findPassage = "plonkered gravitronic snorbels on $findWord lattices for three yonders and debugged a wibblecorn after a glimmerfault"
    private val findQuery = "gravitronic snorbels on $findWord lattices"
    private val askerWord = "zqvasker$runTag"
    private val askerAbout = "sprocketeer of hummable glintwork at $askerWord"
    private val askerQuery = "hummable glintwork $askerWord"
    private val commonTopic = "kubernetes"
    private val zoneA = "Registration"
    private val zoneF = "Expo hall"
    private val spotMarker = "native-spot-$runTag"
    private val wordlist: List<String> = Json.parseToJsonElement(File(root, "config/moderation-words.json").readText())
        .jsonObject["words"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList()

    private fun testName(who: String) = "Caddie Native Test $who $runTag"
    private fun contactMarker(who: String) = "native-contact-$who-$runTag"

    private data class Opts(
        val learn: List<String> = emptyList(),
        val speak: List<String> = emptyList(),
        val about: String = "",
        val interests: String = "",
        val expertise: String = "",
    )

    private val aLearning get() = Opts(about = askerAbout, interests = subject, speak = listOf(commonTopic))
    private val aAround get() = Opts(about = askerAbout, speak = listOf(commonTopic))

    /** A test device: a fresh credential that only this run knows. */
    private inner class Dev(val who: String, profileId: String? = null) {
        val profileId: String = profileId ?: b64(16)
        val secret: String = b64(32)
        val credential = DeviceCredential(backend.base, this.profileId, secret)
        val api = PeopleApi(recorder, backend, { credential }, Pace(Clock.System))
    }

    private fun b64(n: Int) = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(n).also { random.nextBytes(it) })

    // ---------------------------------------------------------------------------------------------
    // Reporting

    private var failures = 0
    private var retried = 0

    private fun report(ok: Boolean, name: String, detail: String = "") {
        if (!ok) failures++
        println("${if (ok) "PASS" else "FAIL"} $name${if (detail.isNotEmpty()) " ($detail)" else ""}")
    }

    private fun skip(name: String, why: String) = println("SKIP $name ($why)")

    private suspend fun check(name: String, block: suspend () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            report(false, name, e.message ?: e::class.simpleName.orEmpty())
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Requests

    /** Every People API answer, with who asked, for the leak checks. */
    private class Seen(val path: String, val label: String, val status: Int, val text: String, val headers: String, val talkId: String?, val callerShares: List<String>)

    private val responses = ArrayList<Seen>()

    /** The talks each test device shares for, per conference, from the profile writes the server accepted. */
    private val sharing = HashMap<Dev, MutableMap<String, List<String>>>()
    private var echoChecked = 0
    private val echoMismatches = ArrayList<String>()
    private var storedChecked = 0
    private val storedMismatches = ArrayList<String>()
    private val storedInconclusive = ArrayList<String>()

    /** Records every People API exchange under the current label; never prints anything. */
    private inner class Recorder(private val http: ApiHttp) : ApiHttp {
        var label = ""
        var device: Dev? = null
        var event: String? = null
        var lastText = ""

        override suspend fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long, maxBytes: Long): HttpResponse {
            val answer = http.send(method, url, headers, body, timeoutMs, maxBytes)
            val text = answer.text()
            lastText = text
            val path = url.removePrefix(backend.base).substringBefore('?')
            val talkId = body?.let { runCatching { Json.parseToJsonElement(it.decodeToString()).jsonObject["talk_id"]?.jsonPrimitive?.contentOrNull }.getOrNull() }
            val shares = device?.let { d -> event?.let { sharing[d]?.get(it) } } ?: emptyList()
            responses += Seen(path, label, answer.status, text, answer.headers.entries.joinToString("\n") { "${it.key}: ${it.value}" }, talkId, shares)
            return answer
        }
    }

    /** One call's outcome, as the smoke reads it: the status, the decoded answer or the error, and the raw text. */
    private class R<T>(val status: Int, val value: T?, val error: PeopleError?, val text: String) {
        val code: String? get() = error?.code
        val ok: Boolean get() = status == 200
    }

    /**
     * Makes one call under [label]. A 429 waits for its Retry-After (1 to 15 seconds, at most eight
     * times), as the smoke does; a 5xx or a network failure on the first attempt is retried once and
     * noted.
     */
    private suspend fun <T> call(label: String, device: Dev?, event: String?, f: suspend (PeopleApi) -> ApiResult<T>): R<T> {
        var rateWaits = 0
        var attempt = 0
        val api = device?.api ?: PeopleApi(recorder, backend, { null }, Pace(Clock.System))
        while (true) {
            recorder.label = label
            recorder.device = device
            recorder.event = event
            recorder.lastText = ""
            val res = f(api)
            val err = res.errorOrNull
            if (err != null && err.kind == PeopleError.Kind.RateLimited && rateWaits < 8) {
                rateWaits++
                delay(min(15L, max(1L, err.retryAfterSeconds ?: 1L)) * 1000)
                continue
            }
            val transient = err != null && (err.status >= 500 || err.kind == PeopleError.Kind.Offline || err.kind == PeopleError.Kind.Timeout)
            if (transient && attempt == 0) {
                retried++
                attempt++
                println("NOTE ($label) answered ${err?.status} ${err?.kind} on the first attempt; retrying once")
                continue
            }
            return R(err?.status ?: 200, res.valueOrNull, err, recorder.lastText)
        }
    }

    /** A request outside the People API (search, recommendations, capabilities), with no device header. */
    private suspend fun raw(method: String, path: String, body: String?): Pair<Int, JsonObject?> {
        val answer = ktor.send(method, backend.base + path, emptyMap(), body?.encodeToByteArray(), 30_000, 8L * 1024 * 1024)
        val o = runCatching { Json.parseToJsonElement(answer.text()).jsonObject }.getOrNull()
        return answer.status to o
    }

    private val created = LinkedHashSet<Pair<Dev, String>>()

    private fun profileBody(event: String, who: String, o: Opts, open: Boolean, shared: List<String>) = ProfilePutRequest(
        event = event,
        profile = ProfileFields(
            displayName = testName(who),
            about = Opt.Of(o.about),
            interests = Opt.Of(o.interests),
            expertise = Opt.Of(o.expertise),
            learnTopics = Opt.Of(o.learn),
            speakTopics = Opt.Of(o.speak),
            linkedinUrl = Opt.Null,
            contactNote = Opt.Of(contactMarker(who)),
        ),
        openToMeet = open,
        sharedTalkIds = Opt.Of(shared),
    )

    /** A profile write through the client, tracked like the smoke's: echo and stored shares checked. */
    private suspend fun putRaw(device: Dev, label: String, request: ProfilePutRequest): R<ProfilePutResponse> {
        val r = call(label, device, request.event) { it.putProfile(request) }
        if (r.ok) {
            val requested = (request.sharedTalkIds.orNull ?: emptyList()).distinct()
            echoChecked++
            if (r.value?.sharedTalkIds != requested) echoMismatches += label
            val before = sharing.getOrPut(device) { HashMap() }[request.event] ?: emptyList()
            sharing.getValue(device)[request.event] = requested
            if (request.openToMeet || requested.isNotEmpty()) created += device to request.event
            readBack(device, request.event, requested, before, label)
        }
        return r
    }

    private suspend fun putProfile(device: Dev, event: String, who: String, o: Opts, open: Boolean = false, shared: List<String> = emptyList()): R<ProfilePutResponse> {
        val r = putRaw(device, "$who-put", profileBody(event, who, o, open, shared))
        if (r.ok) created += device to event
        return r
    }

    // POST /api/circles/members answers from the stored profile: 200 only for a talk the stored
    // shared_talk_ids holds, else 403 share_required. A sample of each list is read back.
    private suspend fun readBack(device: Dev, event: String, requested: List<String>, before: List<String>, label: String) {
        val present = listOfNotNull(requested.firstOrNull(), requested.getOrNull(requested.size / 2), requested.lastOrNull()).distinct()
        val removed = before.filter { it !in requested }.take(2)
        for ((talkId, shouldHold) in present.map { it to true } + removed.map { it to false }) {
            val r = call("$label-readback", device, event) { it.circleMembers(CircleMembersRequest(event, talkId)) }
            storedChecked++
            when {
                r.ok -> if (!shouldHold) storedMismatches += "$label ($talkId should not be stored)"
                r.status == 403 && r.code == "share_required" -> if (shouldHold) storedMismatches += "$label ($talkId should be stored)"
                else -> storedInconclusive += "$label (status ${r.status})"
            }
        }
    }

    private suspend fun deleteProfile(device: Dev, event: String, label: String): R<OkResponse> {
        val r = call(label, device, event) { it.deleteProfile(event) }
        if (r.ok) sharing[device]?.remove(event)
        return r
    }

    private suspend fun matches(device: Dev, label: String, request: MatchesRequest) = call(label, device, request.event) { it.matches(request) }

    private suspend fun findMatches(device: Dev, label: String, query: String = findQuery, whenNow: MatchWhen? = null, from: Int = 0) =
        matches(device, label, MatchesRequest(primary, Opt.Of(emptyList()), Opt.Of(query), Opt.orAbsent(whenNow), if (from > 0) Opt.Of(from) else Opt.Absent))

    private suspend fun findPerson(device: Dev, label: String, who: String, query: String): Person? {
        var from = 0
        while (from < 160) {
            val r = findMatches(device, label, query, from = from)
            val p = r.value?.results?.firstOrNull { it.displayName == testName(who) }
            if (p != null || !r.ok || r.value?.hasMore != true) return p
            from += 20
        }
        return null
    }

    private suspend fun presence(device: Dev, label: String, zone: String, spot: String = "", ble: Boolean? = null) =
        call(label, device, primary) { it.putPresence(PresencePutRequest(primary, zone, spot = Opt.Of(spot), ble = ble)) }

    private suspend fun presenceOff(device: Dev, label: String) = call(label, device, primary) { it.deletePresence(primary) }

    private suspend fun ask(device: Dev, label: String, ref: String, topicId: String? = null, note: String = "") =
        call(label, device, primary) { it.requestMeet(MeetRequest(primary, ref, Opt.of(topicId), Opt.Of(note))) }

    private suspend fun readMeet(device: Dev, label: String, id: String) = call(label, device, null) { it.readMeet(id) }

    private suspend fun inbox(device: Dev, label: String) = call(label, device, primary) { it.inbox(primary) }

    private suspend fun circle(device: Dev, label: String, talkId: String) = call(label, device, primary) { it.circleMembers(CircleMembersRequest(primary, talkId)) }

    private fun names(people: List<Person>?) = people.orEmpty().map { it.displayName }

    private fun ownTalks(slug: String): List<String> =
        File(root, "data/$slug/talks.ndjson").readLines().filter { it.isNotBlank() }.map { json.parseToJsonElement(it).jsonObject }
            .filter { it["kind"]?.jsonPrimitive?.content == "talk" }.map { it["talk_id"]!!.jsonPrimitive.content }

    private fun ms(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilliseconds() }.getOrNull() }

    // ---------------------------------------------------------------------------------------------

    suspend fun run(): Int {
        println("NOTE live people checks against ${backend.base}, run tag $runTag")
        val a = Dev("A")
        val b = Dev("B")
        val c = Dev("C")
        val d = Dev("D")
        val n = Dev("N")
        val e = Dev("E")
        val f = Dev("F")
        val k = Dev("K")
        val x = Dev("X")
        val rr = Dev("R")
        val everyDevice = ArrayList(listOf(a, b, c, d, n, e, f, k, x, rr))
        var circleTalk: String? = null
        try {
            check("p0: the circle talk is found") {
                val (status, o) = raw("POST", "/api/search", """{"conference":"$primary","query":${JsonPrimitive(circleTalkTitle)},"size":5}""")
                circleTalk = o?.get("results")?.jsonArray?.map { it.jsonObject }
                    ?.firstOrNull { it["title"]?.jsonPrimitive?.content == circleTalkTitle }?.get("talk_id")?.jsonPrimitive?.content
                report(circleTalk != null, "p0: the circle talk is found", if (circleTalk != null) "found" else "not found (search $status)")
            }
            val t = circleTalk ?: error("the circle talk is missing, so the people checks cannot run")
            suspend fun countOf(): Int? = call("public-counts", null, primary) { it.circleCounts(CircleCountsRequest(primary, Opt.Of(listOf(t)))) }.value?.counts?.get(t)
            val countBefore = countOf()

            check("p1: test profiles are created") {
                val statuses = listOf(
                    putProfile(a, primary, "A", aLearning, open = true, shared = listOf(t)),
                    putProfile(b, primary, "B", Opts(interests = subject, expertise = expertise), open = true),
                    putProfile(c, primary, "C", Opts(expertise = expertise), open = false, shared = listOf(t)),
                    putProfile(n, primary, "N", Opts(), open = true),
                    putProfile(d, extra, "D", Opts(interests = subject), open = true),
                ).map { it.status }
                report(statuses.all { it == 200 }, "p1: test profiles are created", statuses.joinToString(","))
            }

            var matchesA: List<Person>? = null
            check("p2: wanting to learn something ranks a person who has worked on it near the top") {
                val r = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(listOf(t))))
                if (!r.ok) error("status ${r.status}")
                matchesA = r.value!!.results
                val rank = names(matchesA).indexOf(testName("B"))
                val bp = matchesA!!.getOrNull(rank)
                val named = bp != null && bp.reasons.any { it.startsWith("Ask them about") && it.contains("vexmorlith") } && bp.opener == bp.reasons.firstOrNull()
                report(rank in 0..4 && named, "p2: wanting to learn something ranks a person who has worked on it near the top", if (rank == -1) "not returned" else "rank ${rank + 1}, reason \"${bp?.reasons?.firstOrNull()}\"")
            }

            check("p3: a profile gets people suggestions, and chips alone get talk suggestions") {
                val (status, o) = raw("POST", "/api/recommendations", """{"event":"$primary","learn_topics":["ebpf","gpu","llm"],"interests":"","interested_talk_ids":[]}""")
                val talks = o?.get("results")?.jsonArray?.size ?: 0
                report((matchesA?.size ?: 0) > 0 && status == 200 && talks > 0, "p3: a profile gets people suggestions, and chips alone get talk suggestions", "${matchesA?.size ?: 0} people, $talks talks")
            }

            check("p4: sharing for one talk does not put a profile in conference-wide matches") {
                val ok = matchesA != null && testName("C") !in names(matchesA)
                report(ok, "p4: sharing for one talk does not put a profile in conference-wide matches", if (ok) "${matchesA!!.size} matches, C absent" else "C was returned")
            }

            check("p5: matches need conference-wide visibility") {
                val r = matches(c, "C-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                report(r.status == 403 && r.code == "visibility_required", "p5: matches need conference-wide visibility", "status ${r.status}")
            }

            check("p6: a circle is returned only to a device that shared for that talk") {
                val shared = circle(a, "A-members", t)
                val notShared = circle(n, "N-members", t)
                // The client sends no device route without a credential; the smoke's anonymous call is refused on the device.
                val noDevice = call("anon-members", null, primary) { it.circleMembers(CircleMembersRequest(primary, t)) }
                val count = countOf()
                val members = shared.value?.members.orEmpty()
                val problems = ArrayList<String>()
                if (!shared.ok) problems += "sharer got ${shared.status}"
                if (testName("C") !in names(members)) problems += "C is missing from the circle"
                if (members.firstOrNull { it.displayName == testName("C") }?.contact?.contactNote.isNullOrEmpty()) problems += "the sharer cannot see C's contact"
                if (shared.value?.speakers.isNullOrEmpty()) problems += "the circle lists no speakers"
                if (notShared.status != 403 || notShared.code != "share_required" || notShared.error?.count == null) problems += "non-sharer got ${notShared.status} ${notShared.code}"
                if (notShared.text.contains("\"members\"")) problems += "non-sharer saw more than a count"
                if (noDevice.status != 403 || noDevice.error?.kind != PeopleError.Kind.NoDevice) problems += "no device got ${noDevice.status}"
                if (count == null || count < 2) problems += "public count is $count"
                report(problems.isEmpty(), "p6: a circle is returned only to a device that shared for that talk", problems.joinToString("; ").ifEmpty { "${members.size} members, ${shared.value?.speakers?.size} speakers, everyone else sees the count $count; no device: refused on the device" })
            }

            skip("cors3: an error response to the app origin carries the CORS headers and exposes Retry-After and X-Caddie-Pace", "the native client sends no Origin, so CORS does not apply")
            skip("p7: expired profiles never appear", "no Elasticsearch write key in the environment")

            check("p8: people do not cross conferences") {
                val problems = ArrayList<String>()
                val allKube = names(matchesA).toMutableList()
                allKube += names(circle(a, "A-members", t).value?.members)
                if (testName("D") in allKube) problems += "a profile of another conference appeared"
                val dm = matches(d, "D-matches", MatchesRequest(extra, Opt.Of(emptyList())))
                if (!dm.ok) problems += "other conference matches gave ${dm.status}"
                val foreign = names(dm.value?.results).filter { (it.startsWith("Caddie Native Test") && it.endsWith(runTag)) || it.startsWith("Sample") }
                if (foreign.isNotEmpty()) problems += "${foreign.joinToString(", ")} crossed into $extra"
                val am = matches(a, "A-other-matches", MatchesRequest(extra, Opt.Of(emptyList())))
                if (am.status != 403) problems += "A's matches at $extra gave ${am.status}"
                val wrongTopic = putProfile(a, primary, "A", Opts(learn = listOf("no-such-topic-xyz")), open = true, shared = listOf(t))
                if (wrongTopic.status != 400) problems += "an unknown topic gave ${wrongTopic.status}"
                ownTalks(extra).firstOrNull()?.let { other ->
                    val wrongTalk = putProfile(a, primary, "A", aLearning, open = true, shared = listOf(t, other))
                    if (wrongTalk.status != 400) problems += "sharing another conference's talk gave ${wrongTalk.status}"
                }
                val counts = call("public-counts", null, extra) { it.circleCounts(CircleCountsRequest(extra, Opt.Of(listOf(t)))) }
                if ((counts.value?.counts?.get(t) ?: 0) != 0) problems += "a circle count crossed conferences"
                report(problems.isEmpty(), "p8: people do not cross conferences", problems.joinToString("; ").ifEmpty { "checked matches, circles, counts and writes" })
            }

            check("p9: a write or read with the wrong secret is rejected") {
                val wrong = Dev("Intruder", profileId = a.profileId)
                everyDevice += wrong
                val put = putRaw(wrong, "wrong-put", profileBody(primary, "Intruder", Opts(), open = true, shared = emptyList()))
                val del = deleteProfile(wrong, primary, "wrong-delete")
                val m = matches(wrong, "wrong-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                val cm = circle(wrong, "wrong-members", t)
                val still = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                val statuses = listOf(put.status, del.status, m.status, cm.status)
                report(statuses.all { it == 403 } && still.ok, "p9: a write or read with the wrong secret is rejected", "${statuses.joinToString(",")}; the real profile still answers ${still.status}")
            }

            check("p10n: a write without an Origin header, as the native apps send it, is accepted") {
                val r = putProfile(a, primary, "A", aLearning, open = true, shared = listOf(t))
                report(r.ok, "p10n: a write without an Origin header, as the native apps send it, is accepted", "status ${r.status}; the smoke's p10 sends a foreign Origin, which a native client never does")
            }
            skip("cors4: a device route called from another origin gets 403 and no CORS headers", "the native client sends no Origin, so CORS does not apply")

            // Find & connect. A is the requester.
            var refF: String? = null
            var refA: String? = null
            fun personIn(r: R<MatchesResponse>, who: String) = r.value?.results?.firstOrNull { it.displayName == testName(who) }

            check("q1: a specific query ranks the person with the matching passage first and returns it as evidence") {
                val fr = putProfile(f, primary, "F", Opts(about = findPassage), open = true)
                val kr = putProfile(k, primary, "K", Opts(learn = listOf(commonTopic)), open = true)
                if (!fr.ok || !kr.ok) error("profiles gave ${fr.status}/${kr.status}")
                val r = findMatches(a, "A-find")
                if (!r.ok) error("status ${r.status}")
                val v = r.value!!
                val results = v.results
                val rank = names(results).indexOf(testName("F"))
                val p = results.getOrNull(rank)
                refF = p?.ref
                val problems = ArrayList<String>()
                if (rank != 0) problems += if (rank == -1) "F not returned" else "F at rank ${rank + 1}"
                if (p?.evidence == null || !Regex("gravitronic", RegexOption.IGNORE_CASE).containsMatchIn(p.evidence!!.replace(Regex("</?mark>"), ""))) problems += "evidence \"${p?.evidence}\""
                if (p?.reasons?.firstOrNull()?.startsWith("They've worked on") != true) problems += "first reason \"${p?.reasons?.firstOrNull()}\""
                if (p != null && (p.around || p.zone != null)) problems += "around or zone set before anyone is around"
                if (v.from != 0 || v.size != 20 || !r.text.contains("\"has_more\"")) problems += "paging fields missing"
                report(problems.isEmpty(), "q1: a specific query ranks the person with the matching passage first and returns it as evidence", problems.joinToString("; ").ifEmpty { "rank 1, evidence \"${p!!.evidence!!.take(60)}\"" })
            }

            check("q2: a result sharing only the common topic is dropped") {
                val plain = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                val text = findMatches(a, "A-find")
                if (!plain.ok || !text.ok) error("status ${plain.status}/${text.status}")
                val problems = ArrayList<String>()
                if (testName("K") in names(plain.value?.results)) problems += "K in profile matches"
                if (testName("K") in names(text.value?.results)) problems += "K in text matches"
                if (testName("B") !in names(plain.value?.results)) problems += "B (a specific match) missing from profile matches"
                report(problems.isEmpty(), "q2: a result sharing only the common topic is dropped", problems.joinToString("; ").ifEmpty { "K absent, B present among ${plain.value?.results?.size}; when=soon is not sent: the typed client cannot" })
            }

            // A is around from q4 to q9, so its interests go first.
            val quiet = putProfile(a, primary, "A", aAround, open = true, shared = listOf(t))
            if (!quiet.ok) error("A without interests gave ${quiet.status}, so the presence checks cannot run")

            check("q3: presence needs a visible profile") {
                val none = presence(x, "X-presence", zoneA)
                val circleOnly = presence(c, "C-presence", zoneA)
                val badZone = presence(a, "A-presence", "No Such Zone")
                val ok = none.status == 403 && none.code == "profile_required" && circleOnly.status == 403 && circleOnly.code == "profile_required" && badZone.status == 400
                report(ok, "q3: presence needs a visible profile", "no profile ${none.status} ${none.code}, circle-only ${circleOnly.status} ${circleOnly.code}, unknown zone ${badZone.status}")
            }

            check("q4: a listed word is rejected") {
                val word = wordlist.firstOrNull() ?: error("config/moderation-words.json has no words")
                val leet = word.replace('o', '0').replace('i', '1').replace('e', '3').replace('a', '4').replace('s', '5')
                val spot = presence(a, "A-presence", zoneA, "by the $word stand")
                val leetSpot = presence(a, "A-presence", zoneA, "by the ${leet.uppercase()} stand")
                val url = presence(a, "A-presence", zoneA, "see example.com/me")
                val linkedin = presence(a, "A-presence", zoneA, "see linkedin.com/in/me")
                val projectNames = presence(a, "A-presence", zoneA, "kubectl get pods, node.js v1.2, k8s.io, example.com")
                fun filtered(r: R<*>) = r.status == 400 && r.code == "filtered" && r.error?.serverMessage == PeopleError.FILTERED_MESSAGE
                report(filtered(spot) && filtered(leetSpot) && filtered(url) && linkedin.ok && projectNames.ok, "q4: a listed word is rejected", "word ${spot.status}, leet ${leetSpot.status}, url ${url.status}, linkedin.com ${linkedin.status}, tech text ${projectNames.status}")
            }

            check("q4b: an ask needs both people around") {
                val ref = refF ?: error("F has no ref")
                val off = presenceOff(a, "A-presence")
                if (!off.ok) error("A presence off gave ${off.status}")
                val nobody = ask(a, "A-meet", ref)
                val on = presence(a, "A-presence", zoneA)
                if (!on.ok) error("A presence gave ${on.status}")
                val themNot = ask(a, "A-meet", ref)
                val problems = ArrayList<String>()
                if (nobody.status != 403 || nobody.code != "presence_required" || nobody.error?.serverMessage != "Turn on 'Around and up for a conversation' first.") problems += "asking while not around gave ${nobody.status} ${nobody.code}"
                if (themNot.status != 409 || themNot.code != "not_around" || themNot.error?.serverMessage != "They're not around right now.") problems += "asking someone not around gave ${themNot.status} ${themNot.code}"
                report(problems.isEmpty(), "q4b: an ask needs both people around", problems.joinToString("; ").ifEmpty { "403 presence_required, then 409 not_around" })
            }

            check("q5: results carry no zone unless both are around") {
                val ap = presence(a, "A-presence", zoneA, spotMarker)
                if (!ap.ok) error("A presence gave ${ap.status}")
                val f1 = personIn(findMatches(a, "A-find"), "F")
                val fp = presence(f, "F-presence", zoneF, "$spotMarker-f")
                if (!fp.ok) error("F presence gave ${fp.status}")
                val f2 = personIn(findMatches(a, "A-find"), "F")
                val around = findMatches(a, "A-find", whenNow = MatchWhen.AroundNow)
                val kp = presence(k, "K-presence", zoneA)
                if (!kp.ok) error("K presence gave ${kp.status}")
                val aroundView = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList()), whenNow = Opt.Of(MatchWhen.AroundNow)))
                val kView = personIn(aroundView, "K")
                val anyoneView = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                val f3 = personIn(findMatches(n, "N-find"), "F")
                refA = personIn(findMatches(f, "F-find", askerQuery, MatchWhen.AroundNow), "A")?.ref
                val problems = ArrayList<String>()
                if (f1 == null || f1.around || f1.zone != null) problems += "F not around yet shows around or a zone"
                if (f2 == null || !f2.around || f2.zone != zoneF) problems += "both around: F around ${f2?.around}, zone ${f2?.zone}"
                if (f2 != null && "They're in $zoneF right now." !in f2.reasons) problems += "no zone reason"
                if (testName("F") !in names(around.value?.results)) problems += "around_now misses F"
                if (testName("K") in names(around.value?.results)) problems += "around_now lists K before K is around"
                val aroundNames = names(aroundView.value?.results)
                val kRank = aroundNames.indexOf(testName("K"))
                if (kRank == -1 || kRank != aroundNames.size - 1) problems += "K at rank ${kRank + 1} of ${aroundNames.size} in the around-now view"
                if (kView != null && !(kView.broad && kView.evidence == null && kView.reasons.firstOrNull() == "Also interested in Kubernetes.")) problems += "K is labelled ${kView.reasons}"
                if (testName("K") in names(anyoneView.value?.results)) problems += "K in the anyone view"
                if (f3 == null || !f3.around || f3.zone != null) problems += "N (not around) sees F zone ${f3?.zone}"
                val until = ms(ap.value?.presenceUntil)
                if (until == null || until - System.currentTimeMillis() > 61 * 60_000L) problems += "presence_until is not within an hour"
                report(problems.isEmpty(), "q5: results carry no zone unless both are around", problems.joinToString("; ").ifEmpty { "F zone $zoneF shown to A only" })
            }

            check("q6: a third device gets 403 from a meet, and 410 after found") {
                val ref = refF ?: error("F has no ref")
                val noted = ask(a, "A-meet", ref, note = "see ${wordlist.firstOrNull() ?: "example.com"}")
                val r = ask(a, "A-meet", ref, topicId = "ebpf", note = "compare notes on $findWord")
                if (!r.ok) error("request gave ${r.status} ${r.code}")
                val m = r.value!!
                val id = m.meetId
                val again = ask(a, "A-meet", ref)
                val inboxF = inbox(f, "F-inbox")
                val third = readMeet(n, "N-meet", id)
                val nobody = readMeet(x, "X-meet", id)
                val thirdAccept = call("N-meet", n, null) { it.acceptMeet(id) }
                val accept = call("F-meet", f, null) { it.acceptMeet(id) }
                val details = call("F-meet", f, null) { it.putMeetDetails(id, MeetDetailsRequest(Opt.Of("$spotMarker-me"), Opt.Of(zoneA))) }
                val seen = readMeet(a, "A-meet", id)
                val found = call("A-meet", a, null) { it.foundMeet(id) }
                val after = readMeet(f, "F-meet", id)
                val problems = ArrayList<String>()
                if (noted.status != 400 || noted.code != "filtered") problems += "a listed word in a note gave ${noted.status}"
                if (m.state != MeetState.Requested) problems += "state after request ${m.state}"
                val ttl = (ms(m.expiresAt) ?: 0) - (ms(m.createdAt) ?: 0)
                if (!(ttl > 14 * 60_000L && ttl <= 15 * 60_000L)) problems += "the ask runs out after ${ttl / 60_000} min, not 15"
                if (m.sameZone) problems += "same_zone true across two zones"
                if (again.status != 409 || again.code != "meet_open") problems += "a second open request gave ${again.status} ${again.code}"
                if (inboxF.value?.incoming.orEmpty().none { it.meetId == id && it.from?.displayName == testName("A") && it.topicLabel == "eBPF" && it.expiresAt != null }) problems += "F's inbox lacks the request"
                if (third.status != 403 || nobody.status != 403 || thirdAccept.status != 403) problems += "third devices got ${third.status}/${nobody.status}/${thirdAccept.status}"
                val activeFor = (ms(accept.value?.activeUntil) ?: 0) - System.currentTimeMillis()
                if (!accept.ok || accept.value?.state != MeetState.Active || accept.value?.activeSince == null || !(activeFor > 19 * 60_000L && activeFor <= 20 * 60_000L)) problems += "accept gave ${accept.status} ${accept.value?.state}, active for ${activeFor / 60_000} min"
                if (!details.ok) problems += "details gave ${details.status}"
                val sm = seen.value?.meet
                if (!seen.ok || sm?.other?.zone != zoneF || sm?.other?.spotMe != "$spotMarker-me" || sm?.rendezvous != zoneA) problems += "A sees zone ${sm?.other?.zone}, rendezvous ${sm?.rendezvous}"
                if (!found.ok || found.value?.state != MeetState.Found) problems += "found gave ${found.status}"
                if (after.status != 410 || after.error?.state != MeetState.Found) problems += "after found: ${after.status}"
                report(problems.isEmpty(), "q6: a third device gets 403 from a meet, and 410 after found", problems.joinToString("; ").ifEmpty { "15-min ask, accept -> active at once with zone and spot-me, found, then 410" })
            }

            check("q6b: a silent \"Not now\" leaves the asker's view, details and cancel unchanged") {
                val view = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList()), whenNow = Opt.Of(MatchWhen.AroundNow)))
                val refK = personIn(view, "K")?.ref ?: error("K has no ref in A's around-now view")
                val r = ask(a, "A-meet", refK, note = "Hi there")
                if (!r.ok) error("request gave ${r.status} ${r.code}")
                val id = r.value!!.meetId
                val spot = call("A-meet", a, null) { it.putMeetDetails(id, MeetDetailsRequest(spotMe = Opt.Of("blue cap"))) }
                val before = readMeet(a, "A-meet", id)
                val decline = call("K-meet", k, null) { it.declineMeet(id) }
                val after = readMeet(a, "A-meet", id)
                val again = call("A-meet", a, null) { it.putMeetDetails(id, MeetDetailsRequest(spotMe = Opt.Of("blue cap, red bag"))) }
                val inboxA = inbox(a, "A-inbox")
                val cancel = call("A-meet", a, null) { it.cancelMeet(id) }
                val gone = readMeet(a, "A-meet", id)
                fun shape(v: MeetView?) = listOf(v?.state, v?.note, v?.rendezvous, v?.mine?.spotMe, v?.other?.zone, v?.sameZone, v?.activeUntil).toString()
                val problems = ArrayList<String>()
                if (!spot.ok) problems += "details before the decline gave ${spot.status}"
                if (!before.ok || before.value?.meet?.other?.zone != zoneA || before.value?.meet?.mine?.spotMe != "blue cap") problems += "before: ${shape(before.value?.meet)}"
                if (!decline.ok || decline.value?.state != MeetState.Declined) problems += "decline gave ${decline.status} ${decline.value?.state}"
                if (!after.ok || shape(after.value?.meet) != shape(before.value?.meet)) problems += "after the decline A sees ${shape(after.value?.meet)}, before ${shape(before.value?.meet)}"
                if (!again.ok || again.value?.state != MeetState.Requested || again.value?.mine?.spotMe != "blue cap, red bag") problems += "details after the decline gave ${again.status} ${again.value?.state}"
                if (inboxA.value?.outgoing.orEmpty().none { it.meetId == id && it.state == MeetState.Requested && it.note == "Hi there" }) problems += "A's inbox lacks the waiting ask"
                if (!cancel.ok || cancel.value?.state != MeetState.Cancelled) problems += "cancel gave ${cancel.status} ${cancel.value?.state}"
                if (gone.status != 410 || gone.error?.state != MeetState.Cancelled) problems += "after cancel: ${gone.status} ${gone.error?.state}"
                report(problems.isEmpty(), "q6b: a silent \"Not now\" leaves the asker's view, details and cancel unchanged", problems.joinToString("; ").ifEmpty { "same view with zone, 200 details, 200 cancelled, then 410 cancelled" })
            }

            check("q6c: asking again after Not now answers 409 meet_open, as for a pending ask") {
                val ref = refA ?: error("A has no ref")
                val r = ask(f, "F-meet", ref)
                if (!r.ok) error("request gave ${r.status} ${r.code}")
                val id = r.value!!.meetId
                val decline = call("A-meet", a, null) { it.declineMeet(id) }
                val again = ask(f, "F-meet", ref)
                val inboxA = inbox(a, "A-inbox")
                val cancel = call("F-meet", f, null) { it.cancelMeet(id) }
                val problems = ArrayList<String>()
                if (!decline.ok || decline.value?.state != MeetState.Declined) problems += "decline gave ${decline.status} ${decline.value?.state}"
                if (again.status != 409 || again.code != "meet_open" || again.error?.meetId != id) problems += "asking again gave ${again.status} ${again.code}"
                if (inboxA.value?.incoming.orEmpty().any { it.from?.displayName == testName("F") }) problems += "A got a new card from F"
                if (!cancel.ok || cancel.value?.state != MeetState.Cancelled) problems += "cancel gave ${cancel.status} ${cancel.value?.state}"
                report(problems.isEmpty(), "q6c: asking again after Not now answers 409 meet_open, as for a pending ask", problems.joinToString("; ").ifEmpty { "the re-ask gets 409 meet_open with the same meet, A sees no new card" })
            }

            skip("q7: presence expires", "no Elasticsearch write key in the environment")

            check("q8: block is symmetric and refuses a meet either way with the same body") {
                val rf = refF ?: error("refs missing")
                val ra = refA ?: error("refs missing")
                val back = presence(a, "A-presence", zoneA)
                if (!back.ok) error("A presence gave ${back.status}")
                val blk = call("A-block", a, primary) { it.block(BlockRequest(primary, rf)) }
                val fromA = findMatches(a, "A-find")
                val fromF = findMatches(f, "F-find", askerQuery, MatchWhen.AroundNow)
                val aToF = ask(a, "A-meet", rf)
                val fToA = ask(f, "F-meet", ra)
                val list = call("A-blocks", a, primary) { it.blocks(primary) }
                val un = call("A-block", a, primary) { it.unblock(BlockRequest(primary, rf)) }
                val after = findMatches(a, "A-find")
                val problems = ArrayList<String>()
                if (!blk.ok) problems += "block gave ${blk.status}"
                if (testName("F") in names(fromA.value?.results)) problems += "F still in A's results"
                if (testName("A") in names(fromF.value?.results)) problems += "A still in F's results"
                if (aToF.status != 403 || fToA.status != 403 || aToF.code != "blocked" || aToF.text != fToA.text) problems += "meets gave ${aToF.status} ${aToF.code} and ${fToA.status} ${fToA.code}"
                if (rf !in list.value?.refs.orEmpty() || list.value?.blocks.orEmpty().none { it.ref == rf && it.displayName == testName("F") }) problems += "blocks list lacks F"
                if (!un.ok || testName("F") !in names(after.value?.results)) problems += "F not back after unblock"
                report(problems.isEmpty(), "q8: block is symmetric and refuses a meet either way with the same body", problems.joinToString("; ").ifEmpty { "hidden both ways, 403 blocked both ways, listed, unblocked" })
            }

            check("q8a: a block refuses every meet route between the pair, and closes their meet") {
                val rf = refF ?: error("refs missing")
                val ra = refA ?: error("refs missing")
                val r = ask(f, "F-meet", ra)
                if (!r.ok) error("request gave ${r.status} ${r.code}")
                val id = r.value!!.meetId
                val accept = call("A-meet", a, null) { it.acceptMeet(id) }
                if (!accept.ok) error("accept gave ${accept.status} ${accept.code}")
                val blk = call("A-block", a, primary) { it.block(BlockRequest(primary, rf)) }
                val fGet = readMeet(f, "F-meet", id)
                val fDetails = call("F-meet", f, null) { it.putMeetDetails(id, MeetDetailsRequest(spotMe = Opt.Of("by the door"))) }
                val fCancel = call("F-meet", f, null) { it.cancelMeet(id) }
                val aGet = readMeet(a, "A-meet", id)
                val un = call("A-block", a, primary) { it.unblock(BlockRequest(primary, rf)) }
                val after = readMeet(a, "A-meet", id)
                val problems = ArrayList<String>()
                if (!blk.ok || !un.ok) problems += "block ${blk.status}, unblock ${un.status}"
                val refused = listOf(fGet.status to fGet.code, fDetails.status to fDetails.code, fCancel.status to fCancel.code, aGet.status to aGet.code)
                if (!refused.all { it.first == 403 && it.second == "blocked" }) problems += "while blocked: ${refused.joinToString { "${it.first} ${it.second}" }}"
                if (after.status != 410) problems += "after unblock the meet answers ${after.status}"
                report(problems.isEmpty(), "q8a: a block refuses every meet route between the pair, and closes their meet", problems.joinToString("; ").ifEmpty { "GET, details and cancel 403 blocked both ways; the meet stays over after unblock" })
            }

            skip("q8b: the inbox omits the spot-me line once a presence lapses", "no Elasticsearch write key in the environment")

            check("q9: delete removes everything") {
                val rf = refF ?: error("refs missing")
                val ra = refA ?: error("refs missing")
                val back = presence(a, "A-presence", zoneA)
                if (!back.ok) error("A presence gave ${back.status}")
                val r = ask(a, "A-meet", rf)
                val blk = call("F-block", f, primary) { it.block(BlockRequest(primary, ra)) }
                if (!r.ok || !blk.ok) error("setup gave ${r.status}/${blk.status}")
                val del = deleteProfile(f, primary, "F-delete")
                val meetId = r.value!!.meetId
                val meet = readMeet(a, "A-meet", meetId)
                val inboxA = inbox(a, "A-inbox")
                val found = findMatches(a, "A-find")
                val problems = ArrayList<String>()
                if (!del.ok) problems += "delete gave ${del.status}"
                if (meet.status != 404) problems += "the meet still answers ${meet.status}"
                if (inboxA.value?.outgoing.orEmpty().any { it.meetId == meetId }) problems += "the meet is still in A's inbox"
                if (testName("F") in names(found.value?.results)) problems += "F still found"
                val fromN = findMatches(n, "N-find", askerQuery)
                if (!fromN.ok) problems += "N's search gave ${fromN.status}"
                report(problems.isEmpty(), "q9: delete removes everything", problems.joinToString("; ").ifEmpty { "profile, meet and block gone" })
            }

            check("q10: two reports hide a profile from everyone but its owner") {
                val away = presenceOff(a, "A-presence")
                if (!away.ok) error("A presence off gave ${away.status}")
                val learning = putProfile(a, primary, "A", aLearning, open = true, shared = listOf(t))
                if (!learning.ok) error("A with interests gave ${learning.status}")
                val shareB = putProfile(b, primary, "B", Opts(interests = subject, expertise = expertise), open = true, shared = listOf(t))
                if (!shareB.ok) error("B sharing gave ${shareB.status}")
                val countBeforeR = countOf()
                val r = putProfile(rr, primary, "R", Opts(expertise = expertise), open = true, shared = listOf(t))
                if (!r.ok) error("R gave ${r.status}")
                data class SeenBy(val matches: Boolean, val circle: Boolean, val ref: String?)
                suspend fun seenBy(device: Dev, who: String): SeenBy {
                    val m = matches(device, "$who-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                    val cm = circle(device, "$who-members", t)
                    if (!m.ok || !cm.ok) error("$who got ${m.status}/${cm.status}")
                    return SeenBy(testName("R") in names(m.value?.results), testName("R") in names(cm.value?.members), personIn(m, "R")?.ref)
                }
                val beforeA = seenBy(a, "A")
                val beforeB = seenBy(b, "B")
                val refR = beforeA.ref ?: error("R is not in A's matches before any report")
                suspend fun reportR(device: Dev, who: String, reason: ReportReason = ReportReason.Spam) =
                    call("$who-report", device, primary) { it.report(ReportRequest(primary, refR, ReportContext(ReportKind.Profile, refR), reason)) }
                val first = reportR(a, "A")
                val again = reportR(a, "A", ReportReason.Other)
                val stillA = seenBy(a, "A")
                val second = reportR(b, "B")
                val afterA = seenBy(a, "A")
                val afterB = seenBy(b, "B")
                val meet = ask(a, "A-meet", refR)
                val owner = putProfile(rr, primary, "R", Opts(expertise = expertise), open = true, shared = listOf(t))
                val count = countOf()
                val problems = ArrayList<String>()
                if (!beforeA.matches || !beforeA.circle || !beforeB.matches || !beforeB.circle) problems += "R not visible to both before the reports"
                if (!first.ok || first.value?.hidden != false) problems += "the first report gave ${first.status} hidden ${first.value?.hidden}"
                if (!again.ok || again.value?.hidden != false) problems += "the same device's second report gave ${again.status} hidden ${again.value?.hidden}"
                if (!stillA.matches || !stillA.circle) problems += "one reporter alone hid R"
                if (!second.ok || second.value?.hidden != true) problems += "the second reporter gave ${second.status} hidden ${second.value?.hidden}"
                if (afterA.matches || afterA.circle || afterB.matches || afterB.circle) problems += "R still visible after two reports"
                if (meet.status != 404) problems += "a meet request to R gave ${meet.status}"
                if (!owner.ok || owner.value?.hiddenForOwner != true) problems += "the owner's write gave ${owner.status} hidden_for_owner ${owner.value?.hiddenForOwner}"
                if (count != countBeforeR) problems += "the circle count is $count, expected $countBeforeR without R"
                report(problems.isEmpty(), "q10: two reports hide a profile from everyone but its owner", problems.joinToString("; ").ifEmpty { "gone from matches, circles, counts and meets; the owner sees hidden_for_owner" })
            }

            check("p11: a deleted profile disappears at once") {
                val del = deleteProfile(b, primary, "B-delete")
                val m = matches(a, "A-matches", MatchesRequest(primary, Opt.Of(emptyList())))
                val gone = del.ok && m.ok && testName("B") !in names(m.value?.results)
                val off = putProfile(c, primary, "C", Opts(expertise = expertise), open = false, shared = emptyList())
                val count = countOf()
                report(gone && off.ok && count == (countBefore ?: 0) + 1, "p11: a deleted profile disappears at once", "delete ${del.status}, B ${if (gone) "gone" else "still there"}; turning both choices off leaves the count at $count")
            }

            check("p12: the writes behind the auto-share switch are accepted, and a rejection says why") {
                val own = ownTalks(primary).filter { it != t }.take(2)
                if (own.size < 2) {
                    skip("p12: the writes behind the auto-share switch are accepted, and a rejection says why", "the conference has fewer than three talks")
                    return@check
                }
                val (t1, t2) = own
                fun body(shared: List<String>, name: String = testName("E"), learn: List<String> = emptyList()) = ProfilePutRequest(
                    event = primary,
                    profile = ProfileFields(name, Opt.Of(""), Opt.Of(""), Opt.Of(""), Opt.Of(learn), Opt.Of(emptyList()), Opt.Null, Opt.Of("")),
                    openToMeet = false,
                    sharedTalkIds = Opt.Of(shared),
                )
                val problems = ArrayList<String>()
                val first = putRaw(e, "E-put", body(listOf(t1)))
                if (first.ok) created += e to primary
                val again = putRaw(e, "E-put", body(listOf(t1)))
                val marked = putRaw(e, "E-put", body(listOf(t1, t2)))
                val unmarked = putRaw(e, "E-put", body(listOf(t2)))
                for ((label, r, count) in listOf(Triple("first share", first, 1), Triple("same list again", again, 1), Triple("a marked talk", marked, 2), Triple("an unmarked talk", unmarked, 1))) {
                    if (!r.ok) problems += "$label gave ${r.status} ${r.code ?: ""}".trim()
                    else if (r.value?.sharedTalkIds?.size != count || r.value?.openToMeet != false) problems += "$label echoed the wrong list"
                }
                val retired = putRaw(e, "E-put", body(listOf(t2), learn = listOf("no-such-topic-xyz")))
                if (retired.status != 400 || !(retired.code ?: "").startsWith("learn_topics contains an unknown topic")) problems += "an unknown topic gave ${retired.status} ${retired.code ?: ""}".trim()
                val noName = putRaw(e, "E-put", body(listOf(t2), name = ""))
                if (noName.status != 400 || !(noName.code ?: "").startsWith("display_name is required")) problems += "no name gave ${noName.status} ${noName.code ?: ""}".trim()
                val off = deleteProfile(e, primary, "E-delete")
                if (!off.ok) problems += "delete gave ${off.status}"
                report(problems.isEmpty(), "p12: the writes behind the auto-share switch are accepted, and a rejection says why", problems.joinToString("; ").ifEmpty { "share, re-send, mark and unmark all 200; unknown topic and missing name 400 with their reasons; unknown keys cannot be sent by the typed client" })
            }

            check("q8c: a block outlives the blocked profile: a re-created profile stays blocked, and the block can still be lifted") {
                val bl = Dev("BL")
                val bd = Dev("BD")
                everyDevice += listOf(bl, bd)
                val word = "zqvblock$runTag"
                val aboutBL = "untangles glimberwick $word sprockets"
                val aboutBD = "polishes quorbial $word flanges"
                putProfile(bl, primary, "BL", Opts(about = aboutBL), open = true)
                putProfile(bd, primary, "BD", Opts(about = aboutBD), open = true)
                suspend fun find(device: Dev, label: String, query: String) = matches(device, label, MatchesRequest(primary, Opt.Of(emptyList()), Opt.Of(query)))
                val refBD = find(bl, "BL-find", "quorbial $word flanges").value?.results?.firstOrNull { it.displayName == testName("BD") }?.ref
                val refBL = find(bd, "BD-find", "glimberwick $word sprockets").value?.results?.firstOrNull { it.displayName == testName("BL") }?.ref
                if (refBD == null || refBL == null) error("the two profiles did not find each other")
                val blk = call("BL-block", bl, primary) { it.block(BlockRequest(primary, refBD)) }
                val gone = deleteProfile(bd, primary, "BD-delete")
                val listGone = call("BL-blocks", bl, primary) { it.blocks(primary) }
                putProfile(bd, primary, "BD", Opts(about = aboutBD), open = true)
                val fromBD = find(bd, "BD-find", "glimberwick $word sprockets")
                presence(bl, "BL-presence", zoneA)
                presence(bd, "BD-presence", zoneA)
                val askR = ask(bd, "BD-meet", refBL)
                val un = call("BL-block", bl, primary) { it.unblock(BlockRequest(primary, refBD)) }
                val listAfter = call("BL-blocks", bl, primary) { it.blocks(primary) }
                presenceOff(bl, "BL-presence")
                presenceOff(bd, "BD-presence")
                askR.value?.meetId?.let { id -> call("BD-meet", bd, null) { it.cancelMeet(id) } }
                val problems = ArrayList<String>()
                if (!blk.ok || !gone.ok) problems += "block ${blk.status}, delete ${gone.status}"
                val row = listGone.value?.blocks.orEmpty().firstOrNull { it.ref == refBD }
                if (row == null || row.displayName != null || refBD !in listGone.value?.refs.orEmpty()) problems += "after the delete the blocks list holds ${listGone.value?.blocks?.size} rows, the row's name ${row?.displayName}"
                if (testName("BL") in names(fromBD.value?.results)) problems += "the re-created profile finds the blocker"
                if (askR.status != 403 || askR.code != "blocked") problems += "the re-created profile's ask gave ${askR.status} ${askR.code}"
                if (!un.ok || listAfter.value?.blocks.orEmpty().isNotEmpty()) problems += "unblock gave ${un.status}, ${listAfter.value?.blocks?.size} rows after"
                report(problems.isEmpty(), "q8c: a block outlives the blocked profile: a re-created profile stays blocked, and the block can still be lifted", problems.joinToString("; ").ifEmpty { "listed with display_name null, still hidden and 403 blocked after re-creating, unblocked by ref" })
            }

            check("ble1: Bluetooth sessions follow ble.mode, and sightings need a live session") {
                val (capStatus, caps) = raw("GET", "/api/capabilities", null)
                val mode = caps?.get("ble")?.jsonObject?.get("mode")?.jsonPrimitive?.contentOrNull
                if (capStatus != 200 || mode == null || mode == "none") {
                    skip("ble1: Bluetooth sessions follow ble.mode, and sightings need a live session", "no Bluetooth on this backend")
                    return@check
                }
                val bt = Dev("BT")
                everyDevice += bt
                putProfile(bt, primary, "BT", Opts(speak = listOf(commonTopic)), open = true)
                val on = presence(bt, "BT-presence", zoneA, ble = true)
                val derived = mode == "derived-v1"
                val problems = ArrayList<String>()
                if (!on.ok) problems += "presence gave ${on.status}"
                val key = on.value?.bleKey
                if (derived && !(key != null && Regex("^[A-Za-z0-9_-]{43}$").matches(key) && Regex("^[A-Za-z0-9_-]{11}$").matches(on.value?.bleKeyId ?: ""))) problems += "derived-v1 but no ble_key and ble_key_id"
                if (!derived && (key != null || on.value?.ble?.token == null)) problems += "server-rotate but no legacy token, or a key"
                val own = if (derived) key?.let { tokenOf(it) } else on.value?.ble?.token
                val sight = call("BT-sightings", bt, primary) {
                    it.sightings(SightingsRequest(primary, listOfNotNull(own?.let { o -> Sighting(o, -40) }, Sighting(b64(16), -40))))
                }
                if (!sight.ok || sight.value?.nearby.orEmpty().isNotEmpty()) problems += "own and unknown tokens gave ${sight.status}, ${sight.value?.nearby?.size} nearby"
                if (derived && sight.value?.bleKeyId != on.value?.bleKeyId) problems += "the sightings answer does not name the current key"
                val off = presence(bt, "BT-presence", zoneA, ble = false)
                val after = call("BT-sightings", bt, primary) { it.sightings(SightingsRequest(primary, listOfNotNull(own?.let { o -> Sighting(o, -40) }))) }
                if (!off.ok || after.status != 403 || after.code != "ble_required") problems += "after ble:false sightings gave ${after.status} ${after.code}"
                presenceOff(bt, "BT-presence")
                report(problems.isEmpty(), "ble1: Bluetooth sessions follow ble.mode, and sightings need a live session", problems.joinToString("; ").ifEmpty { "$mode: ${if (derived) "key and key id once, " else ""}own and unknown tokens resolve nobody, 403 ble_required after ble:false (the answers are decoded, not schema-validated)" })
            }
            skip("ble2: sightings resolve only co-located people, with a zone only in the requester's zone, at most 10 new people per window", "it puts specific-match test profiles around; the smoke runs it only against a local API")
            skip("unav1: an owner can delete while the conference is unavailable", "needs SMOKE_UNAVAILABLE=<slug>, an admin token and a local API")
        } catch (e: Throwable) {
            report(false, "people checks", e.message ?: e::class.simpleName.orEmpty())
        } finally {
            cleanUp()
        }
        leakChecks(everyDevice, circleTalk)
        ktor.close()
        return failures
    }

    /** Deletes every test profile made here and checks that each is gone: the delete answers 200 and the device has no live profile any more. */
    private suspend fun cleanUp() {
        var deleted = 0
        var gone = 0
        val problems = ArrayList<String>()
        for ((device, event) in created) {
            val del = runCatching { deleteProfile(device, event, "cleanup") }.getOrNull()
            if (del?.ok == true) deleted++ else problems += "${device.who}@$event delete ${del?.status}"
            // GET /api/people/blocks needs a live profile: 403 profile_required once it is gone.
            val check = runCatching { call("cleanup-check", device, event) { it.blocks(event) } }.getOrNull()
            if (check?.status == 403 && check.code == "profile_required") gone++ else problems += "${device.who}@$event still answers ${check?.status} ${check?.code}"
        }
        report(problems.isEmpty(), "cleanup: every test profile is deleted and gone", problems.joinToString("; ").ifEmpty { "${created.size} profiles: $deleted deleted, $gone answer 403 profile_required" })
    }

    private fun leakChecks(devices: List<Dev>, circleTalk: String?) {
        val hits = ArrayList<String>()
        val secrets = devices.flatMap { listOf(it.secret, it.profileId) }
        val hashes = devices.map { d -> MessageDigest.getInstance("SHA-256").digest(d.secret.encodeToByteArray()).joinToString("") { "%02x".format(it) } }
        for (r in responses) {
            val hay = "${r.text}\n${r.headers}"
            for (word in listOf("secret_hash", "text_hash", "\"profile_id\"", "_semantic", "presence_spot", "blocker_id", "blocked_id")) if (r.text.contains(word)) hits += "$word in ${r.path}"
            if (r.headers.contains("secret_hash")) hits += "secret_hash in a header of ${r.path}"
            if ((secrets + hashes).any { hay.contains(it) }) hits += "a device secret, id or hash in ${r.path}"
            // Spot and spot-me lines leave the server only to the meet's participants, and to their writers.
            if (r.text.contains(spotMarker) && !((r.label == "A-meet" || r.label == "F-meet") && r.path.startsWith("/api/meet/")) && r.label !in setOf("A-presence", "F-presence")) hits += "a spot line in ${r.label} ${r.path}"
            // C's contact only in that circle's member list, to a caller who shared for the talk when it asked.
            val fellowSharer = circleTalk != null && r.path == "/api/circles/members" && r.talkId == circleTalk && circleTalk in r.callerShares
            if (r.text.contains(contactMarker("C")) && !fellowSharer) hits += "C's contact in ${r.label}"
            if (r.label in setOf("N-members", "anon-members", "public-counts", "C-matches", "recs") && Regex("linkedin_url|contact_note").containsMatchIn(r.text)) hits += "contact fields in ${r.label}"
        }
        val l0 = ArrayList<String>()
        if (echoMismatches.isNotEmpty()) l0 += "different echo in ${echoMismatches.distinct().take(4).joinToString(", ")}"
        if (storedMismatches.isNotEmpty()) l0 += "stored differently: ${storedMismatches.distinct().take(4).joinToString("; ")}"
        if (storedInconclusive.isNotEmpty()) l0 += "read-back inconclusive: ${storedInconclusive.distinct().take(4).joinToString("; ")}"
        if (echoChecked > 0 && storedChecked == 0) l0 += "no stored profile was read back"
        report(l0.isEmpty(), "l0: every accepted profile write echoes and stores the shared talks it sent", l0.joinToString("; ").ifEmpty { "$echoChecked writes checked, $storedChecked talks read back" })
        val unique = hits.distinct()
        report(unique.isEmpty(), "l: secret_hash and other people's contact details never leak", unique.take(4).joinToString("; ").ifEmpty { "${responses.size} people responses checked" })
        report(retried == 0, "strict: no request answered 5xx or failed on its first attempt", if (retried > 0) "$retried did; see the NOTE lines above" else "none needed a retry")
    }

    /** The derived-v1 token of the current window: the first 16 bytes of HMAC-SHA256(key, "caddie-ble-v1" ‖ u64be(w)). */
    private fun tokenOf(keyText: String): String {
        val key = Base64.getUrlDecoder().decode(keyText)
        val w = System.currentTimeMillis() / 1000 / 600
        val message = "caddie-ble-v1".encodeToByteArray() + ByteArray(8) { i -> (w ushr (56 - 8 * i)).toByte() }
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        return Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(message).copyOf(16))
    }
}
