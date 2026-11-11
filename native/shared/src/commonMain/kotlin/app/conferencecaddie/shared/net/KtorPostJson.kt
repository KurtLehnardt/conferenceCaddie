package app.conferencecaddie.shared.net

import io.ktor.client.HttpClient
import io.ktor.client.plugins.timeout
import io.ktor.client.request.preparePost
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.content.ByteArrayContent

/**
 * A POST with a JSON body, for the backend routes the talk features use besides the GETs of [Http]:
 * so far only `POST /api/import/schedule`. Tests implement it with canned answers.
 */
fun interface PostJson {
    /**
     * Sends [body] as `application/json` to [url] and reads at most [maxBytes] of the answer (a
     * longer one throws [ResponseTooLarge]). The whole exchange is limited to [timeoutMs]. Throws on a
     * network failure or a timeout; a status other than 2xx is an answer, not an exception.
     */
    suspend fun post(url: String, body: ByteArray, timeoutMs: Long, maxBytes: Long): HttpResponse
}

/**
 * [PostJson] over Ktor, with the same engine and settings as [KtorHttp]: no cookies, no credentials
 * and no `Origin`, redirects only within https (and never for a POST), and the answer streamed into
 * one bounded array.
 */
class KtorPostJson(
    private val client: HttpClient = HttpClient(platformEngine()) {
        val config = this
        with(KtorHttp) { config.configure() }
    },
) : PostJson {
    override suspend fun post(url: String, body: ByteArray, timeoutMs: Long, maxBytes: Long): HttpResponse =
        client.preparePost(url) {
            setBody(ByteArrayContent(body, ContentType.Application.Json))
            timeout { requestTimeoutMillis = timeoutMs }
        }.execute { response ->
            val declared = response.headers[HttpHeaders.ContentLength]?.toLongOrNull()
            if (declared != null && declared > maxBytes) throw ResponseTooLarge(maxBytes)
            HttpResponse(
                status = response.status.value,
                body = KtorHttp.readBounded(response.bodyAsChannel(), maxBytes, declared),
            )
        }

    fun close() = client.close()
}
