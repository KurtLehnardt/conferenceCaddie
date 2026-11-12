package app.conferencecaddie.shared

// Interfaces that each platform implements and injects at start-up (docs/NATIVE_PLAN.md, section
// 10.3). Android implements them in Kotlin in androidMain. iOS implements them in Kotlin in iosMain
// where the platform bindings or a cinterop reach the API (the Keychain, notifications, ONNX
// Runtime's C API, Core Bluetooth), and in Swift only where Kotlin cannot reach the API.

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

// Bluetooth proximity's platform interfaces (BleRadio, BleKeyStore) are in the ble package
// (ble/BlePlatform.kt), next to the protocol they serve.

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
