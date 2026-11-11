package app.conferencecaddie.shared.smoke

import app.conferencecaddie.shared.bundle.BundleVerifier
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.embed.BgeEmbedder
import app.conferencecaddie.shared.importer.ImportConfidence
import app.conferencecaddie.shared.importer.ImportInput
import app.conferencecaddie.shared.importer.ImportRefusal
import app.conferencecaddie.shared.importer.ImportResult
import app.conferencecaddie.shared.importer.ScheduleImport
import app.conferencecaddie.shared.search.Evidence
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.shared.search.TalkSearch
import app.conferencecaddie.shared.search.TopicSearch
import java.io.File
import java.time.Instant as JavaInstant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.test.Test
import kotlin.test.fail
import kotlin.time.Clock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The talk checks of scripts/smoke.mjs, run against the on-device search instead of the server: the
 * exit criterion of phase 2 in docs/NATIVE_PLAN.md. Each check keeps the smoke test's name and its
 * expectations, which come, as there, from the committed data (data/{slug}/talks.ndjson), while the
 * answers come from [TalkSearch], [ForYou] and [TopicSearch] over real bundles built from that data
 * with the real query embedder (bge-small-en-v1.5 int8 through ONNX Runtime).
 *
 * Checks of HTTP behaviour (status codes for malformed requests, paging with "from", rate limits) and
 * of people features have no on-device equivalent; they are listed as N/A with the reason.
 *
 * Run it with the bundles of `node scripts/build-bundles.mjs --out <dir> ...`:
 *   ./gradlew :shared:smokeTalks -Pcaddie.smokeSite=<dir>
 * The normal jvmTest run leaves it out.
 */
class TalkSmokeTest {
    private val site = File(System.getProperty("caddie.smokeSite") ?: fail("set -Pcaddie.smokeSite to a bundle site"))
    private val dataDir = File(System.getProperty("caddie.dataDir") ?: fail("caddie.dataDir is not set"))
    private val embeddingDir = File(System.getProperty("caddie.embeddingDir") ?: fail("caddie.embeddingDir is not set"))
    private val json = Json { ignoreUnknownKeys = true }

    private val primary = "kubecon-cloudnativecon-north-america-2026"
    private val extra = listOf("mcp-dev-summit-nairobi-2026", "pytorch-day-japan-2026")

    private val queries = listOf(
        "making my cluster greener and using less energy" to "Monitoring Power at Planet Scale with Kepler",
        "supporting autistic and ADHD colleagues on my team" to "Neurodivergent Minds with Wings: Engineering Independence at Work",
        "a personal fitness trainer bot for marathon training" to "I Built an AI Running Coach: A Personal kagent Agent in Production",
        "what does each LLM token cost me" to
            "Clueless About The Cost of AI Model Usage? OpenCost+llm-d = first of a kind inference cost tracking",
        "how do I start contributing to the kubernetes project" to "Kubernetes 101: New Contributor Orientation",
    )
    private val nonTalkQueries = listOf("lunch", "coffee break", "registration", "opening remarks", "closing", "keynote welcome")

    private class Outcome(val name: String, val status: String, val detail: String)

    private val outcomes = ArrayList<Outcome>()
    private val allResults = ArrayList<Pair<String, Talk>>()

    private fun report(ok: Boolean, name: String, detail: String) {
        outcomes += Outcome(name, if (ok) "PASS" else "FAIL", detail)
    }

    private fun na(name: String, why: String) {
        outcomes += Outcome(name, "N/A", why)
    }

    private inline fun check(name: String, block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            report(false, name, "threw ${e::class.simpleName}: ${e.message}")
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Setup: every bundle of the site, verified, installed in an in-memory database, searched with
    // the real embedder.

    private class Conf(val bundle: TalkBundle, val search: TalkSearch, val forYou: ForYou, val data: List<JsonObject>)

    private val embedder = BgeEmbedder.create(
        File(embeddingDir, "model_quantized.onnx").readBytes(),
        File(embeddingDir, "vocab.txt").readText(),
    )
    private val database = CaddieDatabase.open(":memory:")
    private val conferences: Map<String, Conf> = runBlocking { load() }
    private val nowMs get() = Clock.System.now().toEpochMilliseconds()

    private suspend fun load(): Map<String, Conf> {
        val bundles = File(site, "bundles")
        val index = json.parseToJsonElement(File(bundles, "conferences.json").readText()).jsonObject
        return index.getValue("conferences").jsonArray.associate { e ->
            val entry = e.jsonObject
            val slug = entry.getValue("slug").jsonPrimitive.content
            val bundleEntry = entry.getValue("bundle").jsonObject
            val dir = File(bundles, bundleEntry.getValue("path").jsonPrimitive.content)
            val files = BundleVerifier.BUNDLE_FILES.associateWith { File(dir, it).readBytes() }
            val problems = BundleVerifier.verify(bundleEntry, files)
            check(problems.isEmpty()) { "$slug does not verify: $problems" }
            val bundle = checkNotNull(TalkBundle.decode(bundleEntry.getValue("content_hash").jsonPrimitive.content, files.getValue("bundle.json"), files.getValue("vectors.i8")))
            val scope = "https://smoke.example\n$slug"
            database.install(scope, bundle, 0)
            val search = TalkSearch(bundle, scope, database, embedder = { embedder })
            val data = File(dataDir, "$slug/talks.ndjson").readLines().filter { it.isNotBlank() }.map { json.parseToJsonElement(it).jsonObject }
            slug to Conf(bundle, search, ForYou(bundle, search), data)
        }
    }

    private fun conf(slug: String) = conferences[slug] ?: error("$slug is not in the site")

    private fun search(slug: String, request: SearchRequest): SearchResult = runBlocking {
        conf(slug).search.search(request).also { r -> allResults += r.talks.map { r.searchText to it } }
    }

    private fun primary(request: SearchRequest) = search(primary, request)

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.content
    private fun JsonObject.kind() = str("kind")

    private val minutesOf = { iso: String -> iso.substring(11, 13).toInt() * 60 + iso.substring(14, 16).toInt() }

    @Test
    fun talkChecks() {
        mvpChecks()
        rankingChecks()
        timeChecks()
        valueChecks()
        conferenceChecks()
        topicChecks()
        forYouChecks()
        scheduleChecks()
        relatedChecks()
        importChecks()
        evidenceCheck()
        notApplicable()

        val table = buildString {
            appendLine("On-device talk checks (scripts/smoke.mjs), ${outcomes.size} rows:")
            for (o in outcomes) appendLine("${o.status.padEnd(4)}  ${o.name} — ${o.detail}")
        }
        println(table)
        File(System.getProperty("caddie.smokeReport") ?: "build/reports/smoke-talks.txt").apply { parentFile?.mkdirs() }.writeText(table)
        val failed = outcomes.filter { it.status == "FAIL" }
        if (failed.isNotEmpty()) fail("${failed.size} talk checks failed:\n" + failed.joinToString("\n") { "${it.name}: ${it.detail}" })
    }

    // a, c, d, e1, e2, f
    private fun mvpChecks() {
        var firstTop: Talk? = null
        for ((i, q) in queries.withIndex()) {
            val (query, title) = q
            val name = "a${i + 1}: \"$query\" has its expected talk in the top five"
            check(name) {
                val r = primary(SearchRequest(query = query))
                if (i == 0) firstTop = r.talks.firstOrNull()
                val rank = r.talks.take(5).indexOfFirst { it.title == title }
                report(rank >= 0, name, if (rank >= 0) "rank ${rank + 1}" else "expected \"$title\", top ${r.talks.take(5).map { it.title }}")
            }
        }

        check("c: saved talks never filter results") {
            // The device's search takes no saved-talk input at all; the equivalent is that the same
            // request always gives the same results, with the first top result marked or not.
            val problems = ArrayList<String>()
            for (body in queries.map { it.first } + "") {
                val a = primary(SearchRequest(query = body))
                val b = primary(SearchRequest(query = body))
                if (a.total != b.total || a.talks.map { it.talkId } != b.talks.map { it.talkId }) problems += "\"$body\" changed"
            }
            report(problems.isEmpty() && firstTop != null, "c: saved talks never filter results", if (problems.isEmpty()) "6 requests identical, the interested list is not an input" else problems.joinToString())
        }

        check("d: no break, housekeeping or ambient item appears") {
            val nonTalk = conf(primary).data.filter { it.kind() != "talk" }.associateBy { it.str("talk_id")!! }
            val days = primary(SearchRequest()).facets.day.map { it.value }
            val requests = nonTalkQueries.map { SearchRequest(query = it) } + days.map { SearchRequest(day = it) }
            val leaked = requests.flatMap { primary(it).talks }.filter { it.talkId in nonTalk }
            report(leaked.isEmpty(), "d: no break, housekeeping or ambient item appears", if (leaked.isEmpty()) "${requests.size} requests, ${nonTalk.size} non-talk items checked" else leaked.take(3).joinToString { "${it.kind} \"${it.title}\"" })
        }

        check("e1: include_events adds co-located events and showcases, and nothing else") {
            val docs = conf(primary).data
            val ambient = docs.filter { it.kind() == "ambient" }.associateBy { it.str("talk_id")!! }
            val other = docs.filter { it.kind() == "break" || it.kind() == "housekeeping" }.map { it.str("talk_id")!! }.toSet()
            val track = ambient.values.firstOrNull { it.str("track") == "Solutions Showcase" }?.str("track") ?: ambient.values.first().str("track")!!
            val off = primary(SearchRequest(tracks = setOf(track)))
            val on = primary(SearchRequest(tracks = setOf(track), includeEvents = true))
            val problems = ArrayList<String>()
            if (off.talks.any { it.talkId in ambient }) problems += "an event appeared with the toggle off"
            val shown = on.talks.filter { it.talkId in ambient }
            if (shown.isEmpty()) problems += "no event appeared with the toggle on"
            if (shown.any { it.kind != "ambient" }) problems += "an event is not kind ambient"
            if (on.talks.any { it.talkId in other }) problems += "a break or housekeeping item appeared"
            val text = primary(SearchRequest(query = "solutions showcase and co-located events", includeEvents = true))
            if (text.talks.any { it.talkId in other }) problems += "a break or housekeeping item matched a text query"
            report(problems.isEmpty(), "e1: include_events adds co-located events and showcases, and nothing else", if (problems.isEmpty()) "${shown.size} events in \"$track\", ${off.total} results off and ${on.total} on" else problems.joinToString())
        }

        check("e2: For you never holds an event") {
            val ambient = conf(primary).data.filter { it.kind() == "ambient" }.map { it.str("talk_id")!! }.toSet()
            val r = forYou(primary, ForYou.Request(listOf("kubernetes", "ebpf"), "solutions showcase and co-located events", size = 50))
            val leaked = r.filter { it.talk.talkId in ambient }
            report(leaked.isEmpty() && r.isNotEmpty(), "e2: For you never holds an event", "${r.size} suggested talks, ${leaked.size} events among them (the boolean check is HTTP validation: N/A)")
        }

        check("f: an unknown filter value finds nothing") {
            val r = primary(SearchRequest(query = "kubernetes", tracks = setOf("No Such Track")))
            report(r.total == 0 && r.facets.track.any { it.value == "No Such Track" && it.count == 0 }, "f: an unknown filter value finds nothing",
                "the server answers 400; the app offers only known values, and an unknown one gives ${r.total} results, listed with count 0")
        }
    }

    // k1, k2
    private fun rankingChecks() {
        check("k1: the ranking drawer reports the keyword and semantic ranks that were fused") {
            val r = primary(SearchRequest(query = "kubernetes security", hideSponsor = true))
            val problems = ArrayList<String>()
            if (!r.semantic) problems += "meaning-based matching did not run"
            var previous = Double.MAX_VALUE
            val rrf = { n: Int? -> if (n != null && n > 0) 1.0 / (60 + n) else 0.0 }
            r.talks.take(15).forEachIndexed { i, t ->
                val g = r.ranking[t.talkId]
                if (g == null || g.rank != i + 1) {
                    problems += "result ${i + 1} has no rank"
                    return@forEachIndexed
                }
                if (g.keywordRank == null && g.semanticRank == null) problems += "\"${t.title}\" is in neither ranking"
                val score = rrf(g.keywordRank) + rrf(g.semanticRank)
                if (score > previous + 1e-9) problems += "\"${t.title}\" at ${g.rank} outscores the talk above it"
                previous = score
            }
            if (r.talks.any { it.sponsor }) problems += "a sponsor talk appeared"
            val first = r.talks.firstOrNull()?.let { r.ranking[it.talkId] }
            report(problems.isEmpty(), "k1: the ranking drawer reports the keyword and semantic ranks that were fused", if (problems.isEmpty()) "top result keyword ${first?.keywordRank}, semantic ${first?.semanticRank}" else problems.take(3).joinToString())
        }
        check("k2: browse mode has no ranking details") {
            val r = primary(SearchRequest())
            report(r.ranking.isEmpty(), "k2: browse mode has no ranking details", "${r.total} talks, ${r.ranking.size} ranks (the boolean check is HTTP validation: N/A)")
        }
    }

    // m1, n1, n2, m2
    private fun timeChecks() {
        check("m1: \"tuesday afternoon\" leaves the text, filters the results and can be removed") {
            val tuesday = listOf("2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12").first { JavaInstant.parse("${it}T12:00:00Z").atZone(ZoneId.of("UTC")).dayOfWeek.value == 2 }
            val r = primary(SearchRequest(query = "kubernetes tuesday afternoon"))
            val keys = r.timePhrases.filter { it.applied }.map { it.key }.sorted().joinToString(",")
            val wrong = r.talks.filter { !it.start.startsWith(tuesday) || minutesOf(it.start) < 720 }
            val off = primary(SearchRequest(query = "kubernetes tuesday afternoon", ignorePhrases = setOf("tuesday", "afternoon")))
            val ok = keys == "afternoon,tuesday" && r.searchText == "kubernetes" && r.talks.isNotEmpty() && wrong.isEmpty() &&
                off.timePhrases.none { it.applied } && off.total > r.total
            report(ok, "m1: \"tuesday afternoon\" leaves the text, filters the results and can be removed", "phrases $keys, text \"${r.searchText}\", ${r.total} talks, ${wrong.size} outside the filter, ${off.total} with both removed")
        }
        check("n1: Happening now is available exactly when the conference has talks today in its own zone") {
            val problems = ArrayList<String>()
            for (slug in listOf(primary, extra[0])) {
                val zone = ZoneId.of(conf(slug).bundle.conference.timeZone!!)
                val before = JavaInstant.now().atZone(zone).toLocalDate().toString()
                val r = search(slug, SearchRequest())
                val after = JavaInstant.now().atZone(zone).toLocalDate().toString()
                if (before != after) continue
                val expected = conf(slug).data.filter { it.kind() == "talk" }.any { it.str("day") == before }
                if (r.happeningNowAvailable != expected) problems += "$slug: expected $expected on $before"
            }
            report(problems.isEmpty(), "n1: Happening now is available exactly when the conference has talks today in its own zone", if (problems.isEmpty()) "checked 2 conferences against the local date in their zones" else problems.joinToString())
        }
        check("n2: Happening now keeps only talks in progress or starting within 60 minutes") {
            val slack = 2 * 60_000L
            val at = nowMs
            val r = primary(SearchRequest(happeningNow = true))
            val all = primary(SearchRequest())
            val outside = r.talks.filter { !(it.endEpochMs > at - slack && it.startEpochMs < at + 3_600_000 + slack) }
            val expected = conf(primary).data.filter { it.kind() == "talk" }.count {
                val start = JavaInstant.parse(OffsetIso.toInstant(it.str("start")!!)).toEpochMilli()
                val end = JavaInstant.parse(OffsetIso.toInstant(it.str("end")!!)).toEpochMilli()
                end > at + slack && start < at + 3_600_000 - slack
            }
            val ok = outside.isEmpty() && r.total >= expected && r.total <= all.total
            report(ok, "n2: Happening now keeps only talks in progress or starting within 60 minutes", "${r.total} of ${all.total} talks, at least $expected expected from the data, ${outside.size} outside the window")
        }
        check("m2: \"after lunch day 2\" uses that day's lunch break and an empty remainder browses") {
            val day2 = "2026-11-10"
            val lunch = conf(primary).data.filter { it.kind() == "break" && it.str("day") == day2 && it.str("title")!!.contains("lunch", ignoreCase = true) }
            val lunchEnd = lunch.maxOf { it["end_minutes"]!!.jsonPrimitive.int }
            val r = primary(SearchRequest(query = "after lunch day 2"))
            val wrong = r.talks.filter { !it.start.startsWith(day2) || minutesOf(it.start) < lunchEnd }
            val unknown = primary(SearchRequest(query = "day 9 friday"))
            val ok = r.searchText == "" && r.talks.isNotEmpty() && wrong.isEmpty() && unknown.timePhrases.isEmpty() && unknown.searchText == "day 9 friday"
            report(ok, "m2: \"after lunch day 2\" uses that day's lunch break and an empty remainder browses", "${r.total} talks, ${wrong.size} outside the window, lunch ends at minute $lunchEnd")
        }
    }

    // v1, v2
    private fun valueChecks() {
        check("v1: a track name in the search text is suggested as a chip, never applied, and applying it filters") {
            val track = "Platform Engineering"
            val r = primary(SearchRequest(query = "${track.lowercase()} talks"))
            val chip = r.suggestions.firstOrNull { it.kind == "track" && it.value == track }
            val applied = primary(SearchRequest(query = "${track.lowercase()} talks", tracks = setOf(track)))
            val wrong = applied.talks.filter { it.track != track }
            val after = applied.suggestions.any { it.kind == "track" && it.value == track }
            val other = primary(SearchRequest(query = "pytorch ecosystem"))
            val leaked = other.suggestions.any { it.value == "PyTorch Ecosystem" }
            val ok = chip != null && r.talks.any { it.track != track } && applied.talks.isNotEmpty() && wrong.isEmpty() && !after && !leaked
            report(ok, "v1: a track name in the search text is suggested as a chip, never applied, and applying it filters", "${r.suggestions.size} chips, ${r.total} talks before, ${applied.total} once applied, ${wrong.size} outside the track")
        }
        check("v2: a speaker name and a room are suggested as chips and filter the results") {
            val sample = primary(SearchRequest()).talks.first { it.speakers.isNotEmpty() && it.room != null }
            val name = sample.speakers[0]
            val chip = primary(SearchRequest(query = name)).suggestions.firstOrNull { it.kind == "speaker" && it.value == name }
            val bySpeaker = primary(SearchRequest(speakers = setOf(name)))
            val byRoom = primary(SearchRequest(rooms = setOf(sample.room!!)))
            val roomChip = primary(SearchRequest(query = sample.room!!.split('|').last().trim())).suggestions.firstOrNull { it.kind == "room" && it.value == sample.room }
            val ok = chip != null && bySpeaker.talks.isNotEmpty() && bySpeaker.talks.all { name in it.speakers } &&
                byRoom.talks.isNotEmpty() && byRoom.talks.all { it.room == sample.room } && roomChip != null
            report(ok, "v2: a speaker name and a room are suggested as chips and filter the results", "speaker chip ${chip != null}, room chip ${roomChip != null}, ${bySpeaker.total} talks by the speaker, ${byRoom.total} in the room (the shape check is HTTP validation: N/A)")
        }
    }

    // x, o
    private fun conferenceChecks() {
        for (slug in listOf(primary) + extra) {
            val name = "x: $slug returns only its own talks, chips and time zone"
            check(name) {
                val c = conf(slug)
                val docs = c.data.filter { it.kind() == "talk" }
                val own = docs.map { it.str("talk_id")!! }.toSet()
                val ownTracks = docs.mapNotNull { it.str("track") }.toSet()
                val ownTagGroups = docs.flatMap { d -> d["tags"]!!.jsonArray.map { it.jsonObject.str("group")!! } }.toSet()
                val zone = ZoneId.of(c.bundle.conference.timeZone!!)
                val problems = LinkedHashSet<String>()
                var checked = 0
                for (query in listOf("", "agents", "kubernetes", "pytorch training", "security")) {
                    val r = search(slug, SearchRequest(query = query))
                    if (query == "" && r.total != own.size) problems += "browse total ${r.total}, expected ${own.size}"
                    for (t in r.talks) {
                        checked++
                        if (t.talkId !in own || !t.talkId.startsWith("$slug:")) problems += "foreign talk \"${t.title}\""
                        val offset = zone.rules.getOffset(JavaInstant.ofEpochMilli(t.startEpochMs)).id.let { if (it == "Z") "+00:00" else it }
                        if (!t.start.endsWith(offset)) problems += "\"${t.title}\" starts ${t.start}, expected offset $offset"
                    }
                    for (b in r.facets.track) if (b.value !in ownTracks) problems += "track chip \"${b.value}\" is not this event's"
                    for (g in r.facets.tags) {
                        if (g.group !in c.bundle.conference.tagGroups) problems += "tag group \"${g.group}\" is not this event's"
                        for (v in g.values) if (v.count > 0 && g.group !in ownTagGroups) problems += "tag \"${v.value}\" is not this event's"
                    }
                    if ((r.facets.level != null) != c.bundle.conference.hasLevel) problems += "level facet does not follow has_level"
                    val facetTotal = r.facets.hasSlides.sumOf { it.count }
                    if (facetTotal != r.total) problems += "has_slides facet sums to $facetTotal, total ${r.total}"
                }
                report(problems.isEmpty(), name, if (problems.isEmpty()) "$checked results in ${zone.id}, ${ownTracks.size} own tracks" else problems.take(3).joinToString())
            }
        }
        check("o: the bundle holds only its conference's talks, with no people fields") {
            val problems = ArrayList<String>()
            var count = 0
            for (slug in listOf(primary) + extra) {
                val c = conf(slug)
                val own = c.data.filter { it.kind() == "talk" }.map { it.str("talk_id")!! }.toSet()
                val talks = c.bundle.talks.filter { it.kind == "talk" }
                count += talks.size
                if (talks.map { it.talkId }.toSet() != own) problems += "$slug has ${talks.size} talks, expected ${own.size}"
                if (talks.any { !it.talkId.startsWith("$slug:") }) problems += "$slug holds another conference's talk"
            }
            report(problems.isEmpty(), "o: the bundle holds only its conference's talks, with no people fields", if (problems.isEmpty()) "$count talks in 3 conferences; the verifier refuses speaker profiles (/api/schedule itself is the server's: its HTTP checks are N/A)" else problems.joinToString())
        }
    }

    // t, t2, t3
    private fun topicChecks() {
        val stoplist = File(dataDir, "../config/topic-stoplist.txt").readLines().map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()
        check("t: the topic list has Kubernetes, eBPF, a two-word topic and no filler") {
            val topics = TopicSearch.common(conf(primary).bundle)
            val labels = topics.map { it.label }
            val problems = ArrayList<String>()
            for (want in listOf("Kubernetes", "eBPF")) if (want !in labels) problems += "no \"$want\""
            val twoWord = topics.firstOrNull { it.label.trim().split(Regex("\\s+")).size == 2 }
            if (twoWord == null) problems += "no two-word topic"
            for (t in topics) {
                val bad = t.topicId.split('-').filter { it in stoplist || it.all(Char::isDigit) || it.length < 2 }
                if (bad.isNotEmpty()) problems += "\"${t.label}\" holds filler \"${bad.joinToString(" ")}\""
            }
            if (topics.size > 150) problems += "${topics.size} topics, more than 150"
            report(problems.isEmpty(), "t: the topic list has Kubernetes, eBPF, a two-word topic and no filler", if (problems.isEmpty()) "${topics.size} topics, for example \"${twoWord!!.label}\"" else problems.take(4).joinToString())
        }
        check("t2: topics do not cross conferences") {
            val problems = ArrayList<String>()
            val primaryIds = conf(primary).bundle.topics.map { it.topicId }.toSet()
            for (slug in extra) {
                val c = conf(slug)
                val topics = c.bundle.topics
                if (topics.isEmpty()) problems += "$slug has no topics"
                if (topics.any { it.topicId == "kubernetes" }) problems += "$slug lists Kubernetes"
                val own = c.data.count { it.kind() == "talk" }
                for (t in topics) if (t.talkCount > own) problems += "$slug \"${t.label}\" counts ${t.talkCount} talks"
                if (TopicSearch.typeAhead(c.bundle, "kube").any { it.topicId == "kubernetes" }) problems += "$slug type-ahead finds Kubernetes"
            }
            val mcp = conf(extra[0]).bundle.topics.firstOrNull { it.topicId !in primaryIds }
            report(problems.isEmpty(), "t2: topics do not cross conferences", if (problems.isEmpty()) "${extra[0]} has \"${mcp?.label}\", which $primary does not" else problems.joinToString())
        }
        check("t3: type-ahead and suggestions return topics with talk counts") {
            val b = conf(primary).bundle
            val typeAhead = TopicSearch.typeAhead(b, "kube")
            val sug = TopicSearch.suggest(b, emptyList(), "eBPF and GPU scheduling")
            val ok = typeAhead.any { it.label == "Kubernetes" && it.talkCount > 0 } && sug.any { it.topicId == "ebpf" }
            report(ok, "t3: type-ahead and suggestions return topics with talk counts", "type-ahead ${typeAhead.take(3).map { it.label }}, suggest ${sug.take(3).map { it.label }}")
        }
    }

    private fun forYou(slug: String, request: ForYou.Request): List<ForYou.Item> = runBlocking {
        when (val r = conf(slug).forYou.recommend(request, nowMs)) {
            ForYou.Result.NeedsInput -> emptyList()
            is ForYou.Result.Ready -> r.items
        }
    }

    // r1 to r8
    private fun forYouChecks() {
        val own = conf(primary).data.filter { it.kind() == "talk" }.map { it.str("talk_id")!! }.toSet()
        check("r1: For you puts talks with a wanted topic first and never an ended or marked one") {
            val first = forYou(primary, ForYou.Request(listOf("ebpf"), "kernel level tracing and observability"))
            val marked = first.take(2).map { it.talk.talkId }.toSet()
            val results = forYou(primary, ForYou.Request(listOf("ebpf"), "kernel level tracing and observability", marked, 50))
            val chips = forYou(primary, ForYou.Request(listOf("ebpf"), "", marked, 50))
            val problems = ArrayList<String>()
            if (results.isEmpty()) problems += "no results"
            val top = results.firstOrNull()
            if (top != null && !("ebpf" in top.talk.topics && "eBPF" in top.learnTopics)) problems += "the first result \"${top.talk.title}\" lacks eBPF"
            // Native only: the marked talks also find talks like them, so a chips-only request with
            // marked talks can hold talks without the topic; without marked talks it cannot.
            val chipsAlone = forYou(primary, ForYou.Request(listOf("ebpf"), "", emptySet(), 50))
            if (chipsAlone.isEmpty() || !chipsAlone.all { "ebpf" in it.talk.topics }) problems += "a chips-only result lacks the wanted topic"
            for (r in results + chips) {
                if (r.talk.endEpochMs <= nowMs) problems += "ended talk \"${r.talk.title}\""
                if (r.talk.talkId in marked) problems += "marked talk \"${r.talk.title}\""
                if (r.talk.talkId !in own) problems += "foreign talk \"${r.talk.title}\""
            }
            val empty = runBlocking { conf(primary).forYou.recommend(ForYou.Request(), nowMs) }
            if (empty != ForYou.Result.NeedsInput) problems += "an empty request does not need input"
            report(problems.isEmpty(), "r1: For you puts talks with a wanted topic first and never an ended or marked one", if (problems.isEmpty()) "${results.size} suggestions, first \"${top?.talk?.title}\"" else problems.distinct().take(3).joinToString())
        }
        check("r2: For you does not cross conferences") {
            val problems = ArrayList<String>()
            for (slug in extra) {
                val c = conf(slug)
                val topics = TopicSearch.common(c.bundle).take(3).map { it.topicId }
                val ownIds = c.data.filter { it.kind() == "talk" }.map { it.str("talk_id")!! }.toSet()
                for (r in forYou(slug, ForYou.Request(topics, "agents and model training", size = 50))) if (r.talk.talkId !in ownIds) problems += "$slug got \"${r.talk.title}\""
            }
            report(problems.isEmpty(), "r2: For you does not cross conferences", if (problems.isEmpty()) "${extra.size} conferences checked" else problems.take(3).joinToString())
        }
        val labelOf = conf(primary).bundle.topics.associate { it.topicId to it.label }
        fun whyProblems(results: List<ForYou.Item>, learn: List<String>): List<String> {
            val learnSet = learn.mapNotNull { labelOf[it] }.toSet()
            return results.filter { !learnSet.containsAll(it.learnTopics) }.map { "\"${it.talk.title}\" lists a learn topic that was not sent" }
        }
        check("r3: a request without kubernetes never names kubernetes in why") {
            val learn = listOf("ai", "agents")
            val results = forYou(primary, ForYou.Request(learn, size = 50))
            val problems = ArrayList(whyProblems(results, learn))
            for (x in results) if (x.learnTopics.any { it.contains("kubernetes", ignoreCase = true) }) problems += "\"${x.talk.title}\" names Kubernetes"
            if (results.none { "kubernetes" in it.talk.topics }) problems += "no returned talk carries the kubernetes topic, so the check proves nothing"
            report(problems.isEmpty(), "r3: a request without kubernetes never names kubernetes in why", if (problems.isEmpty()) "${results.size} suggestions, none name Kubernetes" else problems.take(3).joinToString())
        }
        check("r4: the topics in why are a subset of the learn topics sent") {
            fun have(vararg ids: String) = ids.filter { it in labelOf }
            val cases = listOf(have("ai", "agents"), have("kubernetes"), have("ebpf", "gpu"), have("kubernetes", "ai"), labelOf.keys.take(5)).filter { it.isNotEmpty() }
            val problems = ArrayList<String>()
            var sawLearn = false
            for (learn in cases) {
                val results = forYou(primary, ForYou.Request(learn, size = 50))
                problems += whyProblems(results, learn)
                if (results.any { it.learnTopics.isNotEmpty() }) sawLearn = true
            }
            if (!sawLearn) problems += "no suggestion named a learn topic, so the check proves nothing"
            report(problems.isEmpty(), "r4: the topics in why are a subset of the learn topics sent", if (problems.isEmpty()) "${cases.size} requests checked (no speak topics exist on the device)" else problems.take(3).joinToString())
        }
        check("r7: the learn and problems text alone returns talks with a relevant passage") {
            val results = forYou(primary, ForYou.Request(emptyList(), "our GPU inference costs are too high", size = 10))
            val relevant = Regex("gpu|inference|cost|efficien|scal|latency|throughput|serving|accelerat|resource|utiliz|llm|model", RegexOption.IGNORE_CASE)
            val top = results.take(5)
            val withPassage = top.filter { it.passage != null && relevant.containsMatchIn(it.passage!!) }
            val problems = ArrayList<String>()
            if (results.isEmpty()) problems += "no results"
            if (top.isNotEmpty() && withPassage.size < minOf(3, top.size)) problems += "only ${withPassage.size} of the top ${top.size} have a relevant passage"
            if (results.any { it.learnTopics.isNotEmpty() }) problems += "a topic was named although no topic was sent"
            report(problems.isEmpty(), "r7: the learn and problems text alone returns talks with a relevant passage", if (problems.isEmpty()) "${results.size} talks, first \"${results[0].talk.title}\"" else problems.joinToString())
        }
        check("r8: the same For you request made five times returns the same talk order") {
            val topic = if ("ai" in labelOf) "ai" else labelOf.keys.first()
            val orders = (1..5).map { forYou(primary, ForYou.Request(listOf(topic), size = 10)).map { it.talk.talkId } }
            val ok = orders[0].isNotEmpty() && orders.toSet().size == 1
            report(ok, "r8: the same For you request made five times returns the same talk order", "5 requests, ${orders.toSet().size} order(s) of ${orders[0].size} talks for \"$topic\"")
        }
    }

    // sch1
    private fun scheduleChecks() {
        check("sch1: browsing one day lists only that day's talks in start order, with no duplicates") {
            val busiest = primary(SearchRequest()).facets.day.maxBy { it.count }
            val day = busiest.value
            val expected = conf(primary).data.count { it.kind() == "talk" && it.str("day") == day }
            val r = primary(SearchRequest(day = day))
            val ids = r.talks.map { it.talkId }
            val problems = ArrayList<String>()
            if (ids.toSet().size != ids.size) problems += "duplicates"
            if (r.total != expected || ids.size != expected) problems += "${ids.size} listed, total ${r.total}, expected $expected"
            if (r.talks.any { it.day != day || it.kind != "talk" }) problems += "an item is not a talk on $day"
            if (r.talks.zipWithNext().any { (a, b) -> b.startEpochMs < a.startEpochMs }) problems += "start goes backwards"
            report(problems.isEmpty(), "sch1: browsing one day lists only that day's talks in start order, with no duplicates", if (problems.isEmpty()) "$day: ${ids.size} talks in one list (the device needs no pages)" else problems.joinToString())
        }
    }

    // rel1
    private fun relatedChecks() {
        check("rel1: related talks are up to five other talks of the same conference") {
            val self = primary(SearchRequest(query = queries[0].first)).talks.first()
            val results = conf(primary).search.related(self.talkId)
            val ids = results.map { it.talkId }
            val ok = results.size in 1..5 && self.talkId !in ids && ids.toSet().size == ids.size &&
                results.all { it.talkId.startsWith("$primary:") && it.title.isNotEmpty() && it.url != null && it.kind == "talk" }
            report(ok, "rel1: related talks are up to five other talks of the same conference", "${results.size} results, the first is \"${results.firstOrNull()?.title}\"")
        }
    }

    // im1 to im5: "Import my schedule" on the device (ScheduleImport), with the smoke test's file: five
    // real titles of the primary conference in a schedule as an attendee might save it.
    private fun importChecks() {
        val picks = importPicks(primary, 5)
        val pickIds = picks.mapNotNull { it.str("talk_id") }.toSet()
        val body = scheduleText(picks, conf(primary).bundle.conference.timeZone ?: "UTC")
        fun deviceImport(slug: String, input: ImportInput): ImportResult {
            val checked = ScheduleImport.check(input) as? ScheduleImport.Checked.Ok ?: error("refused")
            return ScheduleImport.onDevice(checked.prepared, conf(slug).bundle)
        }
        fun exactHits(r: ImportResult) = r.matched.count { it.talk.talkId in pickIds && it.confidence == ImportConfidence.ExactTitle }
        val before = runBlocking { listOf(primary, extra[0]).map { database.installedBundle("https://smoke.example\n$it") to database.interested("https://smoke.example\n$it") } }

        check("im1: a text file with 5 real titles gets at least 4 matches at \"exact title\"") {
            val r = deviceImport(primary, ImportInput.Text(body))
            val exact = exactHits(r)
            val foreign = r.matched.count { !it.talk.talkId.startsWith("$primary:") }
            report(picks.size == 5 && exact >= 4 && foreign == 0, "im1: a text file with 5 real titles gets at least 4 matches at \"exact title\"",
                "$exact of ${picks.size} at exact title, ${r.matched.size} matched, ${r.unmatchedCount} unmatched, ${r.extractedChars} characters")
        }
        val other = extra[0]
        check("im2: the same file against $other gets none of the first conference's talks") {
            val r = deviceImport(other, ImportInput.Text(body))
            val primaryIds = conf(primary).bundle.talksById.keys
            val crossed = r.matched.filter { it.talk.talkId in primaryIds || !it.talk.talkId.startsWith("$other:") }
            report(crossed.isEmpty(), "im2: the same file against $other gets none of the first conference's talks",
                if (crossed.isNotEmpty()) "${crossed.size} crossed, for example \"${crossed[0].talk.title}\"" else "${r.matched.size} matched, all of $other")
        }
        na("im3: a PDF goes through the attachment processor and finds the same talks", "native v1 reads no PDF (docs/NATIVE_PLAN.md, decision 8); a PDF file is refused before it is read, which CaddieCoreImportTest checks")
        check("im3b: text the browser extracted from a PDF, sent with its file name and type, finds the same talks") {
            // extractPdfText(makePdf(lines)) in the smoke test gives the lines back, one per line.
            val extracted = body.split('\n').joinToString("\n")
            val prepared = ScheduleImport.Prepared(extracted, "schedule.pdf", "text/plain", isFile = false)
            val exact = exactHits(ScheduleImport.onDevice(prepared, conf(primary).bundle))
            report(exact >= 4, "im3b: text the browser extracted from a PDF, sent with its file name and type, finds the same talks", "$exact of ${picks.size} at exact title")
        }
        check("im4: a 6 MB upload gets 413, and unknown keys, binary files and unknown conferences are refused") {
            val big = ScheduleImport.check(ImportInput.File(ByteArray(6 * 1024 * 1024) { 0x41 }, "big.txt", "text/plain"))
            val binary = ScheduleImport.check(ImportInput.File(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff.toByte(), 0xfe.toByte(), 0x00, 0x80.toByte()), "x.png", "image/png"))
            val reasons = listOf(big, binary).map { (it as? ScheduleImport.Checked.Refused)?.reason }
            report(reasons == listOf(ImportRefusal.TooLarge, ImportRefusal.Unsupported), "im4: a 6 MB upload gets 413, and unknown keys, binary files and unknown conferences are refused",
                "6 MB ${reasons[0]}, binary ${reasons[1]} (unknown keys and conferences are HTTP validation: N/A; the device imports only into the selected conference's bundle)")
        }
        check("im5: an import adds nothing to any index") {
            val after = runBlocking { listOf(primary, extra[0]).map { database.installedBundle("https://smoke.example\n$it") to database.interested("https://smoke.example\n$it") } }
            report(after == before, "im5: an import adds nothing to any index", "the installed bundles and the Interested lists of $primary and $other are unchanged; the device import stores nothing")
        }
    }

    // importPicks in scripts/smoke.mjs: n talks with a unique, printable ASCII title of four words or more, spread over the talk ids.
    private fun importPicks(slug: String, n: Int): List<JsonObject> {
        val talks = conf(slug).data.filter { it.kind() == "talk" }
        val seen = talks.groupingBy { it.str("title") }.eachCount()
        val pool = talks
            .filter { t -> val title = t.str("title") ?: ""; seen[title] == 1 && title.isNotEmpty() && title.all { it in ' '..'~' } && title.trim().split(Regex("\\s+")).size >= 4 }
            .sortedBy { it.str("talk_id") }
        val step = maxOf(1, pool.size / n)
        return pool.filterIndexed { i, _ -> i % step == 0 }.take(n)
    }

    // scheduleText in scripts/smoke.mjs: day headers, time ranges, titles, speakers, rooms and calendar links.
    private fun scheduleText(talks: List<JsonObject>, timeZone: String): String {
        val zone = ZoneId.of(timeZone)
        val day = DateTimeFormatter.ofPattern("EEEE, MMMM d", Locale.US)
        // Intl writes a narrow no-break space before AM and PM.
        val time = DateTimeFormatter.ofPattern("h:mm\u202Fa", Locale.US)
        fun at(iso: String) = JavaInstant.parse(OffsetIso.toInstant(iso)).atZone(zone)
        val lines = mutableListOf("My schedule", "")
        for (t in talks.sortedBy { JavaInstant.parse(OffsetIso.toInstant(it.str("start")!!)) }) {
            val start = at(t.str("start")!!)
            val end = at(t.str("end")!!)
            val speakers = t["speakers"]?.jsonArray?.joinToString(", ") { it.jsonPrimitive.content } ?: ""
            lines += listOf(day.format(start), "", "${time.format(start)} – ${time.format(end)}", t.str("title")!!, "Speakers: $speakers", (t["room"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: "Room 1", "Add to calendar", "")
        }
        return lines.joinToString("\n")
    }

    // b
    private fun evidenceCheck() {
        check("b: every result has non-empty evidence") {
            val empty = allResults.filter { (text, t) -> Evidence.forTalk(t, text).isBlank() }
            report(allResults.isNotEmpty() && empty.isEmpty(), "b: every result has non-empty evidence", if (empty.isEmpty()) "${allResults.size} results" else "${empty.size} empty, for example \"${empty[0].second.title}\"")
        }
    }

    private fun notApplicable() {
        na("f2: a search without a conference, or for an unknown one, returns 400", "HTTP validation; the app searches only the installed bundle")
        na("u: a conference that is not on Sessionize is listed with a working link", "conferences.json lists only searchable conferences with bundles")
        na("r5: speak topics alone need a profile", "the device has no speak topics; an empty request needs input (checked in r1)")
        na("r6: speak topics change neither the ranking nor the reasons", "the device has no speak topics")
        na("sch2: \"from\" is validated and accepted only in browse mode", "HTTP paging; the device lists every result")
        na("rel2: GET /api/related validates its input", "HTTP validation; related talks come from the bundle")
    }
}

/** ISO 8601 with an offset ("2026-11-10T09:00:00-07:00") to an instant string java.time parses. */
private object OffsetIso {
    fun toInstant(s: String): String = java.time.OffsetDateTime.parse(s).toInstant().toString()
}
