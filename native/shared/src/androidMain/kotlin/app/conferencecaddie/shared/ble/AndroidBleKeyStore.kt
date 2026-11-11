package app.conferencecaddie.shared.ble

import android.security.keystore.KeyProperties
import android.security.keystore.KeyProtection
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * [BleKeyStore] in the Android Keystore (docs/contracts/ble-tokens.md, Keys, On the device): each
 * session key is imported as a non-exportable HMAC-SHA256 key for signing only, with no user
 * authentication, so the foreground service can derive tokens while the screen is locked. The
 * HMAC is computed by the Keystore with `Mac`, so the key bytes never come back into the app once
 * [put] has handed them over.
 *
 * - [hmac] is synchronous and safe from any thread (a GATT read is answered from a binder thread):
 *   each call looks the key up and uses its own `Mac`.
 * - A key that can no longer be used (lost, or invalidated by the platform) reads as missing, so the
 *   common runtime asks the server for a new one. Other Keystore errors are thrown, as in
 *   AndroidSecureStore, so a passing failure is never taken for a lost key.
 * - Nothing here logs a key, an alias or an HMAC. Keystore entries are not backed up or moved to
 *   another device, like everything else the app stores.
 */
class AndroidBleKeyStore : BleKeyStore {
    private val lock = Mutex()

    override suspend fun put(alias: String, key: ByteArray) {
        require(key.size == BleProtocol.KEY_BYTES) { "a Bluetooth key is 32 bytes" }
        withContext(Dispatchers.IO) {
            lock.withLock {
                // The algorithm name already fixes the digest of an HMAC key, so no setDigests:
                // the Keystore accepts the import and computes HmacSHA256 without it.
                val protection = KeyProtection.Builder(KeyProperties.PURPOSE_SIGN)
                    .setUserAuthenticationRequired(false)
                    .build()
                // Importing under an alias that holds a key replaces that key.
                keyStore().setEntry(alias, KeyStore.SecretKeyEntry(SecretKeySpec(key, KeyProperties.KEY_ALGORITHM_HMAC_SHA256)), protection)
            }
        }
    }

    override fun hmac(alias: String, message: ByteArray): ByteArray? {
        val key = try {
            keyStore().getKey(alias, null) as? SecretKey
        } catch (e: UnrecoverableKeyException) {
            null
        } ?: return null
        return try {
            Mac.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256).run {
                init(key)
                doFinal(message)
            }
        } catch (e: InvalidKeyException) {
            // KeyPermanentlyInvalidatedException is one: the key cannot be used any more.
            null
        }
    }

    override suspend fun remove(alias: String) {
        withContext(Dispatchers.IO) {
            lock.withLock { keyStore().deleteEntry(alias) }
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
    }
}
