package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.IsoTime
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.plus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The Interested lists the Capacitor app (v0.3.0 and earlier, the same application id) kept in its
 * WebView's local storage, under `caddie.interested.v1.<slug>` (web/src/lib/storage.ts), read into
 * marks the native app keeps, once, when the native app is installed over it.
 *
 * Everything read is untrusted and bounded: a key must name a bundle slug, a value is read with
 * [BoundedJson] and must be at most [MAX_VALUE_CHARS] long, an entry must pass the web's own check
 * (`isInterested()`: a talk id of this conference, a title, a start, an end, a URL, speakers and
 * tags) and only http(s) URLs are kept, and at most [MAX_TALKS] talks are read per conference. A
 * copy of the talk's public fields is kept with each mark, as a mark made in the app keeps one,
 * when its times carry the conference's local offset as the bundles write them.
 */
object LegacyInterested {
    const val PREFIX = "caddie.interested.v1."
    const val MAX_VALUE_CHARS = 2_000_000
    const val MAX_TALKS = 2_000

    private val SLUG = Regex("^[a-z0-9][a-z0-9-]{0,119}$")
    private val LOCAL_TIME = Regex("""^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?[+-]\d{2}:\d{2}$""")
    private val HTTP_URL = Regex("^[Hh][Tt][Tt][Pp][Ss]?://")

    /** One mark: its talk id, and the copy of the talk when its fields allow one. */
    data class Mark(val talkId: String, val copy: InterestedTalk?)

    /** The conference slug a storage key names, or null when it is not one of the lists. */
    fun slugOf(key: String): String? = key.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX)?.takeIf { SLUG.matches(it) }

    /** The marks a stored list holds, in the order they were marked (the web's `marked_at`, then the list's order). */
    fun read(slug: String, value: String): List<Mark> {
        if (value.length > MAX_VALUE_CHARS || !SLUG.matches(slug)) return emptyList()
        val list = BoundedJson().parse(value) as? JsonArray ?: return emptyList()
        val seen = HashSet<String>()
        val marks = ArrayList<Pair<String, Mark>>()
        for (e in list) {
            if (marks.size >= MAX_TALKS) break
            val o = e as? JsonObject ?: continue
            val id = o.string("talk_id") ?: continue
            if (!id.startsWith("$slug:") || id.length > 300 || !seen.add(id)) continue
            if (o.string("conference") != slug) continue
            val title = o.string("title") ?: continue
            val start = o.string("start") ?: continue
            val end = o.string("end") ?: continue
            val url = o.string("url") ?: continue
            val speakers = (o["speakers"] as? JsonArray)?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return@map null } ?: continue
            if (o["tags"] !is JsonArray || speakers.any { it == null }) continue
            val markedAt = o.string("marked_at") ?: ""
            marks += markedAt to Mark(id, copy(id, title, speakers.filterNotNull(), o, start, end, url))
        }
        // Stable: entries with the same (or no) time keep the list's order.
        return marks.sortedBy { it.first }.map { it.second }
    }

    private fun copy(id: String, title: String, speakers: List<String>, o: JsonObject, start: String, end: String, url: String): InterestedTalk? {
        val s = LOCAL_TIME.matchEntire(start) ?: return null
        val e = LOCAL_TIME.matchEntire(end) ?: return null
        val startMs = IsoTime.epochMillis(start) ?: return null
        val endMs = IsoTime.epochMillis(end) ?: return null
        if (endMs < startMs || endMs - startMs > 2L * 24 * 60 * 60 * 1000) return null
        val day = s.groupValues[1]
        val startMinutes = s.groupValues[2].toInt() * 60 + s.groupValues[3].toInt()
        // A talk past midnight ends on the next local day: its end minutes count from the start's day.
        // An end on any other day than the start's or the next is not a talk's.
        val endDay = e.groupValues[1]
        val nextDay = runCatching { LocalDate.parse(day).plus(1, DateTimeUnit.DAY).toString() }.getOrNull() ?: return null
        if (endDay != day && endDay != nextDay) return null
        val endMinutes = e.groupValues[2].toInt() * 60 + e.groupValues[3].toInt() + if (endDay == day) 0 else 1440
        if (startMinutes >= 1440 || endMinutes > 2880) return null
        return InterestedTalk(
            talkId = id,
            kind = "talk",
            title = title.take(1_000),
            speakers = speakers.take(100).map { it.take(300) },
            room = o.string("room")?.take(300),
            track = o.string("track")?.take(300),
            url = url.takeIf { HTTP_URL.containsMatchIn(it) },
            slidesUrl = o.string("slides_url")?.takeIf { HTTP_URL.containsMatchIn(it) },
            start = start,
            end = end,
            day = day,
            startMinutes = startMinutes,
            endMinutes = endMinutes,
        )
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
