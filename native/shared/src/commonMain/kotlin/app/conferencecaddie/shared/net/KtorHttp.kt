package app.conferencecaddie.shared.net

import io.ktor.client.HttpClient
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.HttpResponse as KtorResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.readAvailable

/**
 * [Http] over Ktor. Redirects are followed only within https (Ktor's default refuses an https to
 * http downgrade). No cookies are stored and no credentials are sent: every request the app makes
 * is a public GET.
 */
class KtorHttp(private val client: HttpClient = HttpClient(platformEngine()) { configure() }) : Http {
    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse {
        val response: KtorResponse = client.get(url) {
            if (ifNoneMatch != null) header(HttpHeaders.IfNoneMatch, ifNoneMatch)
        }
        val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
        if (declared != null && declared > maxBytes) throw ResponseTooLarge(maxBytes)
        val channel = response.bodyAsChannel()
        val out = ArrayList<ByteArray>()
        var total = 0L
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val n = channel.readAvailable(buffer, 0, buffer.size)
            if (n < 0) break
            if (n == 0) {
                if (channel.isClosedForRead) break
                continue
            }
            total += n
            if (total > maxBytes) throw ResponseTooLarge(maxBytes)
            out += buffer.copyOf(n)
        }
        val body = ByteArray(total.toInt())
        var at = 0
        for (chunk in out) {
            chunk.copyInto(body, at)
            at += chunk.size
        }
        return HttpResponse(
            status = response.status.value,
            body = body,
            etag = response.headers[HttpHeaders.ETag],
            cacheControl = response.headers[HttpHeaders.CacheControl],
        )
    }

    fun close() = client.close()

    companion object {
        /** Connection and request timeouts for every request. */
        const val CONNECT_TIMEOUT_MS = 10_000L
        const val REQUEST_TIMEOUT_MS = 60_000L

        internal fun io.ktor.client.HttpClientConfig<*>.configure() {
            expectSuccess = false
            followRedirects = true
            install(HttpTimeout) {
                connectTimeoutMillis = CONNECT_TIMEOUT_MS
                requestTimeoutMillis = REQUEST_TIMEOUT_MS
                socketTimeoutMillis = CONNECT_TIMEOUT_MS * 3
            }
        }
    }
}

/** The platform's Ktor engine: OkHttp on Android and the JVM, NSURLSession on iOS. */
internal expect fun platformEngine(): io.ktor.client.engine.HttpClientEngineFactory<*>
