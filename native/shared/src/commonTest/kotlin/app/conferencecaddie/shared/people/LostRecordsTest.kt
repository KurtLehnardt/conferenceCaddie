package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SecureStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

/**
 * The records and the device's key are kept apart (the database and the secure store), and either
 * can be lost without the other. Records lost while the key survives (a database replaced after it
 * could not be opened, an iPhone app installed again, which keeps the Keychain) no longer say where
 * the profile is, so "Delete my profile" reaches every conference still running and keeps the key
 * until a delete is confirmed. Records that came without their key (a restore to a new phone)
 * describe a profile this phone can no longer reach: the device stops treating it as its own and
 * says so, and makes a new one only when the user turns visibility on again.
 */
class LostRecordsTest {
    private val credentialKey = SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)
    private val ended = ConferenceInfo("ended-conf", "Ended Conference", "UTC", "2026-10-01", "2026-10-03")
    private val upcoming = ConferenceInfo("upcoming-conf", "Upcoming Conference", "Europe/Amsterdam", "2027-03-01", "2027-03-04")

    private fun TestScope.relaunch(h: PeopleHarness, kv: PeopleKeyValue, secure: SecureStore = h.secure) =
        PeopleController(kv, h.http, PeopleServices(secure), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)

    /** A harness whose profile was made visible at the fixture conference by a launch now closed. */
    private suspend fun TestScope.madeVisible(): PeopleHarness {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.close()
        h.http.sent.clear()
        return h
    }

    private fun deletes(h: PeopleHarness) = h.sent("DELETE", "/api/people/profile")

    @Test
    fun withTheRecordsLostDeleteMyProfileReachesEveryRunningConferenceWithTheOldKey() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))

        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(listed = listOf(ended, FIXTURE_CONFERENCE, upcoming)))
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()

        assertTrue(result.done, result.message)
        assertEquals(ProfileSync.DELETED_MESSAGE, result.message)
        assertEquals(setOf("event=$FIXTURE_SLUG", "event=upcoming-conf"), deletes(h).map { it.query }.toSet(), "the selected and the upcoming one; not the ended one")
        assertEquals(2, deletes(h).size)
        assertTrue(deletes(h).all { it.headers[PeopleApi.DEVICE_HEADER] == key }, "sent with the key the profile was made with")
        assertNull(h.secure.get(credentialKey), "the key goes once the server confirmed")
        assertFalse(again.state.value.deletes.unfinished)
    }

    @Test
    fun withoutAConfirmedDeleteTheKeyStaysAndNothingIsClaimed() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))
        h.server.profileDelete = { FakeApiHttp.json(502, """{"error":"People are temporarily unavailable"}""") }

        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(listed = listOf(FIXTURE_CONFERENCE, upcoming)))
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()

        assertFalse(result.done)
        assertFalse("from our server" in result.message, result.message)
        assertEquals(2, deletes(h).size)
        assertEquals(key, h.secure.get(credentialKey))
        assertTrue(again.state.value.deletes.deleteAll, "Delete my profile stays, and is tried again")

        // The retries send only what is still unconfirmed, and the key goes after.
        h.server.profileDelete = { h.server.ok() }
        assertTrue(again.finishPendingDeletes())
        assertEquals(4, deletes(h).size)
        assertNull(h.secure.get(credentialKey))
    }

    @Test
    fun manyConferencesAreReachedAcrossPassesWhenTheServerLimitsWrites() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))
        val more = (1..5).map { ConferenceInfo("upcoming-$it", "Upcoming $it", "UTC", "2027-0$it-01", "2027-0$it-03") }
        var answered = 0
        h.server.profileDelete = {
            if (++answered > 3) FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "60")) else h.server.ok()
        }

        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(listed = listOf(FIXTURE_CONFERENCE) + more))
        runCurrent()
        val first = again.deleteMyProfile()
        runCurrent()
        assertFalse(first.done)
        assertTrue(first.message.startsWith("Too many requests right now"), first.message)
        assertEquals(4, deletes(h).size, "the pass stops at the first refusal")
        assertEquals(key, h.secure.get(credentialKey))

        h.server.profileDelete = { h.server.ok() }
        assertTrue(again.finishPendingDeletes())
        val sent = deletes(h).map { it.query }
        assertEquals(7, sent.size, "only the three not yet confirmed are sent again: $sent")
        assertEquals((listOf(FIXTURE_SLUG) + more.map { it.slug }).map { "event=$it" }.toSet(), sent.toSet())
        assertNull(h.secure.get(credentialKey))
    }

    @Test
    fun aKnownEmptyConferenceListLetsTheDeleteFinish() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))

        // The backend answered, and lists no conference: that is a known list, not a missing one.
        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(listed = emptyList(), listKnown = true))
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()

        assertTrue(result.done, result.message)
        assertEquals(listOf("event=$FIXTURE_SLUG"), deletes(h).map { it.query })
        assertNull(h.secure.get(credentialKey))
        assertFalse(again.state.value.deletes.unfinished)
        assertNotNull(key)
    }

    @Test
    fun withTheListUnknownAndNoConferenceNothingIsSentAndTheKeyStays() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))

        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(conference = null, listed = emptyList(), listKnown = false))
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()

        assertFalse(result.done)
        assertTrue(result.message.startsWith("The app needs the list of conferences"), result.message)
        assertTrue("your profile was not deleted yet" in result.message, result.message)
        assertTrue(deletes(h).isEmpty())
        assertEquals(key, h.secure.get(credentialKey), "no key goes on the strength of nothing")
        assertTrue(again.state.value.deletes.deleteAll)

        // Once the list is known, Try again reaches it.
        again.updateContext(h.context())
        runCurrent()
        assertTrue(again.finishPendingDeletes())
        assertEquals(listOf("event=$FIXTURE_SLUG"), deletes(h).map { it.query })
        assertNull(h.secure.get(credentialKey))
    }

    @Test
    fun withTheListUnknownTheSelectedConferenceIsDeletedButTheKeyStaysUntilTheListIsKnown() = runTest {
        val h = madeVisible()
        val key = assertNotNull(h.secure.get(credentialKey))

        val again = relaunch(h, MapKeyValue())
        again.updateContext(h.context().copy(listed = emptyList(), listKnown = false))
        runCurrent()
        val result = again.deleteMyProfile()
        runCurrent()

        assertFalse(result.done)
        assertTrue("deleting your profile has not finished" in result.message, result.message)
        assertFalse("deleted from our server" in result.message, result.message)
        assertEquals(listOf("event=$FIXTURE_SLUG"), deletes(h).map { it.query })
        assertEquals(key, h.secure.get(credentialKey))

        // The list arrives; the retry the app runs on its own finishes the delete.
        again.updateContext(h.context().copy(listed = listOf(FIXTURE_CONFERENCE, upcoming)))
        runCurrent()
        advanceTimeBy(31_000)
        runCurrent()
        assertEquals(setOf("event=$FIXTURE_SLUG", "event=upcoming-conf"), deletes(h).drop(1).map { it.query }.toSet())
        assertNull(h.secure.get(credentialKey))
        assertFalse(again.state.value.deletes.unfinished)
        assertEquals(Profile.EMPTY, again.state.value.profile)
    }

    @Test
    fun recordsThatCameWithoutTheirKeyAreSetRightWithANoticeAndNothingIsSent() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertNull(h.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertNull(h.controller.turnOnPresence("Hallway", ""))
        h.controller.close()
        h.http.sent.clear()

        // A new phone: the records came with a backup, the key did not.
        val phone = InMemorySecureStore()
        val again = relaunch(h, h.kv, phone)
        again.updateContext(h.context())
        runCurrent()

        val s = again.state.value
        assertEquals(ProfileSync.KEY_LOST_MESSAGE, s.notice?.message)
        assertTrue(s.notice?.opensProfile == true, "the notice offers the profile")
        assertFalse(s.visibility.onServer || s.visibility.maybeOnServer, "this phone no longer holds a profile on the server")
        assertFalse(s.visibility.openToMeet)
        assertTrue(s.visibility.sharedTalkIds.isEmpty())
        assertFalse(s.presence.on)
        assertFalse(s.deletes.unfinished)
        assertEquals("Caddie Native Test A", s.profile.displayName, "the profile itself stays on the phone")

        advanceTimeBy(120_000)
        runCurrent()
        assertTrue(h.http.sent.none { it.method == "PUT" || it.method == "DELETE" }, "nothing is written: ${h.http.sent.map { it.method + " " + it.path }}")
        assertNull(phone.get(credentialKey), "no new key is made by itself")

        // Turning visibility on is the user's choice, and makes a new profile under a new key.
        assertNull(again.setOpenToMeet(true))
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        assertNotNull(phone.get(credentialKey))
    }

    @Test
    fun anUnfinishedDeleteThatCameWithoutItsKeyIsDroppedWithTheNotice() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        h.controller.setOpenToMeet(false)
        assertTrue(h.state.deletes.coversConference)
        h.controller.close()
        h.http.sent.clear()

        val again = relaunch(h, h.kv, InMemorySecureStore())
        again.updateContext(h.context())
        runCurrent()
        assertEquals(ProfileSync.KEY_LOST_MESSAGE, again.state.value.notice?.message)
        assertFalse(again.state.value.deletes.unfinished, "this phone can never finish it")
        advanceTimeBy(3_600_000)
        assertTrue(deletes(h).isEmpty())
    }

    @Test
    fun anUnfinishedDeleteMyProfileThatCameWithoutItsKeyFinishesOnThePhone() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.saveMet("Bo", "met at the booth")
        h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        assertFalse(h.controller.deleteMyProfile().done)
        h.controller.close()
        h.http.sent.clear()

        val again = relaunch(h, h.kv, InMemorySecureStore())
        again.updateContext(h.context())
        runCurrent()
        val s = again.state.value
        assertEquals(ProfileSync.DELETED_NO_KEY_MESSAGE, s.notice?.message)
        assertFalse(s.deletes.unfinished)
        assertEquals(Profile.EMPTY, s.profile)
        assertEquals(listOf("Bo"), s.met.map { it.displayName }, "People I met stays")
        assertTrue(deletes(h).isEmpty())
    }

    @Test
    fun aKeyThatCannotBeReadChangesNothingAndAKeyFoundMissingLaterStopsTheWrite() = runTest {
        val h = madeVisible()
        val phone = FlakySecureStore().apply { failing = true }

        val again = relaunch(h, h.kv, phone)
        again.updateContext(h.context())
        runCurrent()
        assertNull(again.state.value.notice)
        assertTrue(again.state.value.visibility.onServer && again.state.value.visibility.openToMeet, "unchanged while the store cannot be read")

        // The store opens, and holds no key: a share would have made a second profile.
        phone.failing = false
        assertEquals(ProfileSync.KEY_LOST_MESSAGE, again.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty())
        assertNull(phone.get(credentialKey))
        assertFalse(again.state.value.visibility.onServer)

        assertNull(again.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        assertNotNull(phone.get(credentialKey))
    }

    /** A secure store that fails while [failing], as the Keychain does before the first unlock. */
    private class FlakySecureStore : SecureStore {
        private val inner = InMemorySecureStore()
        var failing = false

        override suspend fun get(key: String): String? = if (failing) error("errSecInteractionNotAllowed") else inner.get(key)

        override suspend fun put(key: String, value: String) = if (failing) error("errSecInteractionNotAllowed") else inner.put(key, value)

        override suspend fun remove(key: String) = if (failing) error("errSecInteractionNotAllowed") else inner.remove(key)
    }
}
