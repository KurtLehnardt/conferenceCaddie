package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.IsoTime
import app.conferencecaddie.shared.bundle.Talk

/**
 * Time phrases in the search text, ported from server/phrases.mjs: "morning", "afternoon", "before
 * lunch", "after lunch", "day 1" to "day N" and weekday names. A fixed table maps each phrase to a
 * filter; a matched phrase leaves the search text and is shown as a removable chip.
 *
 * - morning: the talk starts before 12:00; afternoon: at 12:00 or later.
 * - day N: the Nth day from the conference's start_date, only while that date is no later than
 *   its end_date.
 * - A weekday name: every day with talks that falls on it, accepted only when such a day exists.
 * - before lunch, after lunch: lunch comes from the conference's own break items whose title
 *   contains "lunch", one window per day (earliest start to latest end). A talk is before lunch when
 *   it starts before that day's lunch begins, after lunch when it starts once it has ended. A day
 *   with no lunch matches neither, and a conference with no lunch item does not recognise them.
 * - Several day or weekday phrases are alternatives; every other phrase narrows the result.
 * - An ignored phrase (one the person removed) still leaves the text but filters nothing, and is
 *   reported with applied = false.
 */
object TimePhrases {
    const val NOON = 12 * 60

    private val WEEKDAYS = listOf("sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday")

    private val PHRASE = Regex(
        """\b(?:(?:in|on|during)\s+(?:the\s+)?)?(before\s+lunch|after\s+lunch|morning|afternoon|day\s*(\d{1,2})|""" +
            WEEKDAYS.joinToString("|") + """)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val LUNCH = Regex("""\blunch""", RegexOption.IGNORE_CASE)
    private val WHITESPACE = Regex("""\s+""")
    private val EDGES = Regex("""^[\s,;:.-]+|[\s,;:.-]+$""")

    /** One recognised phrase. [days] holds the dates a day or weekday phrase stands for. */
    data class Phrase(val key: String, val label: String, val days: List<String>, val applied: Boolean)

    data class LunchWindow(val start: Int, val end: Int)

    /** What the phrases need to know about a conference's schedule. */
    data class Shape(
        val startDate: String?,
        val endDate: String?,
        /** Days that have items of kind talk, sorted. */
        val talkDays: List<String>,
        /** Each day's lunch window, from the break items. */
        val lunch: Map<String, LunchWindow>,
    ) {
        companion object {
            fun of(startDate: String?, endDate: String?, talks: List<Talk>): Shape {
                val talkDays = talks.filter { it.kind == "talk" }.map { it.day }.distinct().sorted()
                val lunch = talks.filter { it.kind == "break" && LUNCH.containsMatchIn(it.title) }
                    .groupBy { it.day }
                    .mapValues { (_, items) -> LunchWindow(items.minOf { it.startMinutes }, items.maxOf { it.endMinutes }) }
                return Shape(startDate, endDate, talkDays, lunch)
            }
        }
    }

    /**
     * The filter the applied phrases stand for: every predicate must hold. Day and weekday phrases
     * are alternatives, so they become one predicate over [days].
     */
    class Filter internal constructor(private val predicates: List<(Talk) -> Boolean>) {
        fun matches(talk: Talk): Boolean = predicates.all { it(talk) }

        val isEmpty: Boolean get() = predicates.isEmpty()
    }

    data class Result(val text: String, val phrases: List<Phrase>, val filter: Filter)

    fun parse(text: String, shape: Shape, ignored: Set<String> = emptySet()): Result {
        val found = PHRASE.findAll(text).toList()
        if (found.isEmpty()) return Result(text, emptyList(), Filter(emptyList()))

        val start = shape.startDate?.takeIf { IsoTime.isDate(it) }
        val end = shape.endDate?.takeIf { IsoTime.isDate(it) } ?: start

        val phrases = LinkedHashMap<String, Phrase>()
        val cuts = ArrayList<IntRange>()
        for (m in found) {
            val word = m.groupValues[1].lowercase().replace(WHITESPACE, " ")
            val dayNumber = m.groups[2]?.value
            val phrase: Phrase? = when {
                word == "morning" -> Phrase("morning", "Morning", emptyList(), true)
                word == "afternoon" -> Phrase("afternoon", "Afternoon", emptyList(), true)
                word == "before lunch" || word == "after lunch" ->
                    if (shape.lunch.isNotEmpty()) Phrase(word.replace(' ', '-'), capitalize(word), emptyList(), true) else null
                dayNumber != null -> {
                    val n = dayNumber.toInt()
                    val date = if (start != null && n >= 1) IsoTime.addDays(start, n - 1) else null
                    if (date != null && end != null && date <= end) Phrase("day-$n", "Day $n", listOf(date), true) else null
                }
                else -> {
                    val days = shape.talkDays.filter { IsoTime.weekday(it) == WEEKDAYS.indexOf(word) }
                    if (days.isNotEmpty()) Phrase(word, capitalize(word), days, true) else null
                }
            }
            if (phrase == null) continue
            phrases.getOrPut(phrase.key) { phrase }
            cuts += m.range
        }

        val rest = StringBuilder()
        var at = 0
        for (cut in cuts) {
            rest.append(text, at, cut.first).append(' ')
            at = cut.last + 1
        }
        rest.append(text, at, text.length)
        val remaining = rest.toString().replace(WHITESPACE, " ").replace(EDGES, "")

        val list = phrases.values.map { it.copy(applied = it.key !in ignored) }
        val applied = list.filter { it.applied }
        val predicates = ArrayList<(Talk) -> Boolean>()
        for (p in applied) {
            when (p.key) {
                "morning" -> predicates += { t -> t.startMinutes < NOON }
                "afternoon" -> predicates += { t -> t.startMinutes >= NOON }
                "before-lunch" -> predicates += { t -> shape.lunch[t.day]?.let { t.startMinutes < it.start } == true }
                "after-lunch" -> predicates += { t -> shape.lunch[t.day]?.let { t.startMinutes >= it.end } == true }
            }
        }
        val days = applied.flatMap { it.days }.toSet()
        if (days.isNotEmpty()) predicates += { t -> t.day in days }
        return Result(remaining, list, Filter(predicates))
    }

    private fun capitalize(s: String): String = s.replaceFirstChar { it.uppercaseChar() }
}
