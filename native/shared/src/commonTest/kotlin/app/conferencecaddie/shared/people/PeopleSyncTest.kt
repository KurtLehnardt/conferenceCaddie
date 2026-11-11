package app.conferencecaddie.shared.people

import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import app.conferencecaddie.shared.SecureStore
import app.conferencecaddie.shared.db.CaddieDatabase
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.files.SystemTemporaryDirectory
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

// sync.ts on virtual time: profile writes one at a time, deletes marked before they are sent and
// retried with backoff, nothing written while a delete covers the conference, and "Delete my
// profile" clearing the device only after the server confirmed.
class PeopleSyncTest {
    private fun shared(r: SentRequest) = (r.jsonObject["shared_talk_ids"] as JsonArray).map { (it as JsonPrimitive).content }

    @Test
    fun theFirstVisibleWriteCreatesTheCredentialAndSendsTheWebsBody() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertEquals(PeopleAvailability.Ready, h.state.availability)
        assertFalse(h.state.hasDevice)
        h.controller.updateProfile { it.copy(displayName = "  Ana  ", about = "SRE", linkedinUrl = "") }
        assertEquals("Add your name to your profile first.", PeopleController.profileProblem(Profile.EMPTY))
        assertNull(h.controller.setOpenToMeet(true))
        val put = h.sent("PUT", "/api/people/profile").single()
        assertEquals(
            """{"event":"$FIXTURE_SLUG","profile":{"display_name":"Ana","about":"SRE","interests":"","expertise":"","learn_topics":[],"speak_topics":[],"linkedin_url":null,"contact_note":""},"open_to_meet":true,"shared_talk_ids":[]}""",
            put.body,
        )
        assertTrue(h.state.hasDevice)
        assertTrue(h.state.visibility.onServer && h.state.visibility.openToMeet && !h.state.visibility.maybeOnServer)
        assertNotNull(h.secure.get(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)))
        assertEquals(SyncStatus.State.Saved, h.state.sync.state)
    }

    @Test
    fun aProfileWithoutANameIsNotSent() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertEquals("Add your name to your profile first.", h.controller.setOpenToMeet(true))
        h.controller.updateProfile { it.copy(displayName = "Ana", linkedinUrl = "https://example.com/ana") }
        assertEquals("The LinkedIn link should look like https://www.linkedin.com/in/your-name.", h.controller.setOpenToMeet(true))
        assertTrue(h.http.sent.isEmpty())
    }

    @Test
    fun profileWritesRunOneAtATimeAndEachReadsTheListThePreviousLeft() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        val gate = CompletableDeferred<Unit>()
        h.server.profilePut = { r ->
            if (h.sent("PUT", "/api/people/profile").size == 1) gate.await()
            h.server.echoProfile(r)
        }
        val a = async { h.controller.shareForTalk("$FIXTURE_SLUG:1001", true) }
        val b = async { h.controller.shareForTalk("$FIXTURE_SLUG:1002", true) }
        runCurrent()
        assertEquals(1, h.sent("PUT", "/api/people/profile").size, "the second write waits for the first")
        gate.complete(Unit)
        assertNull(a.await())
        assertNull(b.await())
        val puts = h.sent("PUT", "/api/people/profile")
        assertEquals(listOf("$FIXTURE_SLUG:1001"), shared(puts[0]))
        assertEquals(listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002"), shared(puts[1]))
        assertEquals(listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002"), h.state.visibility.sharedTalkIds)
    }

    @Test
    fun editsAreDebouncedForASecond() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.updateProfile { it.copy(about = "a") }
        h.controller.updateProfile { it.copy(about = "ab") }
        assertEquals(SyncStatus.State.Saving, h.state.sync.state)
        advanceTimeBy(999)
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty())
        advanceTimeBy(2)
        runCurrent()
        val put = h.sent("PUT", "/api/people/profile").single()
        assertTrue(put.body!!.contains(""""about":"ab""""))
        assertEquals(SyncStatus.State.Saved, h.state.sync.state)
    }

    @Test
    fun aDegradedAnswerIsSentOnceMoreAfterSeventySeconds() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.named()
        h.server.profilePut = { FakeApiHttp.json(200, """{"ok":true,"open_to_meet":true,"shared_talk_ids":[],"hidden_for_owner":false,"degraded":{"semantic":true}}""") }
        assertNull(h.controller.setOpenToMeet(true))
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        advanceTimeBy(69_999)
        assertEquals(1, h.sent("PUT", "/api/people/profile").size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, h.sent("PUT", "/api/people/profile").size, "one re-send")
        advanceTimeBy(200_000)
        assertEquals(2, h.sent("PUT", "/api/people/profile").size, "a re-send answered degraded does not schedule another")
    }

    @Test
    fun aTopicTheConferenceNoLongerOffersIsRemovedAndTheWriteRetried() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.controller.setTopics(learn = listOf(TopicRef("kubernetes", "Kubernetes"), TopicRef("gone-topic", "Gone")), speak = emptyList())
        h.named()
        h.server.profilePut = { r ->
            if (r.body!!.contains("gone-topic")) FakeApiHttp.json(400, """{"error":"learn_topics contains an unknown topic: gone-topic"}""") else h.server.echoProfile(r)
        }
        assertNull(h.controller.setOpenToMeet(true))
        assertEquals(2, h.sent("PUT", "/api/people/profile").size)
        assertEquals(listOf("kubernetes"), h.state.topics.learn.map { it.topicId })
    }

    @Test
    fun turningBothChoicesOffMarksTheDeleteBeforeItIsSentAndRetriesWithBackoff() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        var markedWhenSent = false
        h.server.profileDelete = {
            markedWhenSent = h.kv.map.values.any { v -> v.contains("\"delete_pending\"") }
            FakeApiHttp.json(502, """{"error":"People are temporarily unavailable"}""")
        }
        val message = h.controller.setOpenToMeet(false)
        assertTrue(markedWhenSent, "the mark was stored before the DELETE went out")
        assertEquals(
            "Your profile may already be hidden from others at this conference, but removing it did not finish. The app will try again, or you can finish it from your profile.",
            message,
        )
        assertTrue(h.state.deletes.unfinished && h.state.deletes.coversConference)
        assertEquals(listOf(FIXTURE_SLUG), h.state.deletes.pendingSlugs, "Profile names the conference")
        assertFalse(h.state.visibility.openToMeet, "the choice applies on the device")
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size)

        // 30 s, then 60 s, then 120 s.
        advanceTimeBy(29_999)
        assertEquals(1, h.sent("DELETE", "/api/people/profile").size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, h.sent("DELETE", "/api/people/profile").size)
        advanceTimeBy(59_000)
        assertEquals(2, h.sent("DELETE", "/api/people/profile").size)
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(3, h.sent("DELETE", "/api/people/profile").size)

        h.server.profileDelete = { h.server.ok() }
        advanceTimeBy(120_100)
        runCurrent()
        assertEquals(4, h.sent("DELETE", "/api/people/profile").size)
        assertFalse(h.state.deletes.unfinished)
        assertEquals(emptyList(), h.state.deletes.pendingSlugs)
        assertFalse(h.state.visibility.onServer)
        advanceTimeBy(3_600_000)
        assertEquals(4, h.sent("DELETE", "/api/people/profile").size, "nothing more once confirmed")
    }

    @Test
    fun aRetryAfterLongerThanTheBackoffIsFollowed() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        h.controller.setOpenToMeet(false)
        h.server.profileDelete = { FakeApiHttp.json(429, """{"error":"Too many requests"}""", mapOf("Retry-After" to "600")) }
        advanceTimeBy(30_100)
        runCurrent()
        assertEquals(2, h.sent("DELETE", "/api/people/profile").size)
        advanceTimeBy(599_000)
        assertEquals(2, h.sent("DELETE", "/api/people/profile").size, "waits the ten minutes the server asked for")
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(3, h.sent("DELETE", "/api/people/profile").size)
        assertEquals("Too many requests right now. Wait a minute and try again.", h.state.deletes.detail)
    }

    @Test
    fun nothingThatCouldMakeTheDeviceVisibleIsSentWhileADeleteCoversTheConference() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        assertNull(h.controller.turnOnPresence("Hallway", ""))
        h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        h.controller.setOpenToMeet(false)
        assertFalse(h.state.presence.on, "presence stopped before the delete")
        h.http.sent.clear()

        assertEquals(PeopleError.DELETE_UNFINISHED_MESSAGE, h.controller.setOpenToMeet(true))
        assertEquals(PeopleError.DELETE_UNFINISHED_MESSAGE, h.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        assertEquals(PeopleError.DELETE_UNFINISHED_MESSAGE, h.controller.turnOnPresence("Hallway", ""))
        val p = PeopleJson.responses.decodeFromString(Person.serializer(), person("3f2a9c0d1e4b5a68"))
        assertEquals(PeopleError.Kind.DeleteUnfinished, h.controller.ask(p, "hi").errorOrNull?.kind)
        h.controller.updateProfile { it.copy(about = "changed") }
        advanceTimeBy(5_000)
        runCurrent()
        assertTrue(h.http.sent.none { it.method == "PUT" || (it.method == "POST" && it.path == "/api/meet") }, "no write went out: ${h.http.sent.map { it.method + " " + it.path }}")
    }

    @Test
    fun aRefusedDeleteChangesNothingAndLeavesNoMark() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profileDelete = { FakeApiHttp.json(429, """{"error":"Too many requests"}""") }
        assertEquals("Too many requests right now, so nothing changed. Wait a minute and try again.", h.controller.setOpenToMeet(false))
        assertFalse(h.state.deletes.unfinished)
        assertTrue(h.state.visibility.openToMeet, "the device keeps the earlier state")
    }

    @Test
    fun deleteMyProfileClearsTheDeviceOnlyOnceTheServerConfirmedEveryConference() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.saveMet("Bo", "met at the booth")
        h.server.profileDelete = { throw IllegalStateException("offline") }
        val first = h.controller.deleteMyProfile()
        assertFalse(first.done)
        assertEquals("You appear to be offline. Your profile may be partly deleted. Try again to finish once you are online.", first.message)
        assertTrue(h.state.deletes.deleteAll)
        assertTrue(h.state.hasDevice, "the key stays until the server confirms")

        h.server.profileDelete = { h.server.ok() }
        assertTrue(h.controller.finishPendingDeletes())
        assertFalse(h.state.hasDevice)
        assertNull(h.secure.get(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)))
        assertEquals(Profile.EMPTY, h.state.profile)
        assertFalse(h.state.deletes.unfinished)
        assertEquals(listOf("Bo"), h.state.met.map { it.displayName }, "People I met stays")

        val done = h.controller.deleteMyProfile()
        assertTrue(done.done)
        assertEquals("Your profile was deleted from this phone and from our server.", done.message)
    }

    @Test
    fun threeRefusalsOfTheKeyLetTheUserStopTrying() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profileDelete = { FakeApiHttp.json(403, """{"error":"forbidden"}""") }
        h.controller.deleteMyProfile()
        assertNull(h.state.deletes.stopTryingReason)
        h.controller.finishPendingDeletes()
        h.controller.finishPendingDeletes()
        assertEquals(StopTryingReason.Forbidden, h.state.deletes.stopTryingReason)
        assertEquals("This device is not allowed to delete your profile.", h.state.deletes.detail)
        assertEquals(
            "Your profile was deleted from this phone only. What our server holds may stay visible to other attendees until the conference ends, and this phone can no longer delete it.",
            h.controller.stopTrying(),
        )
        assertFalse(h.state.hasDevice)
        assertFalse(h.state.deletes.unfinished)
    }

    @Test
    fun anUnfinishedDeleteSurvivesARestartAndIsTriedAgain() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profileDelete = { FakeApiHttp.json(502, "{}") }
        h.controller.setOpenToMeet(false)
        h.controller.close()

        // The app starts again on the same records.
        val again = PeopleHarness(this)
        again.kv.map.putAll(h.kv.map)
        again.secure.put(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME), h.secure.get(SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME))!!)
        again.start()
        assertTrue(again.state.deletes.coversConference)
        assertEquals(PeopleError.DELETE_UNFINISHED_MESSAGE, again.controller.setOpenToMeet(true))
        advanceTimeBy(31_000)
        runCurrent()
        assertEquals(1, again.sent("DELETE", "/api/people/profile").size)
        assertFalse(again.state.deletes.unfinished)
    }

    @Test
    fun sharingFollowsInterestedOnlyOnceItIsTurnedOn() = runTest {
        val h = PeopleHarness(this)
        h.start(interested = listOf("$FIXTURE_SLUG:1001"))
        h.named()
        h.controller.updateContext(h.context(interested = listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002")))
        runCurrent()
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty(), "off by default")
        assertNull(h.controller.followInterested())
        assertTrue(h.state.visibility.shareNew)
        assertEquals(listOf("$FIXTURE_SLUG:1001", "$FIXTURE_SLUG:1002"), h.state.visibility.sharedTalkIds)
        h.controller.updateContext(h.context(interested = listOf("$FIXTURE_SLUG:1002", "$FIXTURE_SLUG:1003")))
        runCurrent()
        assertEquals(listOf("$FIXTURE_SLUG:1002", "$FIXTURE_SLUG:1003"), h.state.visibility.sharedTalkIds)
    }

    @Test
    fun fiftyTalksAtMostWithTheWebsHint() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.named()
        val message = h.controller.shareForTalks((1..60).map { "$FIXTURE_SLUG:$it" })
        assertEquals("You can share for up to 50 talks, so the first 50 are shared.", message)
        assertTrue(PeopleController.isHintMessage(message!!))
        assertEquals(50, h.state.visibility.sharedTalkIds.size)
    }

    @Test
    fun anEndedConferenceTurnsVisibilityOffOnTheDevice() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.server.profilePut = { FakeApiHttp.json(400, """{"error":"conference has ended"}""") }
        h.controller.updateProfile { it.copy(about = "new") }
        advanceTimeBy(1_100)
        runCurrent()
        assertFalse(h.state.visibility.onServer)
        assertEquals("This conference has ended, so sharing is closed.", h.state.sync.message)
    }

    @Test
    fun theRecordsLiveInTheMainDatabaseAndOutliveTheCache() = runTest {
        val dir = Path(SystemTemporaryDirectory, "caddie-people-${Random.nextLong().toULong()}").also { SystemFileSystem.createDirectories(it) }
        val path = Path(dir, "caddie.db").toString()
        val key = "people:v1:https://a.example#profile"
        try {
            CaddieDatabase.open(path).apply {
                PeopleKeyValue.forDatabase(this).set(key, """{"name":"Ada"}""")
                // "Clear saved schedules" empties the cache database only.
                clearBundles()
                closeWhenIdle()
            }
            val cachePath = CaddieDatabase.defaultCachePath(path)
            BundledSQLiteDriver().open(cachePath).apply {
                val tables = prepare("SELECT name FROM sqlite_master WHERE type = 'table'").use { s -> buildList { while (s.step()) add(s.getText(0)) } }
                close()
                assertFalse("settings" in tables, "the cache database holds no settings table")
            }
            // A broken cache database is deleted and created again; the records stay.
            SystemFileSystem.sink(Path(cachePath)).buffered().use { it.write(ByteArray(4096) { 'x'.code.toByte() }) }
            val reopened = CaddieDatabase.openLazily(path)
            assertFalse(reopened.wasReset())
            assertFalse(reopened.runsInMemory(), "the main database opened, so the records are kept")
            assertEquals("""{"name":"Ada"}""", PeopleKeyValue.forDatabase(reopened).get(key))
            reopened.closeWhenIdle()
        } finally {
            for (child in SystemFileSystem.list(dir)) SystemFileSystem.delete(child, mustExist = false)
            SystemFileSystem.delete(dir, mustExist = false)
        }
    }
}
