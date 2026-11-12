package app.conferencecaddie.shared

import app.conferencecaddie.shared.ble.BleProtocol
import app.conferencecaddie.shared.ble.BleRadioConfig
import app.conferencecaddie.shared.ble.BleRadioEvents
import app.conferencecaddie.shared.ble.BleRadioState
import app.conferencecaddie.shared.ble.BleStopReason
import app.conferencecaddie.shared.ble.IosBleKeyStore
import app.conferencecaddie.shared.ble.IosBleRadio
import app.conferencecaddie.shared.ble.KeychainBleKeys
import app.conferencecaddie.shared.ble.epochMillis
import app.conferencecaddie.shared.ble.runningInSimulator
import kotlin.time.Duration.Companion.seconds
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import platform.CoreFoundation.CFRetain
import platform.Foundation.CFBridgingRelease
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

/**
 * Checks of the platform services that need the running app, because the Kotlin/Native test
 * process has no Keychain, no location service and no Info.plist. Debug builds run one with the
 * launch option `-caddie.selftest securestore`, `location`, `blekeys` or `bleradio`
 * (MainViewController.kt) and print one line; release builds never call them. The line names what
 * failed, never a value, a key, a token or a position.
 */
@OptIn(ExperimentalForeignApi::class)
object IosSelfTest {
    /** Runs the check called [name] and returns its line. */
    suspend fun run(name: String): String = when (name) {
        "securestore" -> secureStore()
        "location" -> location()
        "blekeys" -> bleKeys()
        "bleradio" -> bleRadio()
        else -> "unknown check"
    }

    /**
     * The Bluetooth key store on the real Keychain, with a service of its own: HMACs of the golden
     * vectors (contracts/fixtures/ble/golden-vectors.v1.json, fake keys) through the store and
     * through a second store that has to read the item back, replacing, the protection class,
     * two aliases kept apart, another service seeing nothing, and removing.
     */
    suspend fun bleKeys(): String {
        val service = "app.conferencecaddie.ble.selftest"
        val store = IosBleKeyStore(KeychainBleKeys(service))
        val alias = BleProtocol.keyAlias("https://caddie.example.org", "selftest-2099")
        val other = BleProtocol.keyAlias("https://caddie.example.org", "selftest-other")
        val keyA = ByteArray(32) { it.toByte() }
        val keyB = ByteArray(32) { (0xff - it).toByte() }
        val w = BleProtocol.tokenMessage(2990520L)
        val wMax = BleProtocol.tokenMessage(-1L)
        fun hex(bytes: ByteArray?) = bytes?.joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
        fun fresh() = IosBleKeyStore(KeychainBleKeys(service))
        val failures = mutableListOf<String>()
        fun expect(what: String, ok: Boolean) {
            if (!ok) failures += what
        }
        return try {
            store.remove(alias)
            store.remove(other)
            expect("missing reads as null", store.hmac(alias, w) == null)
            store.put(alias, keyA)
            expect("key-a at w = 2990520", hex(store.hmac(alias, w)) == KEY_A_2990520)
            expect("key-a read back", hex(fresh().hmac(alias, w)) == KEY_A_2990520)
            expect("key-a at w = 2^64 - 1", hex(fresh().hmac(alias, wMax)) == KEY_A_MAX)
            store.put(alias, keyB)
            expect("replace", hex(store.hmac(alias, w)) == KEY_B_2990520 && hex(fresh().hmac(alias, w)) == KEY_B_2990520)
            val expected = CFBridgingRelease(CFRetain(kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)) as? String
            val protection = KeychainBleKeys(service).protectionOf(alias)
            expect("after first unlock, this device only", protection != null && protection.first == expected)
            expect("not synchronisable", protection != null && !protection.second)
            store.put(other, keyA)
            expect("aliases apart", hex(store.hmac(other, w)) == KEY_A_2990520 && hex(fresh().hmac(alias, w)) == KEY_B_2990520)
            expect("another service sees nothing", IosBleKeyStore(service = "app.conferencecaddie.ble.selftest-other").hmac(alias, w) == null)
            store.remove(alias)
            expect("remove", store.hmac(alias, w) == null && fresh().hmac(alias, w) == null && fresh().hmac(other, w) != null)
            store.remove(alias)
            expect("remove again", store.hmac(alias, w) == null)
            if (failures.isEmpty()) "passed" else "failed: " + failures.joinToString(", ")
        } catch (e: KeychainException) {
            "failed: Keychain status ${e.status}"
        } finally {
            runCatching { store.remove(alias) }
            runCatching { store.remove(other) }
        }
    }

    /**
     * What Core Bluetooth does in this process. The app's radio ([IosBleRadio.shared]) treats the
     * simulator as unsupported and never creates a manager there; this check also drives a radio
     * that creates its managers anyway, so the line records what the simulator's Core Bluetooth
     * really reports, and that asking, starting and stopping neither hang nor crash. The probe never
     * asks for state restoration: two managers with the same restore identifier in one process
     * misuse the API, and the app's own radio may hold them. On a device it reports the device's
     * Bluetooth instead.
     */
    suspend fun bleRadio(): String {
        val app = IosBleRadio.shared
        val failures = mutableListOf<String>()
        if (runningInSimulator() && (app.supported || app.state() != BleRadioState.Unsupported)) failures += "the app's radio is not unsupported in the simulator"
        val probe = IosBleRadio(simulator = false, restoration = false)
        val before = probe.access()
        val after = withTimeoutOrNull(10.seconds) { probe.requestAccess() } ?: return "failed: requestAccess did not return within 10 s (access was $before)"
        val state = probe.state()
        val stopped = CompletableDeferred<BleStopReason>()
        probe.start(
            BleRadioConfig(nearRssi = -75, untilEpochMillis = epochMillis() + 60_000L),
            { null },
            object : BleRadioEvents {
                override fun onHeard(payload: ByteArray, rssi: Int, atEpochMillis: Long) = Unit
                override fun onStopped(reason: BleStopReason) {
                    stopped.complete(reason)
                }
            },
        )
        val reason = withTimeoutOrNull(5.seconds) { stopped.await() }
        probe.stop()
        probe.stop()
        val summary = "authorization $before then $after, state $state, start ${reason?.let { "stopped: $it" } ?: "still running after 5 s"}"
        return if (failures.isEmpty()) "passed ($summary)" else "failed: ${failures.joinToString(", ")} ($summary)"
    }

    /**
     * Location with access granted beforehand (`xcrun simctl privacy <device> grant location
     * app.conferencecaddie`) and a simulated position (`xcrun simctl location <device> set`): the
     * access reads Precise and one fix arrives within 15 seconds.
     */
    suspend fun location(): String {
        val provider = withContext(Dispatchers.Main) { IosLocationProvider() }
        val access = provider.requestAccess()
        if (access != LocationAccess.Precise) return "failed: access is $access"
        val fix = withTimeoutOrNull(15.seconds) { provider.fixes().first() } ?: return "failed: no position within 15 s"
        return if (fix.accuracyM >= 0 && fix.atEpochMillis > 0) "passed (accuracy ${fix.accuracyM} m)" else "failed: invalid fix"
    }

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

    // HMAC-SHA256 golden vectors (contracts/fixtures/ble/golden-vectors.v1.json): key-a is 00 01 .. 1f,
    // key-b is ff fe .. e0, both fake.
    private const val KEY_A_2990520 = "3a4110ed2dbfdaaa28b1951eca84da1963b43518335fa82e45df47f21406e2d7"
    private const val KEY_A_MAX = "e12bcbe754acbae9fe69d58679b7b71651f454e95284a9bfb4d0eab92914572f"
    private const val KEY_B_2990520 = "ed9faec68b8db2609616bc128c7dcbd63bb2d5fceae475866622c9d34614ef43"
}
