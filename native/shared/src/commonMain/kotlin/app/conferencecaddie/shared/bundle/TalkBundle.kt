package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.asArray
import app.conferencecaddie.shared.asInteger
import app.conferencecaddie.shared.asObject
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.asStringList
import app.conferencecaddie.shared.isBoolean
import app.conferencecaddie.shared.isTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** One schedule item of a bundle (docs/contracts/talk-bundle.md, "A talk"). */
data class Talk(
    val talkId: String,
    /** talk, ambient, break or housekeeping. */
    val kind: String,
    val title: String,
    val abstract: String,
    val speakers: List<String>,
    /** Parallel to [speakers]; null for a speaker who gave no tagline. */
    val speakerTaglines: List<String?>,
    val room: String?,
    val track: String?,
    val level: String?,
    val tags: List<Tag>,
    val sponsor: Boolean,
    val hasSlides: Boolean,
    val slidesUrl: String?,
    val url: String?,
    val start: String,
    val end: String,
    /** The conference-local date, `YYYY-MM-DD`. */
    val day: String,
    val startMinutes: Int,
    val endMinutes: Int,
    val topics: List<String>,
    val startEpochMs: Long,
    val endEpochMs: Long,
) {
    data class Tag(val group: String, val value: String)

    /** True for the kinds search covers by default. */
    val isTalk: Boolean get() = kind == "talk"
}

data class Topic(val topicId: String, val label: String, val talkCount: Int, val rank: Int, val aliases: List<String>)

/** A value-matching name: a track, room, speaker or tag, with its normalised keys. */
data class Facet(
    val kind: String,
    val value: String,
    val label: String,
    val group: String?,
    val keys: List<String>,
    val words: String,
    val talks: Int,
)

data class Attribution(
    val licensor: String,
    val license: String,
    val licenseUrl: String,
    val sourceUrl: String?,
    val changes: String,
    val takedown: String,
)

/**
 * A verified bundle, decoded for use. [decode] reads the schema's shapes strictly and returns null
 * for anything that does not fit, so a bundle that passed the hash checks but is malformed in a way
 * [BundleVerifier] does not look at is still refused rather than half-used.
 *
 * [vectors] holds the talk vectors of `vectors.i8` when they were given to [decode] (meaning search
 * and For you need them); without them, search is keyword search alone.
 */
data class TalkBundle(
    val contentHash: String,
    val conference: Conference,
    val attribution: Attribution,
    val talks: List<Talk>,
    val topics: List<Topic>,
    val facets: List<Facet>,
    val related: Map<String, List<String>>,
    val vectors: TalkVectors? = null,
) {
    val talksById: Map<String, Talk> by lazy { talks.associateBy { it.talkId } }
    val topicsById: Map<String, Topic> by lazy { topics.associateBy { it.topicId } }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        private val KINDS = setOf("talk", "ambient", "break", "housekeeping")
        private val FACET_KINDS = setOf("track", "room", "speaker", "tag")
        private val HTTP_URL = Regex("^[Hh][Tt][Tt][Pp][Ss]?://")

        /**
         * Decodes `bundle.json`, and with [vectors] the bytes of `vectors.i8`, which must hold one
         * row of `vectors.dims` bytes for every entry of `vectors.rows` (the verifier checks the
         * same before a bundle is installed).
         */
        fun decode(contentHash: String, bundleJson: ByteArray, vectors: ByteArray? = null): TalkBundle? = try {
            decode(contentHash, json.parseToJsonElement(bundleJson.decodeToString()), vectors)
        } catch (_: Exception) {
            null
        }

        fun decode(contentHash: String, element: JsonElement, vectorBytes: ByteArray? = null): TalkBundle? {
            val o = element.asObject() ?: return null
            val conference = Conference.read(o["conference"]) ?: return null
            val a = o["attribution"].asObject() ?: return null
            val attribution = Attribution(
                licensor = a["licensor"].asString() ?: return null,
                license = a["license"].asString() ?: return null,
                licenseUrl = a["license_url"].asString()?.takeIf { HTTP_URL.containsMatchIn(it) } ?: return null,
                sourceUrl = nullable(a, "source_url", HTTP_URL) ?: return null,
                changes = a["changes"].asString() ?: return null,
                takedown = a["takedown"].asString() ?: return null,
            ).let { it.copy(sourceUrl = it.sourceUrl.orNullMarker()) }
            val talks = o["talks"].asArray()?.map { talk(it) ?: return null } ?: return null
            val topics = o["topics"].asArray()?.map { e ->
                val t = e.asObject() ?: return null
                Topic(
                    topicId = t["topic_id"].asString() ?: return null,
                    label = t["label"].asString() ?: return null,
                    talkCount = t["talk_count"].asInteger()?.toInt() ?: return null,
                    rank = t["rank"].asInteger()?.toInt() ?: return null,
                    aliases = t["aliases"].asStringList() ?: return null,
                )
            } ?: return null
            val facets = o["facets"].asArray()?.map { e ->
                val f = e.asObject() ?: return null
                Facet(
                    kind = f["kind"].asString()?.takeIf { it in FACET_KINDS } ?: return null,
                    value = f["value"].asString() ?: return null,
                    label = f["label"].asString() ?: return null,
                    group = f["group"].let { if (it is JsonNull) null else it.asString() ?: return null },
                    keys = f["keys"].asStringList() ?: return null,
                    words = f["words"].asString() ?: return null,
                    talks = f["talks"].asInteger()?.toInt() ?: return null,
                )
            } ?: return null
            val related = o["related"].asObject()?.mapValues { (_, v) -> v.asStringList() ?: return null } ?: return null
            val vectors = vectorBytes?.let { bytes ->
                val v = o["vectors"].asObject() ?: return null
                val rows = v["rows"].asStringList() ?: return null
                val dims = v["dims"].asInteger()?.toInt() ?: return null
                if (dims != TalkVectors.DIMS || bytes.size != rows.size * dims) return null
                TalkVectors(rows, bytes, dims)
            }
            return TalkBundle(contentHash, conference, attribution, talks, topics, facets, related, vectors)
        }

        // A required field that holds a string or null. Missing or of another type reads as Kotlin
        // null, which the callers turn into "malformed"; a JSON null reads as NULL_MARKER, which
        // orNullMarker() turns back into null once the whole object has been read.
        private const val NULL_MARKER = "\u0000null"

        private fun String?.orNullMarker(): String? = if (this == NULL_MARKER) null else this

        private fun nullable(o: JsonObject, key: String, pattern: Regex? = null): String? {
            val v = o[key] ?: return null
            if (v is JsonNull) return NULL_MARKER
            return v.asString()?.takeIf { pattern == null || pattern.containsMatchIn(it) }
        }

        private fun talk(e: JsonElement): Talk? {
            val t = e.asObject() ?: return null
            val start = t["start"].asString() ?: return null
            val end = t["end"].asString() ?: return null
            val day = t["day"].asString()?.takeIf { IsoTime.isDate(it) } ?: return null
            val tags = t["tags"].asArray()?.map { g ->
                val tag = g.asObject() ?: return null
                Talk.Tag(tag["group"].asString() ?: return null, tag["value"].asString() ?: return null)
            } ?: return null
            if (!t["sponsor"].isBoolean() || !t["has_slides"].isBoolean()) return null
            return Talk(
                talkId = t["talk_id"].asString() ?: return null,
                kind = t["kind"].asString()?.takeIf { it in KINDS } ?: return null,
                title = t["title"].asString() ?: return null,
                abstract = t["abstract"].asString() ?: return null,
                speakers = t["speakers"].asStringList() ?: return null,
                speakerTaglines = t["speaker_taglines"].asArray()?.map { s ->
                    if (s is JsonNull) null else s.asString() ?: return null
                } ?: return null,
                room = nullable(t, "room") ?: return null,
                track = nullable(t, "track") ?: return null,
                level = nullable(t, "level") ?: return null,
                tags = tags,
                sponsor = t["sponsor"].isTrue(),
                hasSlides = t["has_slides"].isTrue(),
                slidesUrl = nullable(t, "slides_url", HTTP_URL) ?: return null,
                url = nullable(t, "url", HTTP_URL) ?: return null,
                start = start,
                end = end,
                day = day,
                startMinutes = t["start_minutes"].asInteger()?.takeIf { it in 0..2880 }?.toInt() ?: return null,
                endMinutes = t["end_minutes"].asInteger()?.takeIf { it in 0..2880 }?.toInt() ?: return null,
                topics = t["topics"].asStringList() ?: return null,
                startEpochMs = IsoTime.epochMillis(start) ?: return null,
                endEpochMs = IsoTime.epochMillis(end) ?: return null,
            ).let {
                it.copy(
                    room = it.room.orNullMarker(),
                    track = it.track.orNullMarker(),
                    level = it.level.orNullMarker(),
                    slidesUrl = it.slidesUrl.orNullMarker(),
                    url = it.url.orNullMarker(),
                )
            }
        }
    }
}
