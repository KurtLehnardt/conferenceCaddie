package app.conferencecaddie.ui.format

/**
 * Dates and times written as the web app writes them (web/src/lib/time.ts, en-US). Every value is
 * already local to the conference: a day is its "YYYY-MM-DD" date and a time is minutes after that
 * day's midnight, as the talk bundle stores them, so nothing here needs a time zone.
 */
object Format {
    private val WEEKDAYS_SHORT = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val WEEKDAYS_LONG = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
    private val MONTHS_SHORT = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val MONTHS_LONG = listOf(
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    )

    private class Ymd(val year: Int, val month: Int, val day: Int)

    private fun parse(date: String): Ymd? {
        val m = Regex("""^(\d{4})-(\d{2})-(\d{2})$""").matchEntire(date) ?: return null
        val (y, mo, d) = m.destructured
        val ymd = Ymd(y.toInt(), mo.toInt(), d.toInt())
        return if (ymd.month in 1..12 && ymd.day in 1..31) ymd else null
    }

    // 0 for Sunday, by Sakamoto's method.
    private fun weekday(d: Ymd): Int {
        val t = intArrayOf(0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4)
        val y = if (d.month < 3) d.year - 1 else d.year
        return (y + y / 4 - y / 100 + y / 400 + t[d.month - 1] + d.day) % 7
    }

    /** "Tue, Nov 10" (formatDay). */
    fun day(date: String): String {
        val d = parse(date) ?: return date
        return "${WEEKDAYS_SHORT[weekday(d)]}, ${MONTHS_SHORT[d.month - 1]} ${d.day}"
    }

    /** "Tuesday, November 10" (formatDayLong). */
    fun dayLong(date: String): String {
        val d = parse(date) ?: return date
        return "${WEEKDAYS_LONG[weekday(d)]}, ${MONTHS_LONG[d.month - 1]} ${d.day}"
    }

    /** "Nov 9–12, 2026", "Nov 30 – Dec 2, 2026" or "Mar 2, 2099" (formatDateRange). */
    fun dateRange(start: String, end: String): String {
        val a = parse(start) ?: return start
        val b = parse(end) ?: return end
        val first = "${MONTHS_SHORT[a.month - 1]} ${a.day}"
        if (start == end) return "$first, ${b.year}"
        if (a.year == b.year && a.month == b.month) return "$first–${b.day}, ${b.year}"
        return "$first – ${MONTHS_SHORT[b.month - 1]} ${b.day}, ${b.year}"
    }

    private fun clock(minutes: Int): Pair<String, String> {
        val m = ((minutes % 1440) + 1440) % 1440
        val h = m / 60
        val period = if (h < 12) "AM" else "PM"
        val h12 = if (h % 12 == 0) 12 else h % 12
        return "$h12:${(m % 60).toString().padStart(2, '0')}" to period
    }

    /** "9:00 AM" (formatTime). */
    fun time(minutes: Int): String = clock(minutes).let { "${it.first} ${it.second}" }

    /** "9:00–9:30 AM" or "11:30 AM–12:15 PM" (formatTimeRange). */
    fun timeRange(startMinutes: Int, endMinutes: Int): String {
        val (a, ap) = clock(startMinutes)
        val (b, bp) = clock(endMinutes)
        return if (ap == bp) "$a–$b $bp" else "$a $ap–$b $bp"
    }

    /** "Tue, Nov 10 · 9:00–9:30 AM CST" (formatWhen); [zoneLabel] is left out when null. */
    fun `when`(day: String, startMinutes: Int, endMinutes: Int, zoneLabel: String?): String =
        "${day(day)} · ${timeRange(startMinutes, endMinutes)}" + (zoneLabel?.let { " $it" } ?: "")

    /** "9 AM" (formatHour). */
    fun hour(hour: Int): String {
        val h = hour % 24
        return "${if (h % 12 == 0) 12 else h % 12} ${if (h < 12) "AM" else "PM"}"
    }

    /** The last two parts of a room such as "Salt Palace | Level 1 | Hall DE" (roomLabel). */
    fun room(room: String): String = room.split('|').map { it.trim() }.filter { it.isNotEmpty() }.takeLast(2).joinToString(" · ")
}
