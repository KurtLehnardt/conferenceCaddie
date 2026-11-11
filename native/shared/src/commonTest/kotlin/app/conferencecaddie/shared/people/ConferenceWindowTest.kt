package app.conferencecaddie.shared.people

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Instant

class ConferenceWindowTest {
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilliseconds()

    @Test
    fun theLastDayEndsAtItsOwnMidnight() {
        // 23:59:59 in Amsterdam (UTC+1 in November) is 22:59:59 UTC, as server/people-shared.mjs computes it.
        assertEquals(ms("2026-11-12T22:59:59Z"), ConferenceWindow.visibleUntilMs("2026-11-12", "Europe/Amsterdam"))
        assertEquals(ms("2026-11-13T07:59:59Z"), ConferenceWindow.visibleUntilMs("2026-11-12", "America/Los_Angeles"))
    }

    @Test
    fun withoutATimeZoneTheServerAddsTwelveHours() {
        assertEquals(ms("2026-11-13T11:59:59Z"), ConferenceWindow.visibleUntilMs("2026-11-12", null))
        assertEquals(ms("2026-11-13T11:59:59Z"), ConferenceWindow.visibleUntilMs("2026-11-12", "Not/AZone"))
    }

    @Test
    fun anUnreadableDateCountsAsLive() {
        assertNull(ConferenceWindow.visibleUntilMs(null, "UTC"))
        assertNull(ConferenceWindow.visibleUntilMs("12 November", "UTC"))
        assertTrue(ConferenceWindow.isLive(ConferenceInfo("c", "C", endDate = null), ms("2030-01-01T00:00:00Z")))
    }

    @Test
    fun liveUntilTheLastSecond() {
        val c = ConferenceInfo("c", "C", timeZone = "UTC", endDate = "2026-11-12")
        assertTrue(ConferenceWindow.isLive(c, ms("2026-11-12T23:59:58Z")))
        assertFalse(ConferenceWindow.isLive(c, ms("2026-11-12T23:59:59Z")))
    }
}
