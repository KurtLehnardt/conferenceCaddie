package app.conferencecaddie.shared.net

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.readAvailable
import kotlinx.io.Buffer
import kotlinx.io.readByteArray

/**
 * [Http] over Ktor. Redirects are followed only within https (Ktor's default refuses an https to
 * http downgrade). No cookies are stored and no credentials are sent: every request the app makes
 * is a public GET.
 *
 * The body is streamed, never buffered by Ktor first: a declared `Content-Length` above the limit
 * is refused before anything is read, and an undeclared or false one stops the read as soon as the
 * bytes passed the limit. So a host that sends an endless body costs at most the limit in memory.
 */
class KtorHttp(private val client: HttpClient = HttpClient(platformEngine()) { configure() }) : Http {
    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse =
        client.prepareGet(url) {
            if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
            timeout { requestTimeoutMillis = requestTimeoutFor(maxBytes) }
        }.execute { response ->
            val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
            if (declared != null && declared > maxBytes) throw ResponseTooLarge(maxBytes)
            val channel = response.bodyAsChannel()
            val body = Buffer()
            val chunk = ByteArray(CHUNK_BYTES)
            var total = 0L
            while (true) {
                val n = channel.readAvailable(chunk, 0, chunk.size)
                if (n < 0) break
                if (n == 0) {
                    if (channel.isClosedForRead) break
                    continue
                }
                total += n
                if (total > maxBytes) throw ResponseTooLarge(maxBytes)
                body.write(chunk, 0, n)
            }
            HttpResponse(
                status = response.status.value,
                body = body.readByteArray(),
                etag = response.headers[HttpHeaders.ETag],
                cacheControl = response.headers[HttpHeaders.CacheControl],
            )
        }

    fun close() = client.close()

    companion object {
        /** Connection timeout, and the default whole-request timeout for small documents. */
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val REQUEST_TIMEOUT_MS = 60_000L

        /** A connection that sends nothing for this long fails, however long the transfer may take. */
        const val SOCKET_TIMEOUT_MS = CONNECT_TIMEOUT_MS * 3

        /**
         * The slowest average rate a large transfer may run at before its request timeout ends it:
         * 8 KB/s, slower than a crowded venue Wi-Fi in practice. A stall is caught sooner by
         * [SOCKET_TIMEOUT_MS].
         */
        const val MIN_BYTES_PER_SECOND = 8L * 1024

        private const val CHUNK_BYTES = 64 * 1024

        /**
         * The whole-request timeout of a GET that may read [maxBytes]: [REQUEST_TIMEOUT_MS] for a
         * small document, and long enough for [maxBytes] at [MIN_BYTES_PER_SECOND] for a large file,
         * so a bundle on a slow network is not cut off after a minute while it is still arriving.
         */
        fun requestTimeoutFor(maxBytes: Long): Long {
            val forSize = maxBytes.coerceAtLeast(0) / MIN_BYTES_PER_SECOND * 1000
            return maxOf(REQUEST_TIMEOUT_MS, forSize)
        }

        internal fun io.ktor.client.HttpClientConfig<*>.configure() {
            expectSuccess = false
            followRedirects = true
            install(HttpTimeout) {
                connectTimeoutMillis = CONNECT_TIMEOUT_MS
                requestTimeoutMillis = REQUEST_TIMEOUT_MS
                socketTimeoutMillis = SOCKET_TIMEOUT_MS
            }
        }
    }
}

/** The platform's Ktor engine: OkHttp on Android and the JVM, NSURLSession on iOS. */
internal expect fun platformEngine(): io.ktor.client.engine.HttpClientEngineFactory<*>
