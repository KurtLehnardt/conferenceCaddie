package app.conferencecaddie.shared.net

import app.conferencecaddie.shared.net.KtorHttp.Companion.configure
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.client.request.HttpResponseData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.writeFully
import io.ktor.utils.io.writer
import kotlin.concurrent.atomics.AtomicLong
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.TimeSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext

// KtorHttp against Ktor's mock engine: the size limit holds whether or not the host declares a
// length, If-None-Match goes out only when there is an ETag, and a 304 passes through. The People
// API requests (send) read through the same capped reader, and their time limit covers the answer.
@OptIn(ExperimentalAtomicApi::class)
class KtorHttpTest {
    private val url = "https://caddie.example/bundles/conferences.json"
    private val writers = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val requests = ArrayList<HttpRequestData>()

    @AfterTest
    fun cleanUp() = writers.cancel()

    private fun http(answer: suspend MockRequestHandleScope.(HttpRequestData) -> HttpResponseData): KtorHttp =
        KtorHttp(
            HttpClient(
                MockEngine { request ->
                    requests += request
                    answer(request)
                },
            ) { configure() },
        )

    // The engine's work runs on real threads, so the tests wait in real time too.
    private fun test(block: suspend () -> Unit) = runTest { withContext(Dispatchers.Default) { block() } }

    @Test
    fun aDeclaredLengthAboveTheLimitIsRefusedBeforeReading() = test {
        val h = http { respond(ByteArray(10), HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, "5000")) }
        val e = assertFailsWith<ResponseTooLarge> { h.get(url, null, maxBytes = 4096) }
        assertEquals(4096, e.limit)
    }

    @Test
    fun anEndlessBodyWithoutALengthIsCutOffAtTheLimit() = test {
        val written = AtomicLong(0)
        val chunk = ByteArray(64 * 1024) { 'x'.code.toByte() }
        val h = http {
            // No Content-Length: the body is a stream that never ends.
            val body = writers.writer {
                while (true) {
                    channel.writeFully(chunk, 0, chunk.size)
                    channel.flush()
                    written.fetchAndAdd(chunk.size.toLong())
                }
            }.channel
            respond(body, HttpStatusCode.OK)
        }
        val limit = 1L * 1024 * 1024
        assertFailsWith<ResponseTooLarge> { h.get(url, null, maxBytes = limit) }
        assertTrue(written.load() < 64L * 1024 * 1024, "the read stopped near the limit, not at the end of the body")
    }

    @Test
    fun aBodyOfExactlyTheLimitIsRead() = test {
        val bytes = ByteArray(300_000) { (it % 251).toByte() }
        val h = http { respond(ByteReadChannel(bytes), HttpStatusCode.OK) }
        val r = h.get(url, null, maxBytes = bytes.size.toLong())
        assertEquals(200, r.status)
        assertContentEquals(bytes, r.body)
        assertFailsWith<ResponseTooLarge> { h.get(url, null, maxBytes = bytes.size.toLong() - 1) }
    }

    @Test
    fun ifNoneMatchIsSentOnlyWithAnEtag() = test {
        val h = http { respond("{}", HttpStatusCode.OK) }
        h.get(url, "\"v1\"", maxBytes = 1024)
        h.get(url, null, maxBytes = 1024)
        assertEquals("\"v1\"", requests[0].headers[HttpHeaders.IfNoneMatch])
        assertNull(requests[1].headers[HttpHeaders.IfNoneMatch])
    }

    @Test
    fun aNotModifiedAnswerPassesThroughWithItsHeaders() = test {
        val h = http {
            respond(
                ByteArray(0),
                HttpStatusCode.NotModified,
                headersOf(HttpHeaders.ETag to listOf("\"v1\""), HttpHeaders.CacheControl to listOf("public, max-age=300")),
            )
        }
        val r = h.get(url, "\"v1\"", maxBytes = 1024)
        assertEquals(304, r.status)
        assertEquals(0, r.body.size)
        assertEquals("\"v1\"", r.etag)
        assertEquals(300L, r.maxAgeSeconds())
    }

    @Test
    fun theRequestTimeoutGrowsWithTheFileSize() {
        assertEquals(KtorHttp.REQUEST_TIMEOUT_MS, KtorHttp.requestTimeoutFor(64 * 1024))
        assertEquals(KtorHttp.REQUEST_TIMEOUT_MS, KtorHttp.requestTimeoutFor(400_000))
        // KubeCon's bundle.json is about 1.3 MB: 2 minutes and 46 seconds at 8 KB/s.
        assertEquals(166_000L, KtorHttp.requestTimeoutFor(1_365_000))
        // The conference list's cap keeps its timeout near two minutes.
        assertEquals(128_000L, KtorHttp.requestTimeoutFor(app.conferencecaddie.shared.bundle.BundleSync.MAX_INDEX_BYTES))
        // The largest file the app accepts (vectors.i8) may take over an hour at the slowest rate.
        assertEquals(4_096_000L, KtorHttp.requestTimeoutFor(app.conferencecaddie.shared.bundle.BundleSync.MAX_VECTOR_BYTES))
    }

    @Test
    fun aBodyOfTheDeclaredLengthIsReadIntoOneArray() = test {
        val bytes = ByteArray(200_000) { (it % 251).toByte() }
        val body = KtorHttp.readBounded(ByteReadChannel(bytes), maxBytes = 200_000, declared = 200_000)
        assertContentEquals(bytes, body)
    }

    @Test
    fun aBodyLongerThanDeclaredGrowsUpToTheLimit() = test {
        // A compressed body declares its compressed length; the read grows past it.
        val bytes = ByteArray(300_000) { 7 }
        assertContentEquals(bytes, KtorHttp.readBounded(ByteReadChannel(bytes), maxBytes = 300_000, declared = 1_000))
        assertContentEquals(bytes, KtorHttp.readBounded(ByteReadChannel(bytes), maxBytes = 1_000_000, declared = null))
        assertFailsWith<ResponseTooLarge> { KtorHttp.readBounded(ByteReadChannel(bytes), maxBytes = 299_999, declared = 299_999) }
        assertContentEquals(ByteArray(0), KtorHttp.readBounded(ByteReadChannel(ByteArray(0)), maxBytes = 10, declared = null))
    }

    private val api = "https://caddie.example/api/people/profile"

    @Test
    fun aPeopleRequestSendsItsMethodHeadersAndJsonOnly() = test {
        val h = http { respond("""{"ok":true}""", HttpStatusCode.OK, headersOf("X-Caddie-Pace" to listOf("2"), HttpHeaders.ContentType to listOf("application/json"))) }
        val r = h.send("PUT", api, mapOf("X-Caddie-Device" to "d.s", "Accept" to "application/json"), """{"event":"e"}""".encodeToByteArray(), timeoutMs = 5_000, maxBytes = 1024)
        assertEquals(200, r.status)
        assertEquals("""{"ok":true}""", r.text())
        assertEquals("2", r.header("x-caddie-pace"))
        val sent = requests.single()
        assertEquals("PUT", sent.method.value)
        assertEquals("d.s", sent.headers["X-Caddie-Device"])
        assertNull(sent.headers[HttpHeaders.Origin])
        assertNull(sent.headers[HttpHeaders.Cookie])
        assertEquals("application/json", sent.body.contentType?.toString())
    }

    @Test
    fun aPeopleAnswerAboveTheCapIsRefusedDeclaredOrNot() = test {
        val declared = http { respond(ByteArray(10), HttpStatusCode.OK, headersOf(HttpHeaders.ContentLength, "5000")) }
        assertFailsWith<ResponseTooLarge> { declared.send("GET", api, emptyMap(), null, timeoutMs = 5_000, maxBytes = 4096) }
        val undeclared = http { respond(ByteReadChannel(ByteArray(5000)), HttpStatusCode.OK) }
        assertFailsWith<ResponseTooLarge> { undeclared.send("GET", api, emptyMap(), null, timeoutMs = 5_000, maxBytes = 4096) }
    }

    @Test
    fun aPeopleAnswerThatStallsHalfwayRunsOutOfTime() = test {
        val h = http {
            // The headers and the start of the body arrive, then nothing more.
            val body = writers.writer {
                channel.writeFully("""{"results":[""".encodeToByteArray())
                channel.flush()
                awaitCancellation()
            }.channel
            respond(body, HttpStatusCode.OK)
        }
        val started = TimeSource.Monotonic.markNow()
        val e = assertFailsWith<RequestTimeout> { h.send("POST", api, emptyMap(), "{}".encodeToByteArray(), timeoutMs = 500, maxBytes = 1024) }
        assertEquals(500, e.limitMs)
        assertTrue(started.elapsedNow().inWholeMilliseconds < 10_000, "the limit ended the read")
        assertTrue(currentCoroutineContext().isActive, "the caller is not cancelled by the request's timeout")
    }

    @Test
    fun aPeopleRequestWithNoAnswerRunsOutOfTime() = test {
        val h = http { awaitCancellation() }
        assertFailsWith<RequestTimeout> { h.send("DELETE", api, emptyMap(), null, timeoutMs = 500, maxBytes = 1024) }
        assertTrue(currentCoroutineContext().isActive)
    }
}
