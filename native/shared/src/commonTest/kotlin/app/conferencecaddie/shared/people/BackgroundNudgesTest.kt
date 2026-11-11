package app.conferencecaddie.shared.people

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Instant

class BackgroundNudgesTest {
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilliseconds()

    private val now = ms("2026-11-11T12:00:00Z")

    private val wanted = PeopleUiState(
        availability = PeopleAvailability.Ready,
        conference = ConferenceInfo("c", "C", timeZone = "UTC", startDate = "2026-11-10", endDate = "2026-11-12"),
        features = PeopleFeatures(enabled = true, presence = true),
        visibility = Visibility(openToMeet = true),
        presence = Presence(on = true, zone = "Hall", until = "2026-11-11T13:00:00Z"),
        nudgesOn = true,
    )

    @Test
    fun wantedWhenVisiblePresentAtALiveConferenceWithNotificationsOn() {
        assertTrue(BackgroundNudges.wanted(wanted, now, notificationsAllowed = true))
    }

    @Test
    fun notWantedWhenTheSystemBlocksNotifications() {
        assertFalse(BackgroundNudges.wanted(wanted, now, notificationsAllowed = false))
    }

    @Test
    fun notWantedWhenNudgesAreOffForTheConference() {
        assertFalse(BackgroundNudges.wanted(wanted.copy(nudgesOn = false), now, true))
    }

    @Test
    fun notWantedWhenTheProfileIsNotVisible() {
        assertFalse(BackgroundNudges.wanted(wanted.copy(visibility = Visibility(openToMeet = false)), now, true))
    }

    @Test
    fun notWantedWhenAProfileDeleteCoversTheConference() {
        assertFalse(BackgroundNudges.wanted(wanted.copy(deletes = DeletesView(coversConference = true)), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(deletes = DeletesView(deleteAll = true)), now, true))
    }

    @Test
    fun notWantedWithoutPresenceOrZone() {
        assertFalse(BackgroundNudges.wanted(wanted.copy(presence = Presence()), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(presence = wanted.presence.copy(zone = null)), now, true))
    }

    @Test
    fun notWantedOnceThePresenceHasRunOut() {
        assertFalse(BackgroundNudges.wanted(wanted, ms("2026-11-11T13:00:00Z"), true))
    }

    @Test
    fun notWantedWhenThePeopleFeaturesAreNotOffered() {
        assertFalse(BackgroundNudges.wanted(wanted.copy(availability = PeopleAvailability.Off), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(availability = PeopleAvailability.NoConference), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(features = PeopleFeatures(enabled = true, presence = false)), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(features = PeopleFeatures(enabled = false, presence = true)), now, true))
        assertFalse(BackgroundNudges.wanted(wanted.copy(conference = null), now, true))
    }

    @Test
    fun notWantedOnceTheConferenceHasEndedInItsOwnTimeZone() {
        // The last day is 2026-11-12. In Los Angeles it ends at 07:59:59 UTC on the 13th, so at
        // 03:00 UTC on the 13th it still runs there; in Amsterdam it ended at 22:59:59 UTC on the 12th.
        val la = wanted.copy(conference = wanted.conference!!.copy(timeZone = "America/Los_Angeles"))
        val amsterdam = wanted.copy(conference = wanted.conference!!.copy(timeZone = "Europe/Amsterdam"))
        val late = ms("2026-11-13T03:00:00Z")
        val open = wanted.presence.copy(until = null)
        assertTrue(BackgroundNudges.wanted(la.copy(presence = open), late, true))
        assertFalse(BackgroundNudges.wanted(amsterdam.copy(presence = open), late, true))
        assertFalse(BackgroundNudges.wanted(la.copy(presence = open), ms("2026-11-13T08:00:00Z"), true))
    }

    @Test
    fun anUnreadablePresenceEndCountsAsNoEnd() {
        assertTrue(BackgroundNudges.wanted(wanted.copy(presence = wanted.presence.copy(until = "soon")), now, true))
    }
}
