package app.conferencecaddie.shared

/**
 * A `caddie://` link the platforms hand to the app: an operator's server link, a link to a
 * conference screen in the shape of the web app's routes (web/src/lib/route.ts), so a web address
 * becomes an app link by replacing its origin with `caddie://`, or the link of a tapped
 * notification:
 *
 * - `caddie://connect?url=<backend>`, parsed by [ConnectLink]: it only ever asks the person to
 *   confirm the switch, and it never gets the debug builds' local http exception.
 * - `caddie://e/<slug>` with an optional `#/<tab>` and, after the tab, `?view=<view>&day=<day>`:
 *   for example `caddie://e/kubecon-2026#/search?view=schedule&day=2026-11-10` opens the full
 *   schedule on that day, and `#/interested?view=day` My schedule's Day view. The tabs are the
 *   web's. The people routes open the People tab with a [PeopleRoute]: `#/people` the People home
 *   (`#/people?around=1` with "Around now" on, as a push nudge opens it on the web), `#/inbox`
 *   Requests, `#/meet/<meet_id>` Meet up, `#/profile` the profile and `#/here/<zone>` the zone a
 *   person says they are in.
 * - `caddie://people?around=1`, `caddie://inbox` and `caddie://meet/<meet_id>`, the links the app's
 *   own notifications carry, accepted only in exactly the shapes [isNotificationDeepLink] accepts
 *   and opening the same screens as `#/people?around=1`, `#/inbox` and `#/meet/<meet_id>` on the
 *   selected conference. Nothing else on these hosts is taken, not even `caddie://people` without
 *   the query: no notification writes it, and `caddie://e#/people` says the same.
 *
 * Everything in a link is untrusted, wherever it came from. A notification's link is no more
 * trusted than any other: every screen it names can be opened by any app through the web's route
 * shapes, and opening one sends nothing until the person taps. [parse] refuses a link longer than
 * [MAX_LENGTH], a slug that is not the bundle contract's slug, and anything it does not know; an
 * unknown tab, view or day is dropped rather than guessed, as the web's router drops them, and so
 * is a meet id that is not one or a zone that is not plausible (the People tab opens without it).
 * The link never carries data into the app: a slug only selects a conference the backend already
 * lists, a meet id only names a meet the server shows the person if they are in it, and a zone is
 * only a candidate to match against the conference's own zones.
 */
sealed interface AppLink {
    data class Connect(val link: ConnectLink) : AppLink

    data class Open(
        /** A conference slug, or null to stay on the selected conference. */
        val slug: String?,
        val tab: Tab?,
        val view: View?,
        /** A local "YYYY-MM-DD" day of the conference. */
        val day: String?,
        /** The people screen to show; set only with [Tab.People]. Null for the People tab as it is. */
        val people: PeopleRoute? = null,
    ) : AppLink

    /** The screens of the People tab a link can open, on the conference of the link (or the selected one). */
    sealed interface PeopleRoute {
        /** The People home; with [aroundNow], "Around now" on (`#/people?around=1`, a nudge). */
        data class Home(val aroundNow: Boolean) : PeopleRoute

        /** Requests (`#/inbox`, `caddie://inbox`). */
        data object Inbox : PeopleRoute

        /** Meet up for [meetId], which has the shape of a meet id ([isMeetId]) and nothing more is known of it. */
        data class Meet(val meetId: String) : PeopleRoute

        /** The person's profile (`#/profile`). */
        data object Profile : PeopleRoute

        /**
         * `#/here/<zone>`: [zone] is the percent-decoded, trimmed value, 1 to [MAX_ZONE] characters
         * without control or format characters. It is only a candidate: the screen matches it
         * against the conference's zones and ignores it when none matches.
         */
        data class Here(val zone: String) : PeopleRoute
    }

    /** The web's tabs that have a native screen; the people routes are [People]. */
    enum class Tab(val route: String) { People("people"), ForYou("for-you"), Search("search"), Interested("interested"), Settings("settings") }

    /** The views inside a tab: List or Day on Interested, Search or Schedule on Search. */
    enum class View(val route: String) { List("list"), Day("day"), Search("search"), Schedule("schedule") }

    companion object {
        const val MAX_LENGTH = 2048

        /** The longest zone a `#/here/<zone>` link may name, as many characters as the app keeps of a zone. */
        const val MAX_ZONE = 120

        private val SLUG = Regex("^[a-z0-9][a-z0-9-]{0,119}$")
        private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val PEOPLE_ROUTES = setOf("here", "inbox", "meet", "profile")
        private val REFUSED_IN_ZONE = setOf(CharCategory.FORMAT, CharCategory.LINE_SEPARATOR, CharCategory.PARAGRAPH_SEPARATOR)

        /** The link [url] names, or null for anything that is not one of the app's links. */
        fun parse(url: String): AppLink? {
            val text = url.trim()
            if (text.isEmpty() || text.length > MAX_LENGTH) return null
            val schemeEnd = text.indexOf("://")
            if (schemeEnd <= 0 || !text.substring(0, schemeEnd).equals("caddie", ignoreCase = true)) return null
            val rest = text.substring(schemeEnd + 3)
            val hostEnd = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
            val host = rest.substring(0, hostEnd).lowercase()
            return when (host) {
                "connect" -> Connect(ConnectLink.parse(text))
                "e" -> open(rest.substring(hostEnd))
                "people", "inbox", "meet" -> notification(text)
                else -> null
            }
        }

        // The exact links of the app's notifications, on the selected conference.
        private fun notification(text: String): Open? {
            if (!isNotificationDeepLink(text)) return null
            val route = when (text) {
                NUDGE_NOTIFICATION_LINK -> PeopleRoute.Home(aroundNow = true)
                INBOX_NOTIFICATION_LINK -> PeopleRoute.Inbox
                else -> PeopleRoute.Meet(text.removePrefix(MEET_NOTIFICATION_LINK_PREFIX))
            }
            return Open(slug = null, tab = Tab.People, view = null, day = null, people = route)
        }

        // "/<slug>[/][#/<tab>[/<param>][?<query>]]", or "#/..." with no slug.
        private fun open(afterHost: String): Open? {
            val hash = afterHost.indexOf('#')
            val path = (if (hash >= 0) afterHost.substring(0, hash) else afterHost).substringBefore('?')
            val fragment = if (hash >= 0) afterHost.substring(hash + 1) else ""
            val segments = path.split('/').filter { it.isNotEmpty() }
            if (segments.size > 1) return null
            val slug = segments.firstOrNull()?.let { decode(it) ?: return null }?.also { if (!SLUG.matches(it)) return null }
            val full = fragment.removePrefix("/")
            val query = full.substringAfter('?', "")
            val route = full.substringBefore('?')
            val head = route.substringBefore('/')
            val tab = when {
                head.isEmpty() -> null
                head in PEOPLE_ROUTES -> Tab.People
                else -> Tab.entries.firstOrNull { it.route == head }
            }
            // As the web: an unknown tab is no tab, and only a tab of the four takes a view and a day.
            val params = if (tab == Tab.Search || tab == Tab.Interested) parseQuery(query) else emptyMap()
            val view = params["view"]?.let { v -> View.entries.firstOrNull { it.route == v } }?.takeIf { fits(tab, it) }
            val day = params["day"]?.takeIf { DAY.matches(it) }
            val people = if (tab == Tab.People) peopleRoute(head, route.substringAfter('/', ""), query) else null
            if (slug == null && tab == null) return null
            return Open(slug, tab, view, day, people)
        }

        // As the web's router: only `meet` and `here` take a parameter, which they need, and only the
        // People home reads `around` from the query.
        private fun peopleRoute(head: String, param: String, query: String): PeopleRoute? = when (head) {
            Tab.People.route -> PeopleRoute.Home(aroundNow = parseQuery(query)["around"] == "1")
            "inbox" -> PeopleRoute.Inbox
            "profile" -> PeopleRoute.Profile
            // A meet id needs no percent-encoding, so it is taken only as written.
            "meet" -> if (isMeetId(param)) PeopleRoute.Meet(param) else null
            "here" -> hereZone(param)?.let { PeopleRoute.Here(it) }
            else -> null
        }

        // The zone of `#/here/<zone>`, decoded and trimmed; null when it is empty, too long, or holds
        // a control, format or line separator character, which no zone name has.
        private fun hereZone(raw: String): String? {
            // No character takes more than nine when percent-encoded, so a longer value is too long.
            if (raw.length > MAX_ZONE * 9) return null
            val zone = decode(raw)?.trim() ?: return null
            if (zone.isEmpty() || zone.length > MAX_ZONE) return null
            if (zone.any { it.isISOControl() || it.category in REFUSED_IN_ZONE }) return null
            return zone
        }

        private fun fits(tab: Tab?, view: View): Boolean = when (tab) {
            Tab.Search -> view == View.Search || view == View.Schedule
            Tab.Interested -> view == View.List || view == View.Day
            else -> false
        }

        private fun parseQuery(query: String): Map<String, String> {
            val out = HashMap<String, String>()
            for (pair in query.split('&').take(8)) {
                val key = pair.substringBefore('=')
                val value = decode(pair.substringAfter('=', "")) ?: continue
                if (key !in out && value.length <= 32) out[key] = value
            }
            return out
        }

        // Percent-decoding as decodeURIComponent; null for a malformed escape or bytes that are not UTF-8.
        private fun decode(s: String): String? {
            if ('%' !in s) return s
            val bytes = ArrayList<Byte>()
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    if (i + 2 > s.lastIndex) return null
                    val hex = s.substring(i + 1, i + 3)
                    if (!hex.all { it in "0123456789abcdefABCDEF" }) return null
                    val v = hex.toInt(16)
                    bytes += v.toByte()
                    i += 3
                } else {
                    c.toString().encodeToByteArray().forEach { bytes += it }
                    i++
                }
            }
            return try {
                bytes.toByteArray().decodeToString(throwOnInvalidSequence = true)
            } catch (_: CharacterCodingException) {
                null
            }
        }
    }
}
