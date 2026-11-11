package app.conferencecaddie.ui.platform

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

// A tapped notification's userInfo, as the app delegate passes it: only the exact links the app's
// notifications carry reach the link hand-off, the same one onOpenURL feeds. On the iOS simulator.
class IosNotificationTapTest {
    @BeforeTest
    @AfterTest
    fun nothingWaiting() = IncomingHandoff.clear()

    private fun tap(userInfo: Map<Any?, *>): String? {
        IncomingHandoff.clear()
        openNotificationTap(userInfo)
        return (IncomingHandoff.latest.value as? Incoming.Link)?.url
    }

    @Test
    fun theAppsOwnLinksAreHandedOver() {
        for (link in listOf("caddie://people?around=1", "caddie://inbox", "caddie://meet/QEFCQ0RFRkdISUpLTE1OTw")) {
            assertEquals(link, tap(mapOf("deepLink" to link)), link)
        }
        // Other keys of a remote notification (the aps dictionary) are left alone.
        assertEquals("caddie://inbox", tap(mapOf("aps" to mapOf("alert" to "Hi"), "deepLink" to "caddie://inbox")))
    }

    @Test
    fun anythingElseIsNot() {
        for (userInfo in listOf<Map<Any?, Any?>>(
            emptyMap(),
            mapOf("deepLink" to null),
            mapOf("deepLink" to 42),
            mapOf("link" to "caddie://inbox"),
            mapOf("deepLink" to "caddie://connect?url=https%3A%2F%2Felsewhere.example"),
            mapOf("deepLink" to "caddie://e/kubecon-2026#/inbox"),
            mapOf("deepLink" to "caddie://people"),
            mapOf("deepLink" to "caddie://people?around=1&x=1"),
            mapOf("deepLink" to "CADDIE://inbox"),
            mapOf("deepLink" to "https://elsewhere.example/"),
        )) {
            assertNull(tap(userInfo), userInfo.toString())
        }
    }

    @Test
    fun aNewerTapReplacesOneNotTakenYet() {
        openNotificationTap(mapOf("deepLink" to "caddie://inbox"))
        openNotificationTap(mapOf("deepLink" to "caddie://meet/abc"))
        assertEquals("caddie://meet/abc", assertIs<Incoming.Link>(IncomingHandoff.latest.value).url)
    }
}
