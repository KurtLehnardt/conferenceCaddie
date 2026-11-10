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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext

// KtorHttp against Ktor's mock engine: the size limit holds whether or not the host declares a
// length, If-None-Match goes out only when there is an ETag, and a 304 passes through.
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
        // The largest file the app accepts may take over two hours at the slowest rate.
        assertEquals(8_192_000L, KtorHttp.requestTimeoutFor(64L * 1024 * 1024))
    }
}
