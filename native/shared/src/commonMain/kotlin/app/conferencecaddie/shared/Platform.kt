package app.conferencecaddie.shared

import kotlinx.coroutines.flow.Flow

// Interfaces that each platform implements and injects at start-up (docs/NATIVE_PLAN.md, section
// 10.3). Android implements them in Kotlin in androidMain; iOS implements them in Swift and passes
// them in, because Core Bluetooth, the Keychain and ONNX Runtime are easiest to reach from Swift.

/** Turns text into embedding vectors on the device (bge-small-en-v1.5 through ONNX Runtime). */
interface Embedder {
    /** Identifies the model, so vectors from different models are never compared. */
    val modelId: String

    /** Length of every vector this embedder returns. */
    val dimensions: Int

    /** Returns one vector per input text, in the same order. */
    suspend fun embed(texts: List<String>): List<FloatArray>
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
 * backend origin, so one backend's secret is never sent to another; use [scopedKey] for that.
 */
interface SecureStore {
    suspend fun get(key: String): String?

    suspend fun put(key: String, value: String)

    suspend fun remove(key: String)

    companion object {
        /** The storage key for [name] under the normalised backend [origin]. */
        fun scopedKey(origin: String, name: String): String = "$origin#$name"
    }
}
