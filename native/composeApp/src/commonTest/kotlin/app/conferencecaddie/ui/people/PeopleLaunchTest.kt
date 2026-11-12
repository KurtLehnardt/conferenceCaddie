package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.AppLink
import app.conferencecaddie.ui.components.badgeText
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// The debug launch option caddie.people, and the badges. The people links themselves are AppLink's
// (shared AppLinkTest) and are opened through the app in PeopleLinksUiTest.
class PeopleLaunchTest {
    @Test
    fun launchOptionsAreRead() {
        assertEquals(PeopleLaunch.Route(AppLink.PeopleRoute.Home(aroundNow = false)), PeopleLaunch.parse("home"))
        assertEquals(PeopleLaunch.Route(AppLink.PeopleRoute.Home(aroundNow = true)), PeopleLaunch.parse("around"))
        assertEquals(PeopleLaunch.Search("kubernetes scheduler"), PeopleLaunch.parse("search:kubernetes scheduler"))
        assertEquals(PeopleLaunch.Route(AppLink.PeopleRoute.Profile), PeopleLaunch.parse("profile"))
        assertEquals(PeopleLaunch.Route(AppLink.PeopleRoute.Inbox), PeopleLaunch.parse("inbox"))
        assertEquals(PeopleLaunch.Route(AppLink.PeopleRoute.Meet("m1")), PeopleLaunch.parse("meet:m1"))
        assertEquals(PeopleLaunch.SettingsPeople, PeopleLaunch.parse("settings-people"))
        assertNull(PeopleLaunch.parse("search:"))
        assertNull(PeopleLaunch.parse("meet:"))
        assertNull(PeopleLaunch.parse("elsewhere"))
        assertNull(PeopleLaunch.parse(null))
    }

    @Test
    fun badgesAndTheirNames() {
        assertEquals("7", badgeText(7))
        assertEquals("99", badgeText(99))
        assertEquals("99+", badgeText(100))
        assertEquals("Requests", Strings.AppBar.requests(0))
        assertEquals("Requests, 3 new", Strings.AppBar.requests(3))
        assertEquals("People, 1 new request", Strings.Tabs.peopleWithCount(1))
        assertEquals("People, 2 new requests", Strings.Tabs.peopleWithCount(2))
    }
}
