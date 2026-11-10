package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.asInteger
import app.conferencecaddie.shared.asObject
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.asStringList
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What the app keeps of a talk the person marked, next to its id, so My schedule can still show it
 * when a newer bundle drops or renames it. The web app keeps the same kind of copy in local storage
 * (`toInterested()` in web/src/lib/storage.ts); like the web's, it holds only public schedule
 * fields.
 */
data class InterestedTalk(
    val talkId: String,
    val kind: String,
    val title: String,
    val speakers: List<String>,
    val room: String?,
    val track: String?,
    val url: String?,
    val slidesUrl: String?,
    val start: String,
    val end: String,
    val day: String,
    val startMinutes: Int,
    val endMinutes: Int,
) {
    /**
     * The copy as a [Talk] the screens can draw. What the copy does not hold (the abstract, the
     * speakers' taglines, tags and topics) is empty. Null when the copy's times cannot be read.
     */
    fun toTalk(): Talk? {
        val startMs = IsoTime.epochMillis(start) ?: return null
        val endMs = IsoTime.epochMillis(end) ?: return null
        return Talk(
            talkId = talkId,
            kind = kind,
            title = title,
            abstract = "",
            speakers = speakers,
            speakerTaglines = speakers.map { null },
            room = room,
            track = track,
            level = null,
            tags = emptyList(),
            sponsor = false,
            hasSlides = slidesUrl != null,
            slidesUrl = slidesUrl,
            url = url,
            start = start,
            end = end,
            day = day,
            startMinutes = startMinutes,
            endMinutes = endMinutes,
            topics = emptyList(),
            startEpochMs = startMs,
            endEpochMs = endMs,
        )
    }

    fun toJson(): String = buildJsonObject {
        put("talk_id", talkId)
        put("kind", kind)
        put("title", title)
        put("speakers", JsonArray(speakers.map { JsonPrimitive(it) }))
        put("room", room)
        put("track", track)
        put("url", url)
        put("slides_url", slidesUrl)
        put("start", start)
        put("end", end)
        put("day", day)
        put("start_minutes", startMinutes)
        put("end_minutes", endMinutes)
    }.toString()

    companion object {
        fun from(talk: Talk) = InterestedTalk(
            talkId = talk.talkId,
            kind = talk.kind,
            title = talk.title,
            speakers = talk.speakers,
            room = talk.room,
            track = talk.track,
            url = talk.url,
            slidesUrl = talk.slidesUrl,
            start = talk.start,
            end = talk.end,
            day = talk.day,
            startMinutes = talk.startMinutes,
            endMinutes = talk.endMinutes,
        )

        /** Reads a copy written by [toJson], or null when [text] is not one. */
        fun fromJson(text: String): InterestedTalk? = try {
            read(Json.parseToJsonElement(text))
        } catch (_: Exception) {
            null
        }

        private fun read(element: JsonElement): InterestedTalk? {
            val o = element.asObject() ?: return null
            return InterestedTalk(
                talkId = o["talk_id"].asString() ?: return null,
                kind = o["kind"].asString() ?: return null,
                title = o["title"].asString() ?: return null,
                speakers = o["speakers"].asStringList() ?: return null,
                room = o.optionalString("room"),
                track = o.optionalString("track"),
                url = o.optionalString("url"),
                slidesUrl = o.optionalString("slides_url"),
                start = o["start"].asString() ?: return null,
                end = o["end"].asString() ?: return null,
                day = o["day"].asString()?.takeIf { IsoTime.isDate(it) } ?: return null,
                startMinutes = o["start_minutes"].asInteger()?.toInt() ?: return null,
                endMinutes = o["end_minutes"].asInteger()?.toInt() ?: return null,
            )
        }

        private fun JsonObject.optionalString(key: String): String? = this[key].let { if (it == null || it is JsonNull) null else it.asString() }
    }
}
