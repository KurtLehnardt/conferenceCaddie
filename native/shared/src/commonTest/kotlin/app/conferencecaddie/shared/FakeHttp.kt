package app.conferencecaddie.shared

import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.net.ResponseTooLarge

/**
 * A stand-in for the network: a map from URL to an answer, or to an exception to throw. Unknown
 * URLs answer 404 with an empty body. Every call is recorded.
 */
class FakeHttp(routes: Map<String, Any> = emptyMap()) : Http {
    val routes: MutableMap<String, Any> = routes.toMutableMap()
    val calls = ArrayList<String>()
    val conditional = ArrayList<String?>()

    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse {
        calls += url
        conditional += ifNoneMatch
        val answer = when (val r = routes[url]) {
            null -> HttpResponse(404, ByteArray(0))
            is Exception -> throw r
            is HttpResponse -> r
            is Function1<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                (r as (String?) -> HttpResponse)(ifNoneMatch)
            }
            else -> error("bad route for $url")
        }
        if (answer.body.size > maxBytes) throw ResponseTooLarge(maxBytes)
        return answer
    }

    companion object {
        fun json(status: Int, body: String, etag: String? = null) = HttpResponse(status, body.encodeToByteArray(), etag)

        fun bytes(status: Int, body: ByteArray) = HttpResponse(status, body)
    }
}
