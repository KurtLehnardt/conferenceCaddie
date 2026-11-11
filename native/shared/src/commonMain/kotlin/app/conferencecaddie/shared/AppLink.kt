package app.conferencecaddie.shared

/**
 * A `caddie://` link the platforms hand to the app: an operator's server link, or a link to a
 * conference screen in the shape of the web app's routes (web/src/lib/route.ts), so a web address
 * becomes an app link by replacing its origin with `caddie://`:
 *
 * - `caddie://connect?url=<backend>`, parsed by [ConnectLink]: it only ever asks the person to
 *   confirm the switch, and it never gets the debug builds' local http exception.
 * - `caddie://e/<slug>` with an optional `#/<tab>` and, after the tab, `?view=<view>&day=<day>`:
 *   for example `caddie://e/kubecon-2026#/search?view=schedule&day=2026-11-10` opens the full
 *   schedule on that day, and `#/interested?view=day` My schedule's Day view. The tabs are the
 *   web's; the people screens (`here`, `inbox`, `meet`, `profile`) open the People tab, whose own
 *   screens read nothing from a link here.
 *
 * Everything in a link is untrusted. [parse] refuses a link longer than [MAX_LENGTH], a slug that is
 * not the bundle contract's slug, and anything it does not know; an unknown tab, view or day is
 * dropped rather than guessed, as the web's router drops them. The link never carries data into the
 * app: a slug only selects a conference the backend already lists.
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
    ) : AppLink

    /** The web's tabs that have a native screen; the people routes are [People]. */
    enum class Tab(val route: String) { People("people"), ForYou("for-you"), Search("search"), Interested("interested"), Settings("settings") }

    /** The views inside a tab: List or Day on Interested, Search or Schedule on Search. */
    enum class View(val route: String) { List("list"), Day("day"), Search("search"), Schedule("schedule") }

    companion object {
        const val MAX_LENGTH = 2048
        private val SLUG = Regex("^[a-z0-9][a-z0-9-]{0,119}$")
        private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        private val PEOPLE_ROUTES = setOf("here", "inbox", "meet", "profile")

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
                else -> null
            }
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
            val head = full.substringBefore('?').substringBefore('/')
            val tab = when {
                head.isEmpty() -> null
                head in PEOPLE_ROUTES -> Tab.People
                else -> Tab.entries.firstOrNull { it.route == head }
            }
            // As the web: an unknown tab is no tab, and only a tab of the four takes a view and a day.
            val params = if (tab == Tab.Search || tab == Tab.Interested) parseQuery(query) else emptyMap()
            val view = params["view"]?.let { v -> View.entries.firstOrNull { it.route == v } }?.takeIf { fits(tab, it) }
            val day = params["day"]?.takeIf { DAY.matches(it) }
            if (slug == null && tab == null) return null
            return Open(slug, tab, view, day)
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
