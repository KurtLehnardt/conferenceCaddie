package app.conferencecaddie.shared

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * [SecureStore] for Android: every value is encrypted with AES-256-GCM under one key in the Android
 * Keystore and kept in a private SharedPreferences file.
 *
 * - The key never leaves the Keystore (it is not exportable) and needs no user authentication, so
 *   the store works whenever the app runs, like the Keychain's "after first unlock".
 * - Each value gets a fresh 12-byte IV, which the Keystore generates (randomised encryption stays
 *   required, so an IV can never be reused). The stored form is `1` (the format), the IV and the
 *   ciphertext with its tag, in base64.
 * - The scoped key is the GCM associated data, so a value copied to another entry does not decrypt.
 * - Entries are named by the SHA-256 of the scoped key, so the file does not list the backends
 *   the person used. The database holds those base URLs anyway; the hash only keeps this file from
 *   saying more than the values it protects.
 * - A value that can no longer be decrypted (its tag does not verify, the Keystore key was
 *   invalidated or lost) is treated as missing and removed. Other Keystore errors are thrown, so a
 *   passing failure never deletes a device secret.
 * - Nothing here logs a key or a value. The file is excluded from backup and device transfer by the
 *   manifest's backup rules, like everything else the app stores.
 *
 * [fileName] and [keyAlias] exist for the instrumented tests, which must not touch the app's own
 * store.
 */
class AndroidSecureStore(
    context: Context,
    private val fileName: String = DEFAULT_FILE,
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
) : SecureStore {
    private val app = context.applicationContext
    private val prefs: SharedPreferences by lazy { app.getSharedPreferences(fileName, Context.MODE_PRIVATE) }
    private val lock = Mutex()

    override suspend fun get(key: String): String? = locked {
        val name = entryName(key)
        val stored = prefs.getString(name, null) ?: return@locked null
        val value = try {
            decrypt(key, stored)
        } catch (e: UndecryptableValue) {
            null
        }
        if (value == null) prefs.edit().remove(name).commit()
        value
    }

    override suspend fun put(key: String, value: String) = locked {
        val stored = encrypt(key, value)
        check(prefs.edit().putString(entryName(key), stored).commit()) { "The secure store could not be written." }
    }

    override suspend fun remove(key: String) = locked {
        check(prefs.edit().remove(entryName(key)).commit()) { "The secure store could not be written." }
    }

    private suspend fun <T> locked(block: () -> T): T = withContext(Dispatchers.IO) { lock.withLock { block() } }

    private fun encrypt(key: String, value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey())
        } catch (e: KeyPermanentlyInvalidatedException) {
            // The key cannot be used any more, so nothing stored under it can be read either.
            cipher.init(Cipher.ENCRYPT_MODE, newKey())
        }
        cipher.updateAAD(key.encodeToByteArray())
        val iv = cipher.iv
        check(iv.size == IV_BYTES) { "The Keystore returned an unexpected IV length." }
        val sealed = cipher.doFinal(value.encodeToByteArray())
        val out = ByteArray(1 + iv.size + sealed.size)
        out[0] = FORMAT
        iv.copyInto(out, 1)
        sealed.copyInto(out, 1 + iv.size)
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** The value, or [UndecryptableValue] when it can never be decrypted again. */
    private fun decrypt(key: String, stored: String): String {
        val bytes = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            throw UndecryptableValue()
        }
        if (bytes.size < 1 + IV_BYTES + TAG_BYTES || bytes[0] != FORMAT) throw UndecryptableValue()
        val secretKey = existingKey() ?: throw UndecryptableValue()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(TAG_BYTES * 8, bytes, 1, IV_BYTES))
            cipher.updateAAD(key.encodeToByteArray())
            val plain = cipher.doFinal(bytes, 1 + IV_BYTES, bytes.size - 1 - IV_BYTES)
            return plain.decodeToString(throwOnInvalidSequence = true)
        } catch (e: AEADBadTagException) {
            throw UndecryptableValue()
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw UndecryptableValue()
        } catch (e: CharacterCodingException) {
            throw UndecryptableValue()
        }
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    /** The Keystore key, or null when there is none (or it cannot be recovered). */
    private fun existingKey(): SecretKey? = try {
        keyStore().getKey(keyAlias, null) as? SecretKey
    } catch (e: UnrecoverableKeyException) {
        null
    }

    /** Creates (or replaces) the Keystore key. Called under [lock], so two callers never race. */
    private fun newKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private class UndecryptableValue : Exception()

    companion object {
        /** The app's store; the instrumented tests use other names. */
        const val DEFAULT_FILE = "caddie_secure_store"
        const val DEFAULT_KEY_ALIAS = "caddie-secure-store"

        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val FORMAT: Byte = 1
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16

        /** The SharedPreferences entry for [key]: "v1." and the SHA-256 of the scoped key in hex. */
        internal fun entryName(key: String): String =
            "v1." + MessageDigest.getInstance("SHA-256").digest(key.encodeToByteArray())
                .joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
    }
}
