package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SecureStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

/**
 * A launch whose stored database could not be opened keeps its data in memory
 * (CoreState.storageInMemory), so the people records last only as long as the launch. The device
 * credential is in the secure store and stays usable. The people features keep working for what
 * leaves nothing behind on the server, but no profile is created that this phone would lose track
 * of, and "Delete my profile" never clears the device's key on the strength of what this launch
 * happens to know.
 */
class StorageInMemoryTest {
    private val credentialKey = SecureStore.scopedKey(BACKEND, DeviceCredential.STORE_NAME)

    @Test
    fun noProfileIsCreatedWhileTheRecordsAreInMemory() = runTest {
        val h = PeopleHarness(this)
        h.controller.updateContext(h.context().copy(storageInMemory = true))
        runCurrent()
        assertEquals(PeopleAvailability.Ready, h.state.availability)

        // The profile can still be edited for this launch; it is just not shared.
        h.named()
        assertEquals("Caddie Native Test A", h.state.profile.displayName)
        assertEquals(PeopleError.RECORDS_IN_MEMORY_MESSAGE, h.controller.setOpenToMeet(true))
        assertEquals(PeopleError.RECORDS_IN_MEMORY_MESSAGE, h.controller.shareForTalk("$FIXTURE_SLUG:1001", true))
        runCurrent()
        assertTrue(h.sent("PUT", "/api/people/profile").isEmpty(), "nothing is sent")
        assertFalse(h.state.visibility.openToMeet)
        assertTrue(h.state.visibility.sharedTalkIds.isEmpty())
        assertNull(h.secure.get(credentialKey), "no credential is made for a profile that is not created")
    }

    @Test
    fun deleteMyProfileKeepsTheKeyWhileTheRecordsAreInMemory() = runTest {
        // An earlier launch made the profile visible: its credential is in the secure store, and
        // its records are in the database this launch cannot open.
        val h = PeopleHarness(this)
        h.start()
        h.visible()
        h.controller.close()
        val credential = assertNotNull(h.secure.get(credentialKey))

        val inMemory = PeopleController(MapKeyValue(), h.http, PeopleServices(h.secure), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        inMemory.updateContext(h.context().copy(storageInMemory = true))
        runCurrent()
        assertTrue(inMemory.state.value.hasDevice)
        val result = inMemory.deleteMyProfile()
        runCurrent()
        assertFalse(result.done)
        assertEquals(PeopleError.RECORDS_IN_MEMORY_DELETE_MESSAGE, result.message)
        assertEquals(credential, h.secure.get(credentialKey), "the key stays, so the profile can still be deleted later")
        assertTrue(h.sent("DELETE", "/api/people/profile").isEmpty())
        assertFalse(inMemory.state.value.deletes.unfinished, "nothing is marked that would be lost at the next start")
        inMemory.close()

        // The same empty records in a stored database (lost to a reset, say) name no conference, but
        // with the key at hand the delete still reaches the running conferences of the list, and
        // the key goes only once the server confirmed.
        val trusting = PeopleController(MapKeyValue(), h.http, PeopleServices(h.secure), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        trusting.updateContext(h.context())
        runCurrent()
        assertTrue(trusting.deleteMyProfile().done)
        runCurrent()
        assertEquals(listOf("event=$FIXTURE_SLUG"), h.sent("DELETE", "/api/people/profile").map { it.query })
        assertNull(h.secure.get(credentialKey))
        trusting.close()
    }
}
