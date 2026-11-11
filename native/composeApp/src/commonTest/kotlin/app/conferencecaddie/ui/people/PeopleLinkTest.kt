package app.conferencecaddie.ui.people

import app.conferencecaddie.ui.components.badgeText
import app.conferencecaddie.ui.strings.Strings
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PeopleLinkTest {
    @Test
    fun theAppsOwnLinksAreRecognised() {
        assertEquals(PeopleLink.People(aroundNow = true), PeopleLink.parse("caddie://people?around=1"))
        assertEquals(PeopleLink.People(aroundNow = false), PeopleLink.parse("caddie://people"))
        assertEquals(PeopleLink.Inbox, PeopleLink.parse("caddie://inbox"))
        assertEquals(PeopleLink.Meet("m_42-AbC"), PeopleLink.parse("caddie://meet/m_42-AbC"))
    }

    @Test
    fun anythingElseIsIgnored() {
        assertNull(PeopleLink.parse("caddie://connect?url=https://x.example"))
        assertNull(PeopleLink.parse("https://caddie.example/people"))
        assertNull(PeopleLink.parse("caddie://meet/"))
        assertNull(PeopleLink.parse("caddie://meet/../../api/people/profile"))
        assertNull(PeopleLink.parse("caddie://meet/a%2Fb"))
        assertNull(PeopleLink.parse("caddie://meet/" + "x".repeat(129)))
        assertNull(PeopleLink.parse("caddie://here/expo-hall"))
    }

    @Test
    fun launchOptionsAreRead() {
        assertEquals(PeopleLaunch.Home, PeopleLaunch.parse("home"))
        assertEquals(PeopleLaunch.Around, PeopleLaunch.parse("around"))
        assertEquals(PeopleLaunch.Search("kubernetes scheduler"), PeopleLaunch.parse("search:kubernetes scheduler"))
        assertEquals(PeopleLaunch.Profile, PeopleLaunch.parse("profile"))
        assertEquals(PeopleLaunch.Inbox, PeopleLaunch.parse("inbox"))
        assertEquals(PeopleLaunch.Meet("m1"), PeopleLaunch.parse("meet:m1"))
        assertEquals(PeopleLaunch.SettingsPeople, PeopleLaunch.parse("settings-people"))
        assertNull(PeopleLaunch.parse("search:"))
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
