package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.asArray
import app.conferencecaddie.shared.asInteger
import app.conferencecaddie.shared.asObject
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.isStringArray
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Checks downloaded bundle files against their `conferences.json` entry and against the rules a
 * schema cannot state (docs/contracts/talk-bundle.md, "Download, verification and caching";
 * reference `verifyBundle()` in contracts/js/bundle.mjs, client mode). It returns a list of
 * problems, empty when the bundle may be used, and never throws.
 *
 * Clients do not recompute the related-talk lists from the vectors (the producer does), so a
 * last-digit difference in another platform's arithmetic can never make a good bundle fail.
 */
object BundleVerifier {
    const val BUNDLE_VERSION = 1
    const val BUNDLE_FILE = "bundle.json"
    const val VECTOR_FILE = "vectors.i8"
    const val RELATED_K = 5
    val BUNDLE_FILES = listOf(BUNDLE_FILE, VECTOR_FILE)
    private val VECTOR_KINDS = setOf("talk", "ambient")
    private val SHA256 = Regex("^[0-9a-f]{64}$")
    private val json = Json

    /** The content hash of a bundle's files (docs/contracts/talk-bundle.md, Content hash). */
    fun contentHash(files: Map<String, ByteArray>): String {
        val sb = StringBuilder("caddie-bundle-v1\n")
        for (name in files.keys.sorted()) {
            val bytes = files.getValue(name)
            sb.append(name).append('\t').append(Sha256.hex(bytes)).append('\t').append(bytes.size).append('\n')
        }
        return Sha256.hex(Sha256.utf8(sb.toString()))
    }

    /** `sha256(title + "\n" + abstract)` in hex, the talk's text_hash. */
    fun textHash(title: String, abstract: String): String = Sha256.hex("$title\n$abstract")

    fun verify(entry: JsonElement?, files: Map<String, ByteArray>): List<String> = try {
        verifyOrThrow(entry, files)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        listOf("$BUNDLE_FILE: could not be checked (${e::class.simpleName ?: "error"})")
    }

    private fun verifyOrThrow(entryElement: JsonElement?, files: Map<String, ByteArray>): List<String> {
        val entry = entryElement.asObject() ?: return listOf("no index entry")
        val hash = entry["content_hash"].asString()
        if (hash == null || !SHA256.matches(hash)) return listOf("content_hash missing or malformed")
        val problems = ArrayList<String>()
        val listedFiles = entry["files"].asObject() ?: JsonObject(emptyMap())
        val listed = listedFiles.keys
        if (listed.size != BUNDLE_FILES.size || !BUNDLE_FILES.all { it in listed }) {
            problems += "the entry must list exactly ${BUNDLE_FILES.joinToString(" and ")}"
        }
        for (name in BUNDLE_FILES) {
            val meta = listedFiles[name] ?: continue
            val bytes = files[name]
            if (bytes == null) {
                problems += "$name: missing"
                continue
            }
            val expected = meta.asObject()?.get("bytes").asInteger()
            if (bytes.size.toLong() != expected) problems += "$name: ${bytes.size} bytes, expected $expected"
            if (Sha256.hex(bytes) != meta.asObject()?.get("sha256").asString()) problems += "$name: sha256 mismatch"
        }
        if (problems.isNotEmpty()) return problems
        if (contentHash(BUNDLE_FILES.associateWith { files.getValue(it) }) != hash) problems += "content_hash mismatch"
        if (entry["path"].asString()?.endsWith("/${hash.substring(0, 16)}/") != true) {
            problems += "path does not end in the first 16 hex digits of content_hash"
        }
        val text = files.getValue(BUNDLE_FILE).decodeToString()
        val bundle = try {
            json.parseToJsonElement(text)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return problems + "$BUNDLE_FILE: not JSON"
        }
        // A bundle whose hashes match can still be malformed: check the shape before reading it.
        val shape = shapeProblems(bundle)
        if (shape.isNotEmpty()) return problems + shape
        return problems + semanticProblems(entry, files, bundle.asObject()!!, text)
    }

    // The structure the semantic checks rely on, checked without assuming anything about the content.
    private fun shapeProblems(element: JsonElement): List<String> {
        val bundle = element.asObject() ?: return listOf("$BUNDLE_FILE: not an object")
        val p = ArrayList<String>()
        val conference = bundle["conference"].asObject()
        if (conference == null || conference["slug"].asString() == null) p += "conference missing or malformed"
        if (bundle["attribution"].asObject() == null) p += "attribution missing or malformed"
        if (bundle["model"].asObject() == null) p += "model missing or malformed"
        val v = bundle["vectors"].asObject()
        val dims = v?.get("dims").asInteger()
        if (v == null || !v["rows"].isStringArray() || v["count"].asInteger() == null || dims == null || dims <= 0) {
            p += "vectors missing or malformed"
        }
        val talks = bundle["talks"].asArray()
        if (talks == null) {
            p += "talks is not an array"
        } else {
            talks.forEachIndexed { i, e ->
                val t = e.asObject()
                if (t == null || t["talk_id"].asString() == null || t["kind"].asString() == null ||
                    t["title"].asString() == null || t["abstract"].asString() == null || t["start"].asString() == null ||
                    !t["speakers"].isStringArray() || t["speaker_taglines"].asArray() == null ||
                    !t["topics"].isStringArray() || t["text_hash"].asString() == null
                ) {
                    p += "talks[$i] malformed"
                }
            }
        }
        val topics = bundle["topics"].asArray()
        if (topics == null || !topics.all { it.asObject()?.get("topic_id").asString() != null }) p += "topics malformed"
        val related = bundle["related"].asObject()
        if (related == null || !related.values.all { it.isStringArray() }) p += "related malformed"
        return p
    }

    private class Row(val id: String, val kind: String, val start: String, val startMs: Long?, val obj: JsonObject)

    // The rules a schema cannot state, on a bundle whose shape shapeProblems accepted.
    private fun semanticProblems(entry: JsonObject, files: Map<String, ByteArray>, bundle: JsonObject, text: String): List<String> {
        val problems = ArrayList<String>()
        val canonical = try {
            CanonicalJson.encode(bundle)
        } catch (_: IllegalArgumentException) {
            null
        }
        if (canonical != text) problems += "$BUNDLE_FILE: not canonical JSON"
        val bundleVersion = bundle["bundle_version"].asInteger()
        if (bundleVersion == null || bundleVersion != entry["bundle_version"].asInteger()) {
            problems += "bundle_version differs from the index entry"
        }
        val v = bundle["vectors"].asObject()!!
        val dims = v["dims"].asInteger()!!
        val count = v["count"].asInteger()!!
        val rows = v["rows"].asArray()!!.map { it.asString()!! }
        val model = bundle["model"].asObject()!!
        if (dims != entry["dims"].asInteger() || model["id"].asString() != entry["model"].asString() ||
            model["dims"].asInteger() != dims
        ) {
            problems += "model or dims differ from the index entry"
        }
        if (count != rows.size.toLong() || count != entry["vector_count"].asInteger()) problems += "vector count mismatch"
        val vectors = files[VECTOR_FILE]
        if (vectors != null && vectors.size.toLong() != count * dims) problems += "$VECTOR_FILE: length is not count x dims"
        if (vectors != null && vectors.any { it == (-128).toByte() }) problems += "$VECTOR_FILE: holds -128"

        val talks = bundle["talks"].asArray()!!.map { e ->
            val t = e.asObject()!!
            val start = t["start"].asString()!!
            Row(t["talk_id"].asString()!!, t["kind"].asString()!!, start, IsoTime.epochMillis(start), t)
        }
        val byId = talks.associateBy { it.id }
        if (byId.size != talks.size) problems += "duplicate talk_id"
        if (talks.count { it.kind == "talk" }.toLong() != entry["talk_count"].asInteger()) problems += "talk_count mismatch"
        talks.forEach { if (it.startMs == null) problems += "${it.id}: start is not a date-time" }
        val sorted = talks.sortedWith(compareBy<Row> { it.startMs ?: Long.MIN_VALUE }.thenBy { it.id })
        if (sorted.indices.any { sorted[it] !== talks[it] }) problems += "talks are not sorted by start, then talk_id"
        if (talks.any { it.obj.containsKey("speaker_profiles") }) problems += "speaker profiles and their links must not be published"
        for (t in talks) {
            if (t.obj["speakers"].asArray()!!.size != t.obj["speaker_taglines"].asArray()!!.size) {
                problems += "${t.id}: speakers and speaker_taglines differ in length"
            }
        }
        val conference = bundle["conference"].asObject()!!
        val attribution = bundle["attribution"].asObject()!!
        // Compared as JSON values, as the reference compares them with !==.
        if (attribution["source_url"]?.toString() != conference["official_schedule_url"]?.toString()) {
            problems += "attribution.source_url must be the conference schedule URL"
        }
        val prefix = "${conference["slug"].asString()}:"
        for (t in talks) if (!t.id.startsWith(prefix)) problems += "${t.id}: not of this conference"
        val rowSet = rows.toSet()
        if (rowSet.size != rows.size) problems += "duplicate vector row"
        val expectedRows = talks.filter { it.kind in VECTOR_KINDS }.map { it.id }
        if (expectedRows != rows) problems += "vector rows must be the talk and ambient items, in talks order"
        val topicIds = bundle["topics"].asArray()!!.map { it.asObject()!!["topic_id"].asString()!! }.toSet()
        for (t in talks) {
            for (id in t.obj["topics"].asArray()!!.map { it.asString()!! }) {
                if (id !in topicIds) problems += "${t.id}: unknown topic $id"
            }
        }
        for (t in talks) {
            if (textHash(t.obj["title"].asString()!!, t.obj["abstract"].asString()!!) != t.obj["text_hash"].asString()) {
                problems += "${t.id}: text_hash mismatch"
            }
        }
        val related = bundle["related"].asObject()!!
        val relatedExpected = talks.filter { it.kind == "talk" && it.id in rowSet }.map { it.id }
        if (related.keys.sorted() != relatedExpected.sorted()) problems += "related must have one entry per talk with a vector"
        for ((id, value) in related) {
            val list = value.asArray()!!.map { it.asString()!! }
            if (list.size > RELATED_K) problems += "$id: more than $RELATED_K related talks"
            if (list.toSet().size != list.size) problems += "$id: duplicate related talk"
            for (other in list) {
                if (other == id) problems += "$id: related to itself"
                if (byId[other]?.kind != "talk") problems += "$id: related $other is not a talk"
            }
        }
        return problems
    }
}
