package app.conferencecaddie.shared.importer

import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.offsetAt

/**
 * Dates and times in schedule files (import-parse.js, "Dates and times"). A time hint is an exact
 * start instant in milliseconds; local times are read in the conference's own time zone, or in an
 * iCalendar event's `TZID`.
 *
 * The JavaScript patterns are matched by hand here (see [JsText] for why), trying the same
 * alternatives in the same order as the regular expression engine would, so the same text gives
 * the same time.
 */
internal object ImportTime {
    private val MONTHS = mapOf(
        "jan" to 1, "january" to 1, "feb" to 2, "february" to 2, "mar" to 3, "march" to 3, "apr" to 4, "april" to 4,
        "may" to 5, "jun" to 6, "june" to 6, "jul" to 7, "july" to 7, "aug" to 8, "august" to 8, "sep" to 9, "sept" to 9,
        "september" to 9, "oct" to 10, "october" to 10, "nov" to 11, "november" to 11, "dec" to 12, "december" to 12,
    )
    private val WEEKDAYS = setOf(
        "mon", "monday", "tue", "tues", "tuesday", "wed", "weds", "wednesday", "thu", "thur", "thurs", "thursday",
        "fri", "friday", "sat", "saturday", "sun", "sunday",
    )
    private val CONNECTORS = setOf("to", "at", "from", "until")
    private val ZONE_WORDS = setOf("mst", "mdt", "pst", "pdt", "est", "edt", "cst", "cdt", "utc", "gmt")

    // ---------------------------------------------------------------------------------------------
    // TIME = (?:\d{1,2}[:.]\d{2}(?:\s*[ap]\.?\s?m\.?)?|\d{1,2}\s*[ap]\.?\s?m\.?)(?![\p{L}\p{N}]) with
    // the i and u flags.

    /** The end of the TIME pattern matched at [i] of [s], or -1. */
    fun timeAt(s: String, i: Int): Int {
        var found = -1
        timeEnds(s, i) { end ->
            if (end >= s.length || !JsText.isWordChar(s[end])) {
                found = end
                true
            } else {
                false
            }
        }
        return found
    }

    // Calls [accept] with every end the pattern without its lookahead can reach from [i], in the
    // order the regular expression engine tries them, until [accept] returns true.
    private inline fun timeEnds(s: String, i: Int, accept: (Int) -> Boolean) {
        // First alternative: \d{1,2}[:.]\d{2} and an optional am/pm suffix, tried with it first.
        for (digits in digitCounts(s, i)) {
            val c = i + digits
            if (c + 2 < s.length && (s[c] == ':' || s[c] == '.') && JsText.isDigit(s[c + 1]) && JsText.isDigit(s[c + 2])) {
                val k = c + 3
                var done = false
                suffixEnds(s, k) { if (accept(it)) { done = true; true } else false }
                if (done) return
                if (accept(k)) return
            }
        }
        // Second alternative: \d{1,2} and a required am/pm suffix.
        for (digits in digitCounts(s, i)) {
            var done = false
            suffixEnds(s, i + digits) { if (accept(it)) { done = true; true } else false }
            if (done) return
        }
    }

    // \d{1,2}, greedy: 2 first when there are two digits, then 1.
    private fun digitCounts(s: String, i: Int): List<Int> = when {
        i >= s.length || !JsText.isDigit(s[i]) -> emptyList()
        i + 1 < s.length && JsText.isDigit(s[i + 1]) -> listOf(2, 1)
        else -> listOf(1)
    }

    // \s*[ap]\.?\s?m\.? from [k], greedy at every step.
    private inline fun suffixEnds(s: String, k: Int, accept: (Int) -> Boolean) {
        var run = 0
        while (k + run < s.length && JsText.isSpace(s[k + run])) run++
        for (sp in run downTo 0) {
            val p = k + sp
            if (p >= s.length || !(JsText.asciiEqualsIgnoreCase(s[p], 'a') || JsText.asciiEqualsIgnoreCase(s[p], 'p'))) continue
            val afterAp = p + 1
            for (dot in (if (afterAp < s.length && s[afterAp] == '.') intArrayOf(1, 0) else intArrayOf(0))) {
                val q = afterAp + dot
                for (space in (if (q < s.length && JsText.isSpace(s[q])) intArrayOf(1, 0) else intArrayOf(0))) {
                    val r = q + space
                    if (r >= s.length || !JsText.asciiEqualsIgnoreCase(s[r], 'm')) continue
                    val afterM = r + 1
                    if (afterM < s.length && s[afterM] == '.' && accept(afterM + 1)) return
                    if (accept(afterM)) return
                }
            }
        }
    }

    /** Every TIME match of [s], left to right, as `[start, end)` ranges (`s.match(ANY_TIME_RE)`). */
    fun allTimes(s: String): List<IntRange> {
        val out = ArrayList<IntRange>()
        var i = 0
        while (i < s.length) {
            val end = timeAt(s, i)
            if (end > i) {
                out += i until end
                i = end
            } else {
                i++
            }
        }
        return out
    }

    /**
     * LEAD_TIME_RE: `^(TIME)(?:\s*(?:-|–|—|to)\s*(TIME))?\s*` with the i and u flags. Returns the
     * length of the whole match and the first time, or null when [s] does not start with a time.
     */
    fun leadTime(s: String): Pair<Int, String>? {
        val e1 = timeAt(s, 0)
        if (e1 < 0) return null
        var end = e1
        // The optional range, greedy: \s* then a separator, \s*, and a second time.
        var run = 0
        while (e1 + run < s.length && JsText.isSpace(s[e1 + run])) run++
        range@ for (sp1 in run downTo 0) {
            val q = e1 + sp1
            for (sepLen in separatorLengths(s, q)) {
                val q2 = q + sepLen
                var run2 = 0
                while (q2 + run2 < s.length && JsText.isSpace(s[q2 + run2])) run2++
                for (sp2 in run2 downTo 0) {
                    val e2 = timeAt(s, q2 + sp2)
                    if (e2 >= 0) {
                        end = e2
                        break@range
                    }
                }
            }
        }
        while (end < s.length && JsText.isSpace(s[end])) end++
        return end to s.substring(0, e1)
    }

    // (?:-|–|—|to) at [q], in the alternation's order.
    private fun separatorLengths(s: String, q: Int): List<Int> {
        if (q >= s.length) return emptyList()
        return when {
            s[q] == '-' || s[q] == '–' || s[q] == '—' -> listOf(1)
            JsText.startsWithAsciiIgnoreCase(s, "to", q) -> listOf(2)
            else -> emptyList()
        }
    }

    /**
     * Minutes after midnight of a clock time such as "9:30", "9.30am", "2 pm" or "14:00"
     * (import-parse.js `clockMinutes`), or null.
     */
    fun clockMinutes(value: String?): Int? {
        val s = JsText.trim(value ?: "")
        var i = 0
        while (i < s.length && i < 2 && JsText.isDigit(s[i])) i++
        if (i == 0) return null
        var h = s.substring(0, i).toInt()
        var minute: Int? = null
        if (i + 2 < s.length && (s[i] == ':' || s[i] == '.') && JsText.isDigit(s[i + 1]) && JsText.isDigit(s[i + 2])) {
            minute = s.substring(i + 1, i + 3).toInt()
            i += 3
        }
        while (i < s.length && JsText.isSpace(s[i])) i++
        var period: Char? = null
        if (i < s.length && (JsText.asciiEqualsIgnoreCase(s[i], 'a') || JsText.asciiEqualsIgnoreCase(s[i], 'p'))) {
            val p = i + 1
            val ok = (if (p < s.length && s[p] == '.') intArrayOf(1, 0) else intArrayOf(0)).any { dot ->
                val q = p + dot
                (if (q < s.length && JsText.isSpace(s[q])) intArrayOf(1, 0) else intArrayOf(0)).any { space ->
                    val r = q + space
                    r < s.length && JsText.asciiEqualsIgnoreCase(s[r], 'm')
                }
            }
            if (ok) period = s[i].lowercaseChar()
        }
        if (minute == null && period == null) return null
        val min = minute ?: 0
        if (min > 59) return null
        if (period != null) {
            if (h < 1 || h > 12) return null
            h = (h % 12) + if (period == 'p') 12 else 0
        } else if (h > 23) {
            return null
        }
        return h * 60 + min
    }

    // ---------------------------------------------------------------------------------------------
    // Time zones.

    private fun zoneOf(name: String?): TimeZone? = try {
        if (name.isNullOrEmpty()) null else TimeZone.of(name)
    } catch (_: Exception) {
        null
    }

    /** True when [name] names a time zone this platform knows (`validZone`). */
    fun validZone(name: String?): Boolean = zoneOf(name) != null

    private fun offsetMs(ms: Long, zone: TimeZone): Long = zone.offsetAt(Instant.fromEpochMilliseconds(ms)).totalSeconds * 1000L

    /**
     * A local wall-clock time in [zone] as an instant in milliseconds (`localToIso`), or null. Days
     * past the end of a month roll over into the next, as `Date.UTC` does, and the offset is found
     * in two passes from the wall time, as there, so a time in a daylight-saving gap or overlap
     * resolves the same way.
     */
    fun localToMs(y: Int, mo: Int, d: Int, minutes: Int?, zone: String?): Long? {
        if (!(y in 2000..2099 && mo in 1..12 && d in 1..31) || minutes == null) return null
        val tz = zoneOf(zone) ?: return null
        val wall = (daysFromCivil(y, mo, 1) + (d - 1)) * 86_400_000L + minutes * 60_000L
        var utc = wall - offsetMs(wall, tz)
        utc = wall - offsetMs(utc, tz)
        return utc
    }

    /** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's days_from_civil). */
    fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    // ---------------------------------------------------------------------------------------------
    // Structured values (CSV cells, JSON fields).

    /**
     * A start value from a structured file (`structuredStart`): ISO 8601 with or without an offset,
     * or a date followed by a time (or a separate [timeValue]). At most 60 characters are read.
     */
    fun structuredStart(value: String?, zone: String?, timeValue: String? = null): Long? {
        if (value == null || value.length > 60) return null
        val v = JsText.trim(value)
        isoDateTime(v)?.let { iso ->
            // The pattern matched; Date.parse then refuses values out of range rather than reading on.
            if (iso.invalid) return null
            if (iso.offsetMinutes != null) {
                if (iso.mo !in 1..12 || iso.d !in 1..31 || iso.h > 24 || (iso.h == 24 && iso.mi != 0) || iso.mi > 59) return null
                return (daysFromCivil(iso.y, iso.mo, 1) + (iso.d - 1)) * 86_400_000L + (iso.h * 60 + iso.mi - iso.offsetMinutes) * 60_000L
            }
            return localToMs(iso.y, iso.mo, iso.d, iso.h * 60 + iso.mi, zone)
        }
        val date = looseDate(v) ?: return null
        val minutes = clockMinutes(timeValue ?: date.rest) ?: return null
        return localToMs(date.y, date.m, date.d, minutes, zone)
    }

    private class IsoParts(val y: Int, val mo: Int, val d: Int, val h: Int, val mi: Int, val offsetMinutes: Int?, val invalid: Boolean = false)

    // ISO_DT_RE: ^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$ (i).
    private fun isoDateTime(v: String): IsoParts? {
        fun digits(at: Int, n: Int) = at + n <= v.length && (at until at + n).all { JsText.isDigit(v[it]) }
        if (!digits(0, 4) || v.getOrNull(4) != '-' || !digits(5, 2) || v.getOrNull(7) != '-' || !digits(8, 2)) return null
        val t = v.getOrNull(10)
        if (t != 'T' && t != 't' && t != ' ') return null
        if (!digits(11, 2) || v.getOrNull(13) != ':' || !digits(14, 2)) return null
        var i = 16
        if (v.getOrNull(i) == ':' && digits(i + 1, 2)) {
            i += 3
            if (v.getOrNull(i) == '.' && v.getOrNull(i + 1)?.let { JsText.isDigit(it) } == true) {
                i += 1
                while (i < v.length && JsText.isDigit(v[i])) i++
            }
        }
        while (i < v.length && JsText.isSpace(v[i])) i++
        var offset: Int? = null
        if (i < v.length) {
            val z = v[i]
            when {
                (z == 'Z' || z == 'z') && i + 1 == v.length -> offset = 0
                (z == '+' || z == '-') && digits(i + 1, 2) -> {
                    var j = i + 3
                    if (v.getOrNull(j) == ':') j++
                    if (!digits(j, 2) || j + 2 != v.length) return null
                    val oh = v.substring(i + 1, i + 3).toInt()
                    val om = v.substring(j, j + 2).toInt()
                    // Date.parse refuses an offset of 24 hours or more, or of 60 minutes or more.
                    if (oh > 23 || om > 59) return IsoParts(0, 0, 0, 0, 0, null, invalid = true)
                    offset = (if (z == '-') -1 else 1) * (oh * 60 + om)
                }
                else -> return null
            }
        }
        val parts = IsoParts(
            v.substring(0, 4).toInt(), v.substring(5, 7).toInt(), v.substring(8, 10).toInt(),
            v.substring(11, 13).toInt(), v.substring(14, 16).toInt(), offset,
        )
        return parts
    }

    class LooseDate(val y: Int, val m: Int, val d: Int, val rest: String)

    /** "2026-11-10", "11/10/2026" (month first) or "Nov 10, 2026" at the start of a value (`looseDate`). */
    fun looseDate(v: String): LooseDate? {
        numericDate(v)?.let { return it }
        return namedMonthDate(v)
    }

    // ^(\d{4})-(\d{1,2})-(\d{1,2})\b\s*(.*)$ and ^(\d{1,2})\/(\d{1,2})\/(\d{4})\b\s*(.*)$.
    private fun numericDate(v: String): LooseDate? {
        fun run(at: Int): Int {
            var j = at
            while (j < v.length && JsText.isDigit(v[j])) j++
            return j - at
        }
        val a = run(0)
        if (a == 4 && v.getOrNull(4) == '-') {
            val b = run(5)
            if (b in 1..2 && v.getOrNull(5 + b) == '-') {
                val cAt = 6 + b
                val c = run(cAt)
                if (c in 1..2 && boundaryAfter(v, cAt + c)) {
                    val rest = restAfter(v, cAt + c)
                    if (rest != null) return LooseDate(v.substring(0, 4).toInt(), v.substring(5, 5 + b).toInt(), v.substring(cAt, cAt + c).toInt(), rest)
                }
            }
        }
        if (a in 1..2 && v.getOrNull(a) == '/') {
            val b = run(a + 1)
            if (b in 1..2 && v.getOrNull(a + 1 + b) == '/') {
                val yAt = a + 2 + b
                if (run(yAt) >= 4 && boundaryAfter(v, yAt + 4)) {
                    val rest = restAfter(v, yAt + 4)
                    if (rest != null) {
                        return LooseDate(v.substring(yAt, yAt + 4).toInt(), v.substring(0, a).toInt(), v.substring(a + 1, a + 1 + b).toInt(), rest)
                    }
                }
            }
        }
        return null
    }

    // \b after a word character at [at] - 1: the next character is not one.
    private fun boundaryAfter(v: String, at: Int): Boolean = at >= v.length || !JsText.isAsciiWord(v[at])

    // \s*(.*)$: the rest after white space, which must hold no line terminator.
    private fun restAfter(v: String, at: Int): String? {
        var i = at
        while (i < v.length && JsText.isSpace(v[i])) i++
        val rest = v.substring(i)
        return if (rest.any { JsText.isLineTerminator(it) }) null else rest
    }

    // ^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b\s*(.*)$ (i): the
    // optional weekday prefix is tried first, as the greedy group is.
    private fun namedMonthDate(v: String): LooseDate? {
        var p = 0
        while (p < v.length && JsText.isAsciiLetter(v[p])) p++
        if (p > 0) {
            var q = p
            if (v.getOrNull(q) == ',') q++
            var sp = 0
            while (q + sp < v.length && JsText.isSpace(v[q + sp])) sp++
            if (sp > 0) monthFrom(v, q + sp)?.let { return it.takeIf { d -> d.m > 0 } }
        }
        return monthFrom(v, 0)?.takeIf { it.m > 0 }
    }

    // ([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b\s*(.*)$ at [at]. A month word that is
    // not a month still matches (the caller then gives up, as looseDate does), so it returns m = 0.
    private fun monthFrom(v: String, at: Int): LooseDate? {
        var i = at
        while (i < v.length && JsText.isAsciiLetter(v[i])) i++
        val len = i - at
        if (len !in 3..9) return null
        val word = v.substring(at, i)
        if (v.getOrNull(i) == '.') i++
        var sp = 0
        while (i + sp < v.length && JsText.isSpace(v[i + sp])) sp++
        if (sp == 0) return null
        i += sp
        val dayAt = i
        while (i < v.length && JsText.isDigit(v[i])) i++
        val dayLen = i - dayAt
        if (dayLen !in 1..2) return null
        val day = v.substring(dayAt, i).toInt()
        for (suffix in listOf("st", "nd", "rd", "th")) {
            if (JsText.startsWithAsciiIgnoreCase(v, suffix, i)) {
                val after = i + 2
                val next = v.getOrNull(after)
                if (next == ',' || (next != null && JsText.isSpace(next))) i = after
                break
            }
        }
        if (v.getOrNull(i) == ',') i++
        sp = 0
        while (i + sp < v.length && JsText.isSpace(v[i + sp])) sp++
        if (sp == 0) return null
        i += sp
        if (!(i + 4 <= v.length && (i until i + 4).all { JsText.isDigit(v[it]) }) || !boundaryAfter(v, i + 4)) return null
        val year = v.substring(i, i + 4).toInt()
        val rest = restAfter(v, i + 4) ?: return null
        return LooseDate(year, MONTHS[word.lowercase()] ?: 0, day, rest)
    }

    // ---------------------------------------------------------------------------------------------
    // Lines of free text.

    class DateTimeLine(val date: Triple<Int, Int, Int>?, val minutes: Int?)

    /**
     * A line that holds only a date and/or times, with weekday names and punctuation, such as
     * "MONDAY 10 • NOVEMBER", "Tue, Nov 10, 2026" or "10:30am – 11:00am" (`dateTimeLine`); null
     * for any other line.
     */
    fun dateTimeLine(line: String, defaultYear: Int): DateTimeLine? {
        val times = allTimes(line)
        val rest = buildString {
            var at = 0
            for (r in times) {
                append(line, at, r.first)
                append(' ')
                at = r.last + 1
            }
            append(line, at, line.length)
        }
        val iso = isoDateIn(rest)
        val withoutIso = if (iso == null) rest else rest.substring(0, iso.first) + " " + rest.substring(iso.last + 1)
        val tokens = JsText.lowerTokens(withoutIso)
        if (tokens.size > 6) return null
        var month: Int? = null
        var day: Int? = null
        var year: Int? = null
        for (t in tokens) {
            when {
                MONTHS[t] != null && month == null -> month = MONTHS[t]
                t in WEEKDAYS -> continue
                t.length == 4 && t.all { JsText.isDigit(it) } && year == null -> year = t.toInt()
                dayToken(t) && day == null -> day = t.takeWhile { JsText.isDigit(it) }.toInt()
                t in CONNECTORS || t in ZONE_WORDS -> continue
                else -> return null
            }
        }
        val date = when {
            iso != null -> Triple(rest.substring(iso.first, iso.first + 4).toInt(), rest.substring(iso.first + 5, iso.first + 7).toInt(), rest.substring(iso.first + 8, iso.first + 10).toInt())
            month != null && day != null && day != 0 -> Triple(year ?: defaultYear, month, day)
            else -> null
        }
        if (date == null && times.isEmpty()) return null
        if (date == null && tokens.any { it !in CONNECTORS && it !in ZONE_WORDS }) return null
        return DateTimeLine(date, if (times.isNotEmpty()) clockMinutes(line.substring(times[0].first, times[0].last + 1)) else null)
    }

    // /^\d{1,2}(st|nd|rd|th)?$/ on a lowercase token.
    private fun dayToken(t: String): Boolean {
        var i = 0
        while (i < t.length && JsText.isDigit(t[i])) i++
        if (i !in 1..2) return false
        val rest = t.substring(i)
        return rest.isEmpty() || rest == "st" || rest == "nd" || rest == "rd" || rest == "th"
    }

    // The first /\b\d{4}-\d{2}-\d{2}\b/ in [s], as a range of 10 characters.
    private fun isoDateIn(s: String): IntRange? {
        var i = 0
        while (i + 10 <= s.length) {
            val ok = (i == 0 || !JsText.isAsciiWord(s[i - 1])) &&
                (0 until 4).all { JsText.isDigit(s[i + it]) } && s[i + 4] == '-' &&
                JsText.isDigit(s[i + 5]) && JsText.isDigit(s[i + 6]) && s[i + 7] == '-' &&
                JsText.isDigit(s[i + 8]) && JsText.isDigit(s[i + 9]) && boundaryAfter(s, i + 10)
            if (ok) return i until i + 10
            i++
        }
        return null
    }
}
