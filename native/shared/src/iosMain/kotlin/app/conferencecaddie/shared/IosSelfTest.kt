package app.conferencecaddie.shared

import kotlin.time.Duration.Companion.seconds
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import platform.CoreFoundation.CFRetain
import platform.Foundation.CFBridgingRelease
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

/**
 * Checks of the platform services that need the running app, because the Kotlin/Native test
 * process has no Keychain and no location service. Debug builds run one with the launch option
 * `-caddie.selftest securestore` or `-caddie.selftest location` (MainViewController.kt) and print
 * one line; release builds never call them. The line names what failed, never a value or a
 * position.
 */
object IosSelfTest {
    /** Runs the check called [name] and returns its line. */
    suspend fun run(name: String): String = when (name) {
        "securestore" -> secureStore()
        "location" -> location()
        else -> "unknown check"
    }

    /**
     * Location with access granted beforehand (`xcrun simctl privacy <device> grant location
     * app.conferencecaddie`) and a simulated position (`xcrun simctl location <device> set`): the
     * access reads Precise and one fix arrives within 15 seconds.
     */
    suspend fun location(): String {
        val provider = IosLocationProvider()
        val access = provider.requestAccess()
        if (access != LocationAccess.Precise) return "failed: access is $access"
        val fix = withTimeoutOrNull(15.seconds) { provider.fixes().first() } ?: return "failed: no position within 15 s"
        return if (fix.accuracyM >= 0 && fix.atEpochMillis > 0) "passed (accuracy ${fix.accuracyM} m)" else "failed: invalid fix"
    }

    @OptIn(ExperimentalForeignApi::class)
    suspend fun secureStore(): String {
        val store = IosSecureStore(service = "app.conferencecaddie.secure-store.selftest")
        val a = SecureStore.scopedKey(BackendUrl.normalise("https://caddie.example.org") as BackendUrl.Valid, "device")
        val b = SecureStore.scopedKey(BackendUrl.normalise("https://caddie.example.org/other") as BackendUrl.Valid, "device")
        val failures = mutableListOf<String>()
        fun expect(what: String, ok: Boolean) {
            if (!ok) failures += what
        }
        return try {
            store.remove(a)
            store.remove(b)
            expect("missing reads as null", store.get(a) == null)
            store.put(a, "first")
            expect("round trip", store.get(a) == "first")
            store.put(a, "second")
            expect("overwrite", store.get(a) == "second")
            store.put(b, "other")
            expect("backends apart", store.get(a) == "second" && store.get(b) == "other")
            expect("another service sees nothing", IosSecureStore(service = "app.conferencecaddie.secure-store.selftest-other").get(a) == null)
            val expected = CFBridgingRelease(CFRetain(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)) as? String
            val protection = store.protectionOf(a)
            expect("after first unlock, this device only", protection != null && protection.first == expected)
            expect("not synchronisable", protection != null && !protection.second)
            store.remove(b)
            expect("remove", store.get(b) == null && store.get(a) == "second")
            store.remove(a)
            expect("remove again", store.get(a) == null)
            if (failures.isEmpty()) "passed" else "failed: " + failures.joinToString(", ")
        } catch (e: KeychainException) {
            "failed: Keychain status ${e.status}"
        } finally {
            runCatching { store.remove(a) }
            runCatching { store.remove(b) }
        }
    }
}
