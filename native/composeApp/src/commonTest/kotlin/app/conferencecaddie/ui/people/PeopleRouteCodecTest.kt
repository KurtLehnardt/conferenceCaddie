package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.AppLink
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

// The string a waiting people route is kept as in saved state.
class PeopleRouteCodecTest {
    private val routes = listOf(
        AppLink.PeopleRoute.Home(aroundNow = true),
        AppLink.PeopleRoute.Home(aroundNow = false),
        AppLink.PeopleRoute.Inbox,
        AppLink.PeopleRoute.Meet("m-42"),
        AppLink.PeopleRoute.Profile,
        AppLink.PeopleRoute.Here("Expo hall"),
        AppLink.PeopleRoute.Here("Hall B: level 2, east"),
        AppLink.PeopleRoute.Here(":leading and trailing:"),
    )

    @Test
    fun everyRouteComesBackAsItWas() {
        for (route in routes) assertEquals(route, decodePeopleRoute(encodePeopleRoute(route)), route.toString())
    }

    @Test
    fun aStringThatIsNoRouteDecodesToNull() {
        for (bad in listOf("", "nope", "home", "home:2", "meet:", "here:", "inbox:1", "profile:x")) {
            assertNull(decodePeopleRoute(bad), bad)
        }
    }
}
