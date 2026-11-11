package app.conferencecaddie.shared

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Security.SecRandomCopyBytes
import platform.Security.errSecSuccess
import platform.Security.kSecRandomDefault

@OptIn(ExperimentalForeignApi::class)
actual fun secureRandomBytes(count: Int): ByteArray {
    val bytes = ByteArray(count)
    if (count == 0) return bytes
    val status = bytes.usePinned { SecRandomCopyBytes(kSecRandomDefault, count.toULong(), it.addressOf(0)) }
    check(status == errSecSuccess) { "The system random number generator failed ($status)." }
    return bytes
}
