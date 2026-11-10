package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.asArray
import app.conferencecaddie.shared.asInteger
import app.conferencecaddie.shared.asObject
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.isBoolean
import app.conferencecaddie.shared.isNullOrMissing
import app.conferencecaddie.shared.isStringArray
import app.conferencecaddie.shared.isTrue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** A conference as `GET /api/conferences` and `conferences.json` describe it. */
data class Conference(
    val slug: String,
    val name: String,
    val startDate: String?,
    val endDate: String?,
    val timeZone: String?,
    val location: Location,
    val status: String,
    val officialScheduleUrl: String?,
    val source: String,
    val hasLevel: Boolean,
    val trackGroup: String?,
    val tagGroups: List<String>,
    val talkCount: Int,
) {
    data class Location(val city: String, val region: String, val country: String, val virtual: Boolean)

    val searchable: Boolean get() = status == "searchable"

    companion object {
        private val SLUG = Regex("^[a-z0-9][a-z0-9-]{0,119}$")
        private val HTTP_URL = Regex("^[Hh][Tt][Tt][Pp][Ss]?://")

        /**
         * Reads [element] if it fits the schema's `Conference` definition
         * (contracts/schema/conferences-index.v1.schema.json) in open mode, else null.
         */
        fun read(element: JsonElement?): Conference? {
            val o = element.asObject() ?: return null
            val slug = o["slug"].asString()?.takeIf { SLUG.matches(it) } ?: return null
            val name = o["name"].asString() ?: return null
            val start = nullableDate(o, "start_date") ?: return null
            val end = nullableDate(o, "end_date") ?: return null
            val zone = nullableString(o, "time_zone") ?: return null
            val loc = o["location"].asObject() ?: return null
            val city = loc["city"].asString() ?: return null
            val region = loc["region"].asString() ?: return null
            val country = loc["country"].asString() ?: return null
            if (!loc["virtual"].isBoolean()) return null
            val status = o["status"].asString()?.takeIf { it == "searchable" || it == "unavailable" } ?: return null
            val url = nullableString(o, "official_schedule_url") ?: return null
            if (url.value != null && !HTTP_URL.containsMatchIn(url.value)) return null
            val source = o["source"].asString() ?: return null
            if (!o["has_level"].isBoolean()) return null
            val trackGroup = nullableString(o, "track_group") ?: return null
            if (!o["tag_groups"].isStringArray()) return null
            val talkCount = o["talk_count"].asInteger()?.takeIf { it in 0..Int.MAX_VALUE.toLong() } ?: return null
            return Conference(
                slug = slug,
                name = name,
                startDate = start.value,
                endDate = end.value,
                timeZone = zone.value,
                location = Location(city, region, country, loc["virtual"].isTrue()),
                status = status,
                officialScheduleUrl = url.value,
                source = source,
                hasLevel = o["has_level"].isTrue(),
                trackGroup = trackGroup.value,
                tagGroups = o["tag_groups"].asArray()!!.map { it.asString()!! },
                talkCount = talkCount.toInt(),
            )
        }

        // A required field that holds a string or null. The outer null means "missing or wrong type".
        private class Nullable(val value: String?)

        private fun nullableString(o: JsonObject, key: String): Nullable? {
            if (!o.containsKey(key)) return null
            val v = o[key]
            if (v is JsonNull) return Nullable(null)
            return v.asString()?.let { Nullable(it) }
        }

        private fun nullableDate(o: JsonObject, key: String): Nullable? =
            nullableString(o, key)?.takeIf { it.value == null || IsoTime.isDate(it.value) }
    }
}

/** One file of a bundle as the index lists it. */
data class BundleFile(val bytes: Long, val sha256: String)

/** A conference's current bundle as `conferences.json` lists it. */
data class BundleEntry(
    val bundleVersion: Int,
    val contentHash: String,
    val path: String,
    val model: String?,
    val dims: Int?,
    val talkCount: Int?,
    val vectorCount: Int?,
    val files: Map<String, BundleFile>,
    /** The entry as it was published, for [BundleVerifier]. */
    val raw: JsonObject,
) {
    companion object {
        const val MODEL_ID = "BAAI/bge-small-en-v1.5"
        const val DIMS = 384
        val V1_FILES = listOf(BundleVerifier.BUNDLE_FILE, BundleVerifier.VECTOR_FILE)
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private val PATH = Regex("^[a-z0-9][a-z0-9-]{0,119}/[0-9a-f]{16}/$")

        /** Reads [element] if it fits the schema's `BundleEntry` definition, else null. */
        fun read(element: JsonElement?): BundleEntry? {
            val o = element.asObject() ?: return null
            val version = o["bundle_version"].asInteger()?.takeIf { it in 1..Int.MAX_VALUE.toLong() } ?: return null
            val hash = o["content_hash"].asString()?.takeIf { SHA256.matches(it) } ?: return null
            val path = o["path"].asString()?.takeIf { PATH.matches(it) } ?: return null
            val model = optional(o, "model") { it.asString() } ?: return null
            val dims = optional(o, "dims") { e -> e.asInteger()?.takeIf { it in 1..Int.MAX_VALUE.toLong() } } ?: return null
            val talkCount = optional(o, "talk_count") { e -> e.asInteger()?.takeIf { it in 0..Int.MAX_VALUE.toLong() } } ?: return null
            val vectorCount = optional(o, "vector_count") { e -> e.asInteger()?.takeIf { it in 0..Int.MAX_VALUE.toLong() } } ?: return null
            val filesObj = o["files"].asObject()?.takeIf { it.isNotEmpty() } ?: return null
            val files = filesObj.mapValues { (_, v) ->
                val f = v.asObject() ?: return null
                val bytes = f["bytes"].asInteger()?.takeIf { it >= 0 } ?: return null
                val sha = f["sha256"].asString()?.takeIf { SHA256.matches(it) } ?: return null
                BundleFile(bytes, sha)
            }
            if (version == 1L) {
                // The v1 rules: exactly bundle.json and vectors.i8, bge-small-en-v1.5 at 384 dimensions.
                if (model.value != MODEL_ID || dims.value != DIMS.toLong() || talkCount.value == null || vectorCount.value == null) return null
                if (files.keys != V1_FILES.toSet()) return null
            }
            return BundleEntry(
                bundleVersion = version.toInt(),
                contentHash = hash,
                path = path,
                model = model.value,
                dims = dims.value?.toInt(),
                talkCount = talkCount.value?.toInt(),
                vectorCount = vectorCount.value?.toInt(),
                files = files,
                raw = o,
            )
        }

        private class Optional<T>(val value: T?)

        // An optional field: absent is fine, present must parse. The outer null means "invalid".
        private fun <T> optional(o: JsonObject, key: String, read: (JsonElement) -> T?): Optional<T>? {
            val v = o[key] ?: return Optional(null)
            return read(v)?.let { Optional(it) }
        }
    }
}

/** What the app may do with a conference's bundle entry (`bundle_status` in the reference). */
enum class BundleStatus {
    /** A v1 bundle this app can use after verification. */
    Ok,

    /** No bundle: the conference is unavailable or its bundle is not built yet. */
    None,

    /** A later bundle_version: keep the bundle the app has and say the app needs an update. */
    Unsupported,

    /** A malformed entry: ignore it. */
    Invalid,
}

data class IndexedConference(val conference: Conference, val bundle: BundleEntry?, val bundleStatus: BundleStatus)

data class SkippedEntry(val position: Int, val slug: String?, val reason: String)

data class Publisher(val name: String, val takedown: String)

/**
 * A `conferences.json` read the way the contract asks (reference `readConferenceIndex()` in
 * contracts/js/bundle.mjs): each conference entry is checked on its own and a bad one is skipped,
 * so one malformed entry never hides the others.
 */
data class ConferenceIndex(
    val ok: Boolean,
    /** "update_app" or "invalid" when [ok] is false. */
    val reason: String?,
    val publisher: Publisher?,
    val conferences: List<IndexedConference>,
    val skipped: List<SkippedEntry>,
) {
    companion object {
        const val INDEX_VERSION = 1

        fun read(doc: JsonElement?): ConferenceIndex {
            val invalid = ConferenceIndex(false, "invalid", null, emptyList(), emptyList())
            val o = doc.asObject() ?: return invalid
            val list = o["conferences"].asArray() ?: return invalid
            val version = o["index_version"].asInteger()
            if (version != INDEX_VERSION.toLong()) {
                return invalid.copy(reason = if (version != null && version > INDEX_VERSION) "update_app" else "invalid")
            }
            val conferences = ArrayList<IndexedConference>()
            val skipped = ArrayList<SkippedEntry>()
            list.forEachIndexed { position, e ->
                val entry = e.asObject()
                if (entry == null) {
                    skipped += SkippedEntry(position, null, "not an object")
                    return@forEachIndexed
                }
                val conference = Conference.read(JsonObject(entry - "bundle"))
                if (conference == null) {
                    skipped += SkippedEntry(position, entry["slug"].asString(), "invalid conference entry")
                    return@forEachIndexed
                }
                val rawBundle = entry["bundle"]
                val bundle = if (rawBundle.isNullOrMissing()) null else BundleEntry.read(rawBundle)
                val status = when {
                    rawBundle.isNullOrMissing() -> BundleStatus.None
                    bundle == null -> BundleStatus.Invalid
                    bundle.bundleVersion != BundleVerifier.BUNDLE_VERSION -> BundleStatus.Unsupported
                    else -> BundleStatus.Ok
                }
                conferences += IndexedConference(conference, if (status == BundleStatus.Ok) bundle else null, status)
            }
            val publisher = o["publisher"].asObject()?.let { p ->
                val name = p["name"].asString()?.takeIf { it.isNotEmpty() }
                val takedown = p["takedown"].asString()?.takeIf { it.startsWith("https://") || it.startsWith("mailto:") }
                if (name != null && takedown != null) Publisher(name, takedown) else null
            }
            return ConferenceIndex(true, null, publisher, conferences, skipped)
        }
    }
}
