package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NotificationLinksTest {
    @Test
    fun onlyTheAppsOwnLinksAreHandedOver() {
        assertTrue(isNotificationDeepLink("caddie://people?around=1"))
        assertTrue(isNotificationDeepLink("caddie://inbox"))
        assertTrue(isNotificationDeepLink("caddie://meet/abc"))
        assertFalse(isNotificationDeepLink("https://caddie.example.org/e/x#/people"))
        assertFalse(isNotificationDeepLink("javascript:alert(1)"))
        assertFalse(isNotificationDeepLink("CADDIE://inbox"))
        assertFalse(isNotificationDeepLink("caddie://" + "a".repeat(600)))
    }
}
