package app.conferencecaddie.shared

import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.alloc
import kotlinx.cinterop.convert
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.ptr
import kotlinx.cinterop.value
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
import platform.Foundation.NSString
import platform.Foundation.NSUTF8StringEncoding
import platform.Foundation.create
import platform.Foundation.dataUsingEncoding
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
import platform.darwin.OSStatus

/**
 * [SecureStore] in the iOS Keychain: one generic password item per scoped key, under the service
 * [service], with the scoped key as the account.
 *
 * - Items are readable after the first unlock since the phone started, on this device only
 *   (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), so they are never in a backup that could
 *   be restored to another phone, and never synchronised through iCloud Keychain.
 * - A missing item is null; any other Keychain error is thrown with its status code and nothing
 *   else, never a key or a value.
 * - Every Core Foundation object created here is released here: the query dictionaries and the
 *   values bridged into them.
 */
@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
class IosSecureStore(private val service: String = DEFAULT_SERVICE) : SecureStore {
    private val lock = Mutex()

    override suspend fun get(key: String): String? = locked {
        query(key, kSecReturnData to kCFBooleanTrue, kSecMatchLimit to kSecMatchLimitOne) { query ->
            memScoped {
                val result = alloc<CFTypeRefVar>()
                val status = SecItemCopyMatching(query, result.ptr)
                when (status) {
                    errSecSuccess -> {
                        val data = CFBridgingRelease(result.value) as? NSData ?: throw KeychainException("read", status)
                        NSString.create(data, NSUTF8StringEncoding)?.toString() ?: throw KeychainException("read", status)
                    }
                    errSecItemNotFound -> null
                    else -> throw KeychainException("read", status)
                }
            }
        }
    }

    override suspend fun put(key: String, value: String) = locked {
        @Suppress("CAST_NEVER_SUCCEEDS")
        val data = (value as NSString).dataUsingEncoding(NSUTF8StringEncoding) ?: error("The value is not UTF-8.")
        val bridged = CFBridgingRetain(data)
        try {
            val updated = query(key) { query ->
                attributes(kSecValueData to bridged, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) {
                    SecItemUpdate(query, it)
                }
            }
            val status = if (updated == errSecItemNotFound) {
                val added = query(key, kSecValueData to bridged, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) {
                    SecItemAdd(it, null)
                }
                // Another process (an extension, later) may have added it in between: update once more.
                if (added == errSecDuplicateItem) {
                    query(key) { query ->
                        attributes(kSecValueData to bridged, kSecAttrAccessible to kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly) {
                            SecItemUpdate(query, it)
                        }
                    }
                } else {
                    added
                }
            } else {
                updated
            }
            if (status != errSecSuccess) throw KeychainException("write", status)
        } finally {
            CFRelease(bridged)
        }
    }

    override suspend fun remove(key: String) = locked {
        val status = query(key) { SecItemDelete(it) }
        if (status != errSecSuccess && status != errSecItemNotFound) throw KeychainException("delete", status)
    }

    /**
     * The protection class and the synchronisable flag of [key]'s item, for the debug self-test
     * ([IosSelfTest]); null when there is no item. Never the value.
     */
    internal suspend fun protectionOf(key: String): Pair<String?, Boolean>? = locked {
        query(key, kSecReturnAttributes to kCFBooleanTrue, kSecMatchLimit to kSecMatchLimitOne) { query ->
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
    }

    private suspend fun <T> locked(block: () -> T): T = withContext(Dispatchers.IO) { lock.withLock { block() } }

    /**
     * Runs [block] with the query for [key]'s item (generic password, [service], the key as the
     * account, never synchronisable) plus [extra] pairs, and releases everything afterwards.
     */
    private fun <T> query(
        key: String,
        vararg extra: Pair<CFTypeRef?, CFTypeRef?>,
        block: (CFMutableDictionaryRef?) -> T,
    ): T {
        val serviceRef = CFBridgingRetain(service)
        val accountRef = CFBridgingRetain(key)
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

    private fun <T> attributes(vararg pairs: Pair<CFTypeRef?, CFTypeRef?>, block: (CFMutableDictionaryRef?) -> T): T =
        dictionary(*pairs, block = block)

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

    companion object {
        /** The Keychain service of the app's items. */
        const val DEFAULT_SERVICE = "app.conferencecaddie.secure-store"
    }
}

/** A Keychain error other than "not found": only the operation and the status code. */
class KeychainException(operation: String, val status: OSStatus) :
    IllegalStateException("The Keychain $operation failed ($status).")
