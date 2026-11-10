package app.conferencecaddie.shared.bundle

import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals

// The web app's formats (web/src/lib/time.ts), checked against what Intl prints in en-US.
class TalkTimeTest {
    @Test
    fun days() {
        assertEquals("Tue, Nov 10", TalkTime.day("2026-11-10"))
        assertEquals("Mon, Mar 2", TalkTime.day("2099-03-02"))
        assertEquals("Tuesday, November 10", TalkTime.dayLong("2026-11-10"))
        assertEquals("Nov 9–12, 2026", TalkTime.dateRange("2026-11-09", "2026-11-12"))
        assertEquals("Nov 30 – Dec 2, 2026", TalkTime.dateRange("2026-11-30", "2026-12-02"))
        assertEquals("Mar 2, 2099", TalkTime.dateRange("2099-03-02", "2099-03-02"))
    }

    @Test
    fun times() {
        assertEquals("9:00–9:30 AM", TalkTime.timeRange(540, 570))
        assertEquals("11:30 AM–12:15 PM", TalkTime.timeRange(690, 735))
        assertEquals("12:00–1:00 PM", TalkTime.timeRange(720, 780))
        assertEquals("11:30 PM–12:30 AM", TalkTime.timeRange(1410, 1470), "an end after midnight")
        assertEquals("12:05 AM", TalkTime.time(5))
    }

    @Test
    fun zones() {
        assertEquals("EST", TalkTime.zoneLabel("America/New_York", "2026-11-10T09:00:00-05:00"))
        assertEquals("EDT", TalkTime.zoneLabel("America/New_York", "2026-07-10T09:00:00-04:00"))
        assertEquals("GMT+1", TalkTime.zoneLabel("Europe/Amsterdam", "2099-03-02T10:00:00+01:00"))
        assertEquals("GMT+5:30", TalkTime.zoneLabel("Asia/Kolkata", "2026-12-01T10:00:00+05:30"))
        assertEquals("GMT", TalkTime.zoneLabel("Europe/London", "2026-12-01T10:00:00Z"))
        assertEquals("GMT+9", TalkTime.zoneLabel("Asia/Tokyo", "2026-12-01T10:00:00+09:00"))
        assertEquals("UTC", TalkTime.zoneLabel("UTC", "2026-12-01T10:00:00Z"), "Intl names UTC itself")
    }

    @Test
    fun zonesOutsideTheUnitedStatesThatUsEnglishAbbreviates() {
        // What `new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })` prints.
        assertEquals("EST", TalkTime.zoneLabel("America/Toronto", "2026-11-10T09:00:00-05:00"))
        assertEquals("EDT", TalkTime.zoneLabel("America/Toronto", "2026-07-10T09:00:00-04:00"))
        assertEquals("PST", TalkTime.zoneLabel("America/Vancouver", "2026-01-15T09:00:00-08:00"))
        assertEquals("PDT", TalkTime.zoneLabel("America/Vancouver", "2026-07-15T09:00:00-07:00"))
        assertEquals("AST", TalkTime.zoneLabel("America/Halifax", "2026-01-15T09:00:00-04:00"))
        assertEquals("ADT", TalkTime.zoneLabel("America/Halifax", "2026-07-15T09:00:00-03:00"))
        assertEquals("MST", TalkTime.zoneLabel("America/Edmonton", "2026-01-15T09:00:00-07:00"))
        assertEquals("MDT", TalkTime.zoneLabel("America/Edmonton", "2026-07-15T09:00:00-06:00"))
        assertEquals("CST", TalkTime.zoneLabel("America/Winnipeg", "2026-01-15T09:00:00-06:00"))
        assertEquals("CDT", TalkTime.zoneLabel("America/Winnipeg", "2026-07-15T09:00:00-05:00"))
        assertEquals("CST", TalkTime.zoneLabel("America/Mexico_City", "2026-07-15T09:00:00-06:00"), "Mexico keeps standard time all year")
        assertEquals("AST", TalkTime.zoneLabel("America/Puerto_Rico", "2026-07-15T09:00:00-04:00"))
        assertEquals("HST", TalkTime.zoneLabel("Pacific/Honolulu", "2026-07-15T09:00:00-10:00"))
        assertEquals("EST", TalkTime.zoneLabel("US/Eastern", "2026-01-15T09:00:00-05:00"), "aliases are listed too")
        assertEquals("EDT", TalkTime.zoneLabel("America/Indiana/Indianapolis", "2026-07-15T09:00:00-04:00"))
        // Newfoundland and Sydney get no abbreviation in US English.
        assertEquals("GMT-3:30", TalkTime.zoneLabel("America/St_Johns", "2026-01-15T09:00:00-03:30"))
        assertEquals("GMT-2:30", TalkTime.zoneLabel("America/St_Johns", "2026-07-15T09:00:00-02:30"))
        assertEquals("GMT+11", TalkTime.zoneLabel("Australia/Sydney", "2026-01-15T09:00:00+11:00"))
        assertEquals("GMT+5:45", TalkTime.zoneLabel("Asia/Kathmandu", "2026-07-15T09:00:00+05:45"))
    }

    @Test
    fun aTalksWhen() {
        val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!
        assertEquals("Mon, Mar 2 · 10:00–10:30 AM GMT+1", TalkTime.`when`(bundle.talksById.getValue(Fixtures.A), "Europe/Amsterdam"))
        assertEquals("Mon, Mar 2 · 1:30–2:00 PM GMT+1", TalkTime.`when`(bundle.talksById.getValue(Fixtures.C), "Europe/Amsterdam"))
    }
}
