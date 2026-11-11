package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.bundle.TalkBundle
import kotlin.math.ceil
import kotlin.math.max

/**
 * The words and pure helpers of the people features that the web app keeps in its logic files
 * (presence.ts, nudges.ts, connect.ts, sync.ts, util.tsx), word for word. Copy that the web keeps
 * in its screens stays with the screens.
 */
object PeopleText {
    // presence.ts

    const val PRESENCE_NOTICE =
        "While this is on, people you can see can also see that you're around and which zone you're in. How to spot you is shared only with someone you accept, only until you meet, and never stored after. Your exact position is shared only with someone you accept, only until you meet, and never stored after. It turns off by itself after an hour unless you choose to stay around for the day."

    const val POSITION_LABEL = "Use my position too (optional)"
    const val POSITION_EXPLAINER =
        "Ranks people near you higher and, once you've both agreed to meet, shows how far apart you are. Nobody else ever sees your position, and it's never stored after."

    /** The labels of the two presence modes. */
    val DURATION_LABELS: Map<PresenceMode, String> = mapOf(PresenceMode.Hour to "For an hour", PresenceMode.Day to "Until I turn it off today")

    /** presenceProblem(): the line for a failed presence write. */
    fun presenceProblem(error: PeopleError): String = when {
        error.code == "profile_required" || error.code == "no_device" -> "Make your profile visible first."
        // The profile changed while the server wrote presence: the same tap works a moment later.
        error.status == 409 -> "That did not go through. Try again."
        else -> error.message
    }

    // nudges.ts

    const val NUDGE_SETTING_LABEL = "Nudge me when a strong match or someone I'm watching is around"

    /** The evidence is cut at a word boundary around this length, so the banner stays one thought. */
    const val EVIDENCE_MAX = 80

    /** The nudge for a specific match in my zone; the server's push says exactly this too. Never a name or a distance. */
    fun nudgeText(evidence: String, zone: String): String = "Someone who's worked on $evidence is in $zone right now"

    /** The nudge for someone on my watch list who is around. */
    fun watchText(name: String, zone: String): String = "$name is around in $zone now"

    /** Server text without its `<mark>` tags or entities, whitespace collapsed. */
    fun plainText(s: String): String =
        ENTITY.replace(s.replace(MARK, "")) { m ->
            when (m.groupValues[1].lowercase()) {
                "amp" -> "&"
                "lt" -> "<"
                "gt" -> ">"
                "quot" -> "\""
                "apos" -> "'"
                "nbsp" -> " "
                else -> m.value
            }
        }.replace(SPACES, " ").trim()

    /** The evidence shortened at a word boundary, else the first speak topic; no name, no distance. */
    fun evidenceFor(p: Person): String? {
        // A trailing full stop would land mid-sentence in the banner, so it goes.
        val text = p.evidence?.let { plainText(it).replace(TRAILING_PUNCTUATION, "") } ?: ""
        if (text.isNotEmpty()) {
            if (text.length <= EVIDENCE_MAX) return text
            val cut = text.take(EVIDENCE_MAX + 1).replace(LAST_WORD, "").trim()
            return "${cut.ifEmpty { text.take(EVIDENCE_MAX).trim() }}…"
        }
        return p.speakTopics.firstOrNull()?.label
    }

    // connect.ts, PersonCard.tsx and AskSheet.tsx: the notes an ask carries

    /** The longest note an ask may carry. */
    const val NOTE_MAX = 140

    /** The note of a Wave, a one-tap ask to someone in my zone. */
    fun waveNote(zone: String): String = "I'm in $zone too — want to talk shop?".take(NOTE_MAX)

    /** The prefilled note of "Ask to talk shop" and the topic it names, if the subject is a topic rather than a passage. */
    fun askPrefill(person: Person): Pair<String, String?> {
        val lead = "I'd like to compare notes on "
        val evidence = person.evidence?.let { plainText(it) } ?: ""
        if (evidence.isNotEmpty()) {
            val room = NOTE_MAX - lead.length
            val subject = if (evidence.length > room) "${evidence.take(room - 1).replace(LAST_WORD, "")}…" else evidence
            return "$lead$subject" to null
        }
        val topic = person.speakTopics.firstOrNull() ?: person.learnTopics.firstOrNull()
        if (topic != null) return "$lead${topic.label}".take(NOTE_MAX) to topic.topicId
        return "${lead}what you're working on" to null
    }

    const val BLOCK_BODY =
        "You won't see each other in matches, talk circles or requests, and neither of you can ask the other to talk shop. They are not told."

    // push.ts, as far as it applies to native push

    const val PUSH_LABEL = "Nudge me even when the app is closed"
    const val PUSH_NOTICE =
        "Nudges tell you when someone whose experience matches yours is in your zone. They never say who until you open the app, and you get at most a few an hour."

    // util.tsx

    const val SHARE_NOTICE =
        "Sharing stores your profile on our server until the conference ends. Only people who also shared for this talk can see it, including How to reach me. Everyone else sees only the count. It does not make you visible conference-wide. Turn it off at any time to remove it."

    fun peopleCountLabel(n: Int): String = if (n == 1) "1 person wants to talk about this" else "$n people want to talk about this"

    /** Minutes left until [untilMs], rounded up, or 0. */
    fun minutesLeft(untilMs: Long?, nowMs: Long): Int =
        if (untilMs == null) 0 else max(0, ceil((untilMs - nowMs) / 60_000.0).toInt())

    private val MARK = Regex("</?mark>")
    private val ENTITY = Regex("&(amp|lt|gt|quot|apos|nbsp|#\\d+|#x[0-9a-f]+);", RegexOption.IGNORE_CASE)
    private val SPACES = Regex("\\s+")
    private val TRAILING_PUNCTUATION = Regex("[.;,:]+$")
    private val LAST_WORD = Regex("\\s+\\S*$")
}

/** The zones of a conference (presence.ts `zonesFor`, server/people.mjs `FIXED_ZONES`). */
object PeopleZones {
    /** Zones every conference has, in the server's order, after its room names. */
    val FIXED: List<String> = listOf("Expo hall", "Registration", "Food and coffee", "Hallway", "Outside")

    /**
     * The conference's zones: the room names of its talks in the installed bundle (the rooms the
     * server reads from its `kind: talk` documents), deduplicated without regard to case, sorted,
     * then the fixed zones. Without a bundle, only the fixed zones.
     */
    fun forBundle(bundle: TalkBundle?): List<String> = forRooms(bundle?.talks?.filter { it.isTalk }?.map { it.room } ?: emptyList())

    /** [forBundle] from a list of room names. */
    fun forRooms(rooms: List<String?>): List<String> {
        val seen = HashSet<String>()
        val names = ArrayList<String>()
        for (r in rooms) {
            val name = (r ?: "").trim()
            if (name.isEmpty() || !seen.add(name.lowercase())) continue
            names += name
        }
        val fixedLower = FIXED.map { it.lowercase() }.toSet()
        return names.filter { it.lowercase() !in fixedLower }.sortedWith(compareBy<String> { it.lowercase() }.thenBy { it }) + FIXED
    }

    /** The zone from [zones] that matches a deep-link value, ignoring case and encoding; else null. */
    fun match(zones: List<String>, raw: String): String? {
        val value = percentDecode(raw) ?: raw
        val key = value.replace(SEPARATORS, " ").trim().lowercase()
        if (key.isEmpty()) return null
        return zones.firstOrNull { it.lowercase() == key || it.replace(SEPARATORS, " ").lowercase() == key }
    }

    private val SEPARATORS = Regex("[-_+]+")

    private fun percentDecode(s: String): String? {
        val out = ArrayList<Byte>()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val b = s.substring(i + 1, i + 3).toIntOrNull(16) ?: return null
                out += b.toByte()
                i += 3
            } else {
                c.toString().encodeToByteArray().forEach { out += it }
                i++
            }
        }
        return out.toByteArray().decodeToString()
    }
}
