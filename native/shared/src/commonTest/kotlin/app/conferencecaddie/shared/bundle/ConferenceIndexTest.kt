package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject

// Reading conferences.json entry by entry (readConferenceIndex() in contracts/js/bundle.mjs).
class ConferenceIndexTest {
    private val index = Fixtures.index

    private fun JsonObject.set(key: String, value: JsonElement) = JsonObject(this + (key to value))

    private fun json(text: String) = Json.parseToJsonElement(text)

    @Test
    fun theFixtureIndexReads() {
        val r = ConferenceIndex.read(index)
        assertTrue(r.ok)
        assertEquals(listOf(Fixtures.SLUG to BundleStatus.Ok, "caddie-unavailable-2099" to BundleStatus.None), r.conferences.map { it.conference.slug to it.bundleStatus })
        assertEquals(Fixtures.HASH, r.conferences[0].bundle?.contentHash)
        assertEquals("Caddie fixture publisher", r.publisher?.name)
        assertEquals("Europe/Amsterdam", r.conferences[0].conference.timeZone)
        assertNull(r.conferences[1].conference.timeZone)
    }

    @Test
    fun aClientSkipsBadEntriesAndKeepsTheRest() {
        val first = index.getValue("conferences").jsonArray[0].jsonObject
        val extra = listOf(
            json("""{ "slug": "broken", "name": 42 }"""),
            JsonPrimitive("not an object"),
            first.set("slug", JsonPrimitive("later-format-2099")).set(
                "bundle",
                json(
                    """{ "bundle_version": 2, "content_hash": "${"a".repeat(64)}", "path": "later-format-2099/aaaaaaaaaaaaaaaa/",
                       "files": { "bundle.json": { "bytes": 1, "sha256": "${"b".repeat(64)}" }, "vectors.f16": { "bytes": 2, "sha256": "${"c".repeat(64)}" } },
                       "model": "other/model", "dims": 768 }""",
                ),
            ),
            first.set("slug", JsonPrimitive("bad-bundle-2099")).set("bundle", json("""{ "bundle_version": 1, "content_hash": "nope" }""")),
            first.set("slug", JsonPrimitive("v1-extra-file-2099")).set(
                "bundle",
                JsonObject(
                    first.getValue("bundle").jsonObject.let { b ->
                        b + ("files" to JsonObject(b.getValue("files").jsonObject + ("extra.bin" to json("""{ "bytes": 0, "sha256": "${"0".repeat(64)}" }"""))))
                    },
                ),
            ),
            first.set("slug", JsonPrimitive("bad-date-2099")).set("start_date", JsonPrimitive("2099-02-30")),
        )
        val doc = index.set("conferences", JsonArray(index.getValue("conferences").jsonArray + extra))
        val r = ConferenceIndex.read(doc)
        assertTrue(r.ok)
        assertEquals(
            listOf(
                Fixtures.SLUG to BundleStatus.Ok,
                "caddie-unavailable-2099" to BundleStatus.None,
                "later-format-2099" to BundleStatus.Unsupported,
                "bad-bundle-2099" to BundleStatus.Invalid,
                "v1-extra-file-2099" to BundleStatus.Invalid,
            ),
            r.conferences.map { it.conference.slug to it.bundleStatus },
        )
        assertEquals(listOf(2 to "broken", 3 to null, 7 to "bad-date-2099"), r.skipped.map { it.position to it.slug })
        assertNull(r.conferences[2].bundle, "an unsupported bundle is not offered for download")
    }

    @Test
    fun aNewerIndexAsksForAnUpdate() {
        assertEquals("update_app", ConferenceIndex.read(index.set("index_version", JsonPrimitive(2))).reason)
        assertEquals("invalid", ConferenceIndex.read(index.set("index_version", JsonPrimitive(0))).reason)
        assertEquals("invalid", ConferenceIndex.read(null).reason)
        assertFalse(ConferenceIndex.read(json("[]")).ok)
        assertFalse(ConferenceIndex.read(json("""{ "index_version": 1 }""")).ok)
    }

    @Test
    fun theApiConferencesResponseReadsWithTheSameParser() {
        // conferences.json is a superset of GET /api/conferences; an entry without a bundle is "none".
        val first = index.getValue("conferences").jsonArray[0].jsonObject
        val api = index.set("conferences", JsonArray(listOf(JsonObject(first - "bundle"))))
        assertEquals(BundleStatus.None, ConferenceIndex.read(api).conferences.single().bundleStatus)
    }

    @Test
    fun onlyTheLiteralTrueMarksADemoConference() {
        val first = JsonObject(index.getValue("conferences").jsonArray[0].jsonObject - "bundle")
        assertFalse(assertNotNull(Conference.read(first)).demo, "an entry without the field is a real conference")
        assertTrue(assertNotNull(Conference.read(first.set("demo", JsonPrimitive(true)))).demo)
        // Any other value still reads as a conference, a real one: the field is optional and open.
        listOf(JsonPrimitive(false), JsonPrimitive("true"), JsonPrimitive(1), JsonNull, json("{}"), json("[true]")).forEach { v ->
            val c = assertNotNull(Conference.read(first.set("demo", v)), "demo = $v still reads")
            assertFalse(c.demo, "demo = $v is not a demo conference")
        }
    }

    @Test
    fun theIndexAndTheBundleCarryTheDemoMark() {
        val first = index.getValue("conferences").jsonArray[0].jsonObject
        val demo = index.set("conferences", JsonArray(listOf(first.set("demo", JsonPrimitive(true)), first.set("slug", JsonPrimitive("real-2099")))))
        assertEquals(listOf(true, false), ConferenceIndex.read(demo).conferences.map { it.conference.demo })

        // The bundle's own conference (bundle.json "conference") is read by the same parser.
        val bundle = json(Fixtures.files.getValue("bundle.json").decodeToString()).jsonObject
        val marked = bundle.set("conference", bundle.getValue("conference").jsonObject.set("demo", JsonPrimitive(true)))
        assertTrue(assertNotNull(TalkBundle.decode(Fixtures.HASH, marked)).conference.demo)
        assertFalse(assertNotNull(TalkBundle.decode(Fixtures.HASH, bundle)).conference.demo)
    }
}
