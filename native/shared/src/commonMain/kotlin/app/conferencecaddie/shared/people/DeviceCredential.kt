package app.conferencecaddie.shared.people

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.SecureStore
import app.conferencecaddie.shared.secureRandomBytes
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * The device credential of one backend (docs/contracts/people-api.md, "Device credential"):
 * `profile_id` is 16 random bytes and `secret` 32, both base64url without padding (22 and 43
 * characters), sent as `X-Caddie-Device: {profile_id}.{secret}`. It belongs to exactly one
 * normalised backend base, [backendBase], and [PeopleApi] refuses to send it anywhere else.
 *
 * Neither part is ever logged: [toString] names neither, and only [header] puts them together.
 */
class DeviceCredential internal constructor(
    val backendBase: String,
    private val profileId: String,
    private val secret: String,
) {
    /** The value of the `X-Caddie-Device` header. */
    fun header(): String = "$profileId.$secret"

    override fun toString(): String = "DeviceCredential(<redacted>)"

    override fun equals(other: Any?): Boolean =
        other is DeviceCredential && other.backendBase == backendBase && other.profileId == profileId && other.secret == secret

    override fun hashCode(): Int = (backendBase.hashCode() * 31 + profileId.hashCode()) * 31 + secret.hashCode()

    companion object {
        const val PROFILE_ID_BYTES = 16
        const val SECRET_BYTES = 32
        private val PROFILE_ID = Regex("^[A-Za-z0-9_-]{22}$")
        private val SECRET = Regex("^[A-Za-z0-9_-]{43}$")

        /** True when [profileId] and [secret] have exactly the shapes the contract gives them (22 and 43 base64url characters). */
        fun wellFormed(profileId: String, secret: String): Boolean = PROFILE_ID.matches(profileId) && SECRET.matches(secret)

        /** The secure store name of the credential, under [SecureStore.scopedKey] of its backend. */
        const val STORE_NAME = "people.device.v1"

        /** A fresh credential for [backend], from the platform's secure random source. */
        fun generate(backend: BackendUrl.Valid): DeviceCredential =
            DeviceCredential(backend.base, base64Url(secureRandomBytes(PROFILE_ID_BYTES)), base64Url(secureRandomBytes(SECRET_BYTES)))

        /** Reads a stored `{profile_id}.{secret}` for [backend], or null when it is malformed. */
        fun parse(backend: BackendUrl.Valid, stored: String): DeviceCredential? {
            val parts = stored.split('.')
            if (parts.size != 2 || !PROFILE_ID.matches(parts[0]) || !SECRET.matches(parts[1])) return null
            return DeviceCredential(backend.base, parts[0], parts[1])
        }

        /** Base64url without padding. */
        @OptIn(ExperimentalEncodingApi::class)
        fun base64Url(bytes: ByteArray): String = Base64.UrlSafe.encode(bytes).trimEnd('=')
    }
}

/**
 * The device credential of one backend, generated once on first use and kept in the platform's
 * secure store under [SecureStore.scopedKey] of that backend, so two backends never share one,
 * even when they share an origin under different paths.
 */
class DeviceCredentials(private val store: SecureStore, private val backend: BackendUrl.Valid) {
    private val mutex = Mutex()
    private var cached: DeviceCredential? = null
    private var loaded = false

    private val key: String get() = storeKey(backend)

    companion object {
        /** The secure store key of [backend]'s credential. */
        fun storeKey(backend: BackendUrl.Valid): String = SecureStore.scopedKey(backend, DeviceCredential.STORE_NAME)
    }

    /**
     * The stored credential, or null when this device has none for the backend yet, or when the
     * secure store cannot be read right now. Use it to decide what to show and what to send; use
     * [lookup] where "none" and "cannot tell" must be told apart.
     */
    suspend fun get(): DeviceCredential? = when (val l = lookup()) {
        is Lookup.Found -> l.credential
        Lookup.None, Lookup.Unavailable -> null
    }

    /**
     * The credential for a request: null when the device has none, and [SecureStoreUnavailable]
     * when the secure store cannot be read now, so [PeopleApi] never reports a store failure as
     * "no credential".
     */
    suspend fun forRequest(): DeviceCredential? = when (val l = lookup()) {
        is Lookup.Found -> l.credential
        Lookup.None -> null
        Lookup.Unavailable -> throw SecureStoreUnavailable(IllegalStateException("The secure store could not be read."))
    }

    /**
     * Whether the device holds a credential for the backend. [Lookup.Unavailable] means the secure
     * store failed (an iPhone before its first unlock, a build without the Keychain entitlement, a
     * Keystore error); nothing is cached then, so the next lookup asks the store again.
     */
    suspend fun lookup(): Lookup = mutex.withLock {
        try {
            load()?.let { Lookup.Found(it) } ?: Lookup.None
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Lookup.Unavailable
        }
    }

    /**
     * The stored credential, generated and stored first when there is none. Throws
     * [SecureStoreUnavailable] when the store cannot be read or written; it never generates a new
     * credential when it could not read the old one, because that would leave the old profile on
     * the server with no way to delete it from this device.
     */
    suspend fun ensure(): DeviceCredential = mutex.withLock {
        try {
            load() ?: DeviceCredential.generate(backend).also {
                store.put(key, it.header())
                cached = it
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw SecureStoreUnavailable(e)
        }
    }

    /**
     * Takes over a `{profile_id}.{secret}` that an earlier app on this phone held for the backend
     * (the Capacitor app's WebView storage, read once by the Android migration). The credential
     * this app already holds wins: when there is one, nothing is written and [Adopted.Kept] comes
     * back, so a profile made in this app is never cut off from its key. A value without exactly
     * the contract's shape is refused before the store is touched ([Adopted.Malformed]). Throws
     * [SecureStoreUnavailable] when the store cannot be read or written now, so the caller tries
     * again later instead of counting the hand-over done. Nothing here logs any part of the value.
     */
    suspend fun adopt(header: String): Adopted = mutex.withLock {
        val parsed = DeviceCredential.parse(backend, header) ?: return@withLock Adopted.Malformed
        try {
            if (load() != null) return@withLock Adopted.Kept
            store.put(key, parsed.header())
            cached = parsed
            loaded = true
            Adopted.Stored
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw SecureStoreUnavailable(e)
        }
    }

    /** What [adopt] did with a credential handed over from an earlier app. */
    enum class Adopted {
        /** The credential is now this device's credential for the backend. */
        Stored,

        /** This device already had a credential for the backend, which stays. */
        Kept,

        /** The value did not have the contract's shape; nothing was stored. */
        Malformed,
    }

    /**
     * Removes the credential, after the server confirmed that nothing of this device is left there.
     * A store that fails here keeps the old credential, which is harmless: the server holds nothing
     * under it any more, and a later profile is created under the same id.
     */
    suspend fun forget() = mutex.withLock {
        try {
            store.remove(key)
            cached = null
            loaded = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            cached = null
            loaded = false
        }
    }

    private suspend fun load(): DeviceCredential? {
        if (!loaded) {
            cached = store.get(key)?.let { DeviceCredential.parse(backend, it) }
            loaded = true
        }
        return cached
    }

    /** What [lookup] found. */
    sealed interface Lookup {
        data class Found(val credential: DeviceCredential) : Lookup

        data object None : Lookup

        data object Unavailable : Lookup
    }
}

/** The platform's secure store could not be read or written, so the device credential is out of reach for now. */
class SecureStoreUnavailable(cause: Throwable) : Exception("The secure store is not available right now.", cause)
