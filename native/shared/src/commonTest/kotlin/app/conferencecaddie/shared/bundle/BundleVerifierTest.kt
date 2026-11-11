package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.fixtures.Fixtures.A
import app.conferencecaddie.shared.fixtures.Fixtures.B
import app.conferencecaddie.shared.fixtures.Fixtures.C
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

// Bundle verification (docs/contracts/talk-bundle.md), the cases of test/contracts-bundle.test.mjs
// that apply to a client.
class BundleVerifierTest {
    private val entry = Fixtures.entry
    private val files = Fixtures.files
    private val bundle = Json.parseToJsonElement(files.getValue("bundle.json").decodeToString()).jsonObject
    private val pretty = Json { prettyPrint = true }

    private fun JsonObject.set(key: String, value: JsonElement) = JsonObject(this + (key to value))

    /** Rebuilds the files and the entry after [mutate] edits the bundle, so every hash matches. */
    private fun rehash(value: JsonElement, canonical: Boolean = true): List<String> {
        val text = if (canonical) CanonicalJson.encode(value) else pretty.encodeToString(JsonElement.serializer(), value)
        val f = mapOf("bundle.json" to text.encodeToByteArray(), "vectors.i8" to files.getValue("vectors.i8"))
        val hash = BundleVerifier.contentHash(f)
        val e = entry
            .set("files", buildJsonObject { f.forEach { (n, b) -> put(n, buildJsonObject { put("bytes", b.size); put("sha256", Sha256.hex(b)) }) } })
            .set("content_hash", JsonPrimitive(hash))
            .set("path", JsonPrimitive("${Fixtures.SLUG}/${hash.substring(0, 16)}/"))
        return BundleVerifier.verify(e, f)
    }

    private fun talks(edit: (Int, JsonObject) -> JsonObject): JsonArray =
        JsonArray(bundle.getValue("talks").jsonArray.mapIndexed { i, t -> edit(i, t.jsonObject) })

    @Test
    fun theFixtureVerifies() {
        assertEquals(emptyList(), BundleVerifier.verify(entry, files))
        assertEquals(Fixtures.HASH, BundleVerifier.contentHash(files))
    }

    @Test
    fun theFixtureDecodes() {
        val b = assertNotNull(TalkBundle.decode(Fixtures.HASH, files.getValue("bundle.json")))
        assertEquals(4, b.talks.size)
        assertEquals(listOf(A, B, Fixtures.LUNCH, C), b.talks.map { it.talkId })
        assertEquals(listOf(C, B), b.related[A])
        assertEquals("CC BY 3.0", b.attribution.license)
        assertEquals(listOf("Engineer, Example Org", null), b.talksById.getValue(C).speakerTaglines)
        assertEquals("2099-03-02T09:00:00Z".let { IsoTime.epochMillis(it) }, b.talksById.getValue(A).startEpochMs)
        assertEquals(10, b.facets.size)
    }

    @Test
    fun verificationCatchesTampering() {
        val flipped = files.getValue("vectors.i8").copyOf().also { it[5] = (it[5].toInt() xor 1).toByte() }
        assertTrue(BundleVerifier.verify(entry, files + ("vectors.i8" to flipped)).any { "sha256" in it })
        assertTrue(BundleVerifier.verify(entry, mapOf("bundle.json" to files.getValue("bundle.json"))).any { "missing" in it })
        assertTrue(BundleVerifier.verify(entry.set("content_hash", JsonPrimitive("0".repeat(64))), files).any { "content_hash" in it })
        assertTrue(BundleVerifier.verify(entry.set("path", JsonPrimitive("${Fixtures.SLUG}/0000000000000000/")), files).any { "path" in it })

        // A consistent but wrong bundle (rehashed after editing) still fails the semantic checks.
        val related = bundle.getValue("related").jsonObject
        assertEquals(
            emptyList(),
            rehash(bundle.set("related", JsonObject(related + (A to JsonArray(listOf(JsonPrimitive(B), JsonPrimitive(C))))))),
            "a client does not recompute related lists",
        )
        assertTrue(rehash(bundle.set("talks", talks { i, t -> if (i == 0) t.set("speaker_taglines", JsonArray(emptyList())) else t })).any { "differ in length" in it })
        assertTrue(rehash(bundle.set("related", JsonObject(related + (A to JsonArray(listOf(JsonPrimitive(A))))))).any { "itself" in it })
        assertTrue(rehash(bundle.set("related", JsonObject(related + (A to JsonArray(listOf(JsonPrimitive(Fixtures.LUNCH))))))).any { "is not a talk" in it })
        assertTrue(rehash(bundle.set("talks", JsonArray(bundle.getValue("talks").jsonArray.reversed()))).any { "sorted" in it })
        assertTrue(rehash(bundle.set("talks", talks { i, t -> if (i == 0) t.set("topics", JsonArray(listOf(JsonPrimitive("nope")))) else t })).any { "unknown topic" in it })
        assertTrue(rehash(bundle.set("talks", talks { i, t -> if (i == 0) t.set("title", JsonPrimitive("Changed")) else t })).any { "text_hash" in it })
        val rows = bundle.getValue("vectors").jsonObject
        assertTrue(rehash(bundle.set("vectors", rows.set("rows", JsonArray(listOf(B, A, C).map { JsonPrimitive(it) })))).any { "vector rows" in it })
        assertTrue(
            rehash(bundle.set("talks", talks { i, t -> if (i == 0) t.set("speaker_profiles", JsonArray(emptyList())) else t })).any { "speaker profiles" in it },
        )
        val attribution = bundle.getValue("attribution").jsonObject
        assertTrue(rehash(bundle.set("attribution", attribution.set("source_url", JsonPrimitive("https://elsewhere.example/")))).any { "source_url" in it })
        assertTrue(rehash(bundle, canonical = false).any { "canonical" in it }, "whitespace or key order makes a bundle non-canonical")
        assertTrue(rehash(bundle.set("bundle_version", JsonPrimitive(2))).any { "bundle_version" in it })
        assertTrue(rehash(bundle.set("talks", talks { i, t -> if (i == 0) t.set("talk_id", JsonPrimitive("other-conf:1")) else t })).any { "not of this conference" in it })
    }

    @Test
    fun aVectorFileHoldingMinus128IsRefused() {
        val v = files.getValue("vectors.i8").copyOf().also { it[1] = (-128).toByte() }
        val f = mapOf("bundle.json" to files.getValue("bundle.json"), "vectors.i8" to v)
        val hash = BundleVerifier.contentHash(f)
        val e = entry
            .set("files", buildJsonObject { f.forEach { (n, b) -> put(n, buildJsonObject { put("bytes", b.size); put("sha256", Sha256.hex(b)) }) } })
            .set("content_hash", JsonPrimitive(hash))
            .set("path", JsonPrimitive("${Fixtures.SLUG}/${hash.substring(0, 16)}/"))
        assertTrue(BundleVerifier.verify(e, f).any { "-128" in it })
    }

    @Test
    fun aMalformedEntryIsRefusedInsteadOfThrowing() {
        assertEquals(listOf("content_hash missing or malformed"), BundleVerifier.verify(JsonObject(entry - "content_hash"), files))
        assertEquals(listOf("no index entry"), BundleVerifier.verify(null, files))
        assertEquals(listOf("no index entry"), BundleVerifier.verify(JsonNull, files))
        val listed = entry.getValue("files").jsonObject
        assertTrue(BundleVerifier.verify(entry.set("files", JsonObject(listed - "vectors.i8")), files).any { "exactly" in it })
        val extra = JsonObject(listed + ("extra.bin" to buildJsonObject { put("bytes", 0); put("sha256", "0".repeat(64)) }))
        assertTrue(BundleVerifier.verify(entry.set("files", extra), files).any { "exactly" in it })
    }

    @Test
    fun verificationNeverThrowsOnAMalformedBundleWhoseHashesMatch() {
        val talksArray = bundle.getValue("talks").jsonArray
        val cases: Map<String, JsonElement> = mapOf(
            "null" to JsonNull,
            "an array" to JsonArray(emptyList()),
            "a talk with no fields" to bundle.set("talks", JsonArray(listOf(JsonObject(emptyMap())))),
            "talks as an object" to bundle.set("talks", buildJsonObject { put("a", 1) }),
            "related lists that are not arrays" to bundle.set("related", buildJsonObject { put(A, "x") }),
            "related as an array" to bundle.set("related", JsonArray(emptyList())),
            "vectors without rows" to bundle.set("vectors", bundle.getValue("vectors").jsonObject.set("rows", JsonNull)),
            "topics of the wrong type" to bundle.set("topics", JsonArray(listOf(JsonNull))),
            "a float somewhere" to bundle.set("conference", bundle.getValue("conference").jsonObject.set("talk_count", JsonPrimitive(0.5))),
            "speakers that are not strings" to bundle.set(
                "talks",
                JsonArray(talksArray.map { it.jsonObject.set("speakers", JsonArray(listOf(JsonPrimitive(1)))) }),
            ),
            "a start that is not a date" to bundle.set("talks", talks { i, t -> if (i == 0) t.set("start", JsonPrimitive("soon")) else t }),
        )
        for ((name, value) in cases) {
            val problems = if (value is JsonObject) rehash(value, canonical = name != "a float somewhere") else rehash(value, canonical = false)
            assertTrue(problems.isNotEmpty(), "$name must be refused")
        }
        // Not JSON at all.
        val garbage = mapOf("bundle.json" to "{nope".encodeToByteArray(), "vectors.i8" to files.getValue("vectors.i8"))
        val hash = BundleVerifier.contentHash(garbage)
        val e = entry
            .set("files", buildJsonObject { garbage.forEach { (n, b) -> put(n, buildJsonObject { put("bytes", b.size); put("sha256", Sha256.hex(b)) }) } })
            .set("content_hash", JsonPrimitive(hash))
            .set("path", JsonPrimitive("${Fixtures.SLUG}/${hash.substring(0, 16)}/"))
        assertTrue(BundleVerifier.verify(e, garbage).any { "not JSON" in it })
    }

    @Test
    fun aBundleThatPassesVerificationButBreaksTheSchemaIsNotDecoded() {
        val roomAsNumber = bundle.set("talks", talks { i, t -> if (i == 0) t.set("room", JsonPrimitive(5)) else t })
        assertEquals(null, TalkBundle.decode("x", roomAsNumber))
        val javascriptUrl = bundle.set("talks", talks { i, t -> if (i == 0) t.set("url", JsonPrimitive("javascript:alert(1)")) else t })
        assertEquals(null, TalkBundle.decode("x", javascriptUrl), "links are http(s) only")
        val mixedCase = bundle.set("talks", talks { i, t -> if (i == 0) t.set("url", JsonPrimitive("Https://example.org/x")) else t })
        assertNotNull(TalkBundle.decode("x", mixedCase), "the feed writes Https:// at times")
    }
}
