package app.conferencecaddie.shared.net

/**
 * The one thing the shared core needs from the network: a GET. [KtorHttp] implements it with Ktor;
 * tests implement it with a map of canned answers.
 */
fun interface Http {
    /**
     * Fetches [url]. [ifNoneMatch] is sent as `If-None-Match` when it is not null. At most
     * [maxBytes] of the body are read; a longer body throws [ResponseTooLarge], so a hostile or
     * broken host cannot make the app read without end. Throws on a network failure or a timeout.
     */
    suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse
}

/**
 * Requests with a method, headers and a JSON body, for the People API ([app.conferencecaddie.shared.people.PeopleApi]).
 * [KtorHttp] implements it next to [Http]; tests implement it with canned answers.
 *
 * An implementation sends exactly the headers it is given, with `Content-Type: application/json`
 * added when there is a body, and nothing else of its own: no `Origin` (the People API accepts a
 * request without one, and the native apps never send one), no cookies and no credentials.
 */
fun interface ApiHttp {
    /**
     * Sends [method] to [url] with [headers] and, when it is not null, [body] as JSON. The whole
     * exchange, reading the answer included, is limited to [timeoutMs]; when that runs out it throws
     * [RequestTimeout]. At most [maxBytes] of the answer are read; a longer one throws
     * [ResponseTooLarge]. Throws on a network failure. A status other than 2xx is an answer, not an
     * exception.
     */
    suspend fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long, maxBytes: Long): HttpResponse
}

/**
 * An answer: the status, the body bytes, and the headers the app uses. [headers] holds every
 * response header under its lowercased name, several values joined with ", "; it is empty for the
 * GETs of the bundle code, which read only [etag] and [cacheControl].
 */
class HttpResponse(
    val status: Int,
    val body: ByteArray,
    val etag: String? = null,
    val cacheControl: String? = null,
    val headers: Map<String, String> = emptyMap(),
) {
    /** The body as UTF-8 text, with malformed sequences replaced. */
    fun text(): String = body.decodeToString()

    /** The header [name] (any case), or null. */
    fun header(name: String): String? = headers[name.lowercase()]

    /** `max-age` from Cache-Control in seconds, or null. */
    fun maxAgeSeconds(): Long? {
        val cc = cacheControl ?: return null
        return Regex("""(?:^|,)\s*max-age\s*=\s*"?(\d{1,9})"?\s*(?:,|$)""", RegexOption.IGNORE_CASE)
            .find(cc)?.groupValues?.get(1)?.toLongOrNull()
    }
}

class ResponseTooLarge(val limit: Long) : Exception("The response is larger than $limit bytes.")

/** The request's time limit ran out before the answer was read in full. */
class RequestTimeout(val limitMs: Long) : Exception("The server did not answer within $limitMs ms.")
