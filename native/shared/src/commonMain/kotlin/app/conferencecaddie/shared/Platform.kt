package app.conferencecaddie.shared

import kotlinx.coroutines.flow.Flow

// Interfaces that each platform implements and injects at start-up (docs/NATIVE_PLAN.md, section
// 10.3). Android implements them in Kotlin in androidMain. iOS implements them in Kotlin in iosMain
// where the platform bindings or a cinterop reach the API (the Keychain, notifications, ONNX
// Runtime's C API), and in Swift, passed in, where they do not (Core Bluetooth is easiest to reach
// from Swift).

/** Turns text into embedding vectors on the device (bge-small-en-v1.5 through ONNX Runtime). */
interface Embedder {
    /** Identifies the model, so vectors from different models are never compared. */
    val modelId: String

    /** Length of every vector this embedder returns. */
    val dimensions: Int

    /** Returns one vector per input text, in the same order. */
    suspend fun embed(texts: List<String>): List<FloatArray>

    /** Releases what the embedder holds (an ONNX Runtime session, for example); later calls may fail. */
    suspend fun close() {}
}

/** One Bluetooth sighting: a token heard from a nearby phone and its strongest signal. */
data class BleSighting(
    val token: ByteArray,
    val rssi: Int,
    val heardAtEpochMillis: Long,
) {
    override fun equals(other: Any?): Boolean =
        other is BleSighting &&
            token.contentEquals(other.token) &&
            rssi == other.rssi &&
            heardAtEpochMillis == other.heardAtEpochMillis

    override fun hashCode(): Int =
        (token.contentHashCode() * 31 + rssi) * 31 + heardAtEpochMillis.hashCode()
}

/**
 * Advertises this phone's current token and scans for other phones' tokens. Token derivation and
 * sightings batching are common code; only the radio work is per platform.
 */
interface BleRadio {
    /** False when the hardware or OS cannot advertise and scan; the UI then hides the feature. */
    val isAvailable: Boolean

    /** Tokens heard while running. Collect it to batch sightings for the backend. */
    val sightings: Flow<BleSighting>

    /** Starts advertising [token] under [serviceUuid] and scanning for the same UUID. */
    suspend fun start(serviceUuid: String, token: ByteArray)

    /** Replaces the advertised token without interrupting the scan. */
    suspend fun rotate(token: ByteArray)

    /** Stops advertising and scanning. Safe to call when not running. */
    suspend fun stop()
}

/** Local notifications ("someone who's worked on X is right near you"). */
interface Notifier {
    /** Asks for notification permission if needed; returns whether notifications may be shown. */
    suspend fun requestPermission(): Boolean

    /** Shows or replaces the notification with [id]. [deepLink] opens the matching screen. */
    fun show(id: String, title: String, body: String, deepLink: String? = null)

    fun cancel(id: String)
}

/**
 * Keychain on iOS, Android Keystore-backed storage on Android. Device secrets are stored per
 * normalised backend base ([BackendUrl.Valid.base]), so one backend's secret is never sent to
 * another, even when two backends share an origin under different paths. Build keys with
 * [scopedKey].
 */
interface SecureStore {
    suspend fun get(key: String): String?

    suspend fun put(key: String, value: String)

    suspend fun remove(key: String)

    companion object {
        private val NAME = Regex("[A-Za-z0-9_.-]{1,64}")

        /**
         * The storage key for [name] under [backend]. A normalised base never contains '#'
         * (fragments are refused and '#' is not a path character) and [name] is limited to
         * letters, digits, '_', '.' and '-', so every key splits back into exactly one
         * (base, name) pair and no two backends can share a key.
         */
        fun scopedKey(backend: BackendUrl.Valid, name: String): String {
            require(NAME.matches(name)) { "A secure store name uses only letters, digits, '_', '.' and '-'." }
            return "${backend.base}#$name"
        }
    }
}
