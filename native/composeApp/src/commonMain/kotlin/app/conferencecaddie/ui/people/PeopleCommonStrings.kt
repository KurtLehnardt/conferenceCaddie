package app.conferencecaddie.ui.people

/**
 * The people screens' copy that more than one screen shows, word for word as the web app shows it
 * (the screens and connect.ts in web/src/people). Copy that one screen alone shows lives with that
 * screen's strings ([ProfileStrings], [PeopleStrings], [ConnectStrings]); copy that the web keeps in
 * its logic files is in the shared module's `PeopleText`; the app bar's titles are in
 * `Strings.AppBar`.
 */
object PeopleCommonStrings {
    // NeedsConnection (app.tsx) uses Strings.Offline.PEOPLE_TITLE and NEEDS_CONNECTION_BODY.

    /** The People tab while the people records could not be opened. */
    const val SESSION_FAILED = "The people features could not be opened on this phone."

    /** The button under [SESSION_FAILED]. */
    const val TRY_AGAIN = "Try again"

    /** The link after a message that names the profile (PeopleScreen, PresenceControls, PushControls, ShareAll, TalkPeopleControls). */
    const val OPEN_MY_PROFILE = "Open my profile"

    /** The toast action after a share that failed for want of a profile (app.tsx). */
    const val OPEN_PROFILE = "Open profile"

    /** The fallback for a write that failed without a message of its own. */
    const val NOT_SAVED = "That could not be saved. Please try again."

    // The overflow menu of a person (PersonCard, InboxScreen, MeetScreen).

    fun optionsFor(name: String) = "Options for $name"

    const val REPORT = "Report"
    const val BLOCK = "Block"

    // Blocking (connect.ts blockWithConfirm and unblock); the body is PeopleText.BLOCK_BODY.

    fun blockTitle(name: String) = "Block $name?"

    fun blocked(name: String) = "Blocked $name"

    fun unblocked(name: String?) = if (name.isNullOrBlank()) "Unblocked" else "Unblocked $name"

    const val UNDO = "Undo"

    // Asks and meets (PersonCard, InboxScreen, MeetScreen).

    const val NO_REPLY_YET = "No reply yet"
    const val OPEN_MEET_UP = "Open meet-up"

    // A person's card and the circles' lists (PersonCard, TalkPeopleControls).

    /** SampleNote, above the first card when any card is a sample. */
    const val SAMPLE_NOTE = "Profiles marked Sample are sample profiles, not real attendees."

    /** The Sample pill: the visible word, its screen-reader name and its tooltip. */
    const val SAMPLE = "Sample"
    const val SAMPLE_SPOKEN = "Sample profile, not a real person"
    const val SAMPLE_TITLE = "A sample profile, not a real person"

    /** The accent line of a person who is around: with their zone when the privacy rules allow it. */
    fun around(zone: String?) = if (zone.isNullOrBlank()) "Around now" else "Around · $zone"

    /** proximityLabel(): the band of someone around, never a distance; nothing for the venue. */
    const val BAND_SAME_ZONE = "Same zone"
    const val BAND_NEAR = "Near"
    const val BAND_AROUND = "Around"

    /** VISIBILITY_NOTICE (PeopleScreen.tsx), on the People prompt and in Profile's Visibility card. */
    const val VISIBILITY_NOTICE =
        "Turning this on stores your profile on our server until the conference ends: your name, about, topics, free text and How to reach me. Other attendees who are also visible at this conference can see it and may be matched with you. People who are not visible see nothing. Turn it off at any time to remove it from the server, or delete your profile."
}
