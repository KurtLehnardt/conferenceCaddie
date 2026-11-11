package app.conferencecaddie.shared.bundle

/**
 * The date and date-time formats the contract schemas assert (contracts/js/validate.mjs, FORMATS),
 * with conversions done in plain calendar arithmetic so they behave the same on every platform.
 */
object IsoTime {
    private val DATE = Regex("""^(\d{4})-(\d{2})-(\d{2})$""")
    private val DATE_TIME = Regex("""^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$""")

    /** True for a valid calendar date written `YYYY-MM-DD`. */
    fun isDate(s: String): Boolean {
        val m = DATE.matchEntire(s) ?: return false
        return validDate(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt())
    }

    /**
     * The instant an RFC 3339 date-time names, in milliseconds since the epoch, or null when [s] is
     * not one. Fractions of a second are truncated to milliseconds.
     */
    fun epochMillis(s: String): Long? {
        val m = DATE_TIME.matchEntire(s) ?: return null
        val g = m.groupValues
        val y = g[1].toInt()
        val mo = g[2].toInt()
        val d = g[3].toInt()
        val h = g[4].toInt()
        val mi = g[5].toInt()
        val se = g[6].toInt()
        if (!validDate(y, mo, d) || h >= 24 || mi >= 60 || se >= 60) return null
        val fraction = g[7].takeIf { it.isNotEmpty() }?.drop(1)?.padEnd(3, '0')?.take(3)?.toLong() ?: 0L
        val offsetMinutes = when (val z = g[8]) {
            "Z", "z" -> 0
            else -> {
                val sign = if (z[0] == '-') -1 else 1
                val oh = z.substring(1, 3).toInt()
                val om = z.substring(4, 6).toInt()
                if (oh >= 24 || om >= 60) return null
                sign * (oh * 60 + om)
            }
        }
        val days = daysFromCivil(y, mo, d)
        val seconds = days * 86_400L + h * 3_600L + mi * 60L + se - offsetMinutes * 60L
        return seconds * 1_000L + fraction
    }

    /** The date [n] days after [date] (`YYYY-MM-DD`), or null when [date] is not a date. */
    fun addDays(date: String, n: Int): String? {
        if (!isDate(date)) return null
        val days = daysFromCivil(date.substring(0, 4).toInt(), date.substring(5, 7).toInt(), date.substring(8, 10).toInt()) + n
        return civilFromDays(days)
    }

    /** The weekday of [date], 0 for Sunday to 6 for Saturday (JavaScript's getUTCDay), or null. */
    fun weekday(date: String): Int? {
        if (!isDate(date)) return null
        val days = daysFromCivil(date.substring(0, 4).toInt(), date.substring(5, 7).toInt(), date.substring(8, 10).toInt())
        // 1970-01-01 was a Thursday (4).
        return (((days % 7) + 7 + 4) % 7).toInt()
    }

    internal fun validDate(y: Int, m: Int, d: Int): Boolean {
        if (m < 1 || m > 12 || d < 1) return false
        val leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        val days = intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
        return d <= days[m - 1]
    }

    // Howard Hinnant's days_from_civil: days since 1970-01-01 of a proleptic Gregorian date.
    private fun daysFromCivil(year: Int, month: Int, day: Int): Long {
        val y = (if (month <= 2) year - 1 else year).toLong()
        val era = (if (y >= 0) y else y - 399) / 400
        val yoe = y - era * 400
        val mp = (month + 9) % 12
        val doy = (153 * mp + 2) / 5 + day - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    private fun civilFromDays(z0: Long): String {
        val z = z0 + 719_468
        val era = (if (z >= 0) z else z - 146_096) / 146_097
        val doe = z - era * 146_097
        val yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = doy - (153 * mp + 2) / 5 + 1
        val m = if (mp < 10) mp + 3 else mp - 9
        val y = yoe + era * 400 + if (m <= 2) 1 else 0
        return "${y.toString().padStart(4, '0')}-${m.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}"
    }
}
