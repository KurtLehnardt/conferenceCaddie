package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

// A push token addresses one device, so its text form never shows it.
class PushTokenTest {
    private val apns = PushToken("apns", "a1".repeat(32), "sandbox")
    private val fcm = PushToken("fcm", "fcm-token_ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789")

    @Test
    fun theTextFormLeavesTheTokenOut() {
        assertEquals("PushToken(channel=apns, token=<redacted, 64 chars>, environment=sandbox)", apns.toString())
        assertEquals("PushToken(channel=fcm, token=<redacted, 47 chars>, environment=null)", fcm.toString())
        for (t in listOf(apns, fcm)) {
            assertFalse(t.token in t.toString())
            assertFalse(t.token.take(8) in t.toString())
            assertFalse(t.token in "$t")
            assertFalse(t.token in listOf(t).toString())
        }
    }

    @Test
    fun theDataClassStillComparesTheToken() {
        assertEquals(apns, apns.copy())
        assertNotEquals(apns, apns.copy(token = "b2".repeat(32)))
        assertEquals("a1".repeat(32), apns.token)
        assertTrue(apns.toString() == apns.copy(token = "b2".repeat(32)).toString())
    }
}
