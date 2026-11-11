package app.conferencecaddie.shared.net

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readAvailable

/**
 * [Http] over Ktor. Redirects are followed only within https (Ktor's default refuses an https to
 * http downgrade). No cookies are stored and no credentials are sent: every request the app makes
 * is a public GET.
 *
 * The body is streamed, never buffered by Ktor first: a declared `Content-Length` above the limit
 * is refused before anything is read, and an undeclared or false one stops the read as soon as the
 * bytes passed the limit. The bytes go straight into the array the caller gets, so a host that sends
 * an endless body costs at most the limit in memory, once.
 */
class KtorHttp(private val client: HttpClient = HttpClient(platformEngine()) { configure() }) : Http {
    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse =
        client.prepareGet(url) {
            if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
            timeout { requestTimeoutMillis = requestTimeoutFor(maxBytes) }
        }.execute { response ->
            val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
            if (declared != null && declared > maxBytes) throw ResponseTooLarge(maxBytes)
            HttpResponse(
                status = response.status.value,
                body = readBounded(response.bodyAsChannel(), maxBytes, declared),
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

        /**
         * The whole-request timeout of a GET that may read [maxBytes]: [REQUEST_TIMEOUT_MS] for a
         * small document, and long enough for [maxBytes] at [MIN_BYTES_PER_SECOND] for a large file,
         * so a bundle on a slow network is not cut off after a minute while it is still arriving.
         */
        fun requestTimeoutFor(maxBytes: Long): Long {
            val forSize = maxBytes.coerceAtLeast(0) / MIN_BYTES_PER_SECOND * 1000
            return maxOf(REQUEST_TIMEOUT_MS, forSize)
        }

        /**
         * Reads [channel] to its end into one array, throwing [ResponseTooLarge] as soon as it holds
         * more than [maxBytes]. The array starts at the [declared] length (the size a bundle file's
         * index entry gives, in practice), so a body of the expected size is read without a second
         * copy; it grows only when the body runs longer (a compressed body's length is its
         * compressed size), and never past [maxBytes].
         */
        internal suspend fun readBounded(channel: ByteReadChannel, maxBytes: Long, declared: Long?): ByteArray {
            val limit = maxBytes.coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
            var buffer = ByteArray((declared ?: FIRST_CHUNK_BYTES.toLong()).coerceIn(0, limit.toLong()).toInt())
            var size = 0
            val probe = ByteArray(1)
            while (true) {
                if (size == buffer.size) {
                    if (size >= limit) {
                        // Full to the limit: one more byte means the body is too large.
                        val n = channel.readAvailable(probe, 0, 1)
                        if (n > 0) throw ResponseTooLarge(maxBytes)
                        if (n < 0 || channel.isClosedForRead) break
                        continue
                    }
                    buffer = buffer.copyOf(minOf(limit.toLong(), maxOf(size * 2L, size + FIRST_CHUNK_BYTES.toLong())).toInt())
                }
                val n = channel.readAvailable(buffer, size, buffer.size - size)
                if (n < 0) break
                if (n == 0) {
                    if (channel.isClosedForRead) break
                    continue
                }
                size += n
            }
            return if (size == buffer.size) buffer else buffer.copyOf(size)
        }

        private const val FIRST_CHUNK_BYTES = 64 * 1024

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
