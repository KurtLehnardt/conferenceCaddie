package app.conferencecaddie.shared

import app.conferencecaddie.shared.people.ConnectRuntime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

// The caddie:// links the platforms hand over: connect links through ConnectLink, the web's
// routes (web/src/lib/route.ts) with every untrusted part checked, and the links of the app's own
// notifications.
class AppLinkTest {
    private fun open(url: String) = assertIs<AppLink.Open>(AppLink.parse(url), url)

    @Test
    fun connectLinksGoThroughConnectLink() {
        val link = assertIs<AppLink.Connect>(AppLink.parse("caddie://connect?url=https%3A%2F%2Fcaddie.example%2Fpath%2F"))
        assertEquals("https://caddie.example/path", assertIs<ConnectLink.Confirm>(link.link).backend.base)
        // Never local http, even where a debug build would allow it when typed.
        assertIs<ConnectLink.Refused>(assertIs<AppLink.Connect>(AppLink.parse("caddie://connect?url=http%3A%2F%2Flocalhost%3A8080")).link)
        assertIs<ConnectLink.Refused>(assertIs<AppLink.Connect>(AppLink.parse("CADDIE://CONNECT?url=https%3A%2F%2Fu%3Ap%40caddie.example")).link)
    }

    @Test
    fun conferenceLinksFollowTheWebsRoutes() {
        assertEquals(AppLink.Open("kubecon-2026", null, null, null), open("caddie://e/kubecon-2026"))
        assertEquals(AppLink.Open("kubecon-2026", null, null, null), open("caddie://e/kubecon-2026/"))
        assertEquals(
            AppLink.Open("kubecon-2026", AppLink.Tab.Search, AppLink.View.Schedule, "2026-11-10"),
            open("caddie://e/kubecon-2026#/search?view=schedule&day=2026-11-10"),
        )
        assertEquals(
            AppLink.Open("kubecon-2026", AppLink.Tab.Interested, AppLink.View.Day, null),
            open("caddie://e/kubecon-2026#/interested?view=day"),
        )
        assertEquals(AppLink.Open("kubecon-2026", AppLink.Tab.ForYou, null, null), open("caddie://e/kubecon-2026#/for-you"))
        assertEquals(AppLink.Open("kubecon-2026", AppLink.Tab.Settings, null, null), open("caddie://e/kubecon-2026#settings"))
        // No conference: the tab of the conference that is open.
        assertEquals(AppLink.Open(null, AppLink.Tab.Search, null, null), open("caddie://e#/search"))
        // A percent-encoded slug is decoded, then checked.
        assertEquals("kubecon-2026", open("caddie://e/kubecon%2D2026").slug)
    }

    @Test
    fun thePeopleRoutesOpenThePeopleTab() {
        for (route in listOf("people", "here/hall-a", "inbox", "meet/abc123", "profile")) {
            assertEquals(AppLink.Tab.People, open("caddie://e/kubecon-2026#/$route").tab, route)
        }
    }

    @Test
    fun thePeopleRoutesNameTheirScreen() {
        val home = AppLink.PeopleRoute.Home(aroundNow = false)
        assertEquals(AppLink.Open("kubecon-2026", AppLink.Tab.People, null, null, home), open("caddie://e/kubecon-2026#/people"))
        assertEquals(home, open("caddie://e/kubecon-2026#people").people)
        assertEquals(home, open("caddie://e/kubecon-2026#/people/").people)
        // A push nudge on the web opens #/people?around=1: "Around now" on.
        assertEquals(AppLink.PeopleRoute.Home(aroundNow = true), open("caddie://e/kubecon-2026#/people?around=1").people)
        assertEquals(AppLink.PeopleRoute.Home(aroundNow = true), open("caddie://e#/people?x=y&around=%31").people)
        assertEquals(AppLink.PeopleRoute.Inbox, open("caddie://e/kubecon-2026#/inbox").people)
        assertEquals(AppLink.PeopleRoute.Profile, open("caddie://e/kubecon-2026#/profile").people)
        assertEquals(AppLink.PeopleRoute.Meet("QEFCQ0RFRkdISUpLTE1OTw"), open("caddie://e/kubecon-2026#/meet/QEFCQ0RFRkdISUpLTE1OTw").people)
        assertEquals(AppLink.PeopleRoute.Meet("a".repeat(128)), open("caddie://e#/meet/" + "a".repeat(128)).people)
        // A zone is decoded and trimmed; matching it to the conference's zones is the screen's work.
        assertEquals(AppLink.PeopleRoute.Here("Hall A | Room 1"), open("caddie://e/kubecon-2026#/here/Hall%20A%20%7C%20Room%201").people)
        assertEquals(AppLink.PeopleRoute.Here("hall-a"), open("caddie://e/kubecon-2026#/here/hall-a?around=1").people)
        assertEquals(AppLink.PeopleRoute.Here("Room 1/2"), open("caddie://e/kubecon-2026#/here/Room%201/2").people)
        assertEquals(AppLink.PeopleRoute.Here("Café"), open("caddie://e/kubecon-2026#/here/%20Caf%C3%A9%20").people)
        assertEquals(AppLink.PeopleRoute.Here("z".repeat(AppLink.MAX_ZONE)), open("caddie://e#/here/" + "z".repeat(AppLink.MAX_ZONE)).people)
        // Other tabs carry no people route.
        for (route in listOf("search", "for-you", "interested", "settings", "admin", "")) {
            assertNull(open("caddie://e/kubecon-2026#/$route?around=1").people, route)
        }
    }

    @Test
    fun aPeopleRouteThatDoesNotFitIsDropped() {
        // As the web's router: the People tab opens, without the route.
        for (route in listOf(
            "meet", "meet/", "meet/abc/def", "meet/../../api/people/profile", "meet/a%2Fb", "meet/abc%3D", "meet/abc.def", "meet/" + "a".repeat(129), "meet/%41bc",
            "here", "here/", "here/%20%20", "here/" + "z".repeat(AppLink.MAX_ZONE + 1), "here/Hall%0AA", "here/Hall%00A",
            "here/Hall%E2%80%AEA", "here/Hall%E2%80%A8A", "here/Hall%C2%85A", "here/Hall%ZZ", "here/Hall%C3",
            "here/" + "%E2%82%AC".repeat(AppLink.MAX_ZONE + 1),
        )) {
            val link = open("caddie://e/kubecon-2026#/$route")
            assertEquals(AppLink.Tab.People, link.tab, route)
            assertNull(link.people, route)
        }
        // "around" must be exactly 1.
        for (query in listOf("around=0", "around=true", "around=", "around", "Around=1", "around=1%20", "x=1")) {
            assertEquals(AppLink.PeopleRoute.Home(aroundNow = false), open("caddie://e/kubecon-2026#/people?$query").people, query)
        }
    }

    @Test
    fun theNotificationLinksOpenTheirScreenOnTheSelectedConference() {
        fun people(route: AppLink.PeopleRoute) = AppLink.Open(null, AppLink.Tab.People, null, null, route)
        assertEquals(people(AppLink.PeopleRoute.Home(aroundNow = true)), AppLink.parse("caddie://people?around=1"))
        assertEquals(people(AppLink.PeopleRoute.Home(aroundNow = true)), AppLink.parse(ConnectRuntime.NUDGE_DEEP_LINK))
        assertEquals(people(AppLink.PeopleRoute.Inbox), AppLink.parse("caddie://inbox"))
        assertEquals(people(AppLink.PeopleRoute.Meet("QEFCQ0RFRkdISUpLTE1OTw")), AppLink.parse("caddie://meet/QEFCQ0RFRkdISUpLTE1OTw"))
        assertEquals(people(AppLink.PeopleRoute.Meet("Az09_-")), AppLink.parse("caddie://meet/Az09_-"))
        assertEquals(people(AppLink.PeopleRoute.Meet("a".repeat(128))), AppLink.parse("caddie://meet/" + "a".repeat(128)))
    }

    @Test
    fun onTheirOwnHostsOnlyTheNotificationsExactLinksAreTaken() {
        // isNotificationDeepLink decides, character for character; the near misses are refused whole.
        val refused = listOf(
            "caddie://people",
            "caddie://people/",
            "caddie://people?around=0",
            "caddie://people?around=1&x=1",
            "caddie://people?around=1#/inbox",
            "caddie://people/?around=1",
            "caddie://People?around=1",
            "CADDIE://people?around=1",
            "caddie://people?Around=1",
            "caddie://people?around=%31",
            "caddie://inbox/",
            "caddie://inbox?x=1",
            "caddie://inbox#x",
            "caddie://Inbox",
            "caddie://INBOX",
            "caddie://meet",
            "caddie://meet/",
            "caddie://meet/abc/",
            "caddie://meet/abc/def",
            "caddie://meet/abc?x=1",
            "caddie://meet/abc#x",
            "caddie://meet/ab%43",
            "caddie://meet/abc.def",
            "caddie://Meet/abc",
            "caddie://meet/" + "a".repeat(129),
            "caddie://meet/../../api/people/profile",
            "caddie://meet/a%2Fb",
            "caddie://profile",
            "caddie://here/hall-a",
            "caddie://people@evil.example?around=1",
            "caddie://inbox:443",
        )
        for (url in refused) assertNull(AppLink.parse(url), url)
    }

    @Test
    fun unknownOrUnfitPartsAreDropped() {
        // An unknown tab is no tab (the web's router does the same), and a view must fit its tab.
        assertEquals(AppLink.Open("kubecon-2026", null, null, null), open("caddie://e/kubecon-2026#/admin"))
        assertNull(open("caddie://e/kubecon-2026#/search?view=day").view)
        assertNull(open("caddie://e/kubecon-2026#/interested?view=schedule").view)
        assertNull(open("caddie://e/kubecon-2026#/for-you?view=day&day=2026-11-10").day)
        // Days must look like days.
        assertNull(open("caddie://e/kubecon-2026#/search?view=schedule&day=tomorrow").day)
        assertNull(open("caddie://e/kubecon-2026#/search?day=2026-11-10T00:00").day)
        assertNull(open("caddie://e/kubecon-2026#/search?day=%32%30%32%36-11-10%0A").day)
        // The first value of a repeated key wins.
        assertEquals("2026-11-10", open("caddie://e/kubecon-2026#/search?day=2026-11-10&day=2026-11-11").day)
    }

    @Test
    fun hostileLinksAreRefused() {
        val refused = listOf(
            "",
            "https://kurtlehnardt.github.io/conferenceCaddie/e/kubecon-2026",
            "https://caddie.example/people?around=1",
            "javascript:alert(1)",
            "caddie:e/kubecon-2026",
            "caddie://evil.example/e/kubecon-2026",
            "caddie://e/",
            "caddie://e",
            "caddie://e/Kubecon-2026",
            "caddie://e/kubecon 2026",
            "caddie://e/..%2F..%2Fetc",
            "caddie://e/%2e%2e",
            "caddie://e/kubecon-2026/search",
            "caddie://e/-kubecon",
            "caddie://e/" + "a".repeat(121),
            "caddie://e/kubecon%ZZ",
            "caddie://e/kubecon%",
            "caddie://e/kubecon%C3",
            "caddie://e/kubecon-2026#/" + "x".repeat(AppLink.MAX_LENGTH),
        )
        for (url in refused) assertNull(AppLink.parse(url), url)
    }
}
