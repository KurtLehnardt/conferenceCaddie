package app.conferencecaddie.ui.people

/**
 * The copy of presence, nudges, asks, Requests and Meet up (web PresenceControls.tsx,
 * NudgeBanner.tsx, PushControls.tsx, AskSheet.tsx, InboxScreen.tsx, MeetScreen.tsx), word for word.
 * Copy that other screens show too is in [PeopleCommonStrings]; copy the web keeps in its logic files
 * is in the shared module's `PeopleText`. The few lines the web has no words for (the phone's own
 * location and notification permissions) are marked native.
 */
object ConnectStrings {
    // PresenceControls.tsx: the card

    const val PRESENCE_LABEL = "Around and up for a conversation"

    const val DAY_HINT =
        "Stays on until you turn it off or the day ends. Whenever you come back to the app after a while, it asks whether you're still in the same zone."

    const val USING_POSITION = "Using your position too"

    fun turnsOffIn(minutes: Int) = "Turns off in $minutes min · Extend"

    const val ON_UNTIL_OFF_TODAY = "On until you turn it off today"
    const val CHANGE_ZONE = "Change zone"
    const val STOP_USING_POSITION = "Stop using position"
    const val USE_MY_POSITION_TOO = "Use my position too"
    const val USE_MY_POSITION = "Use my position"
    const val ZONE_ONLY = "Zone only"

    const val UNKNOWN_ZONE = "That zone isn't on this conference's list. Pick one below."
    const val NEEDS_VISIBLE_PROFILE = "Being around needs a visible profile."
    const val ZONE = "Zone"
    const val HOW_LONG = "How long"
    const val SPOT_LABEL = "Where in the zone (optional)"
    const val SPOT_PLACEHOLDER = "For example: by the coffee cart"
    const val SPOT_HINT = "Shared only with people who can also see you, while this is on."
    const val I_AM_AROUND = "I'm around"
    const val SAVE = "Save"
    const val SAVING = "Saving…"
    const val NOT_NOW = "Not now"
    const val CANCEL = "Cancel"
    const val EXTENDED = "Extended for another hour"
    const val USING_POSITION_TOAST = "Using your position while you are around"

    // Native: the phone's location permission, which the web leaves to the browser. Precise
    // location only; approximate location sends no position at all.

    /** Location was refused for the app. */
    const val POSITION_DENIED =
        "Location is turned off for Caddie, so your position is not used. Allow it in Settings to use your position too."

    /** Only approximate location is allowed, which the server does not keep. */
    const val POSITION_APPROXIMATE =
        "Caddie may use only your approximate location, so no position is sent. Allow precise location in Settings to use your position too."

    /** Opens this app's page in the system settings. */
    const val OPEN_SETTINGS = "Open settings"

    // PresenceControls.tsx: StillHereRow

    fun stillIn(zone: String) = "Still in $zone?"

    const val YES = "Yes"
    const val OTHER_ZONE = "Other…"
    const val I_AM_HERE = "I'm here"
    const val BACK = "Back"

    fun nowIn(zone: String) = "Now in $zone"

    // NudgeBanner.tsx
    const val DISMISS = "Dismiss"
    const val SEE_WHO = "See who"
    const val NUDGE_SETTING_TEXT =
        "While you're around, one banner on the People tab when someone with specific, matching experience is in your zone, or someone you're watching turns up anywhere. Once per person per day. Nothing is sent to your phone."

    // PushControls.tsx

    const val PUSH_ON = "On"
    const val TURN_ON_NUDGES = "Turn on nudges"
    const val NUDGES_ON = "Nudges on"
    const val PUSH_UNAVAILABLE = "Nudges aren't set up on this server yet."
    const val PUSH_PROFILE_NEEDED = "Nudges need a visible profile."
    const val PUSH_FAILED = "Nudges could not be turned on. Please try again."

    /** Native: the web's PUSH_DENIED_HINT names the browser; here the phone's settings hold the switch. */
    const val PUSH_DENIED = "Notifications are blocked for Caddie. Allow them in Settings to get nudges."

    // SettingsPeople.tsx (NudgeSettings): the Push group's explanation

    const val PUSH_SETTINGS_TEXT =
        "The same nudge as a notification while the app is closed: when someone whose experience matches yours is in your zone. It never says who until you open the app, and you get at most a few an hour."

    // AskSheet.tsx

    const val ASK_TITLE = "Ask to talk shop"

    fun askTo(name: String) = "To $name. They see your name, your profile and this note, and have 15 minutes to answer."

    const val NOTE = "Note"

    fun noteCount(n: Int) = "$n of 140"

    const val SEND = "Send"
    const val SENDING = "Sending…"
    const val NOTE_EMPTY = "Add a line about what you want to compare notes on."
    const val ASKED = "Asked. You'll hear back here if they accept."
    const val DONE = "Done"
    const val ASK_BLOCKED = "You can't send a request to this person."
    const val ASK_OPEN = "You already have an open request with them."
    const val NOT_SENT = "That could not be sent. Please try again."

    // PersonCard.tsx: Wave

    const val WAVED = "Waved. You'll hear back here."

    // InboxScreen.tsx

    const val REQUESTS = "Requests"
    const val NO_REQUESTS = "No requests yet"
    const val NO_REQUESTS_BODY = "When someone asks to talk shop, it shows up here while you have the app open."

    fun incomingSameZone(name: String, zone: String) = "$name is in $zone with you and would like to talk shop."

    fun incomingTopic(name: String, topic: String) = "$name would like to talk shop about $topic."

    fun incoming(name: String) = "$name would like to talk shop."

    const val ACCEPT = "Accept"

    fun expiresIn(minutes: Int) = "Expires in $minutes min"

    const val RAN_OUT = "That ask has run out."
    const val YOUR_REQUESTS = "Your requests"

    // InboxScreen.tsx and MeetScreen.tsx

    const val CHECKING = "Checking…"

    // MeetScreen.tsx: ended

    const val MEET_OVER = "This meet-up is over."
    const val MEET_NOT_FOUND = "This meet-up couldn't be found."
    const val MEET_NOT_YOURS = "This meet-up isn't yours to see."
    const val SAID_NOT_NOW = "They said not now."

    fun cancelledBy(name: String) = "${name.ifBlank { "They" }} cancelled the meet-up."

    const val MEET_UNAVAILABLE = "This is unavailable right now. Please try again."
    const val MEET_CANCELLED = "Meet-up cancelled"
    const val BACK_TO_PEOPLE = "Back to People"

    // MeetScreen.tsx: found

    fun youFound(name: String) = "You found $name"

    const val FOUND_HINT = "Compare notes, then swap a way to stay in touch if it went well."
    const val SAVE_PERSON = "Save this person"
    const val SAVED_UNDER_SETTINGS = "Saved under Settings"
    const val SAVED_TOAST = "Saved. Find them under Settings › People I met."

    // MeetScreen.tsx: live

    fun waitingFor(name: String) = "Waiting for $name."

    const val NO_REPLY_YET_DOT = "No reply yet."

    fun bothIn(zone: String) = "You're both in $zone."

    fun meetAt(zone: String) = "Meet at $zone"

    const val MEETING_POINT_OPTIONAL = "Meeting point (optional)"
    const val NO_MEETING_POINT = "No meeting point yet"
    const val CHANGE_MEETING_POINT = "Change meeting point"
    const val SET_MEETING_POINT = "Set a meeting point"
    const val MEETING_POINT = "Meeting point"
    const val SET = "Set"
    const val NOT_SAID_WHERE = "They haven't said where they are."

    fun notAroundNow(name: String) = "$name isn't around right now."

    const val HOW_TO_SPOT_THEM = "How to spot them"
    const val NOT_SAID_SPOT = "They haven't said how to spot them yet."

    fun minutesLeft(n: Int) = "About $n min left."

    const val HOW_TO_SPOT_ME = "How to spot me"

    fun addALine(name: String) = "Add a line so $name can find you."

    const val SPOT_ME_LABEL = "One line they'll see only until you meet"
    const val SPOT_ME_PLACEHOLDER = "For example: green hoodie, grey backpack"

    fun spotMeCount(n: Int) = "$n of 60"

    const val SAVED = "Saved"

    /** distanceText(): the server's distance, already rounded to 10 m. */
    fun distance(meters: Int) = if (meters < 10) "Less than 10 m away" else "About $meters m"

    const val CAVEAT = "Positions indoors are rough. Head to the meeting point and look for them."
    const val FOUND_EACH_OTHER = "We found each other"
    const val CANCEL_MEET_TITLE = "Cancel this meet-up?"
    const val CANCEL_MEET_BODY = "They'll see that it ended. You can ask again later."
    const val CANCEL_MEET_CONFIRM = "Cancel meet-up"
}
