package app.conferencecaddie.shared

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

class ServerUrlTest {
    private fun valid(input: String): String {
        val result = ServerUrl.normalize(input)
        assertIs<ServerUrl.Result.Valid>(result, "expected '$input' to be accepted")
        return result.origin
    }

    @Test
    fun addsHttpsAndDropsTrailingSlashes() {
        assertEquals("https://caddie.example.org", valid("  caddie.example.org/  "))
        assertEquals("https://caddie.example.org", valid("HTTPS://Caddie.Example.org//"))
    }

    @Test
    fun keepsPortsPathsAndPlainHttp() {
        assertEquals("http://10.0.2.2:8080", valid("http://10.0.2.2:8080/"))
        assertEquals("https://owner.github.io/repo", valid("https://owner.github.io/repo/"))
    }

    @Test
    fun rejectsEmptyOtherSchemesAndSpaces() {
        assertIs<ServerUrl.Result.Invalid>(ServerUrl.normalize("   "))
        assertIs<ServerUrl.Result.Invalid>(ServerUrl.normalize("ftp://example.org"))
        assertIs<ServerUrl.Result.Invalid>(ServerUrl.normalize("https://exa mple.org"))
        assertIs<ServerUrl.Result.Invalid>(ServerUrl.normalize("https:///path"))
    }
}
