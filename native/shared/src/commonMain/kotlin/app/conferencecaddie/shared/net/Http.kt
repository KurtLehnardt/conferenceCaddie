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

/** An answer: the status, the body bytes, and the headers the app uses. */
class HttpResponse(
    val status: Int,
    val body: ByteArray,
    val etag: String? = null,
    val cacheControl: String? = null,
) {
    /** The body as UTF-8 text, with malformed sequences replaced. */
    fun text(): String = body.decodeToString()

    /** `max-age` from Cache-Control in seconds, or null. */
    fun maxAgeSeconds(): Long? {
        val cc = cacheControl ?: return null
        return Regex("""(?:^|,)\s*max-age\s*=\s*"?(\d{1,9})"?\s*(?:,|$)""", RegexOption.IGNORE_CASE)
            .find(cc)?.groupValues?.get(1)?.toLongOrNull()
    }
}

class ResponseTooLarge(val limit: Long) : Exception("The response is larger than $limit bytes.")
