package app.conferencecaddie.shared.people

import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant

/**
 * When a conference stops taking people writes, as the server decides it (server/people-shared.mjs,
 * `visibleUntil`): 23:59:59 on its last day in its own time zone. Without a time zone the server
 * takes the wall time as UTC and adds twelve hours, and so does this.
 */
object ConferenceWindow {
    /** The end of [endDate] (`YYYY-MM-DD`) in [timeZone], in epoch milliseconds, or null when [endDate] cannot be read. */
    fun visibleUntilMs(endDate: String?, timeZone: String?): Long? {
        val date = endDate?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return null
        val wall = LocalDateTime(date.year, date.month, date.day, 23, 59, 59)
        val zone = timeZone?.takeIf { it.isNotBlank() }?.let { runCatching { TimeZone.of(it) }.getOrNull() }
        return if (zone != null) {
            wall.toInstant(zone).toEpochMilliseconds()
        } else {
            wall.toInstant(TimeZone.UTC).toEpochMilliseconds() + 12 * 3_600_000L
        }
    }

    /**
     * True while [conference] still takes people writes at [nowMs]. A conference whose last day
     * cannot be read counts as live: the device cannot tell, and the server decides.
     */
    fun isLive(conference: ConferenceInfo, nowMs: Long): Boolean {
        val until = visibleUntilMs(conference.endDate, conference.timeZone) ?: return true
        return nowMs < until
    }
}
