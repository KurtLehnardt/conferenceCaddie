package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.bundle.BundleVerifier
import app.conferencecaddie.shared.bundle.CanonicalJson
import app.conferencecaddie.shared.bundle.Sha256
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.HttpResponse
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
 */
class TestBackend : Http {
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
        val topics: List<String> = emptyList(),
        val vector: Int? = null,
    )

    class TestConference(val slug: String, val name: String, val day: String, val talks: List<TestTalk>)

    val base = "https://caddie.test"

    companion object {
        val TOPIC_LABELS = mapOf("ebpf" to "eBPF", "kubernetes" to "Kubernetes", "scheduling" to "Scheduling")
    }
    private val bundleBase = "$base/bundles/"
    private val routes = HashMap<String, ByteArray>()

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
        val tier1 = buildJsonObject {
            put("api_version", 1)
            put("tier", "demo")
            putJsonObject("talks") {
                put("bundle_base", bundleBase)
                put("server_search", false)
            }
            putJsonObject("people") { put("enabled", false) }
            putJsonObject("ble") { put("mode", "none") }
            putJsonObject("push") {
                put("apns", false)
                put("fcm", false)
                put("webpush", false)
            }
            putJsonObject("imports") {
                put("github", "device")
                put("schedule", "device")
            }
        }
        routes["$base/capabilities.json"] = tier1.toString().encodeToByteArray()
        val entries = listOf(alpha, beta).map { publish(it) }
        val index = buildJsonObject {
            put("index_version", 1)
            put("generated_at", "2099-01-01T00:00:00Z")
            putJsonObject("publisher") {
                put("name", "Test publisher")
                put("takedown", "https://caddie.test/takedown")
            }
            put("conferences", JsonArray(entries))
        }
        routes["${bundleBase}conferences.json"] = index.toString().encodeToByteArray()
    }

    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse {
        val body = routes[url] ?: return HttpResponse(404, ByteArray(0))
        return HttpResponse(200, body)
    }

    private fun conferenceJson(c: TestConference) = buildJsonObject {
        put("slug", c.slug)
        put("name", c.name)
        put("start_date", c.day)
        put("end_date", c.day)
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

    // The topics of a conference by how many talks carry them, then id, as the builder ranks them.
    private fun topicsJson(c: TestConference): JsonArray {
        val counts = c.talks.filter { it.kind == "talk" }.flatMap { it.topics }.groupingBy { it }.eachCount()
        val ordered = counts.entries.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
        return JsonArray(
            ordered.mapIndexed { i, (id, n) ->
                buildJsonObject {
                    put("topic_id", id)
                    put("label", TOPIC_LABELS[id] ?: id)
                    put("talk_count", n)
                    put("rank", i + 1)
                    put("aliases", JsonArray(if (id == "kubernetes") listOf(JsonPrimitive("k8s")) else emptyList()))
                }
            },
        )
    }

    private fun hhmm(minutes: Int) = "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"

    private fun publish(c: TestConference): JsonObject {
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
