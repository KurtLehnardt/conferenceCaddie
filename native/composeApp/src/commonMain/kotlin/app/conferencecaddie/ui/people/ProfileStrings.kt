package app.conferencecaddie.ui.people

/**
 * The copy of Profile, the Settings people groups and the talk circles (web ProfileScreen.tsx,
 * TopicPicker.tsx, SettingsPeople.tsx, TalkPeopleControls.tsx, ShareAllControls.tsx and the
 * EndedTalkBanner of PeopleScreen.tsx), word for word. Each group names the web file it comes from.
 * Copy that other screens show too is in [PeopleCommonStrings]; copy the web keeps in its logic files
 * (the sharing notice, the circle count, the delete messages) is in the shared module's `PeopleText`
 * or comes from the controller.
 */
object ProfileStrings {
    // ---------------------------------------------------------------------------------------------
    // web/src/people/ProfileScreen.tsx: SaveStatus

    const val SAVING = "Saving…"
    const val SAVED = "Saved"
    const val COULD_NOT_SAVE = "Could not save."

    // ProfileScreen.tsx: PendingDelete, the banner of a delete the server has not confirmed yet.

    const val DELETING_UNFINISHED = "Deleting your profile has not finished."

    /** [where] is [conferences], the conference's name or [ANOTHER_CONFERENCE]. */
    fun removingUnfinished(where: String) = "Removing your profile from $where has not finished."

    /** Several conferences whose copy is still being removed (never one). */
    fun conferences(n: Int) = "$n conferences"

    const val ANOTHER_CONFERENCE = "another conference"
    const val PENDING_HIDDEN_COPY = "It may already be hidden from other attendees."
    const val PENDING_DELETE_COPY =
        "Until the delete is done, the app does not share your profile, presence or Bluetooth signal, and sends no requests to talk shop. It tries again by itself."
    const val PENDING_DELETE_ONE_COPY =
        "Until it is done, the app does not share your profile, presence or Bluetooth signal there, and sends no requests to talk shop there. It tries again by itself."
    const val STOP_FORBIDDEN_COPY = "Our server keeps refusing this device's key, so trying again will not help."
    const val STOP_FAILING_COPY = "Deleting has not finished after several tries or a day of trying."
    const val STOP_ALL_COPY =
        "If you stop, your profile is deleted from this phone only. What our server holds may stay visible to other attendees until the conference ends, and this phone can no longer delete it."
    const val STOP_ONE_COPY =
        "If you stop, this phone stops trying. What our server holds may stay visible to other attendees until the conference ends, and this phone will not try to remove it again."
    const val TRY_AGAIN = "Try again"
    const val WORKING = "Working…"
    const val STOP_TRYING = "Stop trying on this device"

    // ProfileScreen.tsx: the banner of a profile hidden after two reports.

    const val HIDDEN_TITLE = "Hidden after reports."
    const val HIDDEN_COPY = "Other attendees cannot see your profile, and you cannot ask to talk shop, until we have looked at it."

    // ProfileScreen.tsx: About you.

    const val ABOUT_YOU = "About you"
    const val NAME = "Name"
    const val NAME_PLACEHOLDER = "How people will see you"
    const val ABOUT_ME = "About me"
    const val ABOUT_PLACEHOLDER = "One or two lines, for example your role and what you work on"

    // ProfileScreen.tsx: the two topic cards.

    const val LEARN_TITLE = "I want to learn about"
    const val INTERESTS_LABEL = "What I'm trying to learn or figure out next"
    const val INTERESTS_PLACEHOLDER =
        "For example: getting Postgres failover under a minute, or why our GPU inference costs so much"
    const val SPEAK_TITLE = "I can speak to"
    const val EXPERTISE_LABEL = "Things I've built, run or broken"
    const val EXPERTISE_PLACEHOLDER = "For example: ran Postgres operators on bare metal for 3 years"

    /** SPECIFIC_HINT, under both free-text fields. */
    const val SPECIFIC_HINT = "The more specific, the better the matches."

    // ProfileScreen.tsx: How to reach me.

    const val REACH_TITLE = "How to reach me"
    const val REACH_HINT = "Optional. Shown only to people you choose to be visible to."
    const val LINKEDIN_LABEL = "LinkedIn link"
    const val LINKEDIN_PLACEHOLDER = "https://www.linkedin.com/in/your-name"
    const val LINKEDIN_INVALID = "Use a link like https://www.linkedin.com/in/your-name"
    const val CONTACT_LABEL = "Another way to reach me"
    const val CONTACT_PLACEHOLDER = "For example: @sam on the CNCF Slack"

    // ProfileScreen.tsx: Visibility. The notice is PeopleCommonStrings.VISIBILITY_NOTICE.

    const val VISIBILITY_TITLE = "Visibility"

    fun visibleAt(conference: String) = "Visible to other attendees at $conference"

    fun alsoShared(n: Int) = "You also share your profile for $n ${if (n == 1) "talk" else "talks"}."

    const val STOP_SHARING_ALL_TALKS = "Stop sharing for all talks"

    // ProfileScreen.tsx: Delete.

    const val DELETE_TITLE = "Delete"
    const val DELETE_MY_PROFILE = "Delete my profile"
    const val DELETE_CONFIRM =
        "This removes your profile from this phone and from our server, for every conference, along with your presence, your requests to talk shop and the people you blocked. It cannot be undone."
    const val DELETING = "Deleting…"

    // ---------------------------------------------------------------------------------------------
    // web/src/people/TopicPicker.tsx

    /** The most topics a set can hold. */
    const val MAX_TOPICS = 30

    fun topicCount(n: Int) = "$n of $MAX_TOPICS"

    const val HOLD_HINT = "Hold a topic to find people who've done it."
    const val FIND_TOPIC = "Find a topic"

    /** The search field's name, with the picker's title in lower case. */
    fun findTopicFor(title: String) = "Find a topic for ${title.lowercase()}"

    const val CLEAR = "Clear"
    const val NO_TOPIC_MATCH = "No topic matches that. Try another word."
    const val SUGGESTED_FOR_YOU = "Suggested for you"
    const val COMMON_AT_CONFERENCE = "Common at this conference"
    const val LOADING_TOPICS = "Loading topics…"

    fun showMore(n: Int) = "Show more ($n)"

    const val SHOW_FEWER = "Show fewer"
    const val TOPICS_FULL = "You have chosen 30 topics, the most a set can hold."
    const val FIND_PEOPLE_DONE = "Find people who've done this"

    fun actionsFor(label: String) = "Actions for $label"

    /** A topic chip's name: "eBPF", or "eBPF, 7 talks" when it carries a count. */
    fun chipName(label: String, count: Int?) = if (count == null) label else "$label, $count ${if (count == 1) "talk" else "talks"}"

    // ---------------------------------------------------------------------------------------------
    // web/src/people/SettingsPeople.tsx and NudgeBanner.tsx: the Settings groups.

    const val BLOCKED_PEOPLE = "Blocked people"
    const val PEOPLE_I_MET = "People I met"
    const val PEOPLE_I_WATCH = "People I'm watching"
    const val NUDGES = "Nudges"
    const val PUSH = "Push"

    fun nobodyBlocked(conference: String) = "Nobody is blocked at $conference."

    const val SOMEONE_YOU_BLOCKED = "Someone you blocked"
    const val SOMEONE = "Someone"
    const val UNBLOCK = "Unblock"
    const val REMOVE = "Remove"
    const val SAVED_ON_PHONE = "Saved on this phone only."
    const val WATCH_FOOTER =
        "While you're around with the app open and nudges on, the People tab tells you when one of them is around. Saved on this phone only."

    // ---------------------------------------------------------------------------------------------
    // web/src/people/TalkPeopleControls.tsx. The count is PeopleText.peopleCountLabel and the notice
    // PeopleText.SHARE_NOTICE.

    const val SHARE_FOR_TALK = "Share my profile with others interested in this talk"
    const val SHARE_MY_PROFILE = "Share my profile"
    const val NOT_NOW = "Not now"
    const val SHARE_LIMIT = "You can share for up to 50 talks. Turn one off first."
    const val SEE_WHOS_HERE = "See who's here"
    const val NEEDS_SHARE = "Share your profile for this talk to see who else is interested."
    const val CIRCLE_UNAVAILABLE = "This is unavailable right now."
    const val LOADING = "Loading…"
    const val SPEAKERS = "Speakers"
    const val LINK = "Link"
    const val OTHERS_WHO_SHARED = "Others who shared"
    const val NO_ONE_SHARED = "No one else has shared yet. Check back later."

    /** Native only: what screen readers hear for "See who's here" (the web's aria-expanded). */
    const val EXPANDED = "Expanded"
    const val COLLAPSED = "Collapsed"

    // ---------------------------------------------------------------------------------------------
    // web/src/people/ShareAllControls.tsx

    const val SHARE_ALL_TITLE = "Share with people interested in these talks"

    /** The summary line for [shared] of [total] listed talks; one talk reads as "this talk". */
    fun shareSummary(shared: Int, total: Int): String = when {
        total == 1 -> if (shared == 0) "Your profile is not shared for this talk." else "Your profile is shared for this talk."
        shared == 0 -> "Your profile is not shared for any of these $total talks."
        shared == total -> "Your profile is shared for all $total talks here."
        else -> "Your profile is shared for $shared of these $total talks."
    }

    const val SHARE_FOR_THIS_TALK = "Share for this talk"

    fun shareForAll(n: Int) = "Share for all $n"

    const val STOP_SHARING_ALL = "Stop sharing for all"
    const val SHARE_AUTOMATICALLY = "Share automatically for talks I mark, and stop when I unmark"

    // ---------------------------------------------------------------------------------------------
    // web/src/people/PeopleScreen.tsx: EndedTalkBanner

    const val ENDED_LEAD = "Want to keep talking about "
    const val ENDED_TAIL = "? See who else was interested."
    const val SEE_WHO_ELSE = "See who else was interested"
    const val OPEN_TALK = "Open talk"
}
