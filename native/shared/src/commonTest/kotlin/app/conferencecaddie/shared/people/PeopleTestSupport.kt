package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.LocationProvider
import app.conferencecaddie.shared.Notifier
import app.conferencecaddie.shared.PushRegistrar
import app.conferencecaddie.shared.PushToken
import app.conferencecaddie.shared.net.ApiHttp
import app.conferencecaddie.shared.net.HttpResponse
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One request the code under test sent. */
data class SentRequest(val method: String, val url: String, val headers: Map<String, String>, val body: String?, val timeoutMs: Long) {
    val path: String get() = url.substringAfter("://").substringAfter('/', "").let { "/" + it }.substringBefore('?')
    val query: String? get() = url.substringAfter('?', "").ifEmpty { null }
    val json: JsonElement? get() = body?.let { Json.parseToJsonElement(it) }
    val jsonObject: JsonObject get() = json as JsonObject
}

/**
 * A stand-in for the People API: [handler] answers each request, and every request is recorded.
 * The default handler answers 404 with an empty JSON object.
 */
class FakeApiHttp(var handler: suspend (SentRequest) -> HttpResponse = { json(404, "{}") }) : ApiHttp {
    val sent = ArrayList<SentRequest>()

    override suspend fun send(method: String, url: String, headers: Map<String, String>, body: ByteArray?, timeoutMs: Long, maxBytes: Long): HttpResponse {
        val r = SentRequest(method, url, headers, body?.decodeToString(), timeoutMs)
        sent += r
        return handler(r)
    }

    fun sentTo(method: String, path: String): List<SentRequest> = sent.filter { it.method == method && it.path == path }

    companion object {
        fun json(status: Int, body: String, headers: Map<String, String> = emptyMap()) =
            HttpResponse(status, body.encodeToByteArray(), headers = headers.mapKeys { it.key.lowercase() })
    }
}

/** A key-value store in memory. */
class MapKeyValue : PeopleKeyValue {
    val map = LinkedHashMap<String, String>()

    override suspend fun get(key: String): String? = map[key]

    override suspend fun set(key: String, value: String?) {
        if (value == null) map.remove(key) else map[key] = value
    }
}

class FakeLocation(var accessNow: LocationAccess = LocationAccess.NotAsked, var afterRequest: LocationAccess = LocationAccess.Precise) : LocationProvider {
    val flow = MutableSharedFlow<GeoFix>(extraBufferCapacity = 16)
    var requests = 0

    override fun access(): LocationAccess = accessNow

    override suspend fun requestAccess(): LocationAccess {
        requests++
        accessNow = afterRequest
        return accessNow
    }

    override fun fixes(): Flow<GeoFix> = flow
}

class FakeNotifier : Notifier {
    data class Shown(val id: String, val title: String, val body: String, val deepLink: String?)

    val shown = ArrayList<Shown>()

    override suspend fun requestPermission(): Boolean = true

    override fun show(id: String, title: String, body: String, deepLink: String?) {
        shown += Shown(id, title, body, deepLink)
    }

    override fun cancel(id: String) = Unit
}

class FakePush(override val channel: String?, private val token: PushToken?) : PushRegistrar {
    var registered = 0
    var unregistered = 0

    override suspend fun register(): PushToken? {
        registered++
        return token
    }

    override suspend fun unregister() {
        unregistered++
    }
}

/** A clock that follows the test scheduler's virtual time, starting at [startMs]. */
fun TestScope.virtualClock(startMs: Long = START_MS): Clock = object : Clock {
    override fun now(): Instant = Instant.fromEpochMilliseconds(startMs + testScheduler.currentTime)
}

/** 2026-11-10T17:00:00Z, during the fixture conference. */
const val START_MS = 1_794_330_000_000L

val BACKEND: BackendUrl.Valid = BackendUrl.normalise("https://caddie.example") as BackendUrl.Valid
const val SLUG = "kubecon-cloudnativecon-north-america-2026"

fun jsonString(s: String) = JsonPrimitive(s)
