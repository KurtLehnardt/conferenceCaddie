package app.conferencecaddie.shared.people

/**
 * The privacy rules of docs/CONTRACT.md ("Find & connect") that a screen must keep, in one place.
 * The server already sends these fields only when the rules allow; these helpers keep a screen from
 * showing a stale or out-of-context value (a zone after my presence ended, a spot line after a meet
 * is over, a distance from anything but a live meet read). Screens read a person's zone, proximity,
 * spot lines and distance only through them.
 *
 * - A person's zone and proximity band: only while both of us are around.
 * - Never a number for proximity: a band only, and nothing for the venue as a whole.
 * - A meet's other zone: while the meet is active, or while a same-zone ask waits and both of us are
 *   still around.
 * - Spot and spot-me lines: only inside an active meet.
 * - Distance and bearing: only from a meet read ([MeetRead]) of an active meet.
 */
object PeoplePrivacy {
    /** [person]'s zone, only when they are around and [myPresenceOn] says I am too. */
    fun zone(person: Person, myPresenceOn: Boolean): String? =
        if (person.around && myPresenceOn) person.zone?.takeIf { it.isNotBlank() } else null

    /** [person]'s proximity band, only when both of us are around; never [Proximity.Venue], which says nothing. */
    fun proximity(person: Person, myPresenceOn: Boolean): Proximity? =
        if (person.around && myPresenceOn) person.proximity?.takeIf { it != Proximity.Venue } else null

    /** True when [person] is around in my own zone. */
    fun inMyZone(person: Person, myPresence: Presence): Boolean {
        val mine = if (myPresence.on) myPresence.zone else null
        return mine != null && zone(person, true) == mine
    }

    /** A nearby person's zone (Bluetooth), only when it is my own zone and my presence is on. */
    fun zone(nearby: NearbyPerson, myPresence: Presence): String? =
        nearby.zone?.takeIf { myPresence.on && it == myPresence.zone }

    /** The other participant's zone of [meet]. */
    fun zone(meet: MeetView): String? {
        val z = meet.other.zone?.takeIf { it.isNotBlank() } ?: return null
        return when {
            meet.state == MeetState.Active -> z
            meet.state == MeetState.Requested && meet.sameZone && meet.other.around && meet.mine.around -> z
            else -> null
        }
    }

    /** The other participant's spot line, only while [meet] is active. */
    fun spot(meet: MeetView): String? = if (meet.state == MeetState.Active) meet.other.spot?.takeIf { it.isNotBlank() } else null

    /** The other participant's how-to-spot-me line, only while [meet] is active. */
    fun spotMe(meet: MeetView): String? = if (meet.state == MeetState.Active) meet.other.spotMe?.takeIf { it.isNotBlank() } else null

    /** A distance in metres (rounded to 10 by the server) and a bearing in degrees clockwise from north. */
    data class Distance(val meters: Int, val bearingDegrees: Int)

    /** The distance and bearing of a meet read, only while the meet is active and both are present. */
    fun distance(read: MeetRead): Distance? {
        val m = read.meet
        if (m.state != MeetState.Active) return null
        val d = m.other.distanceM ?: return null
        val b = m.other.bearingDeg ?: return null
        if (d < 0 || b !in 0..359) return null
        return Distance(d, b)
    }
}
