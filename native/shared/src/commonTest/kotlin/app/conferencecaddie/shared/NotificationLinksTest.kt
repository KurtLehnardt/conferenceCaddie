package app.conferencecaddie.shared

import app.conferencecaddie.shared.people.ConnectRuntime
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// The allowlist of notification deep links: the exact links the app's notifications and the
// server's native pushes carry, and none of the near misses another app could hand over.
class NotificationLinksTest {
    @Test
    fun theLinksTheNotificationsCarryAreAccepted() {
        assertTrue(isNotificationDeepLink("caddie://people?around=1"))
        assertTrue(isNotificationDeepLink(ConnectRuntime.NUDGE_DEEP_LINK))
        assertTrue(isNotificationDeepLink("caddie://inbox"))
        // The server's meet ids: 16 random bytes in base64url.
        assertTrue(isNotificationDeepLink("caddie://meet/QEFCQ0RFRkdISUpLTE1OTw"))
        assertTrue(isNotificationDeepLink("caddie://meet/a"))
        assertTrue(isNotificationDeepLink("caddie://meet/Az09_-"))
        assertTrue(isNotificationDeepLink("caddie://meet/" + "a".repeat(128)))
    }

    @Test
    fun otherSchemesAndHostsAreRefused() {
        for (link in listOf(
            "",
            "caddie://",
            "caddie://people",
            "caddie://connect?url=https%3A%2F%2Fcaddie.example",
            "caddie://e/kubecon-2026#/people?around=1",
            "caddie://here/hall-a",
            "caddie://profile",
            "caddie://settings",
            "caddie://meets/abc",
            "caddie://inboxes",
            "caddie://peoples?around=1",
            "https://caddie.example.org/e/x#/people",
            "https://caddie.example/people?around=1",
            "javascript:alert(1)",
            "intent://inbox#Intent;scheme=caddie;end",
            "caddie:inbox",
            "caddie:/inbox",
            "caddie:///inbox",
            "caddie://user@inbox",
            "caddie://inbox:443",
        )) assertFalse(isNotificationDeepLink(link), link)
    }

    @Test
    fun anotherCaseIsRefused() {
        for (link in listOf(
            "CADDIE://inbox",
            "Caddie://inbox",
            "caddie://INBOX",
            "caddie://People?around=1",
            "caddie://people?Around=1",
            "caddie://MEET/abc",
        )) assertFalse(isNotificationDeepLink(link), link)
    }

    @Test
    fun extraPathSegmentsAndTrailingPartsAreRefused() {
        for (link in listOf(
            "caddie://inbox/",
            "caddie://inbox/x",
            "caddie://inbox#x",
            "caddie://people/?around=1",
            "caddie://people/x?around=1",
            "caddie://people?around=1#x",
            "caddie://people?around=1/",
            "caddie://meet/",
            "caddie://meet/abc/",
            "caddie://meet/abc/def",
            "caddie://meet/abc/../../connect",
            "caddie://meet/../inbox",
            "caddie://meet//abc",
            "caddie://meet/abc#x",
            "caddie://meet/abc.def",
            "caddie://meet/a b",
        )) assertFalse(isNotificationDeepLink(link), link)
    }

    @Test
    fun anyOtherQueryIsRefused() {
        for (link in listOf(
            "caddie://people?around=0",
            "caddie://people?around=1&url=https://elsewhere.example",
            "caddie://people?around=1&",
            "caddie://people?around=1;x",
            "caddie://people?x=1&around=1",
            "caddie://people??around=1",
            "caddie://people?around=11",
            "caddie://people?around=1 ",
            "caddie://inbox?url=https://elsewhere.example",
            "caddie://inbox?",
            "caddie://meet/abc?url=https://elsewhere.example",
            "caddie://meet/abc?",
        )) assertFalse(isNotificationDeepLink(link), link)
    }

    @Test
    fun encodedAndHiddenCharactersAreRefused() {
        for (link in listOf(
            "caddie://people%3Faround=1",
            "caddie://people?around%3D1",
            "caddie://people?around=%31",
            "caddie://%69nbox",
            "caddie://meet/%2e%2e%2fconnect",
            "caddie://meet/abc%2Fdef",
            "caddie://meet/abc%00",
            "caddie://inbox\u0000",
            "caddie://inbox\n",
            "caddie://meet/abc\n",
            "caddie://meet/abc\r\nX-Header: 1",
            " caddie://inbox",
            "caddie://inbox ",
            "​caddie://inbox",
            "caddie://inbox​",
            // Letters that only look like the ASCII ones.
            "caddie://inbоx",
            "caddie://meet/аbc",
            "caddie://meet/ａbc",
        )) assertFalse(isNotificationDeepLink(link), link)
    }

    @Test
    fun anOverlongLinkIsRefused() {
        assertFalse(isNotificationDeepLink("caddie://meet/" + "a".repeat(129)))
        assertFalse(isNotificationDeepLink("caddie://meet/" + "a".repeat(100_000)))
        assertFalse(isNotificationDeepLink("caddie://" + "a".repeat(600)))
        assertFalse(isNotificationDeepLink("caddie://people?around=1" + "&x".repeat(1_000)))
    }
}
