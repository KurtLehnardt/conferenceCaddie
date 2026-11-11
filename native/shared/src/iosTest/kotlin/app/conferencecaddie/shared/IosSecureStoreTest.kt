package app.conferencecaddie.shared

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest
import platform.Foundation.NSData
import platform.Foundation.create

/**
 * The Keychain store on the iOS simulator, with a service of its own. Gradle runs the tests as a
 * plain process in a standalone simulator (`simctl spawn --standalone`), which has no Keychain
 * (errSecNotAvailable, -25291) or lacks the app's entitlements (errSecMissingEntitlement, -34018).
 * There the Keychain tests say so and pass without checking; the store is then checked in the app
 * with the debug launch option `-caddie.selftest securestore` (see native/README.md).
 */
class IosSecureStoreTest {
    private val store = IosSecureStore(service = "app.conferencecaddie.secure-store.test")
    private val official = BackendUrl.normalise("https://caddie.example.org") as BackendUrl.Valid
    private val other = BackendUrl.normalise("https://caddie.example.org/other") as BackendUrl.Valid
    private val key = SecureStore.scopedKey(official, "device")
    private val otherKey = SecureStore.scopedKey(other, "device")

    /** Runs [block] unless this process may not use the Keychain. */
    private fun keychain(block: suspend () -> Unit) = runTest {
        try {
            store.remove(key)
            store.remove(otherKey)
        } catch (e: KeychainException) {
            if (e.status in NO_KEYCHAIN) {
                println("SKIPPED: the Keychain is not available to the test process (${e.status}).")
                return@runTest
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
