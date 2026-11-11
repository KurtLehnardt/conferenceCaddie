package app.conferencecaddie.shared

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

// The platform services the people features need, next to the interfaces in Platform.kt. Each
// platform implements them and passes them in at start-up; the shared core and the screens use only
// these interfaces, so the common tests run with the stand-ins at the end of this file.

/** A position from the platform: degrees, the accuracy radius in metres, and when it was taken. */
data class GeoFix(
    val lat: Double,
    val lon: Double,
    val accuracyM: Double,
    val atEpochMillis: Long,
)

/** What the operating system lets the app do with the device's location. */
enum class LocationAccess {
    /** Never asked; asking may show the system prompt. */
    NotAsked,

    /** Precise location is allowed while the app is in use. */
    Precise,

    /**
     * Only approximate location is allowed (Android 12's "Approximate", iOS's "Precise: Off"). The
     * app then sends no position, because the server keeps none less accurate than 200 m.
     */
    Approximate,

    /** Refused; only the system settings can change it. */
    Denied,

    /** The device has no location service, or it is switched off for the whole device. */
    Unavailable,
}

/**
 * The device's position, used only for the GPS bands of presence, and only after the person said
 * yes to "Use my position too". Nothing reads the position in the background.
 */
interface LocationProvider {
    /** The current access, without asking. */
    fun access(): LocationAccess

    /**
     * Shows the system prompt when the platform still allows one and returns the access afterwards.
     * It never explains anything itself; the screens show the web's wording first.
     */
    suspend fun requestAccess(): LocationAccess

    /**
     * High-accuracy positions while collected, like the web's `watchPosition` with
     * `enableHighAccuracy: true` and `maximumAge: 10_000`. Emits nothing without [LocationAccess.Precise].
     * Cancelling the collection stops the updates.
     */
    fun fixes(): Flow<GeoFix>
}

/**
 * A native push token for the backend's native push registration route. The token addresses this
 * device, so [toString] leaves it out: a log line or a failed assertion that prints a token shows
 * only its channel, environment and length.
 */
data class PushToken(
    /** "apns" or "fcm". */
    val channel: String,
    val token: String,
    /** APNs only: "production" or "sandbox", from the build's signing. Null for FCM. */
    val environment: String? = null,
) {
    override fun toString(): String = "PushToken(channel=$channel, token=<redacted, ${token.length} chars>, environment=$environment)"
}

/**
 * Native push (docs/NATIVE_PLAN.md, decision 3): only the official backend holds the APNs and FCM
 * keys, so the app registers only when the backend's capabilities advertise its channel, and
 * otherwise relies on in-app and local notifications.
 */
interface PushRegistrar {
    /** "apns" or "fcm": the channel this build can receive, or null when it can receive none. */
    val channel: String?

    /** Asks for notification permission if needed, then for a device token; null when refused or unavailable. */
    suspend fun register(): PushToken?

    /** Forgets the device's token on the device side. The caller deletes the backend's copy. */
    suspend fun unregister()
}

/** Opens this app's page in the system settings, where a refused permission can be changed. */
fun interface SystemSettings {
    fun openAppSettings()
}

/** Everything the people features need from the platform, passed in once at start-up. */
class PeopleServices(
    val secureStore: SecureStore,
    val location: LocationProvider = NoLocation,
    val notifier: Notifier = NoNotifier,
    val push: PushRegistrar = NoPush,
    val systemSettings: SystemSettings? = null,
)

/** Cryptographically secure random bytes from the platform (SecureRandom, SecRandomCopyBytes). */
expect fun secureRandomBytes(count: Int): ByteArray

// -------------------------------------------------------------------------------------------------
// Stand-ins for platforms or builds without a service, and for tests and previews.

/** A device without location: the position switch is hidden. */
object NoLocation : LocationProvider {
    override fun access() = LocationAccess.Unavailable
    override suspend fun requestAccess() = LocationAccess.Unavailable
    override fun fixes(): Flow<GeoFix> = emptyFlow()
}

/** A build that can receive no native push. */
object NoPush : PushRegistrar {
    override val channel: String? = null
    override suspend fun register(): PushToken? = null
    override suspend fun unregister() = Unit
}

/** A build that shows no notifications. */
object NoNotifier : Notifier {
    override suspend fun requestPermission() = false
    override fun show(id: String, title: String, body: String, deepLink: String?) = Unit
    override fun cancel(id: String) = Unit
}

/**
 * A [SecureStore] in memory, for tests and previews only. It forgets everything when the process
 * ends, so the platforms never use it for device secrets.
 */
class InMemorySecureStore : SecureStore {
    private val values = HashMap<String, String>()

    override suspend fun get(key: String): String? = values[key]

    override suspend fun put(key: String, value: String) {
        values[key] = value
    }

    override suspend fun remove(key: String) {
        values.remove(key)
    }
}
