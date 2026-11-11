package app.conferencecaddie.shared.ble

import app.conferencecaddie.shared.KeychainException
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.withContext
import platform.CoreFoundation.CFDictionaryAddValue
import platform.CoreFoundation.CFDictionaryCreateMutable
import platform.CoreFoundation.CFMutableDictionaryRef
import platform.CoreFoundation.CFRelease
import platform.CoreFoundation.CFRetain
import platform.CoreFoundation.CFTypeRef
import platform.CoreFoundation.CFTypeRefVar
import platform.CoreFoundation.kCFBooleanFalse
import platform.CoreFoundation.kCFBooleanTrue
import platform.CoreFoundation.kCFTypeDictionaryKeyCallBacks
import platform.CoreFoundation.kCFTypeDictionaryValueCallBacks
import platform.Foundation.CFBridgingRelease
import platform.Foundation.CFBridgingRetain
import platform.Foundation.NSData
import platform.Foundation.NSLock
import platform.Security.SecItemAdd
import platform.Security.SecItemCopyMatching
import platform.Security.SecItemDelete
import platform.Security.SecItemUpdate
import platform.Security.errSecDuplicateItem
import platform.Security.errSecItemNotFound
import platform.Security.errSecSuccess
import platform.Security.kSecAttrAccessible
import platform.Security.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
import platform.Security.kSecAttrAccount
import platform.Security.kSecAttrService
import platform.Security.kSecAttrSynchronizable
import platform.Security.kSecClass
import platform.Security.kSecClassGenericPassword
import platform.Security.kSecMatchLimit
import platform.Security.kSecMatchLimitOne
import platform.Security.kSecReturnAttributes
import platform.Security.kSecReturnData
import platform.Security.kSecValueData

/**
 * [BleKeyStore] in the iOS Keychain (docs/contracts/ble-tokens.md, On the device): one generic
 * password item per alias, under its own service [DEFAULT_SERVICE], with the alias as the account
 * and the 32 key bytes as the value.
 *
 * - Items are `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: a Bluetooth wake can derive tokens
 *   while the phone is locked (after the first unlock since it started), the item is never
 *   synchronised through iCloud Keychain, and a backup restores it only onto this same device.
 * - The HMAC is computed in Kotlin ([HmacSha256]) over the key read from the Keychain. The key is
 *   kept in memory per alias after the first read, so a radio answering read requests does not go
 *   to the Keychain each time; [put] and [remove] update that cache with the item.
 * - Safe from any thread: the radio calls [hmac] on its own dispatch queue while the common runtime
 *   stores and removes keys from coroutines. One lock guards the cache and the Keychain calls; the
 *   HMAC itself runs outside it.
 * - Nothing here logs. A Keychain failure of [put] or [remove] is thrown as a [KeychainException]
 *   carrying only the operation and the status code; [hmac] answers null instead, as the interface
 *   asks when the platform cannot give the key.
 */
class IosBleKeyStore internal constructor(private val backing: BleKeyBacking) : BleKeyStore {
    /** The store over the Keychain items of [service]; tests and the self-test pass a service of their own. */
    constructor(service: String = DEFAULT_SERVICE) : this(KeychainBleKeys(service))

    private val lock = NSLock()
    private val cache = HashMap<String, ByteArray>()

    override suspend fun put(alias: String, key: ByteArray) {
        require(key.size == BleProtocol.KEY_BYTES) { "a Bluetooth key is 32 bytes" }
        val copy = key.copyOf()
        withContext(Dispatchers.IO) {
            locked {
                // The cache changes only once the Keychain holds the new key, so a failed write
                // leaves both on the previous key.
                backing.write(alias, copy)
                cache.put(alias, copy)?.fill(0)
            }
        }
    }

    override fun hmac(alias: String, message: ByteArray): ByteArray? {
        // A copy taken under the lock: put() and remove() wipe the cached array they replace, which
        // must not change the key under an HMAC already running.
        val key = locked {
            val cached = cache[alias] ?: try {
                backing.read(alias)?.takeIf { it.size == BleProtocol.KEY_BYTES }?.also { cache[alias] = it }
            } catch (e: KeychainException) {
                // Before the first unlock (errSecInteractionNotAllowed) or any other failure: no key
                // now, and nothing cached, so the next call asks the Keychain again.
                null
            }
            cached?.copyOf()
        } ?: return null
        return try {
            HmacSha256.mac(key, message)
        } finally {
            key.fill(0)
        }
    }

    override suspend fun remove(alias: String) {
        withContext(Dispatchers.IO) {
            locked {
                try {
                    backing.delete(alias)
                } finally {
                    // Forgotten even when the delete failed: the next hmac() reads what the Keychain
                    // still holds instead of a copy that may be stale.
                    cache.remove(alias)?.fill(0)
                }
            }
        }
    }

    private inline fun <T> locked(block: () -> T): T {
        lock.lock()
        try {
            return block()
        } finally {
            lock.unlock()
        }
    }

    companion object {
        /** The Keychain service of the Bluetooth session keys, apart from the secure store's items. */
        const val DEFAULT_SERVICE = "app.conferencecaddie.ble"
    }
}

/**
 * Where [IosBleKeyStore] keeps the key bytes: the Keychain in the app, a map in the tests (the
 * Kotlin/Native test process has no Keychain). Calls arrive under the store's lock.
 */
internal interface BleKeyBacking {
    /** The bytes stored as [alias], or null when there are none. */
    fun read(alias: String): ByteArray?

    /** Stores [key] as [alias], replacing what was there. */
    fun write(alias: String, key: ByteArray)

    /** Deletes [alias]; nothing happens when there is none. */
    fun delete(alias: String)
}

/**
 * [BleKeyBacking] in the Keychain: generic password items of [service], the alias as the account,
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronisable. Every Core Foundation
 * object created here is released here.
 */
@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
internal class KeychainBleKeys(private val service: String) : BleKeyBacking {
    override fun read(alias: String): ByteArray? =
        query(alias, kSecReturnData to kCFBooleanTrue, kSecMatchLimit to kSecMatchLimitOne) { query ->
            memScoped {
                val result = alloc<CFTypeRefVar>()
                when (val status = SecItemCopyMatching(query, result.ptr)) {
                    errSecSuccess -> (CFBridgingRelease(result.value) as? NSData ?: throw KeychainException("read", status)).toByteArray()
                    errSecItemNotFound -> null
                    else -> throw KeychainException("read", status)
                }
            }
        }

    override fun write(alias: String, key: ByteArray) {
        val bridged = CFBridgingRetain(key.toNSData())
        try {
            fun update() = query(alias) { query ->
                dictionary(kSecValueData to bridged, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) {
                    SecItemUpdate(query, it)
                }
            }
            val updated = update()
            val status = if (updated == errSecItemNotFound) {
                val added = query(alias, kSecValueData to bridged, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) {
                    SecItemAdd(it, null)
                }
                // Added by someone else in between: update once more.
                if (added == errSecDuplicateItem) update() else added
            } else {
                updated
            }
            if (status != errSecSuccess) throw KeychainException("write", status)
        } finally {
            CFRelease(bridged)
        }
    }

    override fun delete(alias: String) {
        val status = query(alias) { SecItemDelete(it) }
        if (status != errSecSuccess && status != errSecItemNotFound) throw KeychainException("delete", status)
    }

    /**
     * The protection class and the synchronisable flag of [alias]'s item, for the debug self-test
     * (`-caddie.selftest blekeys`); null when there is no item. Never the value.
     */
    fun protectionOf(alias: String): Pair<String?, Boolean>? =
        query(alias, kSecReturnAttributes to kCFBooleanTrue, kSecMatchLimit to kSecMatchLimitOne) { query ->
            memScoped {
                val result = alloc<CFTypeRefVar>()
                when (val status = SecItemCopyMatching(query, result.ptr)) {
                    errSecSuccess -> {
                        val attributes = CFBridgingRelease(result.value) as? Map<*, *> ?: throw KeychainException("read", status)
                        val accessible = attributes[CFBridgingRelease(CFRetain(kSecAttrAccessible))] as? String
                        val sync = attributes[CFBridgingRelease(CFRetain(kSecAttrSynchronizable))]
                        accessible to (sync == true || sync == 1L || sync == 1)
                    }
                    errSecItemNotFound -> null
                    else -> throw KeychainException("read", status)
                }
            }
        }

    /** Runs [block] with the query for [alias]'s item plus [extra] pairs, and releases everything afterwards. */
    private fun <T> query(
        alias: String,
        vararg extra: Pair<CFTypeRef?, CFTypeRef?>,
        block: (CFMutableDictionaryRef?) -> T,
    ): T {
        val serviceRef = CFBridgingRetain(service)
        val accountRef = CFBridgingRetain(alias)
        try {
            return dictionary(
                kSecClass to kSecClassGenericPassword,
                kSecAttrService to serviceRef,
                kSecAttrAccount to accountRef,
                kSecAttrSynchronizable to kCFBooleanFalse,
                *extra,
                block = block,
            )
        } finally {
            CFRelease(serviceRef)
            CFRelease(accountRef)
        }
    }

    /** A dictionary that retains its keys and values, released after [block]. */
    private fun <T> dictionary(vararg pairs: Pair<CFTypeRef?, CFTypeRef?>, block: (CFMutableDictionaryRef?) -> T): T {
        val dict = CFDictionaryCreateMutable(null, pairs.size.convert(), kCFTypeDictionaryKeyCallBacks.ptr, kCFTypeDictionaryValueCallBacks.ptr)
            ?: error("Could not create a Core Foundation dictionary.")
        try {
            for ((k, v) in pairs) CFDictionaryAddValue(dict, k, v)
            return block(dict)
        } finally {
            CFRelease(dict)
        }
    }
}
