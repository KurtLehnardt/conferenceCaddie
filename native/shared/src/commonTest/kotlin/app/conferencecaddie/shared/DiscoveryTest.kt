package app.conferencecaddie.shared

import app.conferencecaddie.shared.CapabilitiesDiscovery.Result
import app.conferencecaddie.shared.CapabilitiesDiscovery.Source
import app.conferencecaddie.shared.FakeHttp.Companion.json
import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

// Discovery and the legacy backend (docs/contracts/capabilities.md), the cases of
// test/contracts-capabilities.test.mjs against a stand-in network.
class DiscoveryTest {
    private val legacySite = mapOf<String, Any>(
        "https://legacy.example/api/capabilities" to json(404, """{"error":"Not found"}"""),
        "https://legacy.example/capabilities.json" to json(200, "<html>"),
        "https://legacy.example/api/health" to json(200, """{"ok":true}"""),
    )

    @Test
    fun aTier2Or3BackendAnswersApiCapabilities() = runTest {
        val http = FakeHttp(mapOf("https://caddie.example/api/capabilities" to json(200, Fixtures.text("capabilities/tier3-paid.json"))))
        val r = assertIs<Result.Found>(CapabilitiesDiscovery.discover("https://caddie.example", http, hadDocument = false))
        assertEquals(Source.Api, r.source)
        assertEquals(Fixtures.asWritten(Fixtures.capabilities("tier3-paid.json")), r.capabilities.toJson())
        assertEquals(listOf("https://caddie.example/api/capabilities"), http.calls)
    }

    @Test
    fun aTier1StaticSiteAnswersCapabilitiesJsonUnderItsPath() = runTest {
        val base = "https://kurtlehnardt.github.io/conferenceCaddie"
        val http = FakeHttp(mapOf("$base/capabilities.json" to json(200, Fixtures.text("capabilities/tier1-demo.json"))))
        val r = assertIs<Result.Found>(CapabilitiesDiscovery.discover(base, http, hadDocument = false))
        assertEquals(Source.Static, r.source)
        assertEquals(false, r.capabilities.people.enabled)
        assertEquals(listOf("$base/api/capabilities", "$base/capabilities.json"), http.calls)
    }

    @Test
    fun theServers404BodyAndItsExactHealthAnswerAreTheLegacyServer() = runTest {
        val r = assertIs<Result.Found>(CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(legacySite), hadDocument = false))
        assertEquals(Source.Legacy, r.source)
        assertNull(r.document)
        assertEquals(Fixtures.asWritten(Fixtures.capabilities("legacy-effective.json")), r.capabilities.toJson())
    }

    @Test
    fun theLegacyProbeIsStrictAndNeverAppliesToABackendThatHadADocument() = runTest {
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(legacySite), hadDocument = true))
        val otherNotFound = legacySite + ("https://legacy.example/api/capabilities" to json(404, """{"message":"Not Found"}"""))
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(otherNotFound), hadDocument = false))
        val otherHealth = legacySite + ("https://legacy.example/api/health" to json(200, """{"ok":true,"version":"9"}"""))
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(otherHealth), hadDocument = false))
        val htmlNotFound = legacySite + ("https://legacy.example/api/capabilities" to json(404, "<html>Not found</html>"))
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(htmlNotFound), hadDocument = false))
        val stringOk = legacySite + ("https://legacy.example/api/health" to json(200, """{"ok":"true"}"""))
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://legacy.example", FakeHttp(stringOk), hadDocument = false))
    }

    @Test
    fun failuresNeverLookLikeLegacy() = runTest {
        val down = FakeHttp(
            mapOf(
                "https://caddie.example/api/capabilities" to json(503, """{"error":"down"}"""),
                "https://caddie.example/api/health" to json(200, """{"ok":true}"""),
            ),
        )
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://caddie.example", down, hadDocument = false))
        val offline = FakeHttp(
            mapOf(
                "https://caddie.example/api/capabilities" to IllegalStateException("fetch failed"),
                "https://caddie.example/capabilities.json" to IllegalStateException("fetch failed"),
            ),
        )
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://caddie.example", offline, hadDocument = false))
        val other = FakeHttp(mapOf("https://other.example/api/health" to json(200, """{"status":"ok"}""")))
        assertEquals(Result.Unreachable, CapabilitiesDiscovery.discover("https://other.example", other, hadDocument = false))
    }

    @Test
    fun aDocumentOnlyANewerAppCanReadAsksForAnUpdate() = runTest {
        val http = FakeHttp(mapOf("https://next.example/api/capabilities" to json(200, Fixtures.text("capabilities/too-new-v2.json"))))
        assertEquals(Result.UpdateApp, CapabilitiesDiscovery.discover("https://next.example", http, hadDocument = false))
    }

    @Test
    fun anInvalidApiAnswerFallsThroughToTheStaticFile() = runTest {
        val http = FakeHttp(
            mapOf(
                "https://mixed.example/api/capabilities" to json(200, "{}"),
                "https://mixed.example/capabilities.json" to json(200, Fixtures.text("capabilities/tier1-demo.json")),
            ),
        )
        assertEquals(Source.Static, assertIs<Result.Found>(CapabilitiesDiscovery.discover("https://mixed.example", http, hadDocument = false)).source)
    }

    @Test
    fun maxAgeIsReadFromCacheControl() = runTest {
        val response = app.conferencecaddie.shared.net.HttpResponse(
            200,
            Fixtures.bytes("capabilities/tier1-demo.json"),
            cacheControl = "public, max-age=300",
        )
        val http = FakeHttp(mapOf("https://c.example/api/capabilities" to response))
        assertEquals(300L, assertIs<Result.Found>(CapabilitiesDiscovery.discover("https://c.example", http, hadDocument = false)).maxAgeSeconds)
    }
}
