package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.people.ReportKind
import app.conferencecaddie.shared.people.ReportReason

/**
 * The copy of the People home, the person cards and the report sheet (web PeopleScreen.tsx,
 * PersonCard.tsx, BroadLine.tsx, ReportSheet.tsx), word for word. Copy that other screens show too
 * is in [PeopleCommonStrings].
 */
object PeopleStrings {
    // PeopleScreen.tsx: the search bar.

    /** SEARCH_PLACEHOLDER. */
    const val SEARCH_PLACEHOLDER = "What are you working on, or about to?"

    /** The search input's aria-label. */
    const val FIND_PEOPLE = "Find people"

    /** The search clear button's aria-label. */
    const val CLEAR = "Clear"

    /** The chip of the search bar. */
    const val AROUND_NOW = "Around now"

    /** FIND_LABEL: the Around home's button that opens the search. */
    const val FIND_LABEL = "Find someone specific"

    const val BACK_TO_AROUND = "Back to who's around"

    // PeopleScreen.tsx: the titles of the people list.

    const val PEOPLE_TO_MEET = "People to meet"
    const val PEOPLE_WHO_MATCH = "People who match"
    const val PEOPLE_AROUND_NOW = "People around now"

    /** AROUND_TITLE. */
    const val AROUND_TITLE = "Who's around"

    // PeopleScreen.tsx: the states of the people list (PeopleList).

    const val FINDING = "Finding people…"
    const val FINDING_MORE = "Finding more people…"
    const val UNAVAILABLE = "People are unavailable right now."

    /** SEARCH_EMPTY. */
    const val SEARCH_EMPTY = "Nobody's profile matches that yet. Try different words, or fewer."

    /** AROUND_EMPTY. */
    const val AROUND_EMPTY =
        "Nobody else is around right now. People show up here as they turn on \"Around and up for a conversation\"."

    const val NO_MATCHES = "No matches yet. Add more topics to your profile, or check back as more people join."

    /** The Around home's group titles. */
    fun inZone(zone: String) = "In $zone"

    fun nobodyInZone(zone: String) = "Nobody else in $zone yet"

    const val ELSEWHERE = "Elsewhere at the venue"

    // PeopleScreen.tsx: CreateProfilePrompt.

    const val CREATE_TITLE = "Find people worth meeting"
    const val CREATE_BODY =
        "Make a short profile: what you've built and what you're trying to learn or figure out next. It stays on this phone until you choose to be visible."
    const val CREATE_ACTION = "Create my profile"

    // PeopleScreen.tsx: VisibilityPrompt (its notice is PeopleCommonStrings.VISIBILITY_NOTICE).

    const val VISIBILITY_TITLE = "Turn on visibility to see who to meet"
    const val VISIBILITY_BODY = "You see other attendees only while they can see you too."
    const val MAKE_VISIBLE = "Make me visible"

    // PersonCard.tsx: the topics and How to reach me.

    const val CAN_SPEAK_TO = "Can speak to:"
    const val WANTS_TO_LEARN = "Wants to learn:"

    fun andMore(n: Int) = " and $n more"

    const val HOW_TO_REACH_ME = "How to reach me"
    const val LINKEDIN_PROFILE = "LinkedIn profile"

    // PersonCard.tsx: the card's one action.

    /** The status after a wave this run sent; "No reply yet" (PeopleCommonStrings) after an ask. */
    const val WAVED = "Waved"
    const val WAVE = "Wave"
    const val WAVING = "Waving…"
    const val ASK_TO_TALK_SHOP = "Ask to talk shop"
    const val WATCH = "Tell me when they're around"
    const val WATCHING = "Watching"

    /** watchOnCopy(). */
    fun watchOn(name: String) =
        "Watching $name. While you're around with the app open and nudges on, the People tab tells you when they're around."

    fun stoppedWatching(name: String) = "Stopped watching $name."

    // BroadLine.tsx

    /** The start of the server's reason that a broad match's card leads with. */
    const val ALSO_INTERESTED_IN = "Also interested in"

    // ReportSheet.tsx

    fun reportTitle(name: String) = "Report $name"

    /** The hint under the title: what is reported, and that the reporter stays anonymous. */
    fun reportQuestion(kind: ReportKind) = "What's wrong with ${reportSubject(kind)}? They are not told who reported."

    private fun reportSubject(kind: ReportKind) = when (kind) {
        ReportKind.Profile -> "their profile"
        ReportKind.Spot -> "their spot line"
        ReportKind.Meet -> "this meet-up"
    }

    /** The legend of the reasons, read by screen readers only. */
    const val REPORT_REASON = "Reason"

    /** REPORT_REASONS, in the web's order. */
    val REPORT_REASONS: List<Pair<ReportReason, String>> = listOf(
        ReportReason.Harassment to "Harassment",
        ReportReason.Hate to "Hateful content",
        ReportReason.Sexual to "Sexual content",
        ReportReason.Spam to "Spam or advertising",
        ReportReason.Other to "Something else",
    )

    const val REPORT_HINT = "Two reports from different people hide it from everyone until we have looked."
    const val SENDING = "Sending…"

    /** REPORT_THANKS. */
    const val REPORT_THANKS = "Thanks. We'll look at it."

    const val PICK_A_REASON = "Pick a reason."
    const val REPORT_NOT_FOUND = "This couldn't be found any more."
    const val REPORT_PROFILE_REQUIRED = "Set up your profile first."
    const val REPORT_NOT_SENT = "That could not be sent. Please try again."
}
