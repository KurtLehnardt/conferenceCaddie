package app.conferencecaddie.shared

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.fail
import kotlinx.coroutines.test.runTest
import platform.CoreFoundation.CFRetain
import platform.Foundation.CFBridgingRelease
import platform.Foundation.NSData
import platform.Foundation.create
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

/**
 * The Keychain store on the iOS simulator, with a service of its own. The Keychain needs a booted
 * simulator and the entitlements of an app, so Gradle runs the tests in a booted simulator (not
 * `simctl spawn --standalone`, which has no Keychain) and links the entitlements of
 * src/iosTest/simulator-tests.entitlements into the test executable (shared/build.gradle.kts).
 * Without either the Keychain answers errSecNotAvailable (-25291) or errSecMissingEntitlement
 * (-34018), and these tests fail rather than pass without checking anything. On a phone, the debug
 * launch option `-caddie.selftest securestore` checks the app's own store ([IosSelfTest]).
 */
class IosSecureStoreTest {
    private val store = IosSecureStore(service = "app.conferencecaddie.secure-store.test")
    private val official = BackendUrl.normalise("https://caddie.example.org") as BackendUrl.Valid
    private val other = BackendUrl.normalise("https://caddie.example.org/other") as BackendUrl.Valid
    private val key = SecureStore.scopedKey(official, "device")
    private val otherKey = SecureStore.scopedKey(other, "device")

    /** Runs [block] with neither test item in the Keychain, and removes them afterwards. */
    private fun keychain(block: suspend () -> Unit) = runTest {
        try {
            store.remove(key)
            store.remove(otherKey)
        } catch (e: KeychainException) {
            if (e.status in NO_KEYCHAIN) {
                fail("The Keychain is not available to the test process (${e.status}): run the tests through Gradle, which boots the simulator and links the test entitlements.")
            }
            throw e
        }
        try {
            block()
        } finally {
            store.remove(key)
            store.remove(otherKey)
        }
    }

    @Test
    fun aValueRoundTripsAndIsOverwritten() = keychain {
        assertNull(store.get(key))
        store.put(key, "first")
        assertEquals("first", store.get(key))
        store.put(key, "second ünïcödé")
        assertEquals("second ünïcödé", IosSecureStore(service = "app.conferencecaddie.secure-store.test").get(key))
    }

    @Test
    fun removeForgetsTheValue() = keychain {
        store.put(key, "value")
        store.remove(key)
        assertNull(store.get(key))
        store.remove(key)
    }

    @Test
    fun twoBackendsKeepTheirOwnValues() = keychain {
        store.put(key, "official")
        store.put(otherKey, "other")
        assertEquals("official", store.get(key))
        assertEquals("other", store.get(otherKey))
        store.remove(otherKey)
        assertEquals("official", store.get(key))
        assertNull(store.get(otherKey))
    }

    @Test
    fun anotherServiceSeesNothing() = keychain {
        store.put(key, "value")
        assertNull(IosSecureStore(service = "app.conferencecaddie.secure-store.other-test").get(key))
    }

    @OptIn(ExperimentalForeignApi::class)
    @Test
    fun itemsStayOnThisDeviceAndAreNeverSynchronised() = keychain {
        // The people records are kept out of backups to match this: neither leaves the phone.
        assertNull(store.protectionOf(key))
        store.put(key, "value")
        val expected = CFBridgingRelease(CFRetain(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)) as? String
        assertEquals(expected to false, store.protectionOf(key))
    }

    @OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
    @Test
    fun aDeviceTokenIsWrittenAsLowercaseHex() {
        val bytes = byteArrayOf(0x00, 0x0f, 0x10, 0x7f, 0x80.toByte(), 0xab.toByte(), 0xff.toByte())
        val data = bytes.usePinned { NSData.create(bytes = it.addressOf(0), length = bytes.size.toULong()) }
        assertEquals("000f107f80abff", IosPush.hex(data))
    }

    private companion object {
        /** errSecNotAvailable and errSecMissingEntitlement. */
        val NO_KEYCHAIN = setOf(-25291, -34018)
    }
}
