package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

// Connect deep links and QR codes (docs/contracts/capabilities.md): https only, with a
// confirmation that names the whole base, as parseConnectLink() in the reference does.
class ConnectLinkTest {
    private fun encode(s: String) = s.replace("%", "%25").replace(":", "%3A").replace("/", "%2F").replace("?", "%3F")

    @Test
    fun aLinkNamesTheBaseInItsPrompt() {
        val ok = assertIs<ConnectLink.Confirm>(ConnectLink.parse("caddie://connect?url=${encode("https://caddie.example/")}"))
        assertEquals("https://caddie.example", ok.backend.base)
        assertEquals("https://caddie.example", ok.backend.origin)
        assertEquals("Switch to the server at https://caddie.example?", ok.prompt)
        val pages = assertIs<ConnectLink.Confirm>(
            ConnectLink.parse("caddie://connect?url=${encode("https://kurtlehnardt.github.io/conferenceCaddie/")}"),
        )
        assertEquals("https://kurtlehnardt.github.io/conferenceCaddie", pages.backend.base)
        assertEquals("Switch to the server at https://kurtlehnardt.github.io/conferenceCaddie?", pages.prompt)
        // An unencoded URL works too, as URLSearchParams reads it.
        assertIs<ConnectLink.Confirm>(ConnectLink.parse("caddie://connect?url=https://caddie.example"))
    }

    @Test
    fun plainHttpIsRefusedEvenForLocalHosts() {
        assertEquals(ConnectLink.Refused("https_required"), ConnectLink.parse("caddie://connect?url=${encode("http://caddie.example")}"))
        assertEquals(ConnectLink.Refused("https_required"), ConnectLink.parse("caddie://connect?url=${encode("http://localhost:8081")}"))
    }

    @Test
    fun otherLinksAreRefused() {
        assertEquals(ConnectLink.Refused("missing_url"), ConnectLink.parse("caddie://connect"))
        assertEquals(ConnectLink.Refused("missing_url"), ConnectLink.parse("caddie://connect?url="))
        assertEquals(ConnectLink.Refused("not_a_connect_link"), ConnectLink.parse("https://caddie.example/connect?url=https://x.example"))
        assertEquals(ConnectLink.Refused("not_a_connect_link"), ConnectLink.parse("caddie://other?url=https://x.example"))
        assertEquals(ConnectLink.Refused("not_a_link"), ConnectLink.parse("connect"))
        assertEquals(
            ConnectLink.Refused("credentials_not_allowed"),
            ConnectLink.parse("caddie://connect?url=${encode("https://u:p@caddie.example")}"),
        )
    }
}
