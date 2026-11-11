package app.conferencecaddie.shared

import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.HttpResponse
import app.conferencecaddie.shared.net.ResponseTooLarge
import kotlin.concurrent.atomics.AtomicReference
import kotlin.concurrent.atomics.ExperimentalAtomicApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay

/**
 * A stand-in for the network: a map from URL to an answer, an exception to throw, [Never] (a request
 * that never answers, like a black-holed network) or [Delayed]. Unknown URLs answer 404 with an
 * empty body. Every call is recorded.
 */
@OptIn(ExperimentalAtomicApi::class)
class FakeHttp(routes: Map<String, Any> = emptyMap()) : Http {
    /** The routes; replace or add one with `routes[url] = answer` at any time. */
    val routes = Routes(routes)

    class Routes(initial: Map<String, Any>) {
        private val table = AtomicReference(initial.toMap())

        operator fun get(url: String): Any? = table.load()[url]

        operator fun set(url: String, answer: Any) {
            while (true) {
                val before = table.load()
                if (table.compareAndSet(before, before + (url to answer))) break
            }
        }
    }

    // Requests can arrive from several threads at once.
    private val log = AtomicReference(emptyList<Pair<String, String?>>())
    val calls: List<String> get() = log.load().map { it.first }
    val conditional: List<String?> get() = log.load().map { it.second }

    override suspend fun get(url: String, ifNoneMatch: String?, maxBytes: Long): HttpResponse {
        while (true) {
            val before = log.load()
            if (log.compareAndSet(before, before + (url to ifNoneMatch))) break
        }
        var route = routes[url]
        if (route is Delayed) {
            delay(route.ms)
            route = route.answer
        }
        val answer = when (val r = route) {
            null -> HttpResponse(404, ByteArray(0))
            Never -> awaitCancellation()
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

    /** A request that never answers. */
    data object Never

    /** [answer] (any route value) after [ms] milliseconds. */
    class Delayed(val ms: Long, val answer: Any?)

    companion object {
        fun json(status: Int, body: String, etag: String? = null) = HttpResponse(status, body.encodeToByteArray(), etag)

        fun bytes(status: Int, body: ByteArray) = HttpResponse(status, body)
    }
}
