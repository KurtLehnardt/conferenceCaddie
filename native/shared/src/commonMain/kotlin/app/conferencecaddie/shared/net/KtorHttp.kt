package app.conferencecaddie.shared.net

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.timeout
import io.ktor.client.request.header
import io.ktor.client.request.prepareGet
import io.ktor.client.request.prepareRequest
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse as KtorResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.content.ByteArrayContent
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.readAvailable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive

/**
 * [Http] and [ApiHttp] over Ktor. No cookies are stored (no cookie plugin is installed, OkHttp keeps
 * none, and the iOS engine is set up without cookie storage), no answer is cached (OkHttp has no
 * cache configured, and the iOS engine has no URL cache), and nothing is sent that the caller did
 * not ask for: no `Origin`, no credentials of Ktor's own.
 *
 * Redirects differ between the two:
 * - [get] (the bundle code and capabilities discovery) follows them, only within https (Ktor's
 *   default refuses an https to http downgrade). These requests are public GETs that carry no
 *   credential, so the host a redirect points to learns nothing it could not fetch itself, and a
 *   static host may redirect (a moved file, a custom domain).
 * - [send] (the People API) follows none: a 3xx is returned as the answer, which the People API
 *   client turns into a failed call like any other status outside 2xx. Ktor removes only
 *   `Authorization` when a redirect leaves the host, so following one would hand the device's
 *   `X-Caddie-Device` credential to whatever host the `Location` header names. The People API never
 *   answers with a redirect, so one only comes from something between the app and the server.
 * Neither engine follows a redirect on its own: Ktor sets up OkHttp and NSURLSession not to, and
 * leaves it to its HttpRedirect plugin, which [send]'s client does not install.
 *
 * The body is streamed, never buffered by Ktor first: a declared `Content-Length` above the limit
 * is refused before anything is read, and an undeclared or false one stops the read as soon as the
 * bytes passed the limit. The bytes go straight into the array the caller gets, so a host that sends
 * an endless body costs at most the limit in memory, once.
 */
class KtorHttp(private val client: HttpClient = HttpClient(platformEngine()) { configure() }) : Http, ApiHttp {
    /**
     * The client of [send]: [client]'s engine and settings without the redirect plugin, so a 3xx
     * reaches the caller as it is and no request goes to the host it names.
     */
    private val apiClient: HttpClient = client.config { followRedirects = false }

    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse =
        client.prepareGet(url) {
            if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
            timeout { requestTimeoutMillis = requestTimeoutFor(maxBytes) }
        }.execute { response ->
            HttpResponse(
                status = response.status.value,
                body = readCapped(response, maxBytes),
                etag = response.headers[HttpHeaders.ETag],
                cacheControl = response.headers[HttpHeaders.CacheControl],
            )
        }

    override suspend fun send(
        method: String,
        url: String,
        headers: Map<String, String>,
        body: ByteArray?,
        timeoutMs: Long,
        maxBytes: Long,
    ): HttpResponse {
        // As get(): the whole-request timeout through Ktor's HttpTimeout, here the caller's limit
        // rather than one that grows with the size (a People API answer is small, and the web waits
        // 20 or 30 seconds), with the connect and socket timeouts every request has. The request
        // timeout lasts until the body has been read, so a server that stalls in the middle of its
        // answer cannot hold the request open either (the web's WRITE_TIMEOUT_MS works the same way).
        // The body goes through the same capped reader.
        return try {
            apiClient.prepareRequest(url) {
                this.method = HttpMethod.parse(method)
                timeout { requestTimeoutMillis = timeoutMs }
                for ((name, value) in headers) header(name, value)
                if (body != null) setBody(ByteArrayContent(body, ContentType.Application.Json))
            }.execute { response ->
                HttpResponse(
                    status = response.status.value,
                    body = readCapped(response, maxBytes),
                    headers = response.headers.entries().associate { (name, values) -> name.lowercase() to values.joinToString(", ") },
                )
            }
        } catch (e: HttpRequestTimeoutException) {
            throw RequestTimeout(timeoutMs)
        } catch (e: CancellationException) {
            // An engine may end a body read cut short by the request timeout with the cancellation
            // that carries it. That is this request's timeout, not the caller's cancellation, as
            // long as the caller is still active.
            if (currentCoroutineContext().isActive && generateSequence<Throwable>(e) { it.cause }.any { it is HttpRequestTimeoutException }) {
                throw RequestTimeout(timeoutMs)
            }
            throw e
        }
    }

    fun close() {
        apiClient.close()
        client.close()
    }

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

        /**
         * Streams the body of [response], throwing [ResponseTooLarge] as soon as it passes
         * [maxBytes], or before reading anything when the declared `Content-Length` already does.
         */
        private suspend fun readCapped(response: KtorResponse, maxBytes: Long): ByteArray {
            val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
            if (declared != null && declared > maxBytes) throw ResponseTooLarge(maxBytes)
            return readBounded(response.bodyAsChannel(), maxBytes, declared)
        }
    }
}

/** The platform's Ktor engine: OkHttp on Android and the JVM, NSURLSession on iOS. */
internal expect fun platformEngine(): io.ktor.client.engine.HttpClientEngineFactory<*>
