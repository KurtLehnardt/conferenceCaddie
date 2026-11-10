package app.conferencecaddie.shared

import app.conferencecaddie.shared.BackendUrl.Reason
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotEquals

class BackendUrlTest {
    private fun valid(input: String, allowLocalHttp: Boolean = false): BackendUrl.Valid {
        val result = BackendUrl.normalise(input, allowLocalHttp)
        assertIs<BackendUrl.Valid>(result, "expected '$input' to be accepted, got $result")
        return result
    }

    private fun reason(input: String, allowLocalHttp: Boolean = false): Reason {
        val result = BackendUrl.normalise(input, allowLocalHttp)
        assertIs<BackendUrl.Invalid>(result, "expected '$input' to be refused, got $result")
        return result.reason
    }

    // The cases from the contract's reference tests (test/contracts-capabilities.test.mjs).
    @Test
    fun contractCases() {
        val pages = valid("https://owner.github.io/conferenceCaddie/")
        assertEquals("https://owner.github.io/conferenceCaddie", pages.base)
        assertEquals("https://owner.github.io", pages.origin)

        val mixedCase = valid(" https://Caddie.Example ")
        assertEquals("https://caddie.example", mixedCase.base)
        assertEquals("https://caddie.example", mixedCase.origin)

        assertEquals(Reason.HttpsRequired, reason("http://caddie.example"))
        assertEquals(Reason.CredentialsNotAllowed, reason("https://user:pw@caddie.example"))
        assertEquals(Reason.QueryNotAllowed, reason("https://caddie.example/?x=1"))
        assertEquals(Reason.HttpsRequired, reason("ftp://caddie.example"))
        assertEquals(Reason.HttpsRequired, reason("http://localhost:8081"))
        assertEquals("http://localhost:8081", valid("http://localhost:8081", allowLocalHttp = true).base)
        assertEquals("http://10.0.2.2:8081", valid("http://10.0.2.2:8081", allowLocalHttp = true).base)
        assertEquals(Reason.HttpsRequired, reason("http://caddie.example", allowLocalHttp = true))
    }

    @Test
    fun localHttpCoversOnlyTheLoopbackAndEmulatorHosts() {
        assertEquals("http://127.0.0.1:8081", valid("http://127.0.0.1:8081", allowLocalHttp = true).base)
        assertEquals("http://[::1]:8081", valid("http://[::1]:8081/", allowLocalHttp = true).base)
        assertEquals(Reason.HttpsRequired, reason("http://192.168.1.10:8081", allowLocalHttp = true))
        assertEquals(Reason.HttpsRequired, reason("http://localhost.evil.example", allowLocalHttp = true))
    }

    @Test
    fun credentialsAreRefusedEvenWhenTheyLookLikeTheHost() {
        // The host is evil.example; "caddie.example" is only the user name.
        assertEquals(Reason.CredentialsNotAllowed, reason("https://caddie.example@evil.example"))
        assertEquals(Reason.CredentialsNotAllowed, reason("https://caddie.example:443@evil.example/"))
        assertEquals(Reason.CredentialsNotAllowed, reason("https://@caddie.example"))
    }

    @Test
    fun otherSchemesAreRefused() {
        assertEquals(Reason.HttpsRequired, reason("javascript:alert(1)"))
        assertEquals(Reason.HttpsRequired, reason("JavaScript://caddie.example/%0aalert(1)"))
        assertEquals(Reason.HttpsRequired, reason("data:text/html,hello"))
        assertEquals(Reason.HttpsRequired, reason("caddie://connect?url=https://caddie.example"))
    }

    @Test
    fun backslashesAndMalformedInputAreNotUrls() {
        assertEquals(Reason.NotAUrl, reason("https://evil.example\\@caddie.example"))
        assertEquals(Reason.NotAUrl, reason("https:\\\\caddie.example"))
        assertEquals(Reason.NotAUrl, reason("caddie.example"))
        assertEquals(Reason.NotAUrl, reason("   "))
        assertEquals(Reason.NotAUrl, reason("https://"))
        assertEquals(Reason.NotAUrl, reason("https:caddie.example"))
        assertEquals(Reason.NotAUrl, reason("https:///caddie.example"))
        assertEquals(Reason.NotAUrl, reason("https://exa mple.org"))
        assertEquals(Reason.NotAUrl, reason("https://caddie.example:99999"))
        assertEquals(Reason.NotAUrl, reason("https://caddie.example:44a"))
        assertEquals(Reason.NotAUrl, reason("https://127.1"))
        assertEquals(Reason.NotAUrl, reason("https://[2001:db8::1]"))
        assertEquals(Reason.NotAUrl, reason("https://caddié.example"))
        assertEquals(Reason.NotAUrl, reason("https://caddie.example/a/../b"))
        assertEquals(Reason.NotAUrl, reason("https://caddie.example/a/%2E%2E/b"))
        assertEquals(Reason.NotAUrl, reason("https://caddie.example/%zz"))
    }

    @Test
    fun defaultPortsAreDroppedAndOthersKept() {
        assertEquals("https://caddie.example", valid("https://Caddie.Example:443/").base)
        assertEquals("https://caddie.example", valid("https://caddie.example:0443").origin)
        assertEquals("http://localhost", valid("http://localhost:80", allowLocalHttp = true).base)
        assertEquals("https://caddie.example:8443", valid("https://caddie.example:8443/").base)
        assertEquals("https://caddie.example", valid("https://caddie.example:").base)
    }

    @Test
    fun queriesAndFragmentsAreRefused() {
        assertEquals(Reason.QueryNotAllowed, reason("https://caddie.example/#settings"))
        assertEquals(Reason.QueryNotAllowed, reason("https://caddie.example?"))
        assertEquals(Reason.QueryNotAllowed, reason("https://caddie.example#"))
        assertEquals(Reason.QueryNotAllowed, reason("https://owner.github.io/repo/?ref=x"))
    }

    @Test
    fun pathsAreKeptWithoutTrailingSlashes() {
        assertEquals("https://caddie.example", valid("https://caddie.example//").base)
        assertEquals("https://owner.github.io/repo/sub", valid("https://owner.github.io/repo/sub///").base)
        assertEquals("https://caddie.example/a%20b", valid("https://caddie.example/a%20b").base)
    }

    @Test
    fun secureStoreKeysAreScopedByBase() {
        val repoA = valid("https://owner.github.io/a")
        val repoB = valid("https://owner.github.io/b")
        assertNotEquals(SecureStore.scopedKey(repoA, "secret"), SecureStore.scopedKey(repoB, "secret"))
        assertEquals("https://owner.github.io/a#profile_id", SecureStore.scopedKey(repoA, "profile_id"))
        assertFailsWith<IllegalArgumentException> { SecureStore.scopedKey(repoA, "a#b") }
        assertFailsWith<IllegalArgumentException> { SecureStore.scopedKey(repoA, "") }
    }
}
