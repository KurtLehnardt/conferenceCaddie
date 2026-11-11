package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.bundle.BundleVerifier
import app.conferencecaddie.shared.bundle.CanonicalJson
import app.conferencecaddie.shared.bundle.Sha256
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.HttpResponse
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * A tier 1 backend for the UI tests, served from memory: a capabilities document, a
 * conferences.json and one valid talk bundle per conference, built here with the contract's
 * rules (canonical JSON, text hashes, the content hash), so the shared core verifies and installs
 * them exactly as it would real ones. Each talk carries a unit vector (`vector`, the index of its
 * one non-zero component, or null for none) and topics, so meaning-based search and For you can be
 * checked by hand with a fake embedder.
 *
 * The failure states are switches: [offline] fails every request, [unreachableBundles] fails the
 * bundle files of the named conferences, [corruptBundles] serves their bundle.json with one byte
 * changed, and [publish] lists conferences again, with a newer bundle_version or without a bundle.
 */
@OptIn(ExperimentalAtomicApi::class)
class TestBackend(
    /** True serves a capabilities document with the people features on (tier 3 minus Bluetooth), as [app.conferencecaddie.ui.people.FakePeopleServer] answers them. */
    private val people: Boolean = false,
    /**
     * The topics every conference's bundle lists, as topic_id to label, in rank order; people
     * profiles pick from them. Null lists the topics the conference's talks carry instead, ranked as
     * the builder ranks them (see topicsJson).
     */
    private val topics: List<Pair<String, String>>? = null,
    /** True offers native push nudges (apns and fcm) in the capabilities, with the people features. */
    private val push: Boolean = false,
    /** True offers derived-v1 Bluetooth proximity with the contract's defaults, with the people features. */
    private val ble: Boolean = false,
) : Http {
    class TestTalk(
        val id: String,
        val kind: String,
        val title: String,
        val abstract: String,
        val speakers: List<Pair<String, String?>>,
        val day: String,
        val start: Int,
        val end: Int,
        val track: String?,
        val room: String?,
        val hasSlides: Boolean = false,
        /** The topic_ids of the talk; a topic's talk_count is the number of talks that list it. */
        val topics: List<String> = emptyList(),
        val vector: Int? = null,
    )

    class TestConference(val slug: String, val name: String, val day: String, val talks: List<TestTalk>, val endDay: String = day) {
        fun without(id: String) = TestConference(slug, name, day, talks.filter { it.id != id }, endDay)
    }

    val base = "https://caddie.test"

    companion object {
        val TOPIC_LABELS = mapOf("ebpf" to "eBPF", "kubernetes" to "Kubernetes", "scheduling" to "Scheduling")
    }
    private val bundleBase = "$base/bundles/"
    private val routes = AtomicReference(emptyMap<String, ByteArray>())
    private val offlineFlag = AtomicReference(false)
    private val unreachable = AtomicReference(emptySet<String>())
    private val corrupt = AtomicReference(emptySet<String>())

    /** True fails every request, as a phone without a network does. */
    var offline: Boolean
        get() = offlineFlag.load()
        set(value) = offlineFlag.store(value)

    /** The slugs whose bundle files cannot be downloaded. */
    var unreachableBundles: Set<String>
        get() = unreachable.load()
        set(value) = unreachable.store(value)

    /** The slugs whose bundle.json arrives with one byte changed. */
    var corruptBundles: Set<String>
        get() = corrupt.load()
        set(value) = corrupt.store(value)

    val alpha = TestConference(
        "alpha-conf-2099",
        "Alpha Conference",
        "2099-03-03",
        listOf(
            TestTalk("1", "talk", "Intro to eBPF tracing", "Probes and maps.", listOf("Ada Lovelace" to "Engineer, Example Org"), "2099-03-03", 600, 630, "Observability", "Hall A", hasSlides = true, topics = listOf("ebpf"), vector = 0),
            TestTalk("2", "break", "Lunch", "", emptyList(), "2099-03-03", 720, 780, "Breaks", "Foyer"),
            TestTalk("3", "talk", "Kubernetes scheduling deep dive", "How the scheduler places pods.", listOf("Grace Hopper" to "Maintainer"), "2099-03-03", 810, 840, "Kubernetes", "Hall B", topics = listOf("kubernetes", "scheduling"), vector = 1),
            TestTalk("4", "talk", "Kubernetes networking basics", "Services and ingress.", listOf("Linus Example" to null), "2099-03-03", 900, 930, "Kubernetes", "Hall B", topics = listOf("kubernetes"), vector = 2),
        ),
    )

    val beta = TestConference(
        "beta-conf-2099",
        "Beta Conference",
        "2099-04-07",
        listOf(TestTalk("1", "talk", "Rust for embedded devices", "Bare-metal Rust.", listOf("Ferris Crab" to null), "2099-04-07", 600, 645, "Rust", "Room 1")),
    )

    init {
        publish(listOf(alpha, beta))
    }

    /**
     * Lists [conferences] in conferences.json and serves their bundles. The slugs in [newerBundles]
     * are listed with bundle_version 2; those in [unpublished] are listed without a bundle.
     */
    fun publish(conferences: List<TestConference>, newerBundles: Set<String> = emptySet(), unpublished: Set<String> = emptySet()) {
        val next = HashMap<String, ByteArray>()
        val tier1 = buildJsonObject {
            put("api_version", 1)
            put("tier", "demo")
            putJsonObject("talks") {
                put("bundle_base", bundleBase)
                put("server_search", false)
            }
            putJsonObject("people") {
                put("enabled", people)
                if (people) {
                    put("semantic", "off")
                    put("presence", true)
                    put("gps_bands", true)
                    put("meets", true)
                    put("circles", true)
                    put("reports", true)
                    put("live", "poll")
                }
            }
            putJsonObject("ble") { put("mode", if (people && ble) "derived-v1" else "none") }
            putJsonObject("push") {
                put("apns", people && push)
                put("fcm", people && push)
                put("webpush", false)
            }
            putJsonObject("imports") {
                put("github", "device")
                put("schedule", "device")
            }
        }
        next["$base/capabilities.json"] = tier1.toString().encodeToByteArray()
        val entries = conferences.map { c ->
            when (c.slug) {
                in unpublished -> JsonObject(conferenceJson(c) + ("bundle" to JsonNull))
                else -> {
                    val entry = publish(c, next)
                    if (c.slug !in newerBundles) {
                        entry
                    } else {
                        val bundle = entry["bundle"] as JsonObject
                        JsonObject(entry + ("bundle" to JsonObject(bundle + ("bundle_version" to JsonPrimitive(2)))))
                    }
                }
            }
        }
        val index = buildJsonObject {
            put("index_version", 1)
            put("generated_at", "2099-01-01T00:00:00Z")
            putJsonObject("publisher") {
                put("name", "Test publisher")
                put("takedown", "https://caddie.test/takedown")
            }
            put("conferences", JsonArray(entries))
        }
        next["${bundleBase}conferences.json"] = index.toString().encodeToByteArray()
        routes.store(next)
    }

    /** The bundle of [c] as the app decodes it. */
    fun bundleOf(c: TestConference): TalkBundle {
        val all = routes.load()
        val dir = all.keys.first { it.startsWith("$bundleBase${c.slug}/") && it.endsWith("/bundle.json") }.removeSuffix("bundle.json")
        val files = BundleVerifier.BUNDLE_FILES.associateWith { all.getValue(dir + it) }
        return TalkBundle.decode(BundleVerifier.contentHash(files), files.getValue(BundleVerifier.BUNDLE_FILE))!!
    }

    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse {
        if (offline) throw IllegalStateException("offline")
        val slug = url.removePrefix(bundleBase).substringBefore('/')
        val isBundleFile = url.startsWith(bundleBase) && !url.endsWith("conferences.json")
        if (isBundleFile && slug in unreachableBundles) throw IllegalStateException("offline")
        val body = routes.load()[url] ?: return HttpResponse(404, ByteArray(0))
        if (isBundleFile && slug in corruptBundles && url.endsWith("bundle.json")) {
            return HttpResponse(200, body.copyOf().also { it[it.size / 2] = (it[it.size / 2] + 1).toByte() })
        }
        return HttpResponse(200, body)
    }

    private fun conferenceJson(c: TestConference) = buildJsonObject {
        put("slug", c.slug)
        put("name", c.name)
        put("start_date", c.day)
        put("end_date", c.endDay)
        put("time_zone", "UTC")
        putJsonObject("location") {
            put("city", "Test City")
            put("region", "")
            put("country", "Testland")
            put("virtual", false)
        }
        put("status", "searchable")
        put("official_schedule_url", "https://caddie.test/${c.slug}/")
        put("source", "sessionize")
        put("has_level", false)
        put("track_group", "Track")
        put("tag_groups", JsonArray(emptyList()))
        put("talk_count", c.talks.count { it.kind == "talk" })
    }

    // The topics of a conference: [topics] in the order given when the test names them, otherwise
    // those its talks carry, by how many talks carry them, then id, as the builder ranks them. A
    // topic's talk_count is the number of talks that carry it, 0 for a named topic no talk carries.
    private fun topicsJson(c: TestConference): JsonArray {
        val counts = c.talks.filter { it.kind == "talk" }.flatMap { it.topics }.groupingBy { it }.eachCount()
        val listed = topics ?: counts.entries
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
            .map { (id, _) -> id to (TOPIC_LABELS[id] ?: id) }
        return JsonArray(
            listed.mapIndexed { i, (id, label) ->
                buildJsonObject {
                    put("topic_id", id)
                    put("label", label)
                    put("talk_count", counts[id] ?: 0)
                    put("rank", i + 1)
                    put("aliases", JsonArray(if (id == "kubernetes") listOf(JsonPrimitive("k8s")) else emptyList()))
                }
            },
        )
    }

    private fun hhmm(minutes: Int) = "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"

    private fun publish(c: TestConference, routes: MutableMap<String, ByteArray>): JsonObject {
        val conference = conferenceJson(c)
        val talks = c.talks.map { t ->
            buildJsonObject {
                put("talk_id", "${c.slug}:${t.id}")
                put("kind", t.kind)
                put("title", t.title)
                put("abstract", t.abstract)
                put("speakers", JsonArray(t.speakers.map { JsonPrimitive(it.first) }))
                put("speaker_taglines", JsonArray(t.speakers.map { it.second?.let { s -> JsonPrimitive(s) } ?: JsonNull }))
                put("room", t.room?.let { JsonPrimitive(it) } ?: JsonNull)
                put("track", t.track?.let { JsonPrimitive(it) } ?: JsonNull)
                put("level", JsonNull)
                put("tags", JsonArray(emptyList()))
                put("sponsor", false)
                put("has_slides", t.hasSlides)
                put("slides_url", if (t.hasSlides) JsonPrimitive("https://caddie.test/slides/${t.id}.pdf") else JsonNull)
                put("url", "https://caddie.test/${c.slug}/session/${t.id}")
                put("start", "${t.day}T${hhmm(t.start)}:00Z")
                put("end", "${t.day}T${hhmm(t.end)}:00Z")
                put("day", t.day)
                put("start_minutes", t.start)
                put("end_minutes", t.end)
                put("topics", JsonArray(t.topics.map { JsonPrimitive(it) }))
                put("text_hash", BundleVerifier.textHash(t.title, t.abstract))
            }
        }
        val rows = c.talks.filter { it.kind == "talk" || it.kind == "ambient" }.map { "${c.slug}:${it.id}" }
        val talkIds = c.talks.filter { it.kind == "talk" }.map { "${c.slug}:${it.id}" }
        val facets = c.talks.filter { it.kind == "talk" && it.track != null }.groupBy { it.track!! }.map { (track, list) ->
            val key = app.conferencecaddie.shared.search.normalizeKey(track)
            buildJsonObject {
                put("kind", "track")
                put("value", track)
                put("label", track)
                put("group", JsonNull)
                put("keys", buildJsonArray { add(JsonPrimitive(key)) })
                put("words", key)
                put("talks", list.size)
            }
        }
        val bundle = buildJsonObject {
            put("bundle_version", 1)
            put("conference", conference)
            putJsonObject("attribution") {
                put("licensor", "Test Events")
                put("license", "CC BY 3.0")
                put("license_url", "https://creativecommons.org/licenses/by/3.0/")
                put("source_url", "https://caddie.test/${c.slug}/")
                put("changes", "Reformatted.")
                put("takedown", "https://caddie.test/takedown")
            }
            putJsonObject("model") {
                put("id", "BAAI/bge-small-en-v1.5")
                put("dims", 384)
            }
            putJsonObject("vectors") {
                put("file", "vectors.i8")
                put("dtype", "int8")
                put("dims", 384)
                put("count", rows.size)
                put("quantization", "int8-symmetric-row-maxabs")
                put("rows", JsonArray(rows.map { JsonPrimitive(it) }))
            }
            put("talks", JsonArray(talks))
            put("topics", topicsJson(c))
            put("facets", JsonArray(facets))
            putJsonObject("related") {
                for (id in talkIds) put(id, JsonArray(talkIds.filter { it != id }.take(5).map { JsonPrimitive(it) }))
            }
        }
        val vectors = ByteArray(rows.size * 384)
        c.talks.filter { it.kind == "talk" || it.kind == "ambient" }.forEachIndexed { row, t ->
            t.vector?.let { vectors[row * 384 + it] = 127 }
        }
        val files = mapOf(
            "bundle.json" to CanonicalJson.encode(bundle).encodeToByteArray(),
            "vectors.i8" to vectors,
        )
        val hash = BundleVerifier.contentHash(files)
        val path = "${c.slug}/${hash.substring(0, 16)}/"
        files.forEach { (name, bytes) -> routes["$bundleBase$path$name"] = bytes }
        return JsonObject(
            conferenceJson(c) + ("bundle" to buildJsonObject {
                put("bundle_version", 1)
                put("content_hash", hash)
                put("path", path)
                put("model", "BAAI/bge-small-en-v1.5")
                put("dims", 384)
                put("talk_count", talkIds.size)
                put("vector_count", rows.size)
                putJsonObject("files") {
                    files.forEach { (name, bytes) ->
                        putJsonObject(name) {
                            put("bytes", bytes.size)
                            put("sha256", Sha256.hex(bytes))
                        }
                    }
                }
            }),
        )
    }
}
