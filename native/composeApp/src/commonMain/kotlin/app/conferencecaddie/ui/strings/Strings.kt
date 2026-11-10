package app.conferencecaddie.ui.strings

/**
 * Every piece of copy the native apps show, word for word as the web app shows it, so the two read
 * the same. Each group names the web file it comes from. Copy that exists only in the native apps
 * (the server setting, the cache, the connect confirmation) is marked "native only" and written in
 * the web app's voice. English only, as the web app is.
 */
object Strings {
    const val APP_NAME = "Conference Caddie"

    /** web/src/components/common.tsx (NavBar), in the web's order. */
    object Tabs {
        const val PEOPLE = "People"
        const val FOR_YOU = "For you"
        const val SEARCH = "Search"
        const val INTERESTED = "Interested"
        const val NAV_LABEL = "Main"

        /** The tab's accessible name when it carries a count badge. */
        fun interestedWithCount(n: Int) = "Interested, $n talks"
        fun peopleWithCount(n: Int) = "People, $n new ${if (n == 1) "request" else "requests"}"
    }

    /** web/src/app.tsx (app bar, blockers) and web/src/components/switcher.tsx. */
    object AppBar {
        const val SETTINGS = "Settings"
        const val BACK = "Back"
        const val CHOOSE_CONFERENCE = "Choose a conference"
        const val CHANGE_CONFERENCE = ", change conference"
        const val OFFLINE = "Offline"
        const val INTERESTED_OPTIONS = "Interested options"
        const val CLEAR_LIST = "Clear list"
    }

    object Switcher {
        const val TITLE = "Conferences"
        const val CLOSE = "Close"
        const val SEARCHABLE = "Searchable conferences"
        const val UNAVAILABLE_HEADING = "Schedule not available here yet"
        const val OPENS_OFFICIAL = ", opens the official schedule in a new tab"
        const val VIRTUAL = "Virtual"
    }

    /** web/src/app.tsx, blocker(): what shows instead of a conference screen. */
    object Blockers {
        const val SOMETHING_WRONG = "Something went wrong"
        const val RETRY = "Retry"
        const val LOADING_CONFERENCES = "Loading conferences…"
        const val NO_CONFERENCES = "No conferences yet"
        const val NOT_AVAILABLE_HERE = "This conference isn't available here"
        const val CHOOSE_ANOTHER = "Choose another conference to continue."
        const val CHOOSE_CONFERENCE_BUTTON = "Choose a conference"
        const val SCHEDULE_NOT_AVAILABLE = "Schedule not available here yet"
        fun cantBeSearched(name: String) = "$name can't be searched here yet. Its schedule is on the official site."
        const val OPEN_OFFICIAL = "Open the official schedule"
    }

    /** web/src/components/search.tsx (SearchField, ChipRow, SuggestionRow, FilterSheet, Results). */
    object Search {
        const val VIEW_LABEL = "Search or browse the schedule"
        const val VIEW_SEARCH = "Search"
        const val VIEW_SCHEDULE = "Schedule"
        const val PLACEHOLDER = "Search talks, topics, speakers"
        const val FIELD_LABEL = "Search talks"
        const val CLEAR = "Clear search"
        const val DID_YOU_MEAN = "Did you mean"
        const val SUGGESTION_TRACK = "Track"
        const val SUGGESTION_ROOM = "Room"
        const val SUGGESTION_SPEAKER = "Speaker"
        const val SUGGESTION_TAG = "Tag"
        const val LOADING = "Loading talks"
        const val NO_MATCH = "No talks match. Try removing a filter."
        const val CLEAR_ALL_FILTERS = "Clear all filters"
        const val UNAVAILABLE = "Search is unavailable right now. Please try again."
        const val DEGRADED = "Meaning-based matching is paused right now; these are keyword matches."

        /** The results count line. */
        fun count(n: Int, browse: Boolean, includeEvents: Boolean): String = when {
            includeEvents -> "${if (browse) "Everything · " else ""}$n ${if (n == 1) "result" else "results"}"
            browse -> "All talks · $n"
            else -> "$n ${if (n == 1) "talk" else "talks"}"
        }
    }

    object Chips {
        const val FILTERS = "Filters"
        fun filtersActive(n: Int) = "Filters, $n active"
        const val HAPPENING_NOW = "Happening now"
        const val DAY = "Day"
        const val TIME = "Time"
        const val MORNING = "Morning"
        const val AFTERNOON = "Afternoon"
        const val TRACK = "Track"
        const val LEVEL = "Level"
        const val HAS_SLIDES = "Has slides"
        const val NO_SLIDES = "No slides"
        const val HIDE_SPONSOR = "Hide sponsor content"
        const val EVENTS = "Events and showcases"
        const val CLEAR_ALL = "Clear all"
        const val CLEAR_DAY = "Clear day filter"
        const val CLEAR_TIME = "Clear time filter"
        const val CLEAR_TRACK = "Clear track filter"
        const val CLEAR_LEVEL = "Clear level filter"
        fun clearGroup(group: String) = "Clear $group filter"
        fun speaker(name: String) = "Speaker: $name"
        fun room(label: String) = "Room: $label"
        fun clearSpeaker(name: String) = "Clear speaker $name"
        fun clearRoom(label: String) = "Clear room $label"

        /** A time phrase taken out of the search text ("Tuesday · Tue, Nov 10"). */
        fun timePhrase(label: String, singleDay: String?) = if (singleDay != null) "$label · $singleDay" else label
        fun removePhrase(label: String) = "Remove $label from this search"

        /** A dropdown chip's label: the group's name, its one value, or the name and a count. */
        fun group(name: String, values: List<String>) = when (values.size) {
            0 -> name
            1 -> values[0]
            else -> "$name · ${values.size}"
        }

        fun nowOff(conference: String, range: String?, zone: String?) =
            "Happening now is off: $conference is not running today" +
                (if (range != null && zone != null) " ($range, $zone time)" else "") + "."
    }

    object FilterSheet {
        const val TITLE = "Filters"
        const val CLOSE = "Close filters"
        const val DAY = "Day"
        const val ANY_DAY = "Any day"
        const val TIME = "Time"
        const val TIME_OF_DAY = "Time of day"
        const val ANY_TIME = "Any time"
        const val TRACK = "Track"
        const val NO_TRACKS = "No tracks in these results."
        const val LEVEL = "Level"
        const val NO_LEVELS = "No levels in these results."
        const val NONE_IN_RESULTS = "None in these results."
        const val SLIDES = "Slides"
        const val ANY = "Any"
        const val SPONSOR = "Sponsor content"
        const val HIDE_SPONSOR = "Hide sponsor content"
        const val EVENTS = "Events and showcases"
        const val INCLUDE_EVENTS = "Include co-located events and showcases"
        const val CLEAR_ALL = "Clear all"

        fun show(total: Int?, includeEvents: Boolean): String = when {
            total == null -> if (includeEvents) "Show results" else "Show talks"
            includeEvents -> "Show $total ${if (total == 1) "result" else "results"}"
            else -> "Show $total ${if (total == 1) "talk" else "talks"}"
        }
    }

    /** web/src/components/talk.tsx. */
    object Talk {
        const val INTERESTED = "I'm interested"
        const val WAS_THERE = "I was there / wanted to be"
        const val DETAILS = "Details"
        const val EVENT_BADGE = "Event or showcase, not a talk"
        const val EVENT_LINK = "Details on the official site"
        const val ADD_ON_OFFICIAL = "Add to my schedule on the official site"
        const val SLIDES = "Slides"
        const val RELATED = "Related talks"
        const val RELATED_LOADING = "Finding related talks..."
        const val RELATED_ERROR = "Related talks are unavailable right now."
        const val TRY_AGAIN = "Try again"
        const val RELATED_NONE = "No related talks found."
        const val CIRCLES_OFFLINE = "Talk circles need a connection."
        /** web/src/app.tsx (TalkSheet). */
        const val SHEET_TITLE = "Talk"
        const val CLOSE = "Close"
    }

    /** web/src/components/interested.tsx. */
    object Interested {
        const val TITLE = "My schedule"
        const val EMPTY = "No talks marked yet. Tap “I'm interested” on any talk to keep it here."
        const val FIND_TALKS = "Find talks"
        const val IMPORT_HINT_PREFIX = "You can import your schedule in "
        const val IMPORT_HINT_LINK = "Settings"
        const val VIEW_LABEL = "My schedule view"
        const val VIEW_LIST = "List"
        const val VIEW_DAY = "Day"
        fun footnote(zone: String) = "Times are shown in the event's local time ($zone). This list is kept on this device only."

        /** web/src/app.tsx (clearInterested). */
        const val CLEAR_TITLE = "Clear your Interested list?"
        fun clearBody(n: Int) = "This removes all $n ${if (n == 1) "talk" else "talks"} you marked for this conference from this device."
        const val CLEAR = "Clear"
    }

    /** web/src/people/ForYou.tsx and web/src/app.tsx. */
    object ForYou {
        const val LEDE = "Talks picked from what you want to learn. Ended talks and talks you marked are left out."
        const val PICK_TITLE = "Pick what you want to learn"
        const val PICK_BODY = "Pick topics you want to learn, or write what you're trying to learn or figure out next, to get talk suggestions."
        const val PICK_TOPICS = "Pick topics"
        const val FINDING = "Finding talks…"
        const val NONE = "No upcoming talks match your topics yet. Try adding a few more."
        const val NEEDS_CONNECTION_TITLE = "Suggestions need a connection"
    }

    /** Native only until the People screens arrive (phase 3); the wording follows the web's manifest. */
    object People {
        const val PLACEHOLDER_TITLE = "People to meet"
        const val PLACEHOLDER_BODY = "Find the people to talk to at this conference."
    }

    /** web/src/offline/OfflineSearch.tsx and web/src/app.tsx. */
    object Offline {
        const val BADGE = "Offline"
        const val LABEL = "Offline: keyword search only"
        const val OPENING = "Opening the saved schedule…"
        const val NOT_SAVED_TITLE = "This schedule isn't saved on this phone yet"
        fun notSavedBody(name: String) = "Open $name once while you have a connection, and its talks will be here offline."
        const val NO_MATCH = "No talks contain every word. Try fewer or different words."
        fun showingFirst(n: Int) = "Showing the first $n in schedule order. Add a word to narrow the list."
        const val PEOPLE_TITLE = "People to meet needs a connection"
        const val NEEDS_CONNECTION_BODY =
            "They will load when you're back online. Search, your Interested list and your profile still work on this phone."
    }

    /** web/src/app.tsx (toasts) and web/src/components/common.tsx (ConfirmDialog). */
    object Toasts {
        const val ADDED = "Added to Interested"
        const val REMOVED = "Removed from Interested"
        const val CLEARED = "Interested list cleared"
        const val UNDO = "Undo"
    }

    object Common {
        const val CANCEL = "Cancel"
        const val CLOSE = "Close"
        const val RETRY = "Retry"
    }

    /** web/src/components/settings.tsx, plus the native-only Server and Storage groups. */
    object Settings {
        const val TITLE = "Settings"
        const val YOU = "You"
        const val PROFILE = "Profile"
        const val SET_UP_PROFILE = "Set up your profile"
        const val IMPORT = "Import my schedule"
        const val IMPORT_HINT = "Find talks from a PDF, CSV, calendar or text file"
        const val APPEARANCE = "Appearance"
        const val THEME = "Theme"
        const val THEME_SYSTEM = "System"
        const val THEME_LIGHT = "Light"
        const val THEME_DARK = "Dark"
        const val ABOUT = "About"
        const val ABOUT_1 =
            "Conference Caddie helps you find the people to talk to and the talks you would like. Your official schedule stays on each conference's own site."
        const val ABOUT_2 = "Times are shown in each event's local time."
        const val ABOUT_3 =
            "Schedule data comes from each conference's Sessionize feed, discovered through events.linuxfoundation.org."
        const val SOURCE_CODE = "Source code"
        const val SOURCE_URL = "https://github.com/KurtLehnardt/conferenceCaddie"
        const val VERSION = "Version"

        // Native only.
        const val SERVER = "Server"
        const val SERVER_URL = "Server URL"
        const val SERVER_PLACEHOLDER = "https://caddie.example.org"
        const val SAVE = "Save"
        const val USE_DEFAULT = "Use the official server"
        fun using(base: String) = "Using $base"
        const val OFFICIAL = "The official Conference Caddie server"
        const val WHAT_IT_OFFERS = "What this server offers"
        const val TIER = "Kind of server"
        const val TIER_DEMO = "Demo (talks only)"
        const val TIER_FREE = "Free"
        const val TIER_PAID = "Full"
        const val TIER_UNKNOWN = "Unknown"
        const val TALKS = "Talk search and schedule"
        const val PEOPLE = "People to meet"
        const val ON = "On"
        const val OFF = "Off"
        const val UNREACHABLE = "This server can't be reached right now. Saved schedules still work on this phone."
        const val UPDATE_APP = "This server needs a newer version of the app."
        const val CHECKING = "Checking the server…"
        const val STORAGE = "Storage"
        const val SAVED_SCHEDULES = "Saved schedules"
        const val CLEAR_SAVED = "Clear saved schedules"
        const val CLEAR_SAVED_TITLE = "Clear saved schedules?"
        const val CLEAR_SAVED_BODY =
            "Schedules saved on this phone are removed. They download again the next time you open a conference with a connection. Your Interested list stays."
        const val CLEAR = "Clear"
        const val LICENSES = "Open-source licences"
        const val LICENSES_TITLE = "Open-source licences"

        /** Why a typed URL was refused (BackendUrl.Reason). */
        const val URL_NOT_A_URL = "Enter a full address that starts with https://."
        const val URL_HTTPS = "Use an https address."
        const val URL_HTTPS_DEBUG = "Use https. Plain http works only for localhost, 127.0.0.1, [::1] and 10.0.2.2."
        const val URL_CREDENTIALS = "Remove the user name or password from the address."
        const val URL_QUERY = "Remove the part after ? or # from the address."

        /** A size in decimal units, rounded: "999 bytes", "12 KB", "1.0 MB", "1.3 MB". */
        fun bytes(n: Long): String {
            if (n < 1_000) return "$n bytes"
            val kb = (n + 500) / 1_000
            // A size that rounds to 1000 KB is shown as 1.0 MB rather than "1000 KB".
            if (kb < 1_000) return "$kb KB"
            val tenths = (n + 50_000) / 100_000
            return "${tenths / 10}.${tenths % 10} MB"
        }
    }

    /** Native only: the confirmation before switching to another server (docs/contracts/capabilities.md). */
    object Connect {
        const val TITLE = "Switch servers?"
        /** The contract's prompt, verbatim: it names the backend's base URL exactly. */
        fun prompt(base: String) = "Switch to the server at $base?"
        const val NOT_OFFICIAL =
            "This is not the official Conference Caddie server. Switch only if you trust whoever gave you this address."
        const val KEPT =
            "Your Interested lists and saved schedules for each server stay on this phone, so switching back finds them again."
        const val SWITCH = "Switch"
    }
}
