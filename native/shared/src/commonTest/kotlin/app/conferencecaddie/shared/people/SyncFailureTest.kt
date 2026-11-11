package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import kotlin.time.Clock
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.datetime.TimeZone

/**
 * The sync's own work (the debounced save, the delete retries) and its write lock under failure:
 * a store that cannot write, and a lock handed over just as its wait ran out, leave nothing stuck,
 * and the next action works.
 */
class SyncFailureTest {
    /** Key-value storage whose writes fail while [failing], as a full disk or a broken database would. */
    private class FlakyKeyValue : PeopleKeyValue {
        private val inner = MapKeyValue()
        var failing = false

        override suspend fun get(key: String): String? = inner.get(key)

        override suspend fun set(key: String, value: String?) = if (failing) error("disk I/O error") else inner.set(key, value)
    }

    private class Setup(val h: PeopleHarness, val kv: FlakyKeyValue, val controller: PeopleController, val escaped: List<Throwable>)

    /** A controller over failing-on-demand storage whose scope collects any exception that escapes. */
    private suspend fun TestScope.setUp(): Setup {
        val h = PeopleHarness(this)
        val kv = FlakyKeyValue()
        val escaped = ArrayList<Throwable>()
        val scope = CoroutineScope(backgroundScope.coroutineContext + CoroutineExceptionHandler { _, e -> escaped += e })
        val c = PeopleController(kv, h.http, PeopleServices(h.secure), scope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        c.updateContext(h.context())
        runCurrent()
        c.updateProfile { it.copy(displayName = "Caddie Native Test A") }
        assertNull(c.setOpenToMeet(true))
        runCurrent()
        h.http.sent.clear()
        return Setup(h, kv, c, escaped)
    }

    @Test
    fun aDebouncedSaveTheStoreFailsEndsAsAnErrorAndTheNextEditIsSaved() = runTest {
        val t = setUp()
        val puts = { t.h.sent("PUT", "/api/people/profile").size }
        // The answer says the profile is now hidden after reports; storing that fails.
        t.h.server.profilePut = { FakeApiHttp.json(200, """{"ok":true,"open_to_meet":true,"shared_talk_ids":[],"hidden_for_owner":true}""") }
        t.controller.updateProfile { it.copy(about = "new") }
        t.kv.failing = true
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(1, puts())
        assertEquals(SyncStatus.State.Error, t.controller.state.value.sync.state, "not stuck at Saving")
        assertEquals(ProfileSync.GENERIC_MESSAGE, t.controller.state.value.sync.message)
        assertTrue(t.escaped.isEmpty(), "nothing escaped: ${t.escaped}")

        t.kv.failing = false
        t.h.server.profilePut = { t.h.server.echoProfile(it) }
        t.controller.updateProfile { it.copy(about = "newer") }
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(2, puts())
        assertEquals(SyncStatus.State.Saved, t.controller.state.value.sync.state)
    }

    @Test
    fun aVisibilityChangeTheStoreFailsDoesNotStayAtSaving() = runTest {
        val t = setUp()
        t.h.server.profilePut = { t.h.server.echoProfile(it) }
        t.kv.failing = true
        // The controller turns the failure into its generic message rather than throwing into the screen.
        assertEquals(ProfileSync.GENERIC_MESSAGE, t.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertEquals(SyncStatus.State.Error, t.controller.state.value.sync.state)

        t.kv.failing = false
        assertNull(t.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertEquals(SyncStatus.State.Saved, t.controller.state.value.sync.state)
    }

    @Test
    fun aRetryTheStoreFailsIsTriedAgainLater() = runTest {
        val t = setUp()
        val deletes = { t.h.sent("DELETE", "/api/people/profile").size }
        t.h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        t.controller.setOpenToMeet(false)
        assertEquals(1, deletes())
        assertTrue(t.controller.state.value.deletes.unfinished)

        // The retry after 30 s is sent, but storing how it went fails.
        t.kv.failing = true
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(2, deletes())
        assertTrue(t.escaped.isEmpty(), "nothing escaped: ${t.escaped}")
        assertTrue(t.controller.state.value.deletes.unfinished)

        // The retries carry on by themselves.
        t.kv.failing = false
        t.h.server.profileDelete = { t.h.server.ok() }
        advanceTimeBy(61_000)
        runCurrent()
        assertEquals(3, deletes())
        assertFalse(t.controller.state.value.deletes.unfinished)

        // Try again answers false, not an exception, while the store fails.
        t.h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        t.controller.setOpenToMeet(true)
        t.controller.setOpenToMeet(false)
        t.kv.failing = true
        assertFalse(t.controller.finishPendingDeletes())
        t.kv.failing = false
        t.h.server.profileDelete = { t.h.server.ok() }
        assertTrue(t.controller.finishPendingDeletes())
    }

    /** A write lock taken at once, but handed back to its first caller only after [lateMs]: its wait ran out meanwhile. */
    private class LateLock(private val lateMs: Long, private val inner: Mutex = Mutex()) : Mutex by inner {
        private var late = true

        override suspend fun lock(owner: Any?) {
            inner.lock(owner)
            if (late) {
                late = false
                withContext(NonCancellable) { delay(lateMs) }
            }
        }
    }

    private class Host(override val clock: Clock) : SyncHost {
        override val recordsInMemory = false

        override fun changed() = Unit

        override fun topicIds(slug: String): Set<String>? = null

        override fun selectedSlug(): String? = FIXTURE_SLUG

        override fun listedConferences(): List<ConferenceInfo>? = listOf(FIXTURE_CONFERENCE)

        override suspend fun presenceEndedOnServer(slug: String) = Unit

        override suspend fun stopRuntime(slug: String?) = Unit

        override suspend fun resetRuntime() = Unit

        override suspend fun pushDeletedOnServer(slug: String) = Unit

        override suspend fun forgetPush() = Unit
    }

    @Test
    fun aLockHandedOverAfterItsWaitRanOutIsGivenBack() = runTest {
        val clock = virtualClock()
        val server = StubPeopleServer(clock)
        val http = FakeApiHttp { server.handle(it) }
        val store = PeopleStore(MapKeyValue(), BACKEND.base).also { it.load() }
        store.setProfile(Profile(displayName = "Caddie Native Test A"))
        val credentials = DeviceCredentials(InMemorySecureStore(), BACKEND)
        val api = PeopleApi(http, BACKEND, { credentials.forRequest() }, Pace(clock), clock)
        val lock = LateLock(ProfileSync.SAVE_LOCK_WAIT_MS + 1_000)
        val sync = ProfileSync(store, api, credentials, backgroundScope, Host(clock), lock)

        val first = async { sync.changeVisibility(FIXTURE_SLUG, { it.copy(openToMeet = true) }) }
        advanceTimeBy(ProfileSync.SAVE_LOCK_WAIT_MS + 2_000)
        runCurrent()
        assertEquals(ProfileSync.LOCK_WAIT_MESSAGE, first.await())
        assertFalse(lock.isLocked, "the lock is free again")

        assertNull(sync.changeVisibility(FIXTURE_SLUG, { it.copy(openToMeet = true) }))
        assertEquals(1, http.sentTo("PUT", "/api/people/profile").size)
        assertFalse(lock.isLocked)
    }
}
