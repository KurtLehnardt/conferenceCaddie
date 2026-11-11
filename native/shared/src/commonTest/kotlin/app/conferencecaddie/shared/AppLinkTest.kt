package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

// The caddie:// links the platforms hand over: connect links through ConnectLink, and the web's
// routes (web/src/lib/route.ts) with every untrusted part checked.
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
