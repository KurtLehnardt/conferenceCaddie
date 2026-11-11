package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SecureStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

/**
 * A secure store that fails, as the Keychain does on an iPhone before its first unlock or in a build
 * without the Keychain entitlement, and as the Keystore can: the people features must keep running,
 * say why a write cannot be sent, and never mistake "cannot read" for "no credential".
 */
class SecureStoreFailureTest {
    private class FlakySecureStore : SecureStore {
        private val inner = InMemorySecureStore()
        var failing = false

        override suspend fun get(key: String): String? = if (failing) error("errSecInteractionNotAllowed") else inner.get(key)

        override suspend fun put(key: String, value: String) = if (failing) error("errSecInteractionNotAllowed") else inner.put(key, value)

        override suspend fun remove(key: String) = if (failing) error("errSecInteractionNotAllowed") else inner.remove(key)
    }

    @Test
    fun aFailingStoreStopsNothingAndAWriteSaysWhy() = runTest {
        val store = FlakySecureStore().apply { failing = true }
        val h = PeopleHarness(this, secure = store)
        h.start()
        assertEquals(PeopleAvailability.Ready, h.state.availability)
        assertFalse(h.state.hasDevice)
        h.named()
        assertEquals(PeopleError.SECURE_STORE_MESSAGE, h.controller.setOpenToMeet(true))
        runCurrent()
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty(), "nothing is sent without the credential")

        store.failing = false
        assertNull(h.controller.setOpenToMeet(true))
        runCurrent()
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        assertTrue(h.state.hasDevice)
    }

    @Test
    fun aDeleteWhileTheStoreFailsStaysPendingInsteadOfForgettingTheServerCopy() = runTest {
        val store = FlakySecureStore()
        val h = PeopleHarness(this, secure = store)
        h.start()
        h.visible()
        h.controller.close()

        // A relaunch: a new controller over the same records reads the credential from the store again.
        store.failing = true
        val again = PeopleController(h.kv, h.http, PeopleServices(store), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        again.updateContext(h.context())
        runCurrent()
        assertFalse(again.state.value.hasDevice)
        val result = again.deleteMyProfile()
        runCurrent()
        assertFalse(result.done, "not done: ${result.message}")
        assertTrue(h.sent("DELETE", "/api/people/profile").isEmpty(), "no delete goes out without the credential")
        assertTrue(again.state.value.deletes.unfinished, "the delete stays pending")

        store.failing = false
        assertTrue(again.finishPendingDeletes())
        runCurrent()
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size)
        assertFalse(again.state.value.deletes.unfinished, "finished: ${again.state.value.deletes}")
    }

    @Test
    fun aDeleteWhileTheStoreFailsSaysTheStoreIsUnavailableNotOffline() = runTest {
        val store = FlakySecureStore()
        val h = PeopleHarness(this, secure = store)
        h.start()
        h.visible()
        h.controller.close()

        store.failing = true
        val again = PeopleController(h.kv, h.http, PeopleServices(store), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        again.updateContext(h.context())
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()
        assertFalse(result.done)
        assertEquals(PeopleError.SECURE_STORE_MESSAGE, result.message)
        assertEquals(PeopleError.SECURE_STORE_MESSAGE, again.state.value.deletes.detail)
    }

    @Test
    fun aSearchWhileTheStoreFailsLeavesVisibilityAlone() = runTest {
        val store = FlakySecureStore()
        val h = PeopleHarness(this, secure = store)
        h.start()
        h.visible()
        h.controller.close()

        store.failing = true
        val again = PeopleController(h.kv, h.http, PeopleServices(store), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        again.updateContext(h.context())
        runCurrent()
        val res = again.searchPeople("kubernetes", around = false)
        runCurrent()
        val error = assertIs<ApiResult.Failed>(res).error
        assertEquals("secure_store", error.code)
        assertTrue(error.noAnswer, "a store failure reads like no answer, not like no device")
        assertTrue(h.sent("POST", "/api/people/matches").isEmpty())
        assertTrue(again.state.value.visibility.openToMeet, "the profile stays visible on the device")
    }
}
