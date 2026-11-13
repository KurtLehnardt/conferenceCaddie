package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.GeoFix
import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.LocationAccess
import app.conferencecaddie.shared.LocationProvider
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleKeyValue
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.datetime.TimeZone

/**
 * A [PeopleKeyValue] in memory; [map] shows what the controller stored. While [failWrites] is true
 * every write throws and stores nothing, as a full disk's does.
 */
class InMemoryPeopleKeyValue : PeopleKeyValue {
    val map = LinkedHashMap<String, String>()

    @kotlin.concurrent.Volatile
    var failWrites = false

    override suspend fun get(key: String): String? = map[key]

    override suspend fun set(key: String, value: String?) {
        if (failWrites) error("disk I/O error")
        if (value == null) map.remove(key) else map[key] = value
    }
}

/** A clock the test moves: [ms] is the epoch milliseconds now, and [advance] moves it on. Give the fake server `{ clock.ms }`. */
class TestClock(var ms: Long = START_MS) : Clock {
    override fun now(): Instant = Instant.fromEpochMilliseconds(ms)

    fun advance(deltaMs: Long) {
        ms += deltaMs
    }

    companion object {
        /** 2099-03-03T10:00:00Z, the day of the Alpha conference of [app.conferencecaddie.ui.talks.TestBackend]. */
        const val START_MS = 4_076_215_200_000L
    }
}

/** A location provider with a permission the test sets; [emit] feeds it a fix. */
class FakeDeviceLocation(var access: LocationAccess = LocationAccess.Precise) : LocationProvider {
    private val flow = MutableSharedFlow<GeoFix>(extraBufferCapacity = 16)

    override fun access(): LocationAccess = access

    override suspend fun requestAccess(): LocationAccess = access

    override fun fixes(): Flow<GeoFix> = flow

    fun emit(fix: GeoFix) {
        flow.tryEmit(fix)
    }
}

/**
 * A [PeopleController] wired to [server] as its [app.conferencecaddie.shared.net.ApiHttp], on [clock]
 * and [scope], with a UTC time zone and `allowLocalHttp` off. Give it a context with
 * [PeopleController.updateContext], or follow a real CaddieCore built on TestBackend with
 * [PeopleController.bind].
 */
fun testPeopleController(
    server: FakePeopleServer,
    scope: CoroutineScope,
    clock: Clock,
    keyValue: PeopleKeyValue = InMemoryPeopleKeyValue(),
    services: PeopleServices = PeopleServices(InMemorySecureStore()),
): PeopleController = PeopleController(keyValue, server, services, scope, allowLocalHttp = false, clock = clock, timeZone = TimeZone.UTC)

/** The backend of [app.conferencecaddie.ui.talks.TestBackend] as the controller's context wants it. */
fun testBackendUrl(base: String = "https://caddie.test"): BackendUrl.Valid = BackendUrl.normalise(base) as BackendUrl.Valid
