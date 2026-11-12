package app.conferencecaddie.shared.ble

// The platform side of Bluetooth proximity (docs/contracts/ble-tokens.md, docs/NATIVE_PLAN.md section
// 8): a key store that holds the session key and computes HMACs with it, and a radio that advertises
// this phone's payload and reports the payloads it hears. Everything else (the presence write that
// issues the key, token windows, sightings batching, re-keying, notifications, the permission flow)
// is common code in BleRuntime, so the platforms implement only these interfaces and the common
// tests drive the logic with fakes.

/**
 * Holds the Bluetooth session key of one presence session per alias ([BleProtocol.keyAlias]: one per
 * backend and conference) and computes HMAC-SHA256 with it, so the key does not have to leave the
 * store once it is in.
 *
 * - Android: the Android Keystore, as a non-exportable HMAC-SHA256 key imported with `KeyProtection`
 *   for `PURPOSE_SIGN` and no user authentication, so the foreground service can use it while the
 *   screen is locked.
 * - iOS: a Keychain item of class `kSecClassGenericPassword` with
 *   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so a Bluetooth wake can derive tokens while the
 *   phone is locked and the key never moves to another device; the HMAC is computed in Kotlin.
 *
 * Nothing here logs a key, an alias's key or an HMAC.
 */
interface BleKeyStore {
    /** Stores [key] (32 bytes) as [alias], replacing any key stored under it. The caller drops its copy afterwards. */
    suspend fun put(alias: String, key: ByteArray)

    /**
     * HMAC-SHA256 of [message] under the key stored as [alias] (32 bytes), or null when no key is
     * stored under it or the platform has lost it. Blocking but fast (a key store lookup and one
     * HMAC), and safe from any thread: a radio calls it to answer a read request.
     */
    fun hmac(alias: String, message: ByteArray): ByteArray?

    /** Removes the key stored as [alias]; nothing happens when there is none. */
    suspend fun remove(alias: String)
}

/** A [BleKeyStore] in memory, for tests and previews only; it forgets everything when the process ends. */
class InMemoryBleKeyStore : BleKeyStore {
    private val keys = HashMap<String, ByteArray>()

    override suspend fun put(alias: String, key: ByteArray) {
        require(key.size == BleProtocol.KEY_BYTES) { "a Bluetooth key is 32 bytes" }
        keys[alias] = key.copyOf()
    }

    override fun hmac(alias: String, message: ByteArray): ByteArray? = keys[alias]?.let { HmacSha256.mac(it, message) }

    override suspend fun remove(alias: String) {
        keys.remove(alias)
    }

    /** The aliases holding a key, for tests. */
    val aliases: Set<String> get() = keys.keys.toSet()
}

/** What the operating system lets the app do with Bluetooth. */
enum class BleAccess {
    /** Every permission the radio needs is granted. */
    Granted,

    /** Never asked; asking shows the system prompt. */
    NotAsked,

    /** Refused, but asking again still shows the prompt (Android's rationale case). */
    Denied,

    /** Refused for good (or restricted): only the system settings can change it. */
    Blocked,
}

/** Which permission the platform asks for, so the screens can explain the right one before asking. */
enum class BlePermissionKind {
    /** Android 12 and newer: "Nearby devices" (scan, advertise and connect, never used for location). */
    NearbyDevices,

    /** Android 8 to 11: a Bluetooth scan needs the location permission, although no position is read. */
    Location,

    /** iOS: Bluetooth. */
    Bluetooth,
}

/** The radio's state now, as far as starting it is concerned. */
enum class BleRadioState {
    /** On and allowed: [BleRadio.start] can work. */
    Ready,

    /** Bluetooth is switched off on the device. */
    PoweredOff,

    /** The app may not use Bluetooth (see [BleRadio.access]). */
    Unauthorized,

    /** The device cannot take part: no Bluetooth LE, no advertiser or, on Android, no extended advertising. */
    Unsupported,

    /** Not known yet (iOS reports its state a moment after the managers start). */
    Unknown,

    /** Android 8 to 11: the Location switch is off, so a scan hears nothing. */
    LocationOff,
}

/** Why a running radio stopped by itself. */
enum class BleStopReason {
    /** The person tapped Stop in the ongoing notification (Android). */
    User,

    /** Bluetooth was switched off. */
    BluetoothOff,

    /** A permission the radio needs was revoked. */
    PermissionLost,

    /** The controller could not advertise (an error from the stack). */
    AdvertiseFailed,

    /** The hardware turned out not to support what the radio needs. */
    Unsupported,

    /** The system ended the service or the process. */
    System,

    /** Android 8 to 11: the Location switch was turned off, so a scan hears nothing. */
    LocationOff,
}

/** What the radio needs to run. */
data class BleRadioConfig(
    val serviceUuid: String = BleProtocol.SERVICE_UUID,
    val characteristicUuid: String = BleProtocol.TOKEN_CHARACTERISTIC_UUID,
    /** The weakest RSSI worth reporting or interrogating (`ble.near_rssi`); weaker sightings are dropped. */
    val nearRssi: Int,
    /** Epoch milliseconds at which the radio stops by itself at the latest: the latest `presence_until` seen. */
    val untilEpochMillis: Long,
)

/** Where a radio reads the payload to advertise and to serve, at any moment. */
fun interface BlePayloadSource {
    /**
     * The 17-byte payload for the window of the phone's clock now, or null when there is none (the
     * key is gone). Blocking but fast; safe from any thread, including a GATT read callback.
     */
    fun payloadNow(): ByteArray?
}

/** Events from a running radio. Called from any thread; implementations hand them to their own context. */
interface BleRadioEvents {
    /** A payload heard from another phone (service data, or a characteristic read) with its RSSI in dBm. */
    fun onHeard(payload: ByteArray, rssi: Int, atEpochMillis: Long)

    /** The radio stopped by itself, for [reason]; [BleRadio.stop] does not call this. */
    fun onStopped(reason: BleStopReason)

    /**
     * The platform woke the app at (or after) the time [BleRadio.keepAwakeUntil] named: the runtime
     * sends the report that is due now. A timer of the runtime alone may not fire while the phone
     * sleeps (Android's monotonic clock stops in deep sleep). Called from any thread; does nothing by
     * default.
     */
    fun onReportDue() {}
}

/**
 * Advertises this phone's payload and scans for the payloads of others (docs/contracts/ble-tokens.md,
 * Over the air). The common [app.conferencecaddie.shared.ble] runtime decides when to run it.
 *
 * - Android: a foreground service of type `connectedDevice`. Bluetooth 5 extended advertising
 *   (non-connectable, non-scannable) with the service UUID and the payload as service data, a second
 *   legacy connectable set with the service UUID only, and a GATT server with the read-only token
 *   characteristic. Both sets restart at every window change, so the address changes with the token.
 *   Scans for the service UUID and for Apple manufacturer data at or above [BleRadioConfig.nearRssi],
 *   connecting to read the characteristic where there is no service data, with a per-address negative
 *   cache for the window and a cap on connections per minute.
 * - iOS: Core Bluetooth with state restoration and the `bluetooth-central` and `bluetooth-peripheral`
 *   background modes. Advertises the service UUID only (in the background iOS moves it to the overflow
 *   area, which only other iPhones scanning for it can see), always serves the characteristic, reads
 *   service data where present and otherwise connects and reads.
 */
interface BleRadio {
    /** False when this device can never take part (no Bluetooth LE, or no extended advertising on Android); the screens hide the feature. */
    val supported: Boolean

    /** The permission this platform asks for. */
    val permissionKind: BlePermissionKind

    /** The permission state now, without asking. */
    fun access(): BleAccess

    /**
     * Shows the system prompt when the platform still allows one and returns the access afterwards.
     * The screens explain first; this never explains anything itself.
     */
    suspend fun requestAccess(): BleAccess

    /** The radio's state now, without asking anything. */
    fun state(): BleRadioState

    /** True while started and not stopped. */
    val running: Boolean

    /**
     * Starts advertising [source]'s payload and scanning, or switches a running radio to the new
     * [config], [source] and [events]. Must be called while the app is in the foreground the first
     * time (Android 12 forbids starting a foreground service from the background); a radio the system
     * restarted is resumed the same way. Failures arrive as [BleRadioEvents.onStopped].
     */
    fun start(config: BleRadioConfig, source: BlePayloadSource, events: BleRadioEvents)

    /**
     * The window changed, or the key did: advertise and serve the payload [BlePayloadSource.payloadNow]
     * gives now. Android restarts its advertising sets, which also gives them a new address. Safe to
     * call when nothing changed.
     */
    fun refresh()

    /** Stops advertising, scanning and any connection. Safe to call when not running. */
    fun stop()

    /**
     * The runtime will report pending sightings at [epochMillis] (epoch milliseconds). A platform
     * that suspends the app soon after a Bluetooth event (iOS) keeps it running until a little after
     * then where it can, so the report goes out inside the same wake. Does nothing by default.
     */
    fun keepAwakeUntil(epochMillis: Long) {}

    /**
     * Whether the person stopped the whole app (Android's force stop, or the Task Manager) since the
     * radio last ran, as far as the platform can tell. The runtime's restore then turns Bluetooth
     * proximity off and tells the server instead of resuming it. Reading it clears it. False by default.
     */
    fun takeUserStoppedApp(): Boolean = false

    /**
     * True when iPhones may not find this phone: Android 13 and older offer no connectable
     * advertising set (it would let any phone that connects read the device name), so an iPhone,
     * which cannot read Android's extended advertisement in the background, has nothing to find.
     * This phone still finds iPhones. False by default.
     */
    val hiddenFromIphones: Boolean get() = false
}

/** Bluetooth proximity's platform services; null in [app.conferencecaddie.shared.PeopleServices] where there is no radio. */
class BlePlatform(
    val radio: BleRadio,
    val keys: BleKeyStore,
)
