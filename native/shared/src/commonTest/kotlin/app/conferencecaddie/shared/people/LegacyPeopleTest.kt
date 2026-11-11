package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.SecureStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.TimeZone

/** Fake values of the contract's shape (22 and 43 base64url characters); no real credential appears in a test. */
internal const val FAKE_LEGACY_ID = "legacyProfileId0123456"
internal const val FAKE_LEGACY_SECRET = "legacySecret0123456789012345678901234567890"
internal const val FAKE_LEGACY_HEADER = "$FAKE_LEGACY_ID.$FAKE_LEGACY_SECRET"
internal const val FAKE_LEGACY_DEVICE_JSON = """{"profile_id":"$FAKE_LEGACY_ID","secret":"$FAKE_LEGACY_SECRET"}"""

/**
 * The people keys the Capacitor app kept (web/src/people/storage.ts), handed over once by the
 * Android migration: the device credential is read strictly, the profile leniently, and the
 * controller keeps whatever this app already holds.
 */
class LegacyPeopleTest {
    @Test
    fun theDeviceCredentialIsReadOnlyInExactlyTheContractsShape() {
        assertEquals(FAKE_LEGACY_HEADER, LegacyPeople.credentialHeader(FAKE_LEGACY_DEVICE_JSON))
        assertEquals(FAKE_LEGACY_HEADER, LegacyPeople.credentialHeader("""{"secret":"$FAKE_LEGACY_SECRET","profile_id":"$FAKE_LEGACY_ID","extra":1}"""))
        for (bad in listOf(
            "",
            "not json",
            "[]",
            """{"profile_id":"$FAKE_LEGACY_ID"}""",
            """{"secret":"$FAKE_LEGACY_SECRET"}""",
            """{"profile_id":"short","secret":"$FAKE_LEGACY_SECRET"}""",
            """{"profile_id":"$FAKE_LEGACY_ID","secret":"short"}""",
            """{"profile_id":"$FAKE_LEGACY_ID","secret":"${FAKE_LEGACY_SECRET}x"}""",
            """{"profile_id":"${FAKE_LEGACY_ID.dropLast(1)}+","secret":"$FAKE_LEGACY_SECRET"}""",
            """{"profile_id":"${FAKE_LEGACY_ID.dropLast(1)}.","secret":"$FAKE_LEGACY_SECRET"}""",
            """{"profile_id":1234567890123456789012,"secret":"$FAKE_LEGACY_SECRET"}""",
            """{"profile_id":"$FAKE_LEGACY_ID","secret":null}""",
            "x".repeat(LegacyPeople.MAX_VALUE_CHARS + 1),
        )) {
            assertNull(LegacyPeople.credentialHeader(bad), "refused: ${bad.take(60)}")
        }
    }

    @Test
    fun theProfileIsReadLenientlyAndCutToThisAppsLimits() {
        val stored = """{"display_name":"Ada","about":"${"a".repeat(300)}","interests":"k8s","expertise":"","linkedin_url":"https://www.linkedin.com/in/ada","contact_note":"","topics":{"conf-2026":{"learn":[{"topic_id":"t1","label":"Kubernetes"}],"speak":[]}},"unknown":true}"""
        val p = LegacyPeople.profile(stored)!!
        assertEquals("Ada", p.displayName)
        assertEquals(280, p.about.length)
        assertEquals("k8s", p.interests)
        assertEquals("https://www.linkedin.com/in/ada", p.linkedinUrl)
        assertEquals(listOf(TopicRef("t1", "Kubernetes")), p.topicsFor("conf-2026").learn)
        // The web's empty profile, or no profile at all, is nothing to hand over.
        assertNull(LegacyPeople.profile("""{"display_name":"","about":"","interests":"","expertise":"","linkedin_url":"","contact_note":"","topics":{}}"""))
        for (bad in listOf("", "null", "[]", "\"Ada\"", "{bad", "x".repeat(LegacyPeople.MAX_VALUE_CHARS + 1))) {
            assertNull(LegacyPeople.profile(bad), "refused: ${bad.take(20)}")
        }
        // A null field and a missing one take their defaults, as the records are read; a field of
        // another shape makes the value no profile.
        assertEquals("Ada", LegacyPeople.profile("""{"display_name":"Ada","about":null}""")?.displayName)
        assertNull(LegacyPeople.profile("""{"display_name":"Ada","topics":[]}"""))
    }

    @Test
    fun anAdoptedCredentialIsThisDevicesAndIsSentWithTheFirstVisibleWrite() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertFalse(h.state.hasDevice)
        val profile = LegacyPeople.profile("""{"display_name":"Ada","about":"Platform engineer"}""")
        assertTrue(h.controller.adoptLegacy(BACKEND, FAKE_LEGACY_HEADER, profile))
        runCurrent()
        assertTrue(h.state.hasDevice, "the session sees the credential at once")
        assertEquals("Ada", h.state.profile.displayName)
        assertEquals(FAKE_LEGACY_HEADER, h.secure.get(DeviceCredentials.storeKey(BACKEND)))

        assertNull(h.controller.setOpenToMeet(true))
        runCurrent()
        val put = h.sent("PUT", "/api/people/profile").single()
        assertEquals(FAKE_LEGACY_HEADER, put.headers[PeopleApi.DEVICE_HEADER], "no second credential is generated")
    }

    @Test
    fun aCredentialAndAProfileThisAppAlreadyHoldsAreKept() = runTest {
        val h = PeopleHarness(this)
        h.start()
        h.named("Grace")
        assertNull(h.controller.setOpenToMeet(true))
        runCurrent()
        val own = h.secure.get(DeviceCredentials.storeKey(BACKEND))!!
        assertTrue(own != FAKE_LEGACY_HEADER)

        assertTrue(h.controller.adoptLegacy(BACKEND, FAKE_LEGACY_HEADER, Profile(displayName = "Ada")))
        runCurrent()
        assertEquals(own, h.secure.get(DeviceCredentials.storeKey(BACKEND)), "the credential made in this app stays")
        assertEquals("Grace", h.state.profile.displayName, "the profile made in this app stays")
        assertTrue(h.state.hasDevice)
    }

    @Test
    fun aMalformedCredentialIsRefusedWithoutTouchingTheStore() = runTest {
        val h = PeopleHarness(this)
        h.start()
        assertTrue(h.controller.adoptLegacy(BACKEND, "not.a.credential", null), "settled: there is nothing to try again")
        runCurrent()
        assertNull(h.secure.get(DeviceCredentials.storeKey(BACKEND)))
        assertFalse(h.state.hasDevice)
    }

    @Test
    fun aStoreThatFailsLeavesTheHandOverForLater() = runTest {
        val store = object : SecureStore {
            val inner = InMemorySecureStore()
            var failing = true
            override suspend fun get(key: String): String? = if (failing) error("keystore") else inner.get(key)
            override suspend fun put(key: String, value: String) = if (failing) error("keystore") else inner.put(key, value)
            override suspend fun remove(key: String) = if (failing) error("keystore") else inner.remove(key)
        }
        val h = PeopleHarness(this, secure = store)
        h.start()
        assertFalse(h.controller.adoptLegacy(BACKEND, FAKE_LEGACY_HEADER, Profile(displayName = "Ada")), "tried again later")
        runCurrent()
        assertNull(store.inner.get(DeviceCredentials.storeKey(BACKEND)))

        store.failing = false
        assertTrue(h.controller.adoptLegacy(BACKEND, FAKE_LEGACY_HEADER, Profile(displayName = "Ada")))
        runCurrent()
        assertEquals(FAKE_LEGACY_HEADER, store.inner.get(DeviceCredentials.storeKey(BACKEND)))
        assertTrue(h.state.hasDevice)
        assertEquals("Ada", h.state.profile.displayName)
    }

    @Test
    fun aHandOverBeforeTheSessionOpensIsSeenWhenItOpens() = runTest {
        val h = PeopleHarness(this)
        // No context yet: the migration runs after the first frame, while the core is still loading.
        assertTrue(h.controller.adoptLegacy(BACKEND, FAKE_LEGACY_HEADER, Profile(displayName = "Ada")))
        runCurrent()
        h.start()
        assertTrue(h.state.hasDevice)
        assertEquals("Ada", h.state.profile.displayName)
        assertNull(h.controller.setOpenToMeet(true))
        runCurrent()
        assertEquals(FAKE_LEGACY_HEADER, h.sent("PUT", "/api/people/profile").single().headers[PeopleApi.DEVICE_HEADER])

        // A relaunch reads the same credential from the store.
        h.controller.close()
        val again = PeopleController(h.kv, h.http, PeopleServices(h.secure), backgroundScope, allowLocalHttp = false, clock = h.clock, timeZone = TimeZone.UTC)
        again.updateContext(h.context())
        runCurrent()
        assertTrue(again.state.value.hasDevice)
    }
}
