package app.conferencecaddie.shared.importer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Clock
import kotlin.time.Instant

// The year of a schedule date written without one ("November 9"): the conference's start year, and
// only when the bundle has no start date the year of the clock, which the parser takes as an input
// rather than reading the system clock.
class ScheduleParserYearTest {
    private class FixedClock(private val at: Instant) : Clock {
        override fun now(): Instant = at
    }

    private val clock = FixedClock(Instant.parse("2031-06-01T00:00:00Z"))
    private val text = "November 9\n9:00 AM - 10:00 AM\nKubernetes scheduling deep dive\nSpeakers: Ada Lovelace\n"

    @Test
    fun aDateWithoutAYearTakesTheConferenceStartYear() {
        val entries = ScheduleParser.textEntries(text, ImportConference("x", "2026-11-09", "UTC"), clock)
        assertEquals(listOf(ImportTime.localToMs(2026, 11, 9, 9 * 60, "UTC")), entries.map { it.hintMs })
    }

    @Test
    fun withoutAStartDateTheYearComesFromTheClockGiven() {
        val entries = ScheduleParser.textEntries(text, ImportConference("x", null, "UTC"), clock)
        assertEquals(listOf(ImportTime.localToMs(2031, 11, 9, 9 * 60, "UTC")), entries.map { it.hintMs })
    }
}
