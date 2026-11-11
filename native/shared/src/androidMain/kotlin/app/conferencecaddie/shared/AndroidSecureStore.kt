package app.conferencecaddie.shared

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
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
 * - Only the Keystore's own answer that there is no key (`getKey` returns null, which it does for
 *   KEY_NOT_FOUND and nothing else) makes a value read as missing, and only then does a write
 *   create a new key. Every other Keystore failure is thrown: a transient one (a SYSTEM_ERROR, a
 *   binder failure, the keystore daemon restarting) reaches `getKey` as UnrecoverableKeyException,
 *   exactly like a key that is really broken, so the two cannot be told apart. Treating it as "no
 *   key" would delete the entry and replace the key, losing the device secret for good; thrown, it
 *   reaches [app.conferencecaddie.shared.people.DeviceCredentials] as "unavailable", and the next
 *   attempt reads the value again.
 * - An entry is removed only when it can never be decrypted whatever the Keystore's state: its
 *   bytes are malformed, or its tag does not verify under the key the Keystore did load (it was
 *   written under an earlier key, or changed). A value whose key is missing or permanently
 *   invalidated reads as missing but stays; the next write replaces it.
 * - Nothing here logs a key or a value. The file is excluded from backup and device transfer by the
 *   manifest's backup rules, like everything else the app stores.
 *
 * [fileName], [keyAlias] and [keys] exist for the instrumented tests, which must not touch the
 * app's own store and replace [keys] to inject Keystore failures.
 */
class AndroidSecureStore(
    context: Context,
    private val fileName: String = DEFAULT_FILE,
    keyAlias: String = DEFAULT_KEY_ALIAS,
    private val keys: Keys = KeystoreKeys(keyAlias),
) : SecureStore {
    private val app = context.applicationContext
    private val prefs: SharedPreferences by lazy { app.getSharedPreferences(fileName, Context.MODE_PRIVATE) }
    private val lock = Mutex()

    override suspend fun get(key: String): String? = locked {
        val name = entryName(key)
        val stored = prefs.getString(name, null) ?: return@locked null
        when (val result = decrypt(key, stored)) {
            is Decrypted.Value -> result.value
            Decrypted.NoKey -> null
            Decrypted.Never -> {
                prefs.edit().remove(name).commit()
                null
            }
        }
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
        // A new key only when the Keystore says there is none; any failure to load it is thrown.
        val secretKey = keys.existing() ?: keys.create()
        try {
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
        } catch (e: KeyPermanentlyInvalidatedException) {
            // The key cannot be used any more, so nothing stored under it can be read either.
            cipher.init(Cipher.ENCRYPT_MODE, keys.create())
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

    /**
     * The value; [Decrypted.NoKey] when the Keystore has no key (or the key is permanently
     * invalidated); [Decrypted.Never] when the entry can never be decrypted under any key the
     * Keystore could return. A Keystore failure to load the key is thrown.
     */
    private fun decrypt(key: String, stored: String): Decrypted {
        val bytes = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            return Decrypted.Never
        }
        if (bytes.size < 1 + IV_BYTES + TAG_BYTES || bytes[0] != FORMAT) return Decrypted.Never
        val secretKey = keys.existing() ?: return Decrypted.NoKey
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(TAG_BYTES * 8, bytes, 1, IV_BYTES))
        } catch (e: KeyPermanentlyInvalidatedException) {
            return Decrypted.NoKey
        }
        cipher.updateAAD(key.encodeToByteArray())
        val plain = try {
            cipher.doFinal(bytes, 1 + IV_BYTES, bytes.size - 1 - IV_BYTES)
        } catch (e: AEADBadTagException) {
            // The key was loaded, so this is not a passing Keystore error: the entry was written
            // under another key, or changed.
            return Decrypted.Never
        }
        return try {
            Decrypted.Value(plain.decodeToString(throwOnInvalidSequence = true))
        } catch (e: CharacterCodingException) {
            Decrypted.Never
        }
    }

    private sealed interface Decrypted {
        class Value(val value: String) : Decrypted

        /** The Keystore has no usable key: the value is lost, but its entry stays until the next write. */
        data object NoKey : Decrypted

        /** The entry cannot be decrypted under any key: it is removed. */
        data object Never : Decrypted
    }

    /**
     * Where the store gets its AES key. [KeystoreKeys] is the app's; the instrumented tests wrap it
     * to make the Keystore fail.
     */
    interface Keys {
        /**
         * The key, or null only when the Keystore has none. Any failure to load it is thrown, and
         * never treated as "no key".
         */
        fun existing(): SecretKey?

        /** Creates (or replaces) the key. Called under the store's lock, so two callers never race. */
        fun create(): SecretKey
    }

    /** The key [alias] in the Android Keystore: AES-256, GCM only, no user authentication. */
    class KeystoreKeys(private val alias: String) : Keys {
        private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

        /**
         * `getKey` returns null for KEY_NOT_FOUND only. UnrecoverableKeyException (every Keystore
         * error, transient or not, arrives as one) and every other exception propagate.
         */
        override fun existing(): SecretKey? = keyStore().getKey(alias, null) as SecretKey?

        override fun create(): SecretKey {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            generator.init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            return generator.generateKey()
        }
    }

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
