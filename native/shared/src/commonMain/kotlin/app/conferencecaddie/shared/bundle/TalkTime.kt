package app.conferencecaddie.shared.bundle

/**
 * Dates and times as the web app writes them (web/src/lib/time.ts, US English), always in the
 * conference's own time zone. A bundle gives every talk its local day and minutes after local
 * midnight, and its start with the local offset, so no time zone database is needed here.
 */
object TalkTime {
    private val WEEKDAYS_SHORT = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val WEEKDAYS_LONG = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
    private val MONTHS_SHORT = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val MONTHS_LONG = listOf(
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
    )

    /** "Tue, Nov 10" for a `YYYY-MM-DD` day. */
    fun day(day: String): String {
        val wd = IsoTime.weekday(day) ?: return day
        return "${WEEKDAYS_SHORT[wd]}, ${MONTHS_SHORT[day.substring(5, 7).toInt() - 1]} ${day.substring(8, 10).toInt()}"
    }

    /** "Tuesday, November 10". */
    fun dayLong(day: String): String {
        val wd = IsoTime.weekday(day) ?: return day
        return "${WEEKDAYS_LONG[wd]}, ${MONTHS_LONG[day.substring(5, 7).toInt() - 1]} ${day.substring(8, 10).toInt()}"
    }

    /** "Nov 9–12, 2026", "Nov 30 – Dec 2, 2026" or "Mar 2, 2099" for a conference's dates. */
    fun dateRange(start: String, end: String): String {
        if (!IsoTime.isDate(start) || !IsoTime.isDate(end)) return start
        val year = end.substring(0, 4)
        val a = "${MONTHS_SHORT[start.substring(5, 7).toInt() - 1]} ${start.substring(8, 10).toInt()}"
        if (start == end) return "$a, $year"
        val b = "${MONTHS_SHORT[end.substring(5, 7).toInt() - 1]} ${end.substring(8, 10).toInt()}"
        if (start.substring(0, 7) == end.substring(0, 7)) return "$a–${b.substringAfter(' ')}, $year"
        return "$a – $b, $year"
    }

    /** "9:00–9:30 AM" or "11:30 AM–12:15 PM" from minutes after local midnight. */
    fun timeRange(startMinutes: Int, endMinutes: Int): String {
        val (a, ap) = clock(startMinutes)
        val (b, bp) = clock(endMinutes)
        return if (ap == bp) "$a–$b $bp" else "$a $ap–$b $bp"
    }

    /** "9:00 AM". */
    fun time(minutes: Int): String = clock(minutes).let { "${it.first} ${it.second}" }

    /**
     * The short zone name the web shows (Intl's `timeZoneName: 'short'` in US English): the US
     * abbreviations for US zones, otherwise "GMT", "GMT+1" or "GMT+5:30", from the offset the talk's
     * start carries.
     */
    fun zoneLabel(timeZone: String?, startIso: String): String {
        if (timeZone == "UTC" || timeZone == "Etc/UTC") return "UTC"
        val offset = offsetMinutes(startIso) ?: return timeZone ?: "UTC"
        US_ZONES[timeZone]?.let { (standard, daylight, standardOffset) ->
            return if (offset == standardOffset || daylight == null) standard else daylight
        }
        if (offset == 0) return "GMT"
        val sign = if (offset < 0) "-" else "+"
        val h = kotlin.math.abs(offset) / 60
        val m = kotlin.math.abs(offset) % 60
        return if (m == 0) "GMT$sign$h" else "GMT$sign$h:${m.toString().padStart(2, '0')}"
    }

    /** "Tue, Nov 10 · 9:00–9:30 AM EST". */
    fun `when`(talk: Talk, timeZone: String?): String =
        "${day(talk.day)} · ${timeRange(talk.startMinutes, talk.endMinutes)} ${zoneLabel(timeZone, talk.start)}"

    /** True once the talk's end has passed. */
    fun hasEnded(talk: Talk, nowMs: Long): Boolean = talk.endEpochMs <= nowMs

    private fun clock(minutes: Int): Pair<String, String> {
        val m = ((minutes % 1440) + 1440) % 1440
        val h = m / 60
        val period = if (h < 12) "AM" else "PM"
        val hour = if (h % 12 == 0) 12 else h % 12
        return "$hour:${(m % 60).toString().padStart(2, '0')}" to period
    }

    private fun offsetMinutes(iso: String): Int? {
        val m = Regex("""([Zz]|([+-])(\d{2}):(\d{2}))$""").find(iso) ?: return null
        if (m.groupValues[1].equals("Z", ignoreCase = true)) return 0
        val sign = if (m.groupValues[2] == "-") -1 else 1
        return sign * (m.groupValues[3].toInt() * 60 + m.groupValues[4].toInt())
    }

    // US zones and their abbreviations: standard, daylight (null when the zone has none) and the
    // standard offset in minutes.
    private val US_ZONES: Map<String, Triple<String, String?, Int>> = mapOf(
        "America/New_York" to Triple("EST", "EDT", -300),
        "America/Detroit" to Triple("EST", "EDT", -300),
        "America/Indiana/Indianapolis" to Triple("EST", "EDT", -300),
        "America/Chicago" to Triple("CST", "CDT", -360),
        "America/Denver" to Triple("MST", "MDT", -420),
        "America/Phoenix" to Triple("MST", null, -420),
        "America/Los_Angeles" to Triple("PST", "PDT", -480),
        "America/Anchorage" to Triple("AKST", "AKDT", -540),
        "Pacific/Honolulu" to Triple("HST", null, -600),
    )
}
